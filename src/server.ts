import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID, createHash } from 'node:crypto'
import { createBroadcastDatabase, writeAudit } from './db.ts'
import { BroadcastEngine } from './queue/broadcast-worker.ts'
import { transitionCampaignStatus } from './queue/campaign-lifecycle.ts'
import { issueStudioSession, resolveStudioSession, RateLimiter, safeEqual, resolveClientIp, trustProxyEnabled, STUDIO_SESSION_COOKIE } from './security.ts'
import { verifyEcosystemToken, SingleUseJti } from './ecosystem-sso.ts'
import { HttpCrmDaemonDispatcher } from './adapters/dispatcher.ts'
import { Http2ALockChecker, StandaloneLockChecker } from './safety/lock-checker.ts'
import { LocalSuppressionStore, Http2ASuppressionChecker, CompositeSuppressionChecker } from './safety/suppression.ts'
import { ConsentStore } from './safety/consent-store.ts'
import { renderCampaignStudioHtml } from './studio/campaign-studio-html.ts'
import { renderEcosystemErrorHtml, ecosystemErrorCopy } from './studio/ecosystem-error-html.ts'
// (paridad dashboard 2026-11-15) UI completa + endpoints del dashboard de paridad.
// Todo ADITIVO: las rutas y el esquema existentes del motor de broadcast no cambian.
import { renderDashboardLoginHtml, renderDashboardAppHtml } from './studio/dashboard-html.ts'
import { handleDashboardApi } from './dashboard/api.ts'
import { renderSpintax } from './engine/spintax.ts'
import { parseAudienceCsv } from './audiences/csv-importer.ts'
import { readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// ============================================================
// Página estática del sitio público (/sitio/). El panel NO es estático: se
// Se sirven tal cual desde build/ (resultado de `npm run build`), luego desde
// public/ (salidas antiguas) y, si no se ha construido, desde web/.
// No se ejecuta nada: solo ficheros y su tipo.
// Los datos siguen detrás de /api/* con su autenticación de siempre.
// ============================================================
const WEB_ROOT = resolve(fileURLToPath(new URL('../web/', import.meta.url)))
/** Salidas de `npm run build`, por orden de preferencia. */
const BUILD_ROOTS = ['../build/', '../public/']
  .map((p) => resolve(fileURLToPath(new URL(p, import.meta.url))))

/** Raíces del sitio público, en orden de preferencia. */
function siteBases (): string[] {
  return [...BUILD_ROOTS, join(WEB_ROOT, 'sitio'), join(WEB_ROOT, 'site')]
}

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

/** Localiza un fichero dentro de una de las raíces permitidas, sin salir de ellas. */
function findStaticFile (bases: string[], rel: string): string | null {
  const clean = normalize(rel).replace(/^[/\\]+/, '')
  if (clean.split(/[/\\]/).includes('..')) return null
  const candidates = clean === '' || clean.endsWith('/') || clean.endsWith('\\')
    ? [join(clean, 'index.html')]
    : [clean, join(clean, 'index.html')]
  for (const base of bases) {
    for (const candidate of candidates) {
      const full = resolve(base, candidate)
      if (full !== base && !full.startsWith(base + sep)) continue
      try {
        if (statSync(full).isFile()) return full
      } catch {
        // no existe: se prueba el siguiente candidato
      }
    }
  }
  return null
}

/**
 * Sirve /sitio/* (y el favicon) desde disco. Devuelve true si ya ha respondido.
 * Prioriza public/ (build) y recurre a web/ (fuentes) para servir sin construir.
 */
function serveStaticWeb (pathname: string, res: ServerResponse, headOnly: boolean): boolean {
  // (dashboard único 2026-11-16) Páginas de venta retiradas: el servidor solo sirve el panel.
  // Solo se conserva el favicon.ico para la pestaña del navegador.
  if (pathname === '/favicon.ico') {
    const bases = siteBases()
    const file = findStaticFile(bases, 'favicon.ico')
    if (file) {
      let body: Buffer
      try {
        body = readFileSync(file)
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('No se pudo leer el fichero')
        return true
      }
      res.writeHead(200, {
        'Content-Type': 'image/x-icon',
        'Content-Length': String(body.length),
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      })
      res.end(headOnly ? undefined : body)
      return true
    }
    const ico = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10, 0x00, 0x00, 0x01, 0x00, 0x20, 0x00, 0x68, 0x04, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00])
    res.writeHead(200, {
      'Content-Type': 'image/x-icon',
      'Content-Length': String(ico.length),
      'Cache-Control': 'public, max-age=86400',
    })
    res.end(headOnly ? undefined : ico)
    return true
  }
  return false
}

