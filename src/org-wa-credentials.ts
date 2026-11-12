/**
 * org-wa-credentials.ts — Registro de conexiones y credenciales Meta POR
 * ORGANIZACIÓN (OLEADA 2, decisión de negocio 2026-11-11).
 *
 * DECISIÓN CLAVE: ULTRA (Capa 3) JAMÁS usa credenciales globales de Meta para
 * las campañas. Cada despacho se ejecuta con el token y el número de la
 * organización dueña de la campaña (puntos 2, 6, 7 y 8 de la decisión).
 * La credencial global META_ACCESS_TOKEN deja de ser una vía de envío: si una
 * organización no tiene conexión propia, su campaña NO despacha (fail-closed)
 * y las demás organizaciones siguen operativas (punto 9).
 *
 * Fuentes de verdad (en orden de prioridad):
 *  - META_ORG_CREDENTIALS="orgId:phoneId:token,..." (standalone; solo memoria)
 *  - CRM_INTERNAL_CREDENTIALS="orgId:secreto,..." (vía CRM, administrador de
 *    conexiones): cada org se consulta autenticada CON SU credencial de
 *    servicio (contrato §1); el token vuelve en claro por canal autenticado y
 *    se mantiene SOLO en memoria con TTL (nunca en disco ni logs).
 *  - META_ORG_NUMBERS="orgId:phoneId,..." como índice de identidad standalone.
 *
 * Mismo contrato que WHATSPOWER (Capa 2A): la identidad de organización es la
 * MISMA en los tres módulos (CRM → WHATSPOWER → ULTRA).
 */
import { timingSafeEqual } from 'node:crypto'
import { safeEqual } from './security.ts'

export interface OrgConnection {
  organizationId: string
  connectionId: string | null
  phoneNumberId: string
  phoneNumber: string | null
  wabaId: string | null
}

export interface OrgCredential {
  organizationId: string
  phoneNumberId: string
  connectionId: string | null
  accessToken: string
  /** Expiración de la caché EN MEMORIA (epoch ms). Nunca persistido. */
  cachedUntil: number
}

export interface OrgWaSource {
  listForOrg(orgId: string): Promise<OrgConnection[]>
  resolveCredential(orgId: string, phoneNumberId: string): Promise<Pick<OrgCredential, 'accessToken' | 'connectionId' | 'phoneNumberId'> | null>
}

// ===========================================================================
// Utilidades de parseo (misma disciplina que org-credentials.ts B3)
// ===========================================================================

function timingSafeEqualStrings(a: string, b: string): boolean {
  return safeEqual(a, b)
}

export function parseOrgNumbers(raw: string | undefined): Array<{ orgId: string; phoneNumberId: string }> {
  const out: Array<{ orgId: string; phoneNumberId: string }> = []
  if (!raw) return out
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf(':')
    if (idx <= 0) continue
    const orgId = pair.slice(0, idx).trim()
    const phoneNumberId = pair.slice(idx + 1).trim()
    if (orgId && phoneNumberId && /^[A-Za-z0-9_-]{1,64}$/.test(orgId)) out.push({ orgId, phoneNumberId })
  }
  return out
}

export interface EnvTriple { orgId: string; phoneNumberId: string; accessToken: string }

export function parseOrgCredentialTriples(raw: string | undefined): EnvTriple[] {
  const out: EnvTriple[] = []
  if (!raw) return out
  for (const triple of raw.split(',')) {
    const parts = triple.split(':')
    if (parts.length !== 3) continue
    const [orgId, phoneNumberId, accessToken] = parts.map((s) => s.trim())
    if (!orgId || !phoneNumberId || !accessToken || accessToken.length < 16) continue
    if (orgId === '__legacy__') continue // espacio RESERVADO (contrato §4)
    out.push({ orgId, phoneNumberId, accessToken })
  }
  return out
}

export function parseOrgServiceCredentials(raw: string | undefined): Array<{ orgId: string; secret: string }> {
  const out: Array<{ orgId: string; secret: string }> = []
  if (!raw) return out
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf(':')
    if (idx <= 0) continue
    const orgId = pair.slice(0, idx).trim()
    const secret = pair.slice(idx + 1).trim()
    if (!orgId || !secret || secret.length < 16) continue
    if (orgId === '__legacy__') continue
    out.push({ orgId, secret })
  }
  return out
}

// ===========================================================================
// Fuente ENV (standalone)
// ===========================================================================

export class EnvOrgWaSource implements OrgWaSource {
  private triples: EnvTriple[]
  private numbers: Array<{ orgId: string; phoneNumberId: string }>

  constructor(config?: { metaOrgCredentials?: string; metaOrgNumbers?: string }) {
    this.triples = parseOrgCredentialTriples(config?.metaOrgCredentials ?? process.env.META_ORG_CREDENTIALS)
    this.numbers = parseOrgNumbers(config?.metaOrgNumbers ?? process.env.META_ORG_NUMBERS)
  }

  async listForOrg(orgId: string): Promise<OrgConnection[]> {
    const fromTriples = this.triples.filter((t) => timingSafeEqualStrings(t.orgId, orgId)).map((t) => t.phoneNumberId)
    const fromNumbers = this.numbers.filter((n) => timingSafeEqualStrings(n.orgId, orgId)).map((n) => n.phoneNumberId)
    const phoneIds = [...new Set([...fromTriples, ...fromNumbers])]
    return phoneIds.map((phoneNumberId) => ({
      organizationId: orgId,
      connectionId: null,
      phoneNumberId,
      phoneNumber: null,
      wabaId: null,
    }))
  }

