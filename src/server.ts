import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createBroadcastDatabase } from './db.ts'
import { BroadcastEngine } from './queue/broadcast-worker.ts'
import { transitionCampaignStatus } from './queue/campaign-lifecycle.ts'
import { issueStudioSession, resolveStudioSession } from './security.ts'
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
  checkWebhookSecurity,
  readBody,
  DurableReplayCache,
  parseLeadSecretSpec,
  resolveLeadSecrets,
  LEGACY_LEAD_ORG,
  productionConfigProblems,
  type AdminIdentity,
  type LeadSecretSpec,
} from './security.ts'

// Carga el .env del repo si existe (mismo patrón que Capa 2A; sin él el guard de
// producción bloquearía el arranque por variables ausentes).
try {
  process.loadEnvFile()
} catch {}

export function createBroadcastServer(options?: {
  dbPath?: string
  dispatcher?: any
  lockChecker?: any
  suppressionStore?: any
  whatsPowerEnabled?: boolean
  useMetaCloudApi?: boolean
  /** Ruta del anti-replay durable; ':memory:' para tests. Default: env REPLAY_DB_PATH o <repo>/db/replay-cache.db */
  replayDbPath?: string
}) {
  const whatsPowerEnabled = options?.whatsPowerEnabled ?? (process.env.WHATSPOWER_ENABLED !== 'false')
  const db = createBroadcastDatabase(options?.dbPath)
  const leadIngester = new WebhookLeadIngester(db)
  const neuromarketingEngine = new NeuromarketingEngine()
  const dispatcher =
    options?.dispatcher ||
    (options?.useMetaCloudApi || process.env.TRANSPORT_ENGINE === 'meta_cloud'
      ? new MetaCloudDispatcher()
      // (reparación integral) paridad de salvaguarda: el env explícito habilita el daemon
      : new HttpCrmDaemonDispatcher({ allowRealDispatch: process.env.ALLOW_REAL_DISPATCH === 'true' }))
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

  // Ejecutar recuperación ante caídas al arrancar
  const recovery = engine.recoverFromCrash()
  if (recovery.recoveredCount > 0) {
    console.log(`[Capa 2B] Recuperación ante caídas: ${recovery.recoveredCount} ítems transitorios restablecidos`)
  }

  // Identidades administrativas (orden de cierre 2026-11-06)
  const adminKeys: AdminIdentity[] = parseAdminKeys(process.env.ADMIN_API_KEYS)
  // Anti-replay DURABLE (reparación integral 2026-11-06): sobrevive reinicios;
  // en tests con dbPath ':memory:' se usa ':memory:' para no compartir estado.
  const leadReplay = new DurableReplayCache(
    options?.replayDbPath ?? (options?.dbPath === ':memory:' ? ':memory:' : undefined)
  )
  // Secretos de ingesta de leads por organización (contrato v2) + fallback v1.
  const leadSecretSpec: LeadSecretSpec = parseLeadSecretSpec(process.env)

  /** 404 sin oráculo: la campaña debe existir Y pertenecer a la organización del llamador. */
  function ownCampaign(campaignId: string, identity: AdminIdentity) {
    const campaign = engine.getCampaign(campaignId)
    if (!campaign) return null
    if (identity.org !== null && (campaign as any).organizationId !== identity.org) return null
    return campaign
  }

  const studioLoginAttempts = new Map<string, { count: number; resetAt: number }>()

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

    // ==============================================================
    // PUERTA DE AUTENTICACIÓN (orden de cierre 2026-11-06)
    // Toda ruta /api/* exige identidad administrativa (Bearer ADMIN_API_KEYS),
    // SALVO: /api/health (público) y /api/audiences/webhook-lead (HMAC propio).
    // Fail-closed: sin ADMIN_API_KEYS configurado, 503.
    // ==============================================================
    const isPublicApiPath = url.pathname === '/api/health' || url.pathname === '/api/audiences/webhook-lead'
    let identity: AdminIdentity | null = null
    if (url.pathname.startsWith('/api/') && !isPublicApiPath) {
      if (adminKeys.length === 0) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Service Unavailable: ADMIN_API_KEYS no configurado (fail-closed)' }))
        return
      }
      identity = resolveIdentity(req.headers['authorization'], adminKeys)
        ?? resolveStudioSession(req.headers.cookie as string | undefined, adminKeys)
      if (!identity) {
        console.warn(`[Seguridad 2B ALERTA] Acceso administrativo no autorizado: ${req.method} ${url.pathname} (IP: ${req.socket.remoteAddress})`)
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized: credencial administrativa ausente o inválida' }))
        return
      }
    }

    // -1. (segunda reparación §4.A) Canje de sesión del Studio: el operador
    // envía el secreto UNA vez; el backend responde con cookie HttpOnly de
    // corta vida. El secreto de larga vida JAMÁS vuelve al navegador (antes
    // vivía en sessionStorage: un XSS lo leía).
    if (req.method === 'POST' && url.pathname === '/studio/login') {
      const rb = await readBody(req)
      if (!rb.ok) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Payload demasiado grande' }))
        return
      }
      // Throttle mínimo en memoria (10 intentos/min por IP): anti fuerza bruta
      const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'local'
      const nowMs = Date.now()
      const bucket = studioLoginAttempts.get(ip)
      if (!bucket || bucket.resetAt <= nowMs) studioLoginAttempts.set(ip, { count: 1, resetAt: nowMs + 60_000 })
      else if (++bucket.count > 10) {
        res.writeHead(429, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Demasiados intentos. Inténtalo más tarde.' }))
        return
      }
      let secret = ''
      try { secret = String(JSON.parse(rb.body).secret || '') } catch {}
      const idx = adminKeys.findIndex((k) => k.key === secret)
      if (idx === -1) {
        console.warn(`[Seguridad 2B ALERTA] Studio login fallido (IP: ${req.socket.remoteAddress})`)
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Credencial administrativa inválida' }))
        return
      }
      studioLoginAttempts.delete(ip)
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': issueStudioSession(idx, adminKeys[idx].key),
      })
      res.end(JSON.stringify({ ok: true, sessionTtlSeconds: 3600 }))
      return
    }

    // 0. Campaign Studio UI
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/campaigns')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(renderCampaignStudioHtml())
      return
    }

    // 1. Healthcheck
    if (req.method === 'GET' && url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', service: 'whatspower-ultra' }))
      return
    }

    // 2. Previsualizador Spintax
    if (req.method === 'POST' && url.pathname === '/api/spintax/preview') {
      // (reparación integral) body con límite 1MB → 413 (DoS de memoria cerrado)
      const rb = await readBody(req)
      if (!rb.ok) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Payload demasiado grande' }))
        return
      }
      {
        try {
          const { template, name, variables } = JSON.parse(rb.body)
          const rendered = renderSpintax(template || '', {
            seed: String(Math.random()),
            // Alias name/nombre: el Studio usa {{nombre}} y el CSV usa {{name}};
            // el preview debe reflejar lo mismo que inyectará el despacho real.
            variables: { name: name || 'Juan', nombre: name || 'Juan', ...(variables || {}) },
          })
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ rendered }))
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        }
      }
      return
    }

    // 3. Previsualizador y Validador CSV
    if (req.method === 'POST' && url.pathname === '/api/audiences/preview-csv') {
      // (reparación integral) body con límite 1MB → 413 (DoS de memoria cerrado)
      const rb = await readBody(req)
      if (!rb.ok) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Payload demasiado grande' }))
        return
      }
      {
        try {
          const { csvContent } = JSON.parse(rb.body)
          const result = parseAudienceCsv(csvContent || '')
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        }
      }
      return
    }

    // 4. Listar Campañas (filtrado por organización de la identidad — sin enumeración cross-org)
    if (req.method === 'GET' && url.pathname === '/api/campaigns') {
      const rows = (identity!.org === null
        ? db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all()
        : db.prepare('SELECT * FROM campaigns WHERE organization_id = ? ORDER BY created_at DESC').all(identity!.org)) as any[]
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(rows))
      return
    }

    // 5. Crear Campaña — organizationId EXCLUSIVAMENTE de la identidad autenticada
    if (req.method === 'POST' && url.pathname === '/api/campaigns') {
      const rb = await readBody(req)
      if (!rb.ok) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Payload demasiado grande' }))
        return
      }
      try {
        const data = JSON.parse(rb.body)
        // Identidad ligada: la org SIEMPRE de la clave (el body se ignora; si contradice, 400 auditable)
        if (identity!.org !== null) {
          if (data.organizationId && data.organizationId !== identity!.org) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Bad Request: organizationId del body no coincide con la identidad autenticada (el organizationId viene de la identidad, nunca del body)' }))
            return
          }
          data.organizationId = identity!.org
        } else if (!data.organizationId) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Bad Request: una identidad de servicio debe indicar organizationId de la campaña' }))
          return
        }
        const campaign = await engine.createCampaign(data)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(campaign))
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
      return
    }

    // 6. Detalle de Campaña (GET /api/campaigns/:id) — con ownership (404 sin oráculo)
    if (req.method === 'GET' && /^\/api\/campaigns\/[^/]+$/.test(url.pathname)) {
      const campaignId = decodeURIComponent(url.pathname.replace('/api/campaigns/', ''))
      const campaign = ownCampaign(campaignId, identity!)
      if (!campaign) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Campaña no encontrada' }))
        return
      }

      const items = engine.getItems(campaignId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ campaign, items }))
      return
    }

    // 7. Acciones de Control de Campaña — matching EXACTO de ruta + ownership
    if (req.method === 'POST' && /^\/api\/campaigns\/[^/]+\/step$/.test(url.pathname)) {
      const campaignId = decodeURIComponent(url.pathname.split('/')[3])
      if (!ownCampaign(campaignId, identity!)) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Campaña no encontrada' }))
        return
      }
      const stepRes = await engine.processNextItem(campaignId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(stepRes))
      return
    }

    if (req.method === 'POST' && /^\/api\/campaigns\/[^/]+\/pause$/.test(url.pathname)) {
      const campaignId = decodeURIComponent(url.pathname.split('/')[3])
      if (!ownCampaign(campaignId, identity!)) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Campaña no encontrada' }))
        return
      }
      // (segunda reparación §4.B) Transición CONDICIONAL y ATÓMICA: terminal
      // (CANCELLED/COMPLETED) jamás se pausa; carrera → 409 con estado real.
      const tr = transitionCampaignStatus(db, campaignId, identity!.org, 'PAUSED')
      if (!tr.ok) {
        const status = tr.code === 'NOT_FOUND' ? 404 : 409
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: tr.message, code: tr.code, currentStatus: tr.from }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, status: 'PAUSED', previousStatus: tr.from }))
      return
    }

    if (req.method === 'POST' && /^\/api\/campaigns\/[^/]+\/resume$/.test(url.pathname)) {
      const campaignId = decodeURIComponent(url.pathname.split('/')[3])
      if (!ownCampaign(campaignId, identity!)) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Campaña no encontrada' }))
        return
      }
      // (segunda reparación §4.B) CANCELLED es TERMINAL: una campaña cancelada
      // NO puede reanudarse (antes este UPDATE ciego lo permitía).
      const tr = transitionCampaignStatus(db, campaignId, identity!.org, 'RUNNING')
      if (!tr.ok) {
        const status = tr.code === 'NOT_FOUND' ? 404 : 409
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: tr.message, code: tr.code, currentStatus: tr.from }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, status: 'RUNNING', previousStatus: tr.from }))
      return
    }

    if (req.method === 'POST' && /^\/api\/campaigns\/[^/]+\/cancel$/.test(url.pathname)) {
      const campaignId = decodeURIComponent(url.pathname.split('/')[3])
      if (!ownCampaign(campaignId, identity!)) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Campaña no encontrada' }))
        return
      }
      const tr = transitionCampaignStatus(db, campaignId, identity!.org, 'CANCELLED')
      if (!tr.ok) {
        const status = tr.code === 'NOT_FOUND' ? 404 : 409
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: tr.message, code: tr.code, currentStatus: tr.from }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, status: 'CANCELLED', previousStatus: tr.from }))
      return
    }

    // 8. Enlaces Rastreados y Atribución (/t/:code)
    if (req.method === 'GET' && url.pathname.startsWith('/t/')) {
      const code = url.pathname.replace('/t/', '')
      const contactPhone = url.searchParams.get('p') || null
      const userAgent = req.headers['user-agent'] || null
      const ip = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '127.0.0.1'

      const row = db.prepare('SELECT target_url, campaign_id FROM tracked_links WHERE code = ?').get(code) as any
      if (row && row.target_url) {
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

    // 9. Ingesta de Leads en Tiempo Real — EXIGE HMAC v2 (secreto POR ORGANIZACIÓN,
    //    firma ligada a timestamp+org) + timestamp + replay durable.
    //    La organización NUNCA se toma del body: viene del header X-Org-Id verificado
    //    con el secreto registrado para esa organización (anti inyección cross-org).
    if (req.method === 'POST' && url.pathname === '/api/audiences/webhook-lead') {
      const rb = await readBody(req)
      if (!rb.ok) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Payload demasiado grande' }))
        return
      }
      const rawOrg = typeof req.headers['x-org-id'] === 'string' ? (req.headers['x-org-id'] as string).trim() : ''
      const orgForBinding = rawOrg || LEGACY_LEAD_ORG
      if (leadSecretSpec.byOrg.size === 0) {
        // Fail-closed estricto: sin secretos de ingesta configurados, NUNCA se acepta.
        console.warn(`[Seguridad 2B ALERTA] Ingesta de leads rechazada: sin secretos de webhook configurados (IP: ${req.socket.remoteAddress})`)
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Service Unavailable: secretos de ingesta de leads no configurados (fail-closed)' }))
        return
      }
      const orgSecrets = resolveLeadSecrets(leadSecretSpec, orgForBinding)
      if (!orgSecrets) {
        console.warn(`[Seguridad 2B ALERTA] Ingesta de leads rechazada: organización de webhook desconocida (IP: ${req.socket.remoteAddress})`)
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized: organización de webhook desconocida (X-Org-Id)' }))
        return
      }
      const sec = checkWebhookSecurity(
        rb.body,
        req.headers['x-signature-sha256'] as string | undefined,
        req.headers['x-timestamp'] as string | undefined,
        orgSecrets,
        leadReplay,
        Date.now(),
        orgForBinding,
      )
      if (!sec.ok) {
        console.warn(`[Seguridad 2B ALERTA] Ingesta de leads rechazada: ${sec.error} (IP: ${req.socket.remoteAddress})`)
        res.writeHead(sec.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: sec.error }))
        return
      }
      try {
        const payload = JSON.parse(rb.body)
        const result = leadIngester.ingestLead(payload, orgForBinding === LEGACY_LEAD_ORG ? undefined : orgForBinding)
        if (!result.success && result.reason === 'CAMPAIGN_ORG_MISMATCH') {
          // Rechazo anti-inyección cross-org: la firma era válida pero la campaña
          // referenciada pertenece a otra organización (o el secreto es v1 "_legacy").
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Forbidden: la campaña no pertenece a la organización autenticada' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
      return
    }

    // 10. Reporte de Atribución y Clics de Campaña — con ownership (404 sin oráculo)
    if (req.method === 'GET' && url.pathname.startsWith('/api/attribution/report/')) {
      const campaignId = decodeURIComponent(url.pathname.replace('/api/attribution/report/', ''))
      const campaign = ownCampaign(campaignId, identity!)
      if (!campaign) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Campaña no encontrada' }))
        return
      }

      const linkRows = db.prepare('SELECT * FROM tracked_links WHERE campaign_id = ?').all(campaignId) as any[]
      const totalClicks = linkRows.reduce((sum, r) => sum + (r.clicks || 0), 0)
      const ctr = campaign.sentCount > 0 ? ((totalClicks / campaign.sentCount) * 100).toFixed(1) : '0.0'

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        campaignId,
        campaignName: campaign.name,
        sentCount: campaign.sentCount,
        totalClicks,
        ctrPercent: `${ctr}%`,
        links: linkRows,
      }))
      return
    }

    // 11. Neuromarketing AI: Análisis de Mercado y Perfil Subconsciente
    if (req.method === 'POST' && url.pathname === '/api/ai/neuromarketing/analyze') {
      // (reparación integral) body con límite 1MB → 413 (DoS de memoria cerrado)
      const rb = await readBody(req)
      if (!rb.ok) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Payload demasiado grande' }))
        return
      }
      {
        try {
          const payload = JSON.parse(rb.body)
          const result = neuromarketingEngine.analyzeTargetMarket(payload)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        }
      }
      return
    }

    // 12. Neuromarketing AI: Generación Automática de Spintax Persuasivo
    if (req.method === 'POST' && url.pathname === '/api/ai/neuromarketing/generate-spintax') {
      // (reparación integral) body con límite 1MB → 413 (DoS de memoria cerrado)
      const rb = await readBody(req)
      if (!rb.ok) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Payload demasiado grande' }))
        return
      }
      {
        try {
          const payload = JSON.parse(rb.body)
          const result = neuromarketingEngine.generateNeuromarketingSpintax(payload)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        }
      }
      return
    }

    // 13. Neuromarketing AI: Constructor de Master Prompt 360° para LLMs
    if (req.method === 'POST' && url.pathname === '/api/ai/neuromarketing/master-prompt') {
      // (reparación integral) body con límite 1MB → 413 (DoS de memoria cerrado)
      const rb = await readBody(req)
      if (!rb.ok) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Payload demasiado grande' }))
        return
      }
      {
        try {
          const payload = JSON.parse(rb.body)
          const prompt = neuromarketingEngine.buildMasterPrompt(payload)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ masterPrompt: prompt }))
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        }
      }
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Ruta no encontrada' }))
  })

  return { server, db, engine, leadIngester, dispatcher, neuromarketingEngine }
}

// Auto-arranque si se ejecuta directamente con Node
if (process.argv[1]?.includes('server.ts')) {
  // Guard fail-fast de entorno en producción (orden de cierre): sin claves admin, sin
  // secreto de leads o con configuración incompleta de Meta, NO arranca.
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
