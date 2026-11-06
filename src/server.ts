import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createBroadcastDatabase, purgeExpiredSecurityRows, writeAudit } from './db.ts'
import { BroadcastEngine } from './queue/broadcast-worker.ts'
import { HttpCrmDaemonDispatcher } from './adapters/dispatcher.ts'
import { Http2ALockChecker, StandaloneLockChecker } from './safety/lock-checker.ts'
import { LocalSuppressionStore, Http2ASuppressionChecker, CompositeSuppressionChecker } from './safety/suppression.ts'
import { renderCampaignStudioHtml } from './studio/campaign-studio-html.ts'
import { renderSpintax } from './engine/spintax.ts'
import { parseAudienceCsv } from './audiences/csv-importer.ts'
import { WebhookLeadIngester } from './audiences/webhook-ingest.ts'
import { MetaCloudDispatcher } from './adapters/meta-cloud-dispatcher.ts'
import { NeuromarketingEngine } from './ai/neuromarketing-engine.ts'
import {
  parseAdminKeys,
  resolveIdentity,
  verifyWebhookLead,
  parseWebhookLeadSecrets,
  PersistentReplayStore,
  EventIdempotencyStore,
  RateLimiter,
  clientIp,
  maskPhone,
  readBody,
  productionConfigProblems,
  type AdminIdentity,
} from './security.ts'

// Carga el .env del repo si existe (mismo patrón que Capa 2A; sin él el guard de
// producción bloquearía el arranque por variables ausentes).
try {
  process.loadEnvFile()
} catch {}

