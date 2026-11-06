/**
 * security.ts — Primitivas de seguridad de Capa 2B / WHATSPOWER-ULTRA
 * (orden de cierre 2026-11-06 — prioridad máxima por riesgo de despacho real)
 * (reparación integral 2026-11-06 — contrato HMAC v2 + anti-replay durable)
 *
 * Modelo de identidad:
 *  - ADMIN_API_KEYS="clave:organizationId,clave2:organizationId2,claveServicio"
 *    * clave con ":org"  → identidad LIGADA a esa organización (nunca puede operar otras).
 *    * clave sin ":org"  → identidad de servicio (admin total, puede fijar organizationId).
 *  - organizationId de creación SIEMPRE desde la identidad ligada; el del body se ignora
 *    para identidades ligadas y se rechaza si contradice.
 *  - Fail-closed: sin ADMIN_API_KEYS no hay acceso administrativo.
 *
 * Contrato HMAC de webhooks (v2 — reparación integral):
 *  - canonical = `${orgId}.${timestamp}.${rawBody}` (orgId vacío cuando no aplica).
 *  - X-Signature-Sha256 = hex(HMAC-SHA256(secreto, canonical)).
 *  - El timestamp queda LIGADO a la firma: no puede sustituirse sin romperla
 *    (cierra el replay con timestamp fresco de la v1).
 *  - fingerprint de replay incluye la organización: el mismo cuerpo+timestamp
 *    firmado por organizaciones distintas NO colisiona.
 *  - Secretos por organización: WEBHOOK_LEAD_SECRETS="orgA:sec,orgB:sec2|sec2antigua".
 *    El segmento tras "|" es el secreto previo, aceptado solo durante rotación.
 *  - WEBHOOK_LEAD_SECRET (v1, un solo secreto) sigue aceptado y queda ligado a la
 *    organización reservada "_legacy"; NO permite leads ligados a campañas.
 *  - Anti-replay durable: DurableReplayCache (SQLite) — sobrevive reinicios del
 *    proceso y sirve varias réplicas que compartan el mismo archivo.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { DatabaseSync, StatementSync } from 'node:sqlite'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))

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

/**
 * DurableReplayCache — anti-replay persistente (reparación integral 2026-11-06).
 * - SQLite (node:sqlite), tabla replay_seen(fingerprint PRIMARY KEY, expires_at).
 * - Sobrevive reinicios del proceso y sirve varias réplicas que compartan archivo.
 * - La inserción atómica por PRIMARY KEY cierra la carrera entre réplicas.
 * - Fail-fast: si el archivo no puede abrirse, el constructor lanza (no degrada en silencio).
 * - ':memory:' para tests.
 */
export class DurableReplayCache {
  private db: DatabaseSync
  private insertStmt: StatementSync
  private touchStmt: StatementSync
  private getStmt: StatementSync
  private pruneStmt: StatementSync

