/**
 * security.ts — Primitivas de seguridad de Capa 2B / WHATSPOWER-ULTRA
 * (reparación integral v1.1.0, 2026-11-06 — prioridad máxima por riesgo de despacho real)
 *
 * Modelo de identidad:
 *  - ADMIN_API_KEYS="clave:organizationId,clave2:organizationId2,claveServicio"
 *    * clave con ":org"  → identidad LIGADA a esa organización (nunca puede operar otras).
 *    * clave sin ":org"  → identidad de servicio (infraestructura; TODA su acción se
 *      registra en audit_log — contrato §1).
 *  - organizationId de creación SIEMPRE desde la identidad ligada; el del body se ignora
 *    para identidades ligadas y se rechaza si contradice.
 *  - Fail-closed: sin ADMIN_API_KEYS no hay acceso administrativo.
 *
 * Webhooks (contrato §3): HMAC v2 = HMAC-SHA256(secret, timestamp + "." + rawBody);
 * el timestamp entra en la MAC. Anti-replay PERSISTENTE en SQLite (sobrevive reinicios).
 * Secretos POR ORGANIZACIÓN: WEBHOOK_LEAD_SECRETS="orgId:secreto,..." — el secreto que
 * valida el HMAC VINCULA la organización; el legado WEBHOOK_LEAD_SECRET solo org "default".
 * En producción se EXIGEN secretos por-org (fail-fast).
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

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
  /** null = identidad de servicio (puede operar cualquier organización; auditada) */
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

// ===========================================================================
// HMAC v2 (contrato §3): hex = HMAC-SHA256(secret, timestamp + "." + rawBody)
// ===========================================================================

export function computeHmacV2(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex')
}

export function replayFingerprint(timestamp: string, expectedMac: string): string {
  return `${timestamp}:${expectedMac}`
}

/** Anti-replay PERSISTENTE en SQLite (contrato §3): huellas con purga >600s. */
export const REPLAY_TTL_MS = TIMESTAMP_WINDOW_MS * 2

export class PersistentReplayStore {
  private db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.prune()
  }

  /** Devuelve true si la huella es NUEVA (y la registra); false si es replay. */
  public register(fingerprint: string): boolean {
    const now = Date.now()
    try {
      this.db.prepare('INSERT INTO webhook_replay (fingerprint, seen_at) VALUES (?, ?)').run(fingerprint, now)
    } catch {
      return false
    }
    this.prune()
    return true
  }

  private prune(): void {
    const cutoff = Date.now() - REPLAY_TTL_MS
    this.db.prepare('DELETE FROM webhook_replay WHERE seen_at < ?').run(cutoff)
  }
}

export interface HmacCheckResult {
  ok: boolean
  status: number
  error?: string
}

/** Verificación dura de webhook v2: HMAC sobre timestamp.body + ventana + anti-replay persistente. */
export function checkWebhookSecurity(
  rawBody: string,
  signature: string | undefined,
  timestamp: string | undefined,
  secret: string | undefined,
  replay: { register: (fingerprint: string) => boolean },
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
  const presented = signature.trim().replace(/^v2=/i, '')
  const expected = computeHmacV2(secret, timestamp, rawBody)
  if (!safeEqual(expected, presented)) {
    return { ok: false, status: 401, error: 'Firma HMAC inválida' }
  }
  if (!replay.register(replayFingerprint(timestamp, expected))) {
    return { ok: false, status: 401, error: 'Petición duplicada (replay detectado)' }
  }
  return { ok: true, status: 200 }
}

// ===========================================================================
// SECRETOS DE LEADS POR ORGANIZACIÓN (contrato §3)
// ===========================================================================

export interface LeadSecretBinding {
  orgId: string
  secret: string
}