/** Solo http(s):// absoluto es un destino de redirección válido (contrato §7). */
function isSafeRedirectTarget(target: string): boolean {
  try {
    const u = new URL(target)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export function createBroadcastServer(options?: {
  dbPath?: string
  dispatcher?: any
  lockChecker?: any
  suppressionStore?: any
  whatsPowerEnabled?: boolean
  useMetaCloudApi?: boolean
  leadSecretOverride?: string
}) {
  const whatsPowerEnabled = options?.whatsPowerEnabled ?? (process.env.WHATSPOWER_ENABLED !== 'false')
  const db = createBroadcastDatabase(options?.dbPath)
  const leadIngester = new WebhookLeadIngester(db)
  const neuromarketingEngine = new NeuromarketingEngine()
  const dispatcher =
    options?.dispatcher ||
    (options?.useMetaCloudApi || process.env.TRANSPORT_ENGINE === 'meta_cloud'
      ? new MetaCloudDispatcher()
      : new HttpCrmDaemonDispatcher({ allowRealDispatch: false }))
  const lockChecker = options?.lockChecker || (whatsPowerEnabled ? new Http2ALockChecker({ enabled: true }) : new StandaloneLockChecker())
  const suppressionStore =
    options?.suppressionStore ||
    (whatsPowerEnabled
      ? new CompositeSuppressionChecker(new LocalSuppressionStore(db), new Http2ASuppressionChecker())
      : new LocalSuppressionStore(db))

  const engine = new BroadcastEngine({
    db,
    dispatcher,
    lockChecker,
    suppressionStore,
  })

  // Ejecutar recuperación ante caídas al arrancar (reconcilia huérfanos DISPATCHING)
  const recovery = engine.recoverFromCrash()
  if (recovery.recoveredCount > 0) {
    console.log(`[Capa 2B] Recuperación ante caídas: ${recovery.recoveredCount} ítems transitorios restablecidos`)
  }

  // Identidades administrativas (contrato §1)
  const adminKeys: AdminIdentity[] = parseAdminKeys(process.env.ADMIN_API_KEYS)

  // Anti-replay PERSISTENTE + idempotencia de eventos (contrato §3)
  const leadReplay = new PersistentReplayStore(db)
  const eventStore = new EventIdempotencyStore(db)
  const perOrgLeadSecrets = parseWebhookLeadSecrets(process.env.WEBHOOK_LEAD_SECRETS)
  const legacyLeadSecret = options?.leadSecretOverride || process.env.WEBHOOK_LEAD_SECRET

  // Rate limiting (contrato §7): general 120/min por identidad; webhook-lead 30/min por org.
  const rateLimiter = new RateLimiter()

  // Purga de antigüedad al arrancar + cada hora (replay>600s lo hace su store; eventos>7d aquí).
  purgeExpiredSecurityRows(db)
  eventStore.purge()
  const purgeTimer = setInterval(() => {
    purgeExpiredSecurityRows(db)
    eventStore.purge()
  }, 60 * 60 * 1000)
  purgeTimer.unref?.()

  function json(res: ServerResponse, status: number, payload: unknown, extraHeaders?: Record<string, string>): void {
    res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders })
    res.end(JSON.stringify(payload))
  }

  function tooManyRequests(res: ServerResponse, retryAfterSec: number): void {
    json(res, 429, { error: 'Too Many Requests: límite de tasa excedido' }, { 'Retry-After': String(retryAfterSec) })
  }

  function generic500(res: ServerResponse, scope: string, err: unknown): void {
    console.error(`[Capa 2B ERROR] ${scope}:`, err instanceof Error ? err.message : err)
    json(res, 500, { error: 'Error interno del servidor' })
  }

  /** 404 sin oráculo: la campaña debe existir Y pertenecer a la organización del llamador. */
  function ownCampaign(campaignId: string, identity: AdminIdentity) {
    const campaign = engine.getCampaign(campaignId)
    if (!campaign) return null
    if (identity.org !== null && (campaign as any).organizationId !== identity.org) return null
    return campaign
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

    // ==============================================================
    // PUERTA DE AUTENTICACIÓN (contrato v1.1.0 §1)
    // Toda ruta /api/* exige identidad administrativa (Bearer ADMIN_API_KEYS),
    // SALVO: /api/health (público) y /api/audiences/webhook-lead (HMAC v2 propio).
    // Fail-closed: sin ADMIN_API_KEYS configurado, 503. Las identidades de servicio
    // (clave sin :org) quedan REGISTRADAS en audit_log (contrato §1).
    // ==============================================================
    const isPublicApiPath = url.pathname === '/api/health' || url.pathname === '/api/audiences/webhook-lead'
    let identity: AdminIdentity | null = null
    if (url.pathname.startsWith('/api/') && !isPublicApiPath) {
      const rl = rateLimiter.check(`admin:${clientIp(req)}`, 120)
      if (!rl.allowed) { tooManyRequests(res, rl.retryAfterSec); return }
      if (adminKeys.length === 0) {
        json(res, 503, { error: 'Service Unavailable: ADMIN_API_KEYS no configurado (fail-closed)' })
        return
      }
      identity = resolveIdentity(req.headers['authorization'], adminKeys)
      if (!identity) {
        console.warn(`[Seguridad 2B ALERTA] Acceso administrativo no autorizado: ${req.method} ${url.pathname} (IP: ${clientIp(req)})`)
        json(res, 401, { error: 'Unauthorized: credencial administrativa ausente o inválida' })
        return
      }
      if (identity.org === null) {
        // Identidad de servicio con privilegios globales: acción SIEMPRE auditada (contrato §1)
        writeAudit(db, identity.key, null, `${req.method} ${url.pathname}`, 'service-identity')
      }
    }

    // 0. Campaign Studio UI (público; las llamadas /api/* piden credencial al operador)
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/campaigns')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(renderCampaignStudioHtml())
      return
    }

    // 1. Healthcheck
    if (req.method === 'GET' && url.pathname === '/api/health') {
      json(res, 200, { status: 'ok', service: 'whatspower-ultra' })
      return
    }

    // 2. Previsualizador Spintax
    if (req.method === 'POST' && url.pathname === '/api/spintax/preview') {
      const rb = await readBody(req)
      if (!rb.ok) {
        json(res, 413, { error: 'Payload demasiado grande' })
        return
      }
      try {
        const { template, name, variables } = JSON.parse(rb.body)
        const rendered = renderSpintax(template || '', {
          seed: String(Math.random()),
          // Alias name/nombre: el Studio usa {{nombre}} y el CSV usa {{name}};
          // el preview debe reflejar lo mismo que inyectará el despacho real.
          variables: { name: name || 'Juan', nombre: name || 'Juan', ...(variables || {}) },
        })
        json(res, 200, { rendered })
      } catch {
        json(res, 400, { error: 'Solicitud de previsualización inválida' })
      }
      return
    }

    // 3. Previsualizador y Validador CSV
    if (req.method === 'POST' && url.pathname === '/api/audiences/preview-csv') {
      const rb = await readBody(req)
      if (!rb.ok) {
        json(res, 413, { error: 'Payload demasiado grande' })
        return
      }
      try {
        const { csvContent } = JSON.parse(rb.body)
        const result = parseAudienceCsv(csvContent || '')
        json(res, 200, result)
      } catch {
        json(res, 400, { error: 'CSV inválido' })
      }
      return
    }

    // 4. Listar Campañas (filtrado por organización de la identidad — sin enumeración cross-org)
    if (req.method === 'GET' && url.pathname === '/api/campaigns') {
      const rows = (identity!.org === null
        ? db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all()
        : db.prepare('SELECT * FROM campaigns WHERE organization_id = ? ORDER BY created_at DESC').all(identity!.org)) as any[]
      json(res, 200, rows)
      return
    }

    // 5. Crear Campaña — organizationId EXCLUSIVAMENTE de la identidad autenticada
    if (req.method === 'POST' && url.pathname === '/api/campaigns') {
      const rb = await readBody(req)
      if (!rb.ok) {
        json(res, 413, { error: 'Payload demasiado grande' })
        return
      }
      try {
        const data = JSON.parse(rb.body)
        // Identidad ligada: la org SIEMPRE de la clave (el body se ignora; si contradice, 400 auditable)
        if (identity!.org !== null) {
          if (data.organizationId && data.organizationId !== identity!.org) {
            json(res, 400, { error: 'Bad Request: organizationId del body no coincide con la identidad autenticada (el organizationId viene de la identidad, nunca del body)' })
            return
          }
          data.organizationId = identity!.org
        } else if (!data.organizationId) {
          json(res, 400, { error: 'Bad Request: una identidad de servicio debe indicar organizationId de la campaña' })
          return
        }
        const campaign = await engine.createCampaign(data)
        writeAudit(db, identity!.key, data.organizationId, 'create_campaign', campaign.id)
        json(res, 200, campaign)
      } catch {
        json(res, 400, { error: 'Datos de campaña inválidos' })
      }
      return
    }

    // 6. Detalle de Campaña (GET /api/campaigns/:id) — con ownership (404 sin oráculo)
    if (req.method === 'GET' && /^\/api\/campaigns\/[^/]+$/.test(url.pathname)) {
      const campaignId = decodeURIComponent(url.pathname.replace('/api/campaigns/', ''))
      const campaign = ownCampaign(campaignId, identity!)
      if (!campaign) {
        json(res, 404, { error: 'Campaña no encontrada' })
        return
      }

      const items = engine.getItems(campaignId)
      json(res, 200, { campaign, items })
      return
    }

    // 7. Acciones de Control de Campaña — matching EXACTO de ruta + ownership + máquina de estados
    if (req.method === 'POST' && /^\/api\/campaigns\/[^/]+\/step$/.test(url.pathname)) {
      const campaignId = decodeURIComponent(url.pathname.split('/')[3])
      if (!ownCampaign(campaignId, identity!)) {
        json(res, 404, { error: 'Campaña no encontrada' })
        return
      }
      const stepRes = await engine.processNextItem(campaignId)
      json(res, 200, stepRes)
      return
    }

    if (req.method === 'POST' && /^\/api\/campaigns\/[^/]+\/pause$/.test(url.pathname)) {
      const campaignId = decodeURIComponent(url.pathname.split('/')[3])
      if (!ownCampaign(campaignId, identity!)) {
        json(res, 404, { error: 'Campaña no encontrada' })
        return
      }
      // Máquina de estados (contrato §6): RUNNING⇄PAUSED; terminales intocables (409).
      const r = db.prepare("UPDATE campaigns SET status = 'PAUSED' WHERE id = ? AND status IN ('RUNNING','DRAFT')").run(campaignId)
      if (r.changes === 0) {
        const current = (engine.getCampaign(campaignId) as any)?.status
        json(res, 409, { error: `Conflicto: transición ilegal ${current} → PAUSED (los estados terminales son intocables)` })
        return
      }
      writeAudit(db, identity!.key, identity!.org, 'pause_campaign', campaignId)
      json(res, 200, { ok: true, status: 'PAUSED' })
      return
    }

    if (req.method === 'POST' && /^\/api\/campaigns\/[^/]+\/resume$/.test(url.pathname)) {
      const campaignId = decodeURIComponent(url.pathname.split('/')[3])
      if (!ownCampaign(campaignId, identity!)) {
        json(res, 404, { error: 'Campaña no encontrada' })
        return
      }
      // Sólo estados de pausa vuelven a RUNNING; terminales intocables (409).
      const r = db.prepare("UPDATE campaigns SET status = 'RUNNING' WHERE id = ? AND status IN ('PAUSED','PAUSED_OFF_HOURS','PAUSED_COOLDOWN')").run(campaignId)
      if (r.changes === 0) {
        const current = (engine.getCampaign(campaignId) as any)?.status
        json(res, 409, { error: `Conflicto: transición ilegal ${current} → RUNNING (los estados terminales son intocables)` })
        return
      }
      writeAudit(db, identity!.key, identity!.org, 'resume_campaign', campaignId)
      json(res, 200, { ok: true, status: 'RUNNING' })
      return
    }

    if (req.method === 'POST' && /^\/api\/campaigns\/[^/]+\/cancel$/.test(url.pathname)) {
      const campaignId = decodeURIComponent(url.pathname.split('/')[3])
      if (!ownCampaign(campaignId, identity!)) {
        json(res, 404, { error: 'Campaña no encontrada' })
        return
      }
      // CANCELLED es terminal: sólo cancelable desde estados no terminales (409 si ya lo está).
      const r = db.prepare("UPDATE campaigns SET status = 'CANCELLED', finished_at = ? WHERE id = ? AND status NOT IN ('COMPLETED','CANCELLED')").run(Math.floor(Date.now() / 1000), campaignId)
      if (r.changes === 0) {
        json(res, 409, { error: 'Conflicto: la campaña ya está en estado terminal (intocable)' })
        return
      }
      writeAudit(db, identity!.key, identity!.org, 'cancel_campaign', campaignId)
      json(res, 200, { ok: true, status: 'CANCELLED' })
      return
    }

    // 8. Enlaces Rastreados y Atribución (/t/:code) — destino SOLO http(s):// absoluto (contrato §7)
    if (req.method === 'GET' && url.pathname.startsWith('/t/')) {
      const code = url.pathname.replace('/t/', '')
      const contactPhone = url.searchParams.get('p') || null
      const userAgent = req.headers['user-agent'] || null
      const ip = clientIp(req)

      const row = db.prepare('SELECT target_url, campaign_id FROM tracked_links WHERE code = ?').get(code) as any
      if (row && row.target_url) {
        if (!isSafeRedirectTarget(row.target_url)) {
          console.warn(`[Seguridad 2B ALERTA] Enlace rastreado con destino no http(s): ${code}`)
          json(res, 404, { error: 'Enlace no encontrado' })
          return
        }
        db.prepare('UPDATE tracked_links SET clicks = clicks + 1 WHERE code = ?').run(code)

        // Registrar evento individual para heatmap y atribución
        try {
          db.prepare(`
            INSERT INTO tracked_link_clicks (id, code, contact_phone, user_agent, ip, clicked_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(`clk_${randomUUID()}`, code, contactPhone, userAgent, ip, Math.floor(Date.now() / 1000))
        } catch {}

        res.writeHead(302, { Location: row.target_url })
        res.end()
        return
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Enlace no encontrado')
      return
    }

    // 9. Ingesta de Leads — HMAC v2 (contrato §3) con secretos POR ORGANIZACIÓN: el secreto
    // que valida la firma VINCULA la org; un webhook de la org A jamás añade leads a la org B.
    if (req.method === 'POST' && url.pathname === '/api/audiences/webhook-lead') {
      const rl = rateLimiter.check(`webhook-lead:${clientIp(req)}`, 30)
      if (!rl.allowed) { tooManyRequests(res, rl.retryAfterSec); return }
      const rb = await readBody(req)
      if (!rb.ok) {
        json(res, 413, { error: 'Payload demasiado grande' })
        return
      }
      const sec = verifyWebhookLead(
        rb.body,
        req.headers['x-signature-sha256'] as string | undefined,
        req.headers['x-timestamp'] as string | undefined,
        { perOrgSecrets: perOrgLeadSecrets, legacySecret: legacyLeadSecret, replay: leadReplay },
      )
      if (!sec.ok) {
        console.warn(`[Seguridad 2B ALERTA] Ingesta de leads rechazada: ${sec.error} (IP: ${clientIp(req)})`)
        json(res, sec.status, { error: sec.error })
        return
      }
      try {
        const payload = JSON.parse(rb.body)
        // eventId OBLIGATORIO para operaciones con efectos externos (contrato §3):
        // cabecera X-Event-Id (preferida) o body.eventId.
        const eventId = (req.headers['x-event-id'] as string | undefined) || payload.eventId
        if (!eventId || !/^[a-zA-Z0-9._-]{1,128}$/.test(String(eventId))) {
          json(res, 400, { error: 'eventId obligatorio (cabecera X-Event-Id o body.eventId) para la ingesta con efectos externos' })
          return
        }
        const result = leadIngester.ingestLead(payload, sec.orgId!, String(eventId))
        if (result.success === false && result.reason === 'CAMPAIGN_NOT_IN_ORG') {
          // 404 sin oráculo: la campaña no es de la organización vinculada al secreto
          json(res, 404, { error: 'Campaña no encontrada' })
          return
        }
        json(res, 200, result)
      } catch {
        json(res, 400, { error: 'Payload de lead inválido' })
      }
      return
    }

    // 10. Reporte de Atribución y Clics de Campaña — con ownership (404 sin oráculo)
    if (req.method === 'GET' && url.pathname.startsWith('/api/attribution/report/')) {
      const campaignId = decodeURIComponent(url.pathname.replace('/api/attribution/report/', ''))
      const campaign = ownCampaign(campaignId, identity!)
      if (!campaign) {
        json(res, 404, { error: 'Campaña no encontrada' })
        return
      }

      const linkRows = db.prepare('SELECT * FROM tracked_links WHERE campaign_id = ?').all(campaignId) as any[]
      const totalClicks = linkRows.reduce((sum, r) => sum + (r.clicks || 0), 0)
      const ctr = campaign.sentCount > 0 ? ((totalClicks / campaign.sentCount) * 100).toFixed(1) : '0.0'

      json(res, 200, {
        campaignId,
        campaignName: campaign.name,
        sentCount: campaign.sentCount,
        totalClicks,
        ctrPercent: `${ctr}%`,
        links: linkRows,
      })
      return
    }

    // 11. Neuromarketing AI: Análisis de Mercado y Perfil Subconsciente
    if (req.method === 'POST' && url.pathname === '/api/ai/neuromarketing/analyze') {
      const rb = await readBody(req)
      if (!rb.ok) {
        json(res, 413, { error: 'Payload demasiado grande' })
        return
      }
      try {
        const payload = JSON.parse(rb.body)
        const result = neuromarketingEngine.analyzeTargetMarket(payload)
        json(res, 200, result)
      } catch {
        json(res, 400, { error: 'Solicitud de análisis inválida' })
      }
      return
    }

    // 12. Neuromarketing AI: Generación Automática de Spintax Persuasivo
    if (req.method === 'POST' && url.pathname === '/api/ai/neuromarketing/generate-spintax') {
      const rb = await readBody(req)
      if (!rb.ok) {
        json(res, 413, { error: 'Payload demasiado grande' })
        return
      }
      try {
        const payload = JSON.parse(rb.body)
        const result = neuromarketingEngine.generateNeuromarketingSpintax(payload)
        json(res, 200, result)
      } catch {
        json(res, 400, { error: 'Solicitud de generación inválida' })
      }
      return
    }

    // 13. Neuromarketing AI: Constructor de Master Prompt 360° para LLMs
    if (req.method === 'POST' && url.pathname === '/api/ai/neuromarketing/master-prompt') {
      const rb = await readBody(req)
      if (!rb.ok) {
        json(res, 413, { error: 'Payload demasiado grande' })
        return
      }
      try {
        const payload = JSON.parse(rb.body)
        const prompt = neuromarketingEngine.buildMasterPrompt(payload)
        json(res, 200, { masterPrompt: prompt })
      } catch {
        json(res, 400, { error: 'Solicitud de master prompt inválida' })
      }
      return
    }

    json(res, 404, { error: 'Ruta no encontrada' })
  })

  return { server, db, engine, leadIngester, dispatcher, neuromarketingEngine }
}

// Auto-arranque si se ejecuta directamente con Node
if (process.argv[1]?.includes('server.ts')) {
  // Guard fail-fast de entorno en producción (orden de cierre): sin claves admin, sin
  // secretos por-org de leads o con configuración incompleta de Meta, NO arranca.
  if (process.env.NODE_ENV === 'production') {
    const problems = productionConfigProblems()
    if (problems.length > 0) {
      console.error('[Capa 2B ✋] Arranque bloqueado por configuración insegura/incompleta:')
      for (const p of problems) console.error(`  - ${p}`)
      process.exit(1)
    }
  }
  const PORT = Number(process.env.PORT || 3004)
  // Por defecto solo localhost (la API de despacho no se expone a la red);
  // usa HOST=0.0.0.0 explícitamente si la topología lo exige.
  const HOST = process.env.HOST || '127.0.0.1'
  const { server } = createBroadcastServer()
  server.listen(PORT, HOST, () => {
    console.log(`[Capa 2B] Servidor de Broadcast escuchando en http://${HOST}:${PORT}`)
  })
}