  constructor(path?: string) {
    const target = path ?? process.env.REPLAY_DB_PATH ?? join(__dirname, '..', 'db', 'replay-cache.db')
    if (target !== ':memory:') mkdirSync(dirname(target), { recursive: true })
    this.db = new DatabaseSync(target)
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS replay_seen (
        fingerprint TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
    `)
    this.insertStmt = this.db.prepare('INSERT INTO replay_seen (fingerprint, expires_at) VALUES (?, ?)')
    this.touchStmt = this.db.prepare('INSERT OR REPLACE INTO replay_seen (fingerprint, expires_at) VALUES (?, ?)')
    this.getStmt = this.db.prepare('SELECT expires_at FROM replay_seen WHERE fingerprint = ?')
    this.pruneStmt = this.db.prepare('DELETE FROM replay_seen WHERE expires_at < ?')
  }

  public register(fingerprint: string, ttlMs: number = TIMESTAMP_WINDOW_MS * 2): boolean {
    const now = Date.now()
    const expiresAt = now + ttlMs
    try {
      this.insertStmt.run(fingerprint, expiresAt)
      return true
    } catch {
      // Ya existía la huella (INSERT atómico serializado por PRIMARY KEY)
      const row = this.getStmt.get(fingerprint) as { expires_at: number } | undefined
      if (row && row.expires_at > now) return false
      // Expirada: se reemplaza y se acepta como nueva
      this.touchStmt.run(fingerprint, expiresAt)
      return true
    } finally {
      this.pruneStmt.run(now)
    }
  }

  public get size(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM replay_seen').get() as { n: number }
    return row.n
  }

  public close(): void {
    this.db.close()
  }
}

export interface HmacCheckResult {
  ok: boolean
  status: number
  error?: string
}

/**
 * Firma canonical v2: HMAC-SHA256 sobre `${orgId}.${timestamp}.${rawBody}`.
 * El timestamp y la organización quedan ligados criptográficamente a la firma.
 */
export function signWebhookPayload(timestamp: string | number, rawBody: string, secret: string, org: string = ''): string {
  const canonical = `${org ? org + '.' : ''}${String(timestamp)}.${rawBody}`
  return createHmac('sha256', secret).update(canonical).digest('hex')
}

/** Expande "actual|previo" en lista de secretos válidos (rotación sin interrupción). */
export function expandSecretEntry(entry: string): string[] {
  return entry.split('|').map((s) => s.trim()).filter(Boolean)
}

/**
 * Verificación dura de webhook v2: HMAC obligatorio (ligado a timestamp y organización)
 * + ventana de tolerancia + anti-replay. Acepta varios secretos (rotación) probando
 * cada uno con comparación timing-safe.
 * - secrets: undefined/empty → 503 fail-closed (nunca acepta sin secreto).
 * - org: organiza la firma y el fingerprint de replay (sin colisión cross-org).
 */
export function checkWebhookSecurity(
  rawBody: string,
  signature: string | undefined,
  timestamp: string | undefined,
  secrets: string | string[] | undefined,
  replay: ReplayCache | DurableReplayCache,
  now: number = Date.now(),
  org: string = '',
): HmacCheckResult {
  const secretList = (Array.isArray(secrets) ? secrets : [secrets])
    .flatMap((s) => (typeof s === 'string' ? expandSecretEntry(s) : []))
    .filter(Boolean)
  if (secretList.length === 0) {
    return { ok: false, status: 503, error: 'Service Unavailable: secreto de webhook no configurado' }
  }
  if (!signature || !timestamp) {
    return { ok: false, status: 401, error: 'Firma HMAC y timestamp son obligatorios' }
  }
  const reqTime = Number(timestamp) || new Date(timestamp).getTime()
  if (!Number.isFinite(reqTime) || Math.abs(now - reqTime) > TIMESTAMP_WINDOW_MS) {
    return { ok: false, status: 401, error: 'Timestamp expirado o fuera de ventana de tolerancia (replay protection)' }
  }
  let matched: string | null = null
  for (const secret of secretList) {
    const expected = signWebhookPayload(timestamp, rawBody, secret, org)
    if (safeEqual(expected, signature)) {
      matched = expected
      break
    }
  }
  if (!matched) {
    return { ok: false, status: 401, error: 'Firma HMAC inválida' }
  }
  if (!replay.register(`${org}\u0000${reqTime}:${matched}`)) {
    return { ok: false, status: 401, error: 'Petición duplicada (replay detectado)' }
  }
  return { ok: true, status: 200 }
}

export interface LeadSecretSpec {
  /** org → entradas de secreto ("actual" o "actual|previo") */
  byOrg: Map<string, string[]>
}

/** Organización reservada para el secreto único v1 (WEBHOOK_LEAD_SECRET). */
export const LEGACY_LEAD_ORG = '_legacy'

/**
 * Parsea WEBHOOK_LEAD_SECRETS="orgA:sec,orgB:sec2|sec2prev" y, como fallback,
 * WEBHOOK_LEAD_SECRET="sec" → org reservada "_legacy". Nunca lanza; devuelve vacío
 * si no hay nada configurado (las capas superiores deciden el fail-closed).
 */
export function parseLeadSecretSpec(env: NodeJS.ProcessEnv = process.env): LeadSecretSpec {
  const byOrg = new Map<string, string[]>()
  const spec = env.WEBHOOK_LEAD_SECRETS
  if (spec) {
    for (const entry of spec.split(',')) {
      const trimmed = entry.trim()
      if (!trimmed) continue
      const idx = trimmed.indexOf(':')
      if (idx <= 0) continue
      const org = trimmed.slice(0, idx).trim()
      const secretPart = trimmed.slice(idx + 1).trim()
      if (!org || !secretPart) continue
      byOrg.set(org, [secretPart])
    }
  }
  if (byOrg.size === 0 && env.WEBHOOK_LEAD_SECRET) {
    byOrg.set(LEGACY_LEAD_ORG, [env.WEBHOOK_LEAD_SECRET])
  }
  return { byOrg }
}

/** Secretos válidos para una organización, o null si la org es desconocida. */
export function resolveLeadSecrets(spec: LeadSecretSpec, org: string): string[] | null {
  const entries = spec.byOrg.get(org)
  if (!entries || entries.length === 0) return null
  return entries
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

/** Validación de fortaleza de un secreto de webhook (sin exponer el valor). */
function leadSecretStrengthProblems(name: string, entry: string, weakDefaults: string[]): string[] {
  const problems: string[] = []
  for (const candidate of expandSecretEntry(entry)) {
    if (candidate.length < 24) {
      problems.push(`${name}: contiene un secreto de menos de 24 caracteres`)
      continue
    }
    for (const w of weakDefaults) {
      if (candidate.toLowerCase().includes(w.toLowerCase())) {
        problems.push(`${name}: contiene un valor débil o publicado conocido`)
        break
      }
    }
  }
  return problems
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

  if (!env.WEBHOOK_LEAD_SECRETS && !env.WEBHOOK_LEAD_SECRET) {
    problems.push('WEBHOOK_LEAD_SECRETS/WEBHOOK_LEAD_SECRET: ausentes (la ingesta de leads exige firma HMAC fail-closed)')
  } else {
    if (env.WEBHOOK_LEAD_SECRETS) {
      const spec = parseLeadSecretSpec(env)
      if (spec.byOrg.size === 0) {
        problems.push('WEBHOOK_LEAD_SECRETS: presente pero sin entradas válidas (formato "org:secreto[|secretoPrevio]")')
      }
      for (const [org, entries] of spec.byOrg) {
        for (const entry of entries) {
          for (const p of leadSecretStrengthProblems(`WEBHOOK_LEAD_SECRETS[${org}]`, entry, weakDefaults)) problems.push(p)
        }
      }
    }
    if (env.WEBHOOK_LEAD_SECRET) {
      for (const p of leadSecretStrengthProblems('WEBHOOK_LEAD_SECRET', env.WEBHOOK_LEAD_SECRET, weakDefaults)) problems.push(p)
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

// ============================================================================
// SESIÓN DE STUDIO POR COOKIE HttpOnly (segunda reparación — orden §4.A)
//
// Causa raíz corregida: el Studio guardaba el secreto administrativo en
// sessionStorage — cualquier XSS leía la credencial completa. Ahora el
// navegador canjea el secreto UNA vez por una cookie de sesión:
//   - HttpOnly  → invisible para JavaScript (un XSS NO puede exfiltrarla);
//   - SameSite=Strict → no viaja en navegaciones cruzadas;
//   - corta vida (1 h) y token HMAC stateless ligado al secreto vigente:
//     rotar el secreto revoca todas las sesiones al instante.
// El patrón preferido es "backend entrega sesión, no credenciales": el
// secreto de larga vida jamás vuelve a tocar el navegador.
// ============================================================================


export const STUDIO_SESSION_COOKIE = 'wp_ultra_studio_session'
export const STUDIO_SESSION_TTL_SECONDS = 3600

/** Firma stateless: HMAC(secret_vigente, `${orgIndex}.${issuedAtMs}`). */
function studioSessionToken(secret: string, orgIndex: number, issuedAtMs: number): string {
  return createHmac('sha256', secret).update(`${orgIndex}.${issuedAtMs}`).digest('base64url')
}

/**
 * Emite el valor de la cookie de sesión para una identidad admin (por índice).
 * El token NO contiene el secreto: solo el índice de identidad + iat + firma.
 */
export function issueStudioSession(identityIndex: number, secret: string, nowMs: number = Date.now()): string {
  const token = `${identityIndex}.${nowMs}.${studioSessionToken(secret, identityIndex, nowMs)}`
  return `${STUDIO_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${STUDIO_SESSION_TTL_SECONDS}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`
}

/**
 * Verifica la cookie de sesión contra las identidades vigentes.
 * Devuelve la identidad si el token es válido, reciente (≤ TTL) y la firma
 * corresponde al secreto ACTUAL (rotación de secreto ⇒ revocación total).
 */
export function resolveStudioSession(cookieHeader: string | undefined, adminKeys: AdminIdentity[], nowMs: number = Date.now()): AdminIdentity | null {
  if (!cookieHeader) return null
  const cookies = cookieHeader.split(';').map((c) => c.trim())
  const raw = cookies.find((c) => c.startsWith(`${STUDIO_SESSION_COOKIE}=`))
  if (!raw) return null
  const token = raw.slice(STUDIO_SESSION_COOKIE.length + 1)
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [idxStr, iatStr, sig] = parts
  const idx = Number.parseInt(idxStr, 10)
  const iat = Number.parseInt(iatStr, 10)
  if (!Number.isInteger(idx) || idx < 0 || idx >= adminKeys.length || !Number.isFinite(iat)) return null
  if (nowMs - iat > STUDIO_SESSION_TTL_SECONDS * 1000) return null
  const identity = adminKeys[idx]
  const expected = studioSessionToken(identity.key, idx, iat)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  return identity
}