  async resolveCredential(orgId: string, phoneNumberId: string) {
    const entry = this.triples.find((t) => timingSafeEqualStrings(t.orgId, orgId) && timingSafeEqualStrings(t.phoneNumberId, phoneNumberId))
    return entry
      ? { accessToken: entry.accessToken, connectionId: null, phoneNumberId: entry.phoneNumberId }
      : null
  }
}

// ===========================================================================
// Fuente CRM (administrador de conexiones — una credencial de servicio POR org)
// ===========================================================================

export class CrmOrgWaSource implements OrgWaSource {
  private credentialsByOrg: Map<string, string>

  constructor(credentialsByOrg?: Array<{ orgId: string; secret: string }>) {
    const raw = credentialsByOrg ?? parseOrgServiceCredentials(process.env.CRM_INTERNAL_CREDENTIALS)
    if (raw.length === 0) {
      throw new Error('CrmOrgWaSource exige credenciales de servicio por organización (CRM_INTERNAL_CREDENTIALS="orgId:secreto,...")')
    }
    this.credentialsByOrg = new Map(raw.map((c) => [c.orgId, c.secret]))
  }

  private async crmGet(orgId: string, url: string): Promise<Response | null> {
    const secret = this.credentialsByOrg.get(orgId)
    if (!secret) return null // la org sin credencial declarada NO se consulta
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    try {
      return await fetch(url, {
        headers: { Authorization: `Bearer ${secret}` },
        signal: controller.signal,
      })
    } catch {
      return null // CRM caído: fail-closed en el llamador
    } finally {
      clearTimeout(timer)
    }
  }

  async listForOrg(orgId: string): Promise<OrgConnection[]> {
    const base = process.env.CRM_BASE_URL || 'http://localhost:3000'
    const res = await this.crmGet(orgId, `${base}/api/internal/whatsapp/credentials`)
    if (!res || !res.ok) return []
    const body = (await res.json().catch(() => null)) as {
      organizationId?: string
      connections?: Array<{ id: string; phoneNumberId: string; phoneNumber: string; wabaId: string | null }>
    } | null
    // Verificación de identidad: el CRM confirma la org de lo entregado.
    if (!body || !body.organizationId || !timingSafeEqualStrings(body.organizationId, orgId)) return []
    return (body.connections ?? []).map((c) => ({
      organizationId: orgId,
      connectionId: c.id,
      phoneNumberId: c.phoneNumberId,
      phoneNumber: c.phoneNumber,
      wabaId: c.wabaId,
    }))
  }

  async resolveCredential(orgId: string, phoneNumberId: string) {
    const base = process.env.CRM_BASE_URL || 'http://localhost:3000'
    const res = await this.crmGet(orgId, `${base}/api/internal/whatsapp/credentials?phoneNumberId=${encodeURIComponent(phoneNumberId)}`)
    if (!res || !res.ok) return null
    const body = (await res.json().catch(() => null)) as {
      organizationId?: string
      connectionId?: string
      phoneNumberId?: string
      accessToken?: string
    } | null
    if (!body?.accessToken || !body.organizationId || !timingSafeEqualStrings(body.organizationId, orgId)) return null
    return { accessToken: body.accessToken, connectionId: body.connectionId ?? null, phoneNumberId: body.phoneNumberId ?? phoneNumberId }
  }
}

// ===========================================================================
// Registro con caché en memoria (tokens con TTL — nunca en disco)
// ===========================================================================

const TOKEN_TTL_MS = 5 * 60 * 1000
const IDENTITY_TTL_MS = 60 * 1000

export class OrgWaCredentialRegistry {
  private sources: OrgWaSource[]
  private identityCache = new Map<string, { connections: OrgConnection[]; cachedUntil: number }>()
  private credentialCache = new Map<string, { credential: OrgCredential }>()

  constructor(sources?: OrgWaSource[]) {
    this.sources = sources ?? [
      new EnvOrgWaSource(),
      ...(process.env.CRM_INTERNAL_CREDENTIALS ? [new CrmOrgWaSource()] : []),
    ]
  }

  invalidate(): void {
    this.identityCache.clear()
    this.credentialCache.clear()
  }

  /** Números conectados de UNA organización (caché 60s). */
  async listForOrg(orgId: string): Promise<OrgConnection[]> {
    const now = Date.now()
    const cached = this.identityCache.get(orgId)
    if (cached && cached.cachedUntil > now) return cached.connections
    const connections: OrgConnection[] = []
    for (const source of this.sources) {
      try {
        connections.push(...await source.listForOrg(orgId))
      } catch {
        // fuente caída: se acumula solo lo válido; sin fuentes → [] (fail-closed)
      }
    }
    this.identityCache.set(orgId, { connections, cachedUntil: now + IDENTITY_TTL_MS })
    return connections
  }

  /** Credencial de UNA organización para UN número (caché en memoria 5 min). */
  async resolveCredential(orgId: string, phoneNumberId: string): Promise<OrgCredential | null> {
    const cacheKey = `${orgId}::${phoneNumberId}`
    const cached = this.credentialCache.get(cacheKey)
    if (cached && cached.credential.cachedUntil > Date.now()) return cached.credential
    for (const source of this.sources) {
      try {
        const resolved = await source.resolveCredential(orgId, phoneNumberId)
        if (resolved) {
          const credential: OrgCredential = {
            organizationId: orgId,
            phoneNumberId: resolved.phoneNumberId,
            connectionId: resolved.connectionId,
            accessToken: resolved.accessToken,
            cachedUntil: Date.now() + TOKEN_TTL_MS,
          }
          this.credentialCache.set(cacheKey, { credential })
          return credential
        }
      } catch {
        // fuente caída → siguiente; sin fuentes válidas → null (fail-closed)
      }
    }
    return null
  }
}
