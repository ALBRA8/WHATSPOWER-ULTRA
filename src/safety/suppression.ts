import type { DatabaseSync } from 'node:sqlite'
import type { SuppressionChecker } from '../types.ts'
import { resolveOrgServiceCredential } from '../org-credentials.ts'

/**
 * POLÍTICA DE SUPRESIÓN (tercera reparación 5.B — decisión documentada):
 *
 *   POR ORGANIZACIÓN por defecto: la baja (opt-out) de un contacto vale para
 *   la organización con la que mantuvo la relación comercial. La lista global
 *   quedó PROHIBIDA como modelo por defecto porque mezclaba silenciosamente
 *   organizaciones distintas y exponía la existencia de contactos entre ellas.
 *
 *   COMPLEMENTO GLOBAL RESTRINGIDO y AUDITABLE: existe `global_suppression_list`
 *   SOLO para requisitos legales/regulatorios documentados (p. ej. bloqueos
 *   regulatorios, números extintos administrativos). Se gestiona por operación
 *   explícita (addGlobalSuppression), queda con motivo y fecha, y jamás se
 *   alimenta de datos de una organización concreta.
 *
 *   MIGRACIÓN CONSERVADORA: los opt-outs previos a la v4 eran GLOBALES sin
 *   organización conocida. Reasignarlos a una org inventaría atribución
 *   (prohibido); borrarlos rompería una solicitud legal de no-contacto.
 *   Decisión conservadora: se copian a `global_suppression_list` con motivo
 *   'migrado_v4: opt-out previo al aislamiento (política conservadora)' — el
 *   contacto NO vuelve a recibir mensajes de nadie; cada org puede además
 *   gestionar sus propias bajas por organización.
 *
 *   Gestión: docs/POLITICA-SUPRESION.md (sección 5.B del informe de tercera fase).
 */
export const LEGACY_MIGRATION_REASON = 'migrado_v4: opt-out previo al aislamiento (política conservadora)'

export class LocalSuppressionStore implements SuppressionChecker {
  db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  async isSuppressed(phone: string, organizationId: string): Promise<boolean> {
    if (!organizationId) {
      // Fail-closed: sin organización no hay respuesta válida
      throw new Error('TENANT_CONTEXT_INVALID: isSuppressed exige organizationId')
    }
    const orgRow = this.db.prepare('SELECT phone FROM suppression_list WHERE organization_id = ? AND phone = ?').get(organizationId, phone)
    if (orgRow) return true
    // Lista global restringida (requisitos legales documentados)
    const globalRow = this.db.prepare('SELECT phone FROM global_suppression_list WHERE phone = ?').get(phone)
    return Boolean(globalRow)
  }

  /** Baja POR ORGANIZACIÓN (5.B — política por defecto). */
  async addSuppression(organizationId: string, phone: string, reason: string = 'opt_out'): Promise<void> {
    if (!organizationId) throw new Error('TENANT_CONTEXT_INVALID: addSuppression exige organizationId')
    this.db.prepare(`
      INSERT INTO suppression_list (organization_id, phone, reason, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(organization_id, phone) DO UPDATE SET
        reason = excluded.reason,
        created_at = excluded.created_at
    `).run(organizationId, phone, reason, Math.floor(Date.now() / 1000))
  }

  /** Alta en la lista GLOBAL restringida (solo requisitos legales documentados; auditable). */
  addGlobalSuppression(phone: string, reason: string): void {
    if (!reason || reason.trim().length < 8) {
      throw new Error('GLOBAL_SUPPRESSION_REQUIRES_DOCUMENTED_REASON: la lista global exige un motivo documentado (mín. 8 caracteres)')
    }
    this.db.prepare(`
      INSERT INTO global_suppression_list (phone, reason, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET reason = excluded.reason
    `).run(phone, reason, Math.floor(Date.now() / 1000))
  }

  /** Re-activa a un contacto SOLO para la organización que lo pide (la global NO se toca aquí). */
  async removeSuppression(organizationId: string, phone: string): Promise<void> {
    if (!organizationId) throw new Error('TENANT_CONTEXT_INVALID: removeSuppression exige organizationId')
    this.db.prepare('DELETE FROM suppression_list WHERE organization_id = ? AND phone = ?').run(organizationId, phone)
  }

  /** Listado por organización (jamás cruza organizaciones). */
  listForOrg(organizationId: string): Array<{ phone: string; reason: string; createdAt: number }> {
    const rows = this.db.prepare('SELECT phone, reason, created_at FROM suppression_list WHERE organization_id = ? ORDER BY created_at DESC').all(organizationId) as any[]
    return rows.map((r) => ({ phone: r.phone, reason: r.reason, createdAt: r.created_at }))
  }
}

export class Http2ASuppressionChecker implements SuppressionChecker {
  baseUrl: string
  timeoutMs: number

  constructor(options?: { baseUrl?: string; timeoutMs?: number }) {
    this.baseUrl = options?.baseUrl || (process.env.AGENTIC_2A_URL?.replace('/api/inbound', '') || 'http://localhost:3003')
    this.timeoutMs = options?.timeoutMs || 1500
  }