const STATIC_REDIRECTS: Record<string, string> = {
  '/app': '/',
  '/app/': '/',
  '/sitio': '/',
  '/sitio/': '/',
  '/inicio': '/',
  '/panel': '/',
}

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
  const consentStore = new ConsentStore(db)
  const suppressionStore =
    options?.suppressionStore ||
    (whatsPowerEnabled
      ? new CompositeSuppressionChecker(new LocalSuppressionStore(db, consentStore), new Http2ASuppressionChecker())
      : new LocalSuppressionStore(db, consentStore))

  const engine = new BroadcastEngine({
    db,
    dispatcher,
    lockChecker,
    suppressionStore,
    consentStore,
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
  // (ecosistema 2026-11-17) jti de enlaces SSO del CRM: un solo canje por enlace
  const ecosystemJti = new SingleUseJti()

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    // 0-bis. Redirección total al panel único en / (las páginas de venta se retiraron).
    if (req.method === 'GET' || req.method === 'HEAD') {
      const redirectTo = STATIC_REDIRECTS[url.pathname] ?? (url.pathname.startsWith('/app/') || url.pathname.startsWith('/sitio/') ? '/' : undefined)
      if (redirectTo) {
        res.writeHead(302, { Location: redirectTo })
        res.end()
        return
      }
      if (serveStaticWeb(url.pathname, res, req.method === 'HEAD')) return
    }

    // ==============================================================
    // PUERTA DE AUTENTICACIÓN (orden de cierre 2026-11-06)
    // Toda ruta /api/* exige identidad administrativa (Bearer ADMIN_API_KEYS),
    // SALVO: /api/health (público) y /api/audiences/webhook-lead (HMAC propio).
    // Fail-closed: sin ADMIN_API_KEYS configurado, 503.
    // ==============================================================
    // (paridad dashboard) webhook-message es público CON SU PROPIA verificación HMAC v2
    // (igual que webhook-lead) y se gestiona en handleDashboardApi.
    const isPublicApiPath = url.pathname === '/api/health'
      || url.pathname === '/api/audiences/webhook-lead'
      || url.pathname === '/api/audiences/webhook-message'
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
      // (reparación 2026-11-17) IP del SOCKET salvo TRUST_PROXY=true (jamás
      // x-forwarded-for crudo, falsificable por el cliente).
      const ip = resolveClientIp(req, trustProxyEnabled())
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
      // (reparación 2026-11-17) el contador NO se borra al acertar: los intentos
      // se acumulan dentro de la ventana (60 s) para cerrar el bypass por fuerza
      // bruta (aciertos intercalados entre fallos). El bucket expira solo.
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': issueStudioSession(matchIdx, adminKeys[matchIdx].key),
      })
      res.end(JSON.stringify({ ok: true, sessionTtlSeconds: 3600 }))
      return
    }

    // 0.a. Login DEMO (sin registro): solo cuando DEMO_MODE=true en .env y
    // FUERA de producción (reparación 2026-11-17: 403 SIEMPRE con
    // NODE_ENV=production, aunque DEMO_MODE hubiese quedado activo en env).
    // Emite una sesión con la PRIMERA identidad de ADMIN_API_KEYS.
    if (req.method === 'POST' && url.pathname === '/studio/login-demo') {
      if (process.env.NODE_ENV === 'production') {
        console.warn('[Seguridad 2B ALERTA] Intento de login-demo en PRODUCCIÓN (bloqueado)')
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Forbidden: el login demo está prohibido en producción' }))
        return
      }
      const demoEnabled = String(process.env.DEMO_MODE || '').toLowerCase() === 'true'
      if (!demoEnabled || adminKeys.length === 0) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Modo demo no habilitado. Configura DEMO_MODE=true en .env' }))
        return
      }
      // Throttle anti-abuso del demo (mismo bucket que login normal)
      const ip = resolveClientIp(req, trustProxyEnabled())
      const nowMs = Date.now()
      const bucket = studioLoginAttempts.get(ip)
      if (!bucket || bucket.resetAt <= nowMs) studioLoginAttempts.set(ip, { count: 1, resetAt: nowMs + 60_000 })
      else if (++bucket.count > 10) {
        res.writeHead(429, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Demasiados intentos. Inténtalo más tarde.' }))
        return
      }
      // (reparación 2026-11-17) sin delete(ip) al acertar: los intentos
      // acumulan en la ventana aunque el demo conceda sesión (anti fuerza bruta).
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': issueStudioSession(0, adminKeys[0].key),
      })
      res.end(JSON.stringify({ ok: true, sessionTtlSeconds: 3600, demo: true }))
      return
    }

    // 0.a-bis. Canje del ENLACE de ECOSISTEMA emitido por el CRM (2026-11-17):
    // HMAC-SHA256 con TTL de 90 s y UN solo uso, emitido por el CRM SOLO a
    // sesiones autenticadas (demo o real). NO es el login-demo anónimo (sus
    // reglas quedan intactas); es el SSO consciente del dueño: funciona en
    // producción SOLO si ECOSYSTEM_SSO_SECRET está configurado (fail-closed:
    // sin el secreto la ruta NO existe → 404).
    if (req.method === 'GET' && url.pathname === '/studio/login-ecosystem') {
      if (process.env.NODE_ENV === 'production') {
        const ip = resolveClientIp(req, trustProxyEnabled())
        console.warn(`[Seguridad 2B ALERTA] Intento de login-ecosystem en PRODUCCIÓN (IP: ${ip})`)
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(renderEcosystemErrorHtml({
          title: 'Acceso Prohibido en Producción',
          detail: 'El acceso directo SSO del ecosistema está estrictamente restringido a entornos de prueba/desarrollo y no se permite en producción.',
        }))
        return
      }
      const demoEnabled = String(process.env.DEMO_MODE || '').toLowerCase() === 'true'
      if (!demoEnabled) {
        const ip = resolveClientIp(req, trustProxyEnabled())
        console.warn(`[Seguridad 2B ALERTA] Intento de login-ecosystem con DEMO_MODE inactivo (IP: ${ip})`)
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(renderEcosystemErrorHtml({
          title: 'Modo Demo No Habilitado',
          detail: 'El acceso directo SSO del ecosistema requiere DEMO_MODE=true.',
        }))
        return
      }
      const ssoSecret = process.env.ECOSYSTEM_SSO_SECRET
      if (!ssoSecret) {
        // (2026-11-17 bis) fail-closed EXPLICADO: página HTML con el motivo y
        // el enlace de vuelta al CRM — jamás un JSON crudo ni un body vacío.
        const copy = ecosystemErrorCopy('ECOSYSTEM_SSO_SECRET no configurado (ruta deshabilitada)', false)
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(renderEcosystemErrorHtml(copy))
        return
      }
      const ip = resolveClientIp(req, trustProxyEnabled())
      const nowMs = Date.now()
      const bucket = studioLoginAttempts.get(ip)
      if (!bucket || bucket.resetAt <= nowMs) studioLoginAttempts.set(ip, { count: 1, resetAt: nowMs + 60_000 })
      else if (++bucket.count > 10) {
        res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(renderEcosystemErrorHtml({
          title: 'Demasiados intentos',
          detail: 'Se alcanzó el límite de canjes por minuto (protección anti-abuso). Espera un momento y vuelve a abrir la capa desde el botón Ecosistema del CRM.',
        }))
        return
      }
      const requestedOrg = url.searchParams.get('orgId') || undefined
      const verdict = verifyEcosystemToken(String(url.searchParams.get('token') || ''), ssoSecret, Date.now(), requestedOrg)
      if (!verdict.ok || !ecosystemJti.claim(verdict.payload.jti)) {
        const jtiUsed = verdict.ok // verdict.ok=true aquí significa jti ya canjeado
        console.warn(`[Seguridad 2B ALERTA] Canje ecosystem rechazado: ${verdict.ok ? 'jti ya utilizado' : verdict.reason} (IP: ${ip})`)
        const copy = ecosystemErrorCopy(verdict.ok ? 'jti ya utilizado' : verdict.reason, jtiUsed)
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(renderEcosystemErrorHtml(copy))
        return
      }
      if (adminKeys.length === 0) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Service Unavailable: sin ADMIN_API_KEYS (fail-closed)' }))
        return
      }
      res.writeHead(302, {
        'Set-Cookie': issueStudioSession(0, adminKeys[0].key),
        Location: '/',
      })
      res.end()
      return
    }

    // 0. UI del DASHBOARD de paridad (Fase 3): login dedicado + app completa.
    // El studio legado queda intacto en /studio (mismo HTML y comportamiento de antes).
    if (req.method === 'GET' && url.pathname === '/login') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(renderDashboardLoginHtml())
      return
    }
    if (req.method === 'POST' && url.pathname === '/logout') {
      // Cierre de sesión del dashboard: expira la cookie de studio (misma cookie HttpOnly)
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `${STUDIO_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
      })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/campaigns')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(renderDashboardAppHtml())
      return
    }
    if (req.method === 'GET' && url.pathname === '/studio') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(renderCampaignStudioHtml())
      return
    }

    // 1. Healthcheck y Métricas Operativas (Capa 2B)
    if (req.method === 'GET' && url.pathname === '/api/health') {
      try {
        db.prepare('SELECT 1').get()
        const queuePending = (db.prepare("SELECT COUNT(*) as c FROM campaign_items WHERE status = 'PENDING'").get() as any)?.c ?? 0
        const queueInFlight = (db.prepare("SELECT COUNT(*) as c FROM campaign_items WHERE status = 'DISPATCHING'").get() as any)?.c ?? 0
        const totalSent = (db.prepare("SELECT COUNT(*) as c FROM campaign_items WHERE status = 'SENT'").get() as any)?.c ?? 0
        const totalUncertain = (db.prepare("SELECT COUNT(*) as c FROM campaign_items WHERE status = 'UNCERTAIN_DISPATCH'").get() as any)?.c ?? 0
        const totalFailed = (db.prepare("SELECT COUNT(*) as c FROM campaign_items WHERE status IN ('FAILED_FATAL', 'FAILED_RETRYABLE')").get() as any)?.c ?? 0
        const mem = process.memoryUsage()

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          status: 'ok',
          service: 'whatspower-ultra',
          uptimeSeconds: Math.floor(process.uptime()),
          timestamp: new Date().toISOString(),
          database: { connected: true, driver: 'node:sqlite' },
          metrics: {
            queue: { pending: queuePending, inFlight: queueInFlight },
            dispatches: { sent: totalSent, failed: totalFailed, uncertain: totalUncertain },
          },
          memory: {
            rssMb: Math.round(mem.rss / 1024 / 1024),
            heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
          }
        }))
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'error', error: err.message }))
      }
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

      // (A4-10) Ítems paginados: ?itemsLimit (1..2000, default 500) + total
      // para el paginado del Studio.
      // Nota honesta (reauditoría ciclo 2): las columnas pesadas
      // (rendered_text/variables_json) SIGUEN incluidas en el SELECT — la
      // paginación acota el daño pero no elimina el coste; proyección de
      // columnas pendiente si el volumen lo exige.
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
      const userAgent = (req.headers['user-agent'] as string) || null

      // Validación X-Forwarded-For SOLO si TRUST_PROXY está explícitamente habilitado
      const trustProxy = process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1'
      let clientIp = req.socket.remoteAddress || '127.0.0.1'
      if (trustProxy && req.headers['x-forwarded-for']) {
        const xff = req.headers['x-forwarded-for']
        const first = (Array.isArray(xff) ? xff[0] : xff).split(',')[0].trim()
        if (first) clientIp = first
      }

      // No guardar IP cruda: anonimización mediante SHA-256 (Ley 1581 / GDPR)
      const salt = process.env.IP_HASH_SALT || 'crm_albra_privacy_salt'
      const hashedIp = createHash('sha256').update(`${clientIp}:${salt}`).digest('hex').slice(0, 16)

      const row = db.prepare('SELECT target_url, campaign_id FROM tracked_links WHERE code = ?').get(code) as any
      if (row && row.target_url) {
        db.prepare('UPDATE tracked_links SET clicks = clicks + 1 WHERE code = ?').run(code)
        
        // Registrar evento individual para atribución con IP anonimizada (no cruda)
        try {
          db.prepare(`
            INSERT INTO tracked_link_clicks (id, code, contact_phone, user_agent, ip, clicked_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(`clk_${randomUUID()}`, code, contactPhone, userAgent, hashedIp, Math.floor(Date.now() / 1000))
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

    // 14. Cumplimiento y Protección de Datos Personales (Ley 1581 de 2012 / Habeas Data)
    if (req.method === 'GET' && url.pathname === '/api/compliance/contact-data') {
      const phone = url.searchParams.get('phone')
      if (!phone) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'PHONE_REQUIRED' }))
        return
      }
      const orgId = identity!.org ?? url.searchParams.get('org') ?? 'default'
      const data = consentStore.exportContactData(orgId, phone)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(data))
      return
    }

    if (req.method === 'DELETE' && url.pathname === '/api/compliance/contact-data') {
      const phone = url.searchParams.get('phone')
      if (!phone) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'PHONE_REQUIRED' }))
        return
      }
      const orgId = identity!.org ?? url.searchParams.get('org') ?? 'default'
      const result = consentStore.deleteContactData(orgId, phone, identity!.key)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/compliance/consent') {
      const rb = await readBody(req)
      if (!rb.ok) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Payload demasiado grande' }))
        return
      }
      try {
        const body = JSON.parse(rb.body)
        const orgId = identity!.org ?? body.organizationId ?? 'default'
        const rec = consentStore.recordConsent({
          organizationId: orgId,
          contactPhone: body.contactPhone,
          whoAuthorized: body.whoAuthorized,
          channel: body.channel,
          textShown: body.textShown,
          source: body.source,
          authorizedAt: body.authorizedAt,
        })
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, consent: rec }))
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/compliance/opt-out') {
      const rb = await readBody(req)
      if (!rb.ok) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Payload demasiado grande' }))
        return
      }
      try {
        const body = JSON.parse(rb.body)
        const orgId = identity!.org ?? body.organizationId ?? 'default'
        await suppressionStore.addSuppression(orgId, body.contactPhone, body.reason || 'opt_out')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, suppressed: true, consentRevoked: true }))
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    // 15. (paridad dashboard) Endpoints del dashboard: resumen, contactos, etiquetas,
    // respuestas rápidas, agentes, embudo, conversaciones/chat, ajustes, transporte,
    // supresión y borrado/reintento de campañas. Nada de esto se toca arriba; si la
    // ruta no es del dashboard, cae al 404 original.
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/studio/')) {
      const handled = await handleDashboardApi(req, res, url, {
        db,
        identity: identity ?? { key: 'studio-session', org: null },
        dispatcher,
        lockChecker,
        suppressionStore,
        leadReplay,
        leadRate,
        leadSecretSpec,
      })
      if (handled) return
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
