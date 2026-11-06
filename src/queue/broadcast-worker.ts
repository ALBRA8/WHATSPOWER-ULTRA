import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  Campaign,
  CampaignItem,
  Dispatcher,
  LockChecker,
  SuppressionChecker,
} from '../types.ts'
import { parseAudienceCsv } from '../audiences/csv-importer.ts'
import { renderSpintax } from '../engine/spintax.ts'
import { FatigueManager, LocalSuppressionStore } from '../safety/suppression.ts'
import { Throttler, type ThrottlerOptions } from './throttler.ts'
import { isDispatchableStatus } from './campaign-lifecycle.ts'

export interface CreateCampaignOptions {
  organizationId: string
  name: string
  templateSpintax: string
  csvContent: string
}

export class BroadcastEngine {
  db: DatabaseSync
  dispatcher: Dispatcher
  lockChecker: LockChecker
  suppressionStore: SuppressionChecker
  fatigueManager: FatigueManager
  throttler: Throttler
  /** Identidad única de este worker — queda registrada en campaign_items.claimed_by. */
  readonly workerId: string

  constructor(options: {
    db: DatabaseSync
    dispatcher: Dispatcher
    lockChecker: LockChecker
    suppressionStore?: SuppressionChecker
    throttlerOptions?: Partial<ThrottlerOptions>
    workerId?: string
  }) {
    this.db = options.db
    this.dispatcher = options.dispatcher
    this.lockChecker = options.lockChecker
    this.suppressionStore = options.suppressionStore || new LocalSuppressionStore(this.db)
    this.fatigueManager = new FatigueManager(this.db)
    this.throttler = new Throttler(options.throttlerOptions)
    this.workerId = options.workerId || `wrk_${randomUUID()}`
  }

  /**
   * Crea y encola una campaña a partir de un archivo CSV aplicando la Fase 1 de Pre-filtrado
   */
  async createCampaign(opts: CreateCampaignOptions): Promise<Campaign> {
    const campaignId = `cmp_${randomUUID()}`
    const now = Math.floor(Date.now() / 1000)

    const importResult = parseAudienceCsv(opts.csvContent)

    this.db.prepare(`
      INSERT INTO campaigns (id, organization_id, name, template_spintax, status, total_targets, created_at)
      VALUES (?, ?, ?, ?, 'DRAFT', ?, ?)
    `).run(campaignId, opts.organizationId, opts.name, opts.templateSpintax, importResult.contacts.length, now)

    let skippedCount = 0
    const orgId = opts.organizationId

    for (const contact of importResult.contacts) {
      const phone = contact.phone
      const itemId = `itm_${randomUUID()}`
      const idempotencyKey = createHash('sha256').update(`${campaignId}_${phone}`).digest('hex')

      // 1. Pre-filtrado de Supresión (Bajas) — POR ORGANIZACIÓN (tercera reparación 5.B)
      if (await this.suppressionStore.isSuppressed(phone, orgId)) {
        this.saveItem({
          id: itemId,
          campaignId,
          contactPhone: phone,
          contactName: contact.name,
          variables: contact.variables,
          status: 'SUPPRESSED',
          errorReason: 'Opt-out / Lista de baja activa',
          idempotencyKey,
        })
        skippedCount++
        continue
      }

      // 2. Pre-filtrado de Fatiga (Máximo 1 broadcast cada 7 días) — por organización
      if (this.fatigueManager.isFatigued(phone, orgId)) {
        this.saveItem({
          id: itemId,
          campaignId,
          contactPhone: phone,
          contactName: contact.name,
          variables: contact.variables,
          status: 'FATIGUE_EXCLUDED',
          errorReason: 'Regla de fatiga: ya recibió difusión en los últimos 7 días',
          idempotencyKey,
        })
        skippedCount++
        continue
      }

      // 3. Pre-filtrado de Locks de Conversación en Capa 2A (Fase 1) — de ESTA org
      const lockRes = await this.lockChecker.checkLock(phone, orgId)
      if (!lockRes.available) {
        this.saveItem({
          id: itemId,
          campaignId,
          contactPhone: phone,
          contactName: contact.name,
          variables: contact.variables,
          status: 'LOCK_EXCLUDED',
          errorReason: lockRes.state ? `Lock activo en 2A (${lockRes.state})` : (lockRes.error || 'Lock no disponible'),
          idempotencyKey,
        })
        skippedCount++
        continue
      }

      // 4. Contacto libre: se encola como PENDING
      this.saveItem({
        id: itemId,
        campaignId,
        contactPhone: phone,
        contactName: contact.name,
        variables: contact.variables,
        status: 'PENDING',
        idempotencyKey,
      })
    }

    this.db.prepare('UPDATE campaigns SET skipped_count = ? WHERE id = ?').run(skippedCount, campaignId)

    return this.getCampaign(campaignId)!
  }