  async isSuppressed(phone: string, organizationId: string): Promise<boolean> {
    if (!organizationId) {
      // (5.A) Fail-closed de contexto: sin organización NO se pregunta (jamás se
      // asume una org por defecto ni se consulta "global")
      throw new Error('TENANT_CONTEXT_INVALID: isSuppressed exige organizationId de la campaña')
    }
    // B3: credencial de servicio VINCULADA a esta organización. Sin ella la
    // llamada NO se hace (fail-closed, sin red): el secreto global ya no
    // sustituye la validación de organización.
    const orgCredential = resolveOrgServiceCredential(organizationId)
    if (!orgCredential) {
      throw new Error(`TENANT_CREDENTIAL_MISSING: sin credencial de servicio registrada para ${organizationId} (configura WHATSPOWER_ORG_CREDENTIALS "orgId:credencial")`)
    }
    const encodedPhone = encodeURIComponent(phone)
    const url = `${this.baseUrl}/api/internal/suppression/${encodedPhone}`

    try {
      // (tercera reparación 5.A) X-Org-Id SIEMPRE presente + verificación del eco.
      // (B3) Bearer = credencial de servicio de ESTA organización (no secreto global).
      const headers: Record<string, string> = {
        'Accept': 'application/json',
        'X-Org-Id': organizationId,
        'Authorization': `Bearer ${orgCredential}`,
      }
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      })

      if (!response.ok) {
        // (5.A) Un rechazo por contexto de organización es un error de CONTRATO,
        // no una supresión legítima: se lanza con código explícito (fail-closed,
        // auditable como contractError y NO como "contacto suprimido").
        if (response.status === 400 || response.status === 403) {
          throw new Error(`TENANT_CONTEXT_REJECTED_${response.status}: Capa 2A rechazó el contexto de organización (contrato X-Org-Id)`)
        }
        throw new Error(`SUPPRESSION_CHECK_HTTP_${response.status}`)
      }

      const data = await response.json() as { phone: string; suppressed: boolean; organizationId?: string }

      // (5.A) Verificación ESTRICTA del eco de organización: sin eco o desajustado
      // → la respuesta es INCOMPATIBLE, jamás se interpreta como "no suprimido".
      if (typeof data.organizationId !== 'string' || data.organizationId.length === 0) {
        throw new Error('TENANT_UNVERIFIED: Capa 2A no confirmó la organización en la respuesta de supresión')
      }
      if (data.organizationId !== organizationId) {
        throw new Error(`TENANT_MISMATCH: Capa 2A respondió supresión para ${data.organizationId}, se consultó ${organizationId}`)
      }

      return Boolean(data.suppressed)
    } catch (err: any) {
      if (typeof err?.message === 'string' && err.message.startsWith('TENANT_')) throw err
      throw new Error(`SUPPRESSION_CHECK_UNAVAILABLE: ${err?.message || err}`)
    }
  }
}

export class CompositeSuppressionChecker implements SuppressionChecker {
  local: LocalSuppressionStore
  remote?: SuppressionChecker

  constructor(local: LocalSuppressionStore, remote?: SuppressionChecker) {
    this.local = local
    this.remote = remote
  }

  async isSuppressed(phone: string, organizationId: string): Promise<boolean> {
    if (await this.local.isSuppressed(phone, organizationId)) return true

    if (this.remote) {
      // (5.B) La sincronización remota es POR ORGANIZACIÓN: una baja de la org X
      // se guarda en el espacio LOCAL de la org X — jamás contamina otras orgs.
      const isRemoteSuppressed = await this.remote.isSuppressed(phone, organizationId)
      if (isRemoteSuppressed) {
        await this.local.addSuppression(organizationId, phone, 'synced_from_2a')
        return true
      }
    }

    return false
  }
}

export class FatigueManager {
  db: DatabaseSync
  daysThreshold: number

  constructor(db: DatabaseSync, daysThreshold: number = 7) {
    this.db = db
    this.daysThreshold = daysThreshold
  }

  /** (5.B) La fatiga es POR ORGANIZACIÓN: el descanso comercial de un contacto
   *  pertenece a la relación con ESA organización. */
  isFatigued(phone: string, organizationId: string): boolean {
    const row = this.db.prepare('SELECT last_broadcast_at FROM contact_fatigue WHERE organization_id = ? AND phone = ?').get(organizationId, phone) as { last_broadcast_at: number } | undefined
    if (!row) return false

    const now = Math.floor(Date.now() / 1000)
    const thresholdSeconds = this.daysThreshold * 24 * 60 * 60
    return (now - row.last_broadcast_at) < thresholdSeconds
  }

  recordBroadcast(phone: string, campaignId: string, organizationId: string) {
    const now = Math.floor(Date.now() / 1000)
    this.db.prepare(`
      INSERT OR REPLACE INTO contact_fatigue (organization_id, phone, last_broadcast_at, last_campaign_id)
      VALUES (?, ?, ?, ?)
    `).run(organizationId, phone, now, campaignId)
  }
}
