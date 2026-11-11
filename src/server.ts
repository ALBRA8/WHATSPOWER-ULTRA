import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createBroadcastDatabase, writeAudit } from './db.ts'
import { BroadcastEngine } from './queue/broadcast-worker.ts'
import { transitionCampaignStatus } from './queue/campaign-lifecycle.ts'
import { issueStudioSession, resolveStudioSession, RateLimiter, safeEqual } from './security.ts'
import { HttpCrmDaemonDispatcher } from './adapters/dispatcher.ts'
import { Http2ALockChecker, StandaloneLockChecker } from './safety/lock-checker.ts'
import { LocalSuppressionStore, Http2ASuppressionChecker, CompositeSuppressionChecker } from './safety/suppression.ts'
import { renderCampaignStudioHtml } from './studio/campaign-studio-html.ts'
import { renderSpintax } from './engine/spintax.ts'
import { parseAudienceCsv } from './audiences/csv-importer.ts'

// ============================================================
// (A5-08, auditoría 2026-11-11) Umbrales de proceso: una rejection/excepción
// no capturada NUNCA muere en silencio ni arrastra el proceso sin rastro:
// se loguea con detalle y el proceso termina limpio (systemd/docker con
// restart: unless-stopped lo reinicia; el arranque ya ejecuta recoverFromCrash).
// ============================================================
process.on('unhandledRejection', (reason) => {
  console.error('[ultra-server] unhandledRejection:', reason instanceof Error ? reason.message : reason)
})
process.on('uncaughtException', (err) => {
  console.error('[ultra-server] uncaughtException (parada de emergencia):', err.message)
  process.exit(1)
})
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
  const leadRate = new RateLimiter() // (fusión integral §7): ingesta de leads 30/min por IP
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
      if (identity.org === null) {
        // (fusión integral §1) Identidad de servicio con privilegios globales:
        // acción SIEMPRE auditada con actor truncado (jamás la clave completa).
        writeAudit(db, identity.key, null, `${req.method} ${url.pathname}`, 'service-identity')
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
      // (A2-04) Comparación EN TIEMPO CONSTANTE (política del propio repo):
      // se recorren TODAS las claves con safeEqual y se agrega el índice
      // coincidente; nunca se corta al primer acierto.
      let matchIdx = -1
      for (let i = 0; i < adminKeys.length; i++) {
        if (safeEqual(adminKeys[i].key, secret)) matchIdx = i
      }
      if (matchIdx === -1) {
        console.warn(`[Seguridad 2B ALERTA] Studio login fallido (IP: ${req.socket.remoteAddress})`)
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Credencial administrativa inválida' }))
        return
      }
      studioLoginAttempts.delete(ip)
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': issueStudioSession(matchIdx, adminKeys[matchIdx].key),
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
    // (A4-10) Paginación obligatoria: ?limit (1..500, default 100) & ?offset.
    if (req.method === 'GET' && url.pathname === '/api/campaigns') {
      const q = url.searchParams
      const limit = Math.min(Math.max(parseInt(q.get('limit') || '100', 10) || 100, 1), 500)
      const offset = Math.max(parseInt(q.get('offset') || '0', 10) || 0, 0)
      const listSql = identity!.org === null
        ? 'SELECT * FROM campaigns ORDER BY created_at DESC LIMIT ? OFFSET ?'
        : 'SELECT * FROM campaigns WHERE organization_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
      const rows = (identity!.org === null
        ? db.prepare(listSql).all(limit, offset)
        : db.prepare(listSql).all(identity!.org, limit, offset)) as any[]
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ campaigns: rows, limit, offset }))
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
        // (A4-15) 201 Created: la creación SÍ creó un recurso nuevo.
        res.writeHead(201, { 'Content-Type': 'application/json' })
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

      // (A4-10) Ítems paginados y SIN columnas pesadas por defecto
      // (rendered_text/variables_json pueden ser MB por ítem) + total para
      // paginado del Studio: ?itemsLimit (1..2000, default 500).
      const itemsLimit = Math.min(Math.max(parseInt(url.searchParams.get('itemsLimit') || '500', 10) || 500, 1), 2000)
      const items = engine.getItems(campaignId, itemsLimit)
      const total = (db.prepare('SELECT COUNT(*) AS n FROM campaign_items WHERE campaign_id = ?').get(campaignId) as { n: number }).n
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ campaign, items, itemsTotal: total, itemsLimit }))
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
      // (fusión integral) rate limit 30/min por IP (429 + Retry-After) ANTES de leer cuerpo.
      const leadRl = leadRate.check(`lead:${(typeof req.headers['x-forwarded-for'] === 'string' ? (req.headers['x-forwarded-for'] as string).split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown'}`, 30)
      if (!leadRl.allowed) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(leadRl.retryAfterSec) })
        res.end(JSON.stringify({ error: 'Demasiadas peticiones (rate limit)' }))
        return
      }
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
          // Rechazo anti-inyección cross-org SIN ORÁCULO (fusión integral): la firma
          // era válida pero la campaña pertenece a OTRA organización → 404 genérico
          // (jamás se confirma la existencia de campañas ajenas; ni 403 nombrándolas).
          // NOTA (residual documentado): una campaña INEXISTENTE sigue la conducta
          // heredada de fix/b3 (200 con resultado sin efectos) para no romper el
          // contrato de ingesta de leads sin campaña válida.
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Not Found' }))
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