  private saveItem(item: {
    id: string
    campaignId: string
    contactPhone: string
    contactName?: string
    variables?: Record<string, string>
    status: string
    errorReason?: string
    idempotencyKey: string
  }) {
    this.db.prepare(`
      INSERT INTO campaign_items (
        id, campaign_id, contact_phone, contact_name, variables_json, status, error_reason, retry_count, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      item.id,
      item.campaignId,
      item.contactPhone,
      item.contactName || null,
      item.variables ? JSON.stringify(item.variables) : null,
      item.status,
      item.errorReason || null,
      item.idempotencyKey
    )
  }

  getCampaign(campaignId: string): Campaign | null {
    const row = this.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId) as any
    if (!row) return null
    return {
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      templateSpintax: row.template_spintax,
      status: row.status,
      scheduledAt: row.scheduled_at || undefined,
      startedAt: row.started_at || undefined,
      finishedAt: row.finished_at || undefined,
      totalTargets: row.total_targets,
      sentCount: row.sent_count,
      failedCount: row.failed_count,
      skippedCount: row.skipped_count,
      createdAt: row.created_at,
    }
  }

  getItems(campaignId: string): CampaignItem[] {
    const rows = this.db.prepare('SELECT * FROM campaign_items WHERE campaign_id = ? ORDER BY rowid ASC').all(campaignId) as any[]
    return rows.map((r) => ({
      id: r.id,
      campaignId: r.campaign_id,
      contactPhone: r.contact_phone,
      contactName: r.contact_name || undefined,
      variables: r.variables_json ? JSON.parse(r.variables_json) : undefined,
      renderedText: r.rendered_text || undefined,
      status: r.status,
      lockCheckedAt: r.lock_checked_at || undefined,
      dispatchedAt: r.dispatched_at || undefined,
      errorReason: r.error_reason || undefined,
      messageId: r.message_id || undefined,
      retryCount: r.retry_count,
      idempotencyKey: r.idempotency_key,
    }))
  }

  /**
   * Ejecuta un paso de despacho del siguiente ítem PENDING de la campaña
   */
  async processNextItem(campaignId: string, customDate?: Date): Promise<{ processed: boolean; status?: string; error?: string }> {
    const campaign = this.getCampaign(campaignId)
    // (reparación integral) PAUSED tampoco puede despachar: la pausa debe respetarse.
    if (!campaign || ['COMPLETED', 'CANCELLED', 'PAUSED', 'PAUSED_OFF_HOURS', 'PAUSED_COOLDOWN'].includes(campaign.status)) {
      return { processed: false, status: campaign?.status }
    }

    // A. Validación de Horario Comercial
    if (!this.throttler.isWithinBusinessHours(customDate)) {
      this.db.prepare("UPDATE campaigns SET status = 'PAUSED_OFF_HOURS' WHERE id = ?").run(campaignId)
      return { processed: false, status: 'PAUSED_OFF_HOURS', error: 'Fuera de horario comercial permitido' }
    }

    // B. Validación de Pausa de Enfriamiento por Lotes
    if (this.throttler.isCooldownNeeded()) {
      this.db.prepare("UPDATE campaigns SET status = 'PAUSED_COOLDOWN' WHERE id = ?").run(campaignId)
      return { processed: false, status: 'PAUSED_COOLDOWN', error: 'En pausa de enfriamiento por lote' }
    }

    // C. CLAIM ATÓMICO (reparación integral 2026-11-06):
    // Un ítem solo puede pasar PENDING→DISPATCHING por UN worker. El UPDATE condicional
    // es la primitiva de claim: si otro worker lo tomó primero, changes === 0.
    const pendingExists = this.db.prepare(
      "SELECT 1 AS x FROM campaign_items WHERE campaign_id = ? AND status = 'PENDING' LIMIT 1"
    ).get(campaignId)

    if (!pendingExists) {
      // (segunda reparación §4.C) La campaña SOLO se marca COMPLETED cuando no
      // quedan ítems PENDING NI DISPATCHING (ítems en vuelo de otros workers):
      // antes se completaba con despachos aún en curso.
      const inFlight = this.db.prepare(
        "SELECT 1 AS x FROM campaign_items WHERE campaign_id = ? AND status = 'DISPATCHING' LIMIT 1"
      ).get(campaignId)
      if (!inFlight) {
        const now = Math.floor(Date.now() / 1000)
        this.db.prepare("UPDATE campaigns SET status = 'COMPLETED', finished_at = ? WHERE id = ? AND status IN ('RUNNING','DRAFT')").run(now, campaignId)
        return { processed: false, status: 'COMPLETED' }
      }
      return { processed: false, status: 'ITEMS_IN_FLIGHT' }
    }

    const claim = this.claimNextItem(campaignId)
    if (!claim.claimed) {
      // Carrera perdida: otro worker reclamó el ítem candidato. NO se marca COMPLETED.
      return { processed: false, status: 'CLAIMED_BY_OTHER_WORKER' }
    }
    const nextItem = claim.item as any

    // Marcar como RUNNING si estaba DRAFT — CONDICIONAL: si la campaña fue
    // cancelada/pausada durante el claim, el UPDATE no aplica (guard de estado).
    if (campaign.status === 'DRAFT') {
      const now = Math.floor(Date.now() / 1000)
      this.db.prepare("UPDATE campaigns SET status = 'RUNNING', started_at = ? WHERE id = ? AND status = 'DRAFT'").run(now, campaignId)
    }

    const phone = nextItem.contactPhone
    const checkNow = Math.floor(Date.now() / 1000)

    // D1. FASE 2: Comprobación Just-In-Time de Supresiones / Bajas (< 50 ms antes del despacho)
    // (tercera reparación 5.A) SIEMPRE con la organización de la CAMPAÑA.
    try {
      const isSupp = await this.suppressionStore.isSuppressed(phone, campaign.organizationId)
      if (isSupp) {
        this.db.prepare(`
          UPDATE campaign_items
          SET status = 'SUPPRESSED', error_reason = 'Baja / Opt-out detectada Just-In-Time'
          WHERE id = ?
        `).run(nextItem.id)
        this.db.prepare('UPDATE campaigns SET skipped_count = skipped_count + 1 WHERE id = ?').run(campaignId)
        return { processed: true, status: 'SUPPRESSED' }
      }
    } catch (suppErr: any) {
      // Fail-closed estricto si falla la verificación de supresión
      this.db.prepare(`
        UPDATE campaign_items
        SET status = 'SKIPPED_SUPPRESSION_UNAVAILABLE', error_reason = ?
        WHERE id = ?
      `).run(`Error consultando supresiones (Fail-Closed): ${suppErr.message}`, nextItem.id)
      this.db.prepare('UPDATE campaigns SET skipped_count = skipped_count + 1 WHERE id = ?').run(campaignId)
      return { processed: true, status: 'SKIPPED_SUPPRESSION_UNAVAILABLE' }
    }

    // D2. FASE 2: Comprobación Just-In-Time de Locks (< 50 ms antes del despacho)
    // (tercera reparación 5.A) El lock consultado es el de (org de la campaña, teléfono)
    const lockRes = await this.lockChecker.checkLock(phone, campaign.organizationId)

    if (!lockRes.available) {
      // 1. Si Capa 2A reporta lock activo: se aborta el despacho
      if (lockRes.state) {
        this.db.prepare(`
          UPDATE campaign_items
          SET status = 'ABORTED_LOCK_ACTIVE', lock_checked_at = ?, error_reason = ?
          WHERE id = ?
        `).run(checkNow, `Lock activo en 2A (${lockRes.state}) detectado Just-In-Time`, nextItem.id)
        this.db.prepare('UPDATE campaigns SET skipped_count = skipped_count + 1 WHERE id = ?').run(campaignId)
        return { processed: true, status: 'ABORTED_LOCK_ACTIVE' }
      }

      // 2. Fail-Closed estricto: si 2A dio error o timeout, NUNCA despachar
      this.db.prepare(`
        UPDATE campaign_items
        SET status = 'SKIPPED_LOCK_UNAVAILABLE', lock_checked_at = ?, error_reason = ?
        WHERE id = ?
      `).run(checkNow, lockRes.error || 'Servicio de locks 2A no disponible (Fail-Closed)', nextItem.id)
      this.db.prepare('UPDATE campaigns SET skipped_count = skipped_count + 1 WHERE id = ?').run(campaignId)
      return { processed: true, status: 'SKIPPED_LOCK_UNAVAILABLE' }
    }

    // E. Generación determinista de Spintax con semilla por contacto
    const seed = `${campaignId}_${phone}`
    const variables: Record<string, string> = nextItem.variables ? { ...nextItem.variables } : {}
    if (nextItem.contactName) {
      variables.name = nextItem.contactName
      // Alias: las plantillas del Campaign Studio usan {{nombre}} (el CSV usa {{name}})
      if (!variables.nombre) variables.nombre = nextItem.contactName
    }

    const renderedText = renderSpintax(campaign.templateSpintax, { seed, variables })

    // F0. (segunda reparación §4.B) RE-CHECK DE ESTADO Y OWNERSHIP JUSTO ANTES
    // DEL DESPACHO: la campaña puede haberse pausado/cancelado DURANTE los
    // chequeos asíncronos anteriores (supresión/lock son await). Solo se
    // despacha si el estado VIGENTE en BD sigue despachable; si no, el ítem se
    // aborta SIN enviar y se libera el cómputo.
    const freshCampaign = this.db.prepare('SELECT status, organization_id FROM campaigns WHERE id = ?').get(campaignId) as { status: string; organization_id: string } | undefined
    if (!freshCampaign || !isDispatchableStatus(freshCampaign.status)) {
      this.db.prepare(`
        UPDATE campaign_items
        SET status = 'ABORTED_CAMPAIGN_NOT_RUNNING', error_reason = ?
        WHERE id = ? AND status = 'DISPATCHING' AND claimed_by = ?
      `).run(`Campaña en estado ${freshCampaign?.status ?? 'inexistente'} al momento del despacho (pausa/cancelación respetadas)`, nextItem.id, this.workerId)
      this.db.prepare('UPDATE campaigns SET skipped_count = skipped_count + 1 WHERE id = ?').run(campaignId)
      return { processed: true, status: 'ABORTED_CAMPAIGN_NOT_RUNNING' }
    }

    // F. El ítem ya está en DISPATCHING desde el claim atómico; se registran
    //    el texto renderizado y el momento del check de lock.
    this.db.prepare(`
      UPDATE campaign_items
      SET rendered_text = ?, lock_checked_at = ?
      WHERE id = ? AND status = 'DISPATCHING' AND claimed_by = ?
    `).run(renderedText, checkNow, nextItem.id, this.workerId)

    // G. Despacho a través de la Interfaz del CRM
    // B3: el despacho NOMBRA la organización de la campaña (identidad extremo a extremo).
    const dispatchRes = await this.dispatcher.dispatch(phone, renderedText, campaign.organizationId)
    const dispatchTime = Math.floor(Date.now() / 1000)

    if (dispatchRes.success) {
      // Guard: solo el worker que reclama escribe el resultado (multi-réplica seguro)
      this.db.prepare(`
        UPDATE campaign_items
        SET status = 'SENT', dispatched_at = ?, message_id = ?
        WHERE id = ? AND status = 'DISPATCHING' AND claimed_by = ?
      `).run(dispatchTime, dispatchRes.messageId || null, nextItem.id, this.workerId)

      this.db.prepare('UPDATE campaigns SET sent_count = sent_count + 1 WHERE id = ?').run(campaignId)
      this.fatigueManager.recordBroadcast(phone, campaignId, campaign.organizationId)
      this.throttler.registerDispatch()

      return { processed: true, status: 'SENT' }
    } else if (dispatchRes.uncertain) {
      // RESULTADO INCIERTO (timeout / desconexión): el daemon pudo haber enviado el mensaje.
      // REGLA OBLIGATORIA: Bloquear reintentos automáticos a ciegas para impedir duplicidad en WhatsApp.
      this.db.prepare(`
        UPDATE campaign_items
        SET status = 'UNCERTAIN_DISPATCH', error_reason = ?
        WHERE id = ? AND status = 'DISPATCHING' AND claimed_by = ?
      `).run(dispatchRes.error || 'Resultado incierto de despacho (Requiere reconciliación previa)', nextItem.id, this.workerId)

      this.db.prepare('UPDATE campaigns SET failed_count = failed_count + 1 WHERE id = ?').run(campaignId)
      return { processed: true, status: 'UNCERTAIN_DISPATCH', error: dispatchRes.error }
    } else {
      // Fallo confirmado por el daemon (400, auth, etc.)
      const isRetryable = nextItem.retryCount < 2
      const newStatus = isRetryable ? 'FAILED_RETRYABLE' : 'FAILED_FATAL'

      this.db.prepare(`
        UPDATE campaign_items
        SET status = ?, error_reason = ?, retry_count = retry_count + 1
        WHERE id = ? AND status = 'DISPATCHING' AND claimed_by = ?
      `).run(newStatus, dispatchRes.error || 'Fallo de despacho saliente confirmado', nextItem.id, this.workerId)

      this.db.prepare('UPDATE campaigns SET failed_count = failed_count + 1 WHERE id = ?').run(campaignId)
      return { processed: true, status: newStatus, error: dispatchRes.error }
    }
  }

  /**
   * CLAIM ATÓMICO (reparación integral 2026-11-06):
   * selecciona el candidato y lo mueve PENDING→DISPATCHING con un UPDATE condicional
   * en una sola sentencia lógica: si otro worker lo reclamó primero, changes === 0.
   * El ítem reclamado queda registrado con claimed_by/claimed_at para trazabilidad
   * y reconciliación controlada.
   */
  claimNextItem(campaignId: string): { claimed: false } | { claimed: true; item: CampaignItem } {
    const candidate = this.db.prepare(`
      SELECT id FROM campaign_items
      WHERE campaign_id = ? AND status = 'PENDING'
      ORDER BY rowid ASC
      LIMIT 1
    `).get(campaignId) as { id: string } | undefined

    if (!candidate) return { claimed: false }

    const now = Math.floor(Date.now() / 1000)
    const claimRes = this.db.prepare(`
      UPDATE campaign_items
      SET status = 'DISPATCHING', claimed_by = ?, claimed_at = ?
      WHERE id = ? AND status = 'PENDING'
    `).run(this.workerId, now, candidate.id)

    // node:sqlite devuelve changes como number | bigint: normalizar (0n === 0 es false)
    if (Number(claimRes.changes) === 0) return { claimed: false }

    const item = this.getItem(candidate.id)
    if (!item) return { claimed: false }
    return { claimed: true, item }
  }

  getItem(id: string): CampaignItem | null {
    const r = this.db.prepare('SELECT * FROM campaign_items WHERE id = ?').get(id) as any
    if (!r) return null
    return {
      id: r.id,
      campaignId: r.campaign_id,
      contactPhone: r.contact_phone,
      contactName: r.contact_name || undefined,
      variables: r.variables_json ? JSON.parse(r.variables_json) : undefined,
      renderedText: r.rendered_text || undefined,
      status: r.status,
      lockCheckedAt: r.lock_checked_at || undefined,
      dispatchedAt: r.dispatched_at || undefined,
      errorReason: r.error_reason || undefined,
      messageId: r.message_id || undefined,
      retryCount: r.retry_count,
      idempotencyKey: r.idempotency_key,
    }
  }

  /**
   * Reconciliación CONTROLADA (nunca reintento ciego):
   * mueve a UNCERTAIN_DISPATCH los ítems DISPATCHING con claims expirados
   * (worker muerto sin pasar por recoverFromCrash). No los devuelve a PENDING jamás;
   * exigen resolución humana o del proceso de reconciliación autorizado.
   */
  reconcileStaleClaims(maxAgeSeconds: number = 900): { reconciledCount: number } {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSeconds
    const res = this.db.prepare(`
      UPDATE campaign_items
      SET status = 'UNCERTAIN_DISPATCH',
          error_reason = 'Claim de worker expirado (reconciliación controlada — resultado incierto, requiere resolución manual)'
      WHERE status = 'DISPATCHING' AND claimed_at IS NOT NULL AND claimed_at < ?
    `).run(cutoff)
    return { reconciledCount: Number(res.changes) }
  }

  /**
   * Procedimiento de Recuperación ante Caídas (Crash Recovery)
   */
  recoverFromCrash() {
    // Cualquier ítem que quedó en estado transitorio 'DISPATCHING' cuando el proceso cayó
    // NO debe reintentarse ciegamente (pudo haberse enviado al socket antes de la caída).
    // Se marca 'UNCERTAIN_DISPATCH' exigiendo reconciliación controlada.
    // (reparación integral) Solo los claims EXPIRIDOS o huérfanos (claimed_at nulo de
    // migraciones viejas) se marcan UNCERTAIN_DISPATCH; los ítems en vuelo de workers
    // vivos (claim reciente) NO se tocan al arrancar otra réplica.
    const staleCutoff = Math.floor(Date.now() / 1000) - 900
    const result = this.db.prepare(`
      UPDATE campaign_items
      SET status = 'UNCERTAIN_DISPATCH', error_reason = 'Proceso interrumpido durante despacho (Resultado Incierto - Bloqueado contra reenvío ciego)'
      WHERE status = 'DISPATCHING' AND (claimed_at IS NULL OR claimed_at < ?)
    `).run(staleCutoff)

    return { recoveredCount: Number(result.changes) }
  }
}
