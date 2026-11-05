/**
 * security.ts — Primitivas de seguridad de Capa 2B / WHATSPOWER-ULTRA
 * (orden de cierre 2026-11-06 — prioridad máxima por riesgo de despacho real)
 *
 * Modelo de identidad:
 *  - ADMIN_API_KEYS="clave:organizationId,clave2:organizationId2,claveServicio"
 *    * clave con ":org"  → identidad LIGADA a esa organización (nunca puede operar otras).
 *    * clave sin ":org"  → identidad de servicio (admin total, puede fijar organizationId).
 *  - organizationId de creación SIEMPRE desde la identidad ligada; el del body se ignora
 *    para identidades ligadas y se rechaza si contradice.
 *  - Fail-closed: sin ADMIN_API_KEYS no hay acceso administrativo.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba)
    return false
  }
  return timingSafeEqual(ba, bb)
}

export function isAuthorizedBearer(authHeader: string | undefined, expectedSecret: string): boolean {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false
  return safeEqual(authHeader.slice('Bearer '.length), expectedSecret)
}

export interface AdminIdentity {
  key: string
  /** null = identidad de servicio (puede operar cualquier organización) */
  org: string | null
}

/** Parsea ADMIN_API_KEYS="k1:orgA,k2,k3:orgC" → identidades. Ignora entradas vacías. */
export function parseAdminKeys(spec: string | undefined): AdminIdentity[] {
  if (!spec) return []
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(':')
      if (idx === -1) return { key: entry, org: null }
      return { key: entry.slice(0, idx), org: entry.slice(idx + 1) }
    })
    .filter((i) => i.key.length >= 16)
}

/** Resuelve la identidad del llamador desde el header Bearer. null = no autenticado. */
export function resolveIdentity(authHeader: string | undefined, adminKeys: AdminIdentity[]): AdminIdentity | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null
  const token = authHeader.slice('Bearer '.length)
  for (const identity of adminKeys) {
    if (safeEqual(identity.key, token)) return identity
  }
  return null
}

export const TIMESTAMP_WINDOW_MS = 300_000

export class ReplayCache {
  private seen = new Map<string, number>()
  public register(fingerprint: string, ttlMs: number = TIMESTAMP_WINDOW_MS * 2): boolean {
    this.prune()
    if (this.seen.has(fingerprint)) return false
    this.seen.set(fingerprint, Date.now() + ttlMs)
    return true
  }
  private prune(): void {
    const now = Date.now()
    for (const [k, exp] of this.seen) if (exp < now) this.seen.delete(k)
  }
  public get size(): number {
    return this.seen.size
  }
}

export interface HmacCheckResult {
  ok: boolean
  status: number
  error?: string
}

/** Verificación dura de webhook: HMAC obligatorio + timestamp obligatorio + anti-replay. */
export function checkWebhookSecurity(
  rawBody: string,
  signature: string | undefined,
  timestamp: string | undefined,
  secret: string | undefined,
  replay: ReplayCache,
  now: number = Date.now(),
): HmacCheckResult {
  if (!secret) {
    return { ok: false, status: 503, error: 'Service Unavailable: secreto de webhook no configurado' }
  }
  if (!signature || !timestamp) {
    return { ok: false, status: 401, error: 'Firma HMAC y timestamp son obligatorios' }
  }
  const reqTime = Number(timestamp) || new Date(timestamp).getTime()
  if (!Number.isFinite(reqTime) || Math.abs(now - reqTime) > TIMESTAMP_WINDOW_MS) {
    return { ok: false, status: 401, error: 'Timestamp expirado o fuera de ventana de tolerancia (replay protection)' }
  }
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  if (!safeEqual(expected, signature)) {
    return { ok: false, status: 401, error: 'Firma HMAC inválida' }
  }
  if (!replay.register(`${reqTime}:${expected}`)) {
    return { ok: false, status: 401, error: 'Petición duplicada (replay detectado)' }
  }
  return { ok: true, status: 200 }
}

export const MAX_BODY_BYTES = 1_048_576

export function readBody(req: import('node:http').IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<{ ok: true; body: string } | { ok: false; tooLarge: true }> {
  return new Promise((resolve) => {
    let body = ''
    let size = 0
    let rejected = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        rejected = true
        resolve({ ok: false, tooLarge: true })
        req.destroy()
        return
      }
      body += chunk
    })
    req.on('end', () => { if (!rejected) resolve({ ok: true, body }) })
    req.on('error', () => { if (!rejected) resolve({ ok: true, body }) })
  })
}

/**
 * Guard fail-fast de producción para ULTRA (nombra variables, jamás valores).
 */
export function productionConfigProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = []
  const weakDefaults = [
    'crm_albra_internal_secret_key_fixed_length_for_daemon_2026',
    'dev_secret_shared_albra_2a',
    'dev_shared_hmac_secret_albra_2a',
    'changeme', 'cambia-esto', 'REPLACE_WITH', 'test_internal_secret_daemon_min24',
  ]

  if (!env.ADMIN_API_KEYS) {
    problems.push('ADMIN_API_KEYS: ausente (obligatorio en producción — sin él no hay acceso administrativo)')
  } else {
    const identities = parseAdminKeys(env.ADMIN_API_KEYS)
    if (identities.length === 0) problems.push('ADMIN_API_KEYS: sin claves válidas (cada clave necesita 16+ caracteres)')
    const shortKeys = env.ADMIN_API_KEYS.split(',').map((s) => s.trim()).filter((s) => s && s.split(':')[0].length < 16)
    if (shortKeys.length > 0) problems.push('ADMIN_API_KEYS: contiene claves de menos de 16 caracteres')
  }

  if (!env.WEBHOOK_LEAD_SECRET) {
    problems.push('WEBHOOK_LEAD_SECRET: ausente (la ingesta de leads exige firma HMAC fail-closed)')
  } else if (env.WEBHOOK_LEAD_SECRET.length < 24) {
    problems.push('WEBHOOK_LEAD_SECRET: demasiado corto (mínimo 24 caracteres)')
  } else {
    for (const w of weakDefaults) {
      if (env.WEBHOOK_LEAD_SECRET.toLowerCase().includes(w.toLowerCase())) { problems.push('WEBHOOK_LEAD_SECRET: contiene un valor débil o publicado conocido'); break }
    }
  }

  if (!env.INTERNAL_API_SECRET) {
    problems.push('INTERNAL_API_SECRET: ausente (contrato con el daemon de WhatsApp y Capa 2A)')
  } else if (env.INTERNAL_API_SECRET.length < 24) {
    problems.push('INTERNAL_API_SECRET: demasiado corto (mínimo 24 caracteres)')
  } else {
    for (const w of weakDefaults) {
      if (env.INTERNAL_API_SECRET.toLowerCase().includes(w.toLowerCase())) { problems.push('INTERNAL_API_SECRET: contiene un valor débil o publicado conocido'); break }
    }
  }

  if (env.TRANSPORT_ENGINE === 'meta_cloud') {
    if (!env.META_ACCESS_TOKEN) problems.push('META_ACCESS_TOKEN: ausente con TRANSPORT_ENGINE=meta_cloud')
    if (!env.META_PHONE_NUMBER_ID) problems.push('META_PHONE_NUMBER_ID: ausente con TRANSPORT_ENGINE=meta_cloud')
    if (env.ALLOW_REAL_DISPATCH !== 'true') {
      problems.push('ALLOW_REAL_DISPATCH: no está en true — los envíos de Meta Cloud quedarán BLOQUEADOS (fail-closed); actívala solo con autorización expresa')
    }
  }
  return problems
}