/** Parsea WEBHOOK_LEAD_SECRETS="orgId:secreto,orgId:secreto". */
export function parseWebhookLeadSecrets(raw: string | undefined): LeadSecretBinding[] {
  if (!raw) return []
  const out: LeadSecretBinding[] = []
  for (const part of raw.split(',')) {
    const trimmed = part.trim()
    const idx = trimmed.indexOf(':')
    if (idx <= 0) continue
    const orgId = trimmed.slice(0, idx)
    const secret = trimmed.slice(idx + 1)
    if (!orgId || !secret || !/^[a-zA-Z0-9_-]{1,64}$/.test(orgId) || secret.length < 16) continue
    out.push({ orgId, secret })
  }
  return out
}

export interface WebhookLeadVerification {
  ok: boolean
  status: number
  error?: string
  /** Organización vinculada al secreto que validó la firma. */
  orgId?: string
}

/**
 * Verificación v2 de la ingesta de leads con VINCULACIÓN de organización por secreto.
 * Con WEBHOOK_LEAD_SECRETS configurado: el secreto válido VINCULA la org (contrato §3).
 * Con solo el legado WEBHOOK_LEAD_SECRET: vincula ÚNICAMENTE la org "default".
 */
export function verifyWebhookLead(
  rawBody: string,
  signature: string | undefined,
  timestamp: string | undefined,
  options: {
    perOrgSecrets: LeadSecretBinding[]
    legacySecret?: string
    replay: { register: (fingerprint: string) => boolean }
    now?: number
  },
): WebhookLeadVerification {
  const { perOrgSecrets, legacySecret, replay, now } = options
  if (perOrgSecrets.length === 0 && !legacySecret) {
    return { ok: false, status: 503, error: 'Service Unavailable: secreto de webhook de leads no configurado' }
  }
  if (!signature || !timestamp) {
    return { ok: false, status: 401, error: 'Firma HMAC y timestamp son obligatorios' }
  }
  const reqTime = Number(timestamp) || new Date(timestamp).getTime()
  if (!Number.isFinite(reqTime) || Math.abs((now ?? Date.now()) - reqTime) > TIMESTAMP_WINDOW_MS) {
    return { ok: false, status: 401, error: 'Timestamp expirado o fuera de ventana de tolerancia (replay protection)' }
  }
  const presented = signature.trim().replace(/^v2=/i, '')
  for (const binding of perOrgSecrets) {
    const expected = computeHmacV2(binding.secret, timestamp, rawBody)
    if (safeEqual(expected, presented)) {
      if (!replay.register(replayFingerprint(timestamp, expected))) {
        return { ok: false, status: 401, error: 'Petición duplicada (replay detectado)' }
      }
      return { ok: true, status: 200, orgId: binding.orgId }
    }
  }
  if (legacySecret) {
    const expected = computeHmacV2(legacySecret, timestamp, rawBody)
    if (safeEqual(expected, presented)) {
      if (!replay.register(replayFingerprint(timestamp, expected))) {
        return { ok: false, status: 401, error: 'Petición duplicada (replay detectado)' }
      }
      return { ok: true, status: 200, orgId: 'default' }
    }
  }
  return { ok: false, status: 401, error: 'Firma HMAC inválida' }
}

// ===========================================================================
// IDEMPOTENCIA PERSISTENTE DE EVENTOS (contrato §3): clave orgId::eventId, purga 7 días
// ===========================================================================

export type EventClaim = 'new' | 'duplicate'

export class EventIdempotencyStore {
  private db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  /** Reclamación atómica: 'new' ⇒ este llamador ejecuta la operación; 'duplicate' ⇒ ya reclamado. */
  public claim(orgId: string, eventId: string): EventClaim {
    try {
      const res = this.db.prepare('INSERT OR IGNORE INTO event_idempotency (key, claimed_at) VALUES (?, ?)').run(`${orgId}::${eventId}`, Date.now())
      return res.changes > 0 ? 'new' : 'duplicate'
    } catch {
      // Fail-closed: si la reclamación no puede persistirse, el evento se trata como duplicado
      // (jamás se ejecuta dos veces una operación con efectos externos por un fallo de BD).
      return 'duplicate'
    }
  }

  public purge(): void {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    try {
      this.db.prepare('DELETE FROM event_idempotency WHERE claimed_at < ?').run(cutoff)
    } catch { /* la purga jamás rompe el tráfico */ }
  }
}

// ===========================================================================
// RATE LIMITING (contrato §7) y utilidades
// ===========================================================================

export interface RateLimitResult {
  allowed: boolean
  retryAfterSec: number
}

export class RateLimiter {
  private hits = new Map<string, number[]>()

  public check(key: string, limit: number, windowMs: number = 60_000): RateLimitResult {
    const now = Date.now()
    const arr = (this.hits.get(key) || []).filter((t) => now - t < windowMs)
    if (arr.length >= limit) {
      this.hits.set(key, arr)
      const oldest = arr[0] || now
      const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000))
      return { allowed: false, retryAfterSec }
    }
    arr.push(now)
    this.hits.set(key, arr)
    return { allowed: true, retryAfterSec: 0 }
  }
}

/** IP del cliente: x-forwarded-for solo con TRUST_PROXY==='true' (contrato §7). */
export function clientIp(req: import('node:http').IncomingMessage): string {
  if (process.env.TRUST_PROXY === 'true') {
    const xff = req.headers['x-forwarded-for']
    if (typeof xff === 'string' && xff.length > 0) {
      return xff.split(',')[0].trim()
    }
  }
  return req.socket.remoteAddress || 'unknown'
}

/** Enmascara un teléfono para logs. */
export function maskPhone(phone: string): string {
  const clean = String(phone || '')
  if (clean.length <= 4) return '***'
  return `${clean.slice(0, 4)}****${clean.slice(-2)}`
}

export const MAX_BODY_BYTES = 1_048_576
const DRAIN_LIMIT_BYTES = 8 * 1_048_576

export type ReadBodyResult = { ok: true; body: string } | { ok: false; tooLarge?: boolean; streamError?: boolean }

/** Lee el body con tope; 413 si excede (drenando con tope); error de stream ⇒ rechazo. */
export function readBody(req: import('node:http').IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<ReadBodyResult> {
  return new Promise((resolve) => {
    let body = ''
    let size = 0
    let drained = 0
    let rejected = false
    let finished = false
    const settle = (r: ReadBodyResult) => { if (!finished) { finished = true; resolve(r) } }
    req.on('data', (chunk: Buffer) => {
      if (rejected) {
        drained += chunk.length
        if (drained > DRAIN_LIMIT_BYTES) { req.destroy(); settle({ ok: false, tooLarge: true }) }
        return
      }
      size += chunk.length
      if (size > maxBytes) {
        rejected = true
        settle({ ok: false, tooLarge: true })
        return
      }
      body += chunk
    })
    req.on('end', () => {
      if (rejected) { req.destroy(); settle({ ok: false, tooLarge: true }); return }
      settle({ ok: true, body })
    })
    req.on('error', () => {
      // Un error de stream JAMÁS se procesa como éxito con cuerpo parcial.
      settle({ ok: false, streamError: true })
    })
  })
}

/**
 * Guard fail-fast de producción para ULTRA (nombra variables, jamás valores).
 * Contrato §3: en producción se EXIGEN secretos de leads POR ORGANIZACIÓN.
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

  if (!env.WEBHOOK_LEAD_SECRETS) {
    problems.push('WEBHOOK_LEAD_SECRETS: ausente (en producción se EXIGEN secretos de leads por organización "orgId:secreto,..." — contrato §3)')
  } else if (parseWebhookLeadSecrets(env.WEBHOOK_LEAD_SECRETS).length === 0) {
    problems.push('WEBHOOK_LEAD_SECRETS: sin entradas válidas (formato "orgId:secreto,..." con secretos de 16+ caracteres)')
  }
  if (env.WEBHOOK_LEAD_SECRET) {
    if (env.WEBHOOK_LEAD_SECRET.length < 24) {
      problems.push('WEBHOOK_LEAD_SECRET (legado): demasiado corto (mínimo 24 caracteres)')
    } else {
      for (const w of weakDefaults) {
        if (env.WEBHOOK_LEAD_SECRET.toLowerCase().includes(w.toLowerCase())) { problems.push('WEBHOOK_LEAD_SECRET (legado): contiene un valor débil o publicado conocido'); break }
      }
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
