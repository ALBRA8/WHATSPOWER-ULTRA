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

  constructor(options: {
    db: DatabaseSync
    dispatcher: Dispatcher
    lockChecker: LockChecker
    suppressionStore?: SuppressionChecker
    throttlerOptions?: Partial<ThrottlerOptions>
  }) {
    this.db = options.db
    this.dispatcher = options.dispatcher
    this.lockChecker = options.lockChecker
    this.suppressionStore = options.suppressionStore || new LocalSuppressionStore(this.db)
    this.fatigueManager = new FatigueManager(this.db)
    this.throttler = new Throttler(options.throttlerOptions)
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

    for (const contact of importResult.contacts) {
      const phone = contact.phone
      const itemId = `itm_${randomUUID()}`
      const idempotencyKey = createHash('sha256').update(`${campaignId}_${phone}`).digest('hex')

      // 1. Pre-filtrado de Supresión (Bajas) — scoped a la organización de la campaña
      if (await this.suppressionStore.isSuppressed(phone, opts.organizationId)) {
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

      // 2. Pre-filtrado de Fatiga (Máximo 1 broadcast cada 7 días) — scoped por organización
      if (this.fatigueManager.isFatigued(phone, opts.organizationId)) {
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

      // 3. Pre-filtrado de Locks de Conversación en Capa 2A (Fase 1)
      const lockRes = await this.lockChecker.checkLock(phone)
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
   * Ejecuta un paso de despacho del siguiente ítem PENDING de la campaña.
   * Contrato v1.1.0 §5-§6:
   *  - Claim ATÓMICO: UPDATE ... WHERE id=? AND status='PENDING'; changes=0 ⇒ otro worker
   *    lo tomó (jamás doble despacho bajo concurrencia).
   *  - Toda transición posterior usa guard WHERE status='DISPATCHING' (changes check).
   *  - /step solo procesa campañas RUNNING (DRAFT promociona una vez; pausas y terminales no).
   *  - UNCERTAIN_DISPATCH preservado; jamás reintento ciego; FAILED_RETRYABLE reintenta
   *    máximo 3 intentos vía claim condicional y después → FAILED permanente.
   *  - Reconciliación al arrancar: recoverFromCrash() marca huérfanos DISPATCHING.
   *  - El resultado informa nextPacingDelayMs (jitter 15–35 s por defecto) que el
   *    llamador debe respetar antes del siguiente paso.
   */
  async processNextItem(campaignId: string, customDate?: Date): Promise<{ processed: boolean; status?: string; error?: string; nextPacingDelayMs?: number }> {
    const campaign = this.getCampaign(campaignId)
    if (!campaign) return { processed: false }

    let status: string = campaign.status

    // Estados terminales: intocables (jamás se procesan ni se mutan aquí).
    if (status === 'COMPLETED' || status === 'CANCELLED' || status === 'FAILED') {
      return { processed: false, status }
    }

    // Pausa de enfriamiento por lote: con vencimiento temporal y reset automático (contrato §5).
    if (status === 'PAUSED_COOLDOWN') {
      if (this.throttler.isCooldownExpired()) {
        this.throttler.resetCooldown()
        const res = this.db.prepare("UPDATE campaigns SET status = 'RUNNING' WHERE id = ? AND status = 'PAUSED_COOLDOWN'").run(campaignId)
        if (res.changes > 0) status = 'RUNNING'
      } else {
        return { processed: false, status: 'PAUSED_COOLDOWN', error: 'En pausa de enfriamiento por lote (vence automáticamente)' }
      }
    }

    // Sólo RUNNING procesa; DRAFT promociona a RUNNING (transición legal DRAFT→RUNNING).
    if (status === 'DRAFT') {
      const res = this.db.prepare("UPDATE campaigns SET status = 'RUNNING', started_at = ? WHERE id = ? AND status = 'DRAFT'").run(Math.floor(Date.now() / 1000), campaignId)
      if (res.changes > 0) status = 'RUNNING'
      else return { processed: false, status: this.getCampaign(campaignId)?.status }
    }
    if (status !== 'RUNNING') {
      // PAUSED / PAUSED_OFF_HOURS / SCHEDULED: /step jamás despacha fuera de RUNNING.
      return { processed: false, status }
    }

    // A. Validación de Horario Comercial (solo pausa campañas RUNNING)
    if (!this.throttler.isWithinBusinessHours(customDate)) {
      this.db.prepare("UPDATE campaigns SET status = 'PAUSED_OFF_HOURS' WHERE id = ? AND status = 'RUNNING'").run(campaignId)
      return { processed: false, status: 'PAUSED_OFF_HOURS', error: 'Fuera de horario comercial permitido' }
    }

    // B. Validación de Pausa de Enfriamiento por Lotes
    if (this.throttler.isCooldownNeeded()) {
      this.db.prepare("UPDATE campaigns SET status = 'PAUSED_COOLDOWN' WHERE id = ? AND status = 'RUNNING'").run(campaignId)
      return { processed: false, status: 'PAUSED_COOLDOWN', error: 'En pausa de enfriamiento por lote' }
    }

    // C. RECONCILIACIÓN CONTROLADA: sin PENDING pero con FAILED_RETRYABLE (≤3 intentos)
    // ⇒ re-encola UNO mediante claim condicional (jamás reintento ciego de UNCERTAIN).
    const pendingCount = this.db.prepare("SELECT COUNT(*) as n FROM campaign_items WHERE campaign_id = ? AND status = 'PENDING'").get(campaignId) as { n: number }
    if (pendingCount.n === 0) {
      this.requeueRetryable(campaignId)
    }

    // D. Selección del siguiente ítem PENDING (candidato; la propiedad se decide en el claim)
    const candidate = this.db.prepare(`
      SELECT id FROM campaign_items
      WHERE campaign_id = ? AND status = 'PENDING'
      ORDER BY rowid ASC
      LIMIT 1
    `).get(campaignId) as { id: string } | undefined

    if (!candidate) {
      // Sin PENDING ni reintentos posibles: la campaña se marca COMPLETED (terminal)
      const now = Math.floor(Date.now() / 1000)
      this.db.prepare("UPDATE campaigns SET status = 'COMPLETED', finished_at = ? WHERE id = ? AND status = 'RUNNING'").run(now, campaignId)
      return { processed: false, status: 'COMPLETED' }
    }

    // E. CLAIM ATÓMICO (contrato §5): UPDATE condicional — changes=0 ⇒ otro worker lo tomó.
    const checkNow = Math.floor(Date.now() / 1000)
    const claim = this.db.prepare(`
      UPDATE campaign_items SET status = 'DISPATCHING', lock_checked_at = ?
      WHERE id = ? AND status = 'PENDING'
    `).run(checkNow, candidate.id)
    if (claim.changes === 0) {
      // Otro worker lo reclamó primero: jamás doble despacho.
      return { processed: false, status: 'CLAIMED_BY_OTHER_WORKER' }
    }
    const itemId = candidate.id
    const nextItem = this.db.prepare('SELECT * FROM campaign_items WHERE id = ?').get(itemId) as any
    const phone = nextItem.contact_phone

    // F1. FASE 2: Comprobación Just-In-Time de Supresiones / Bajas (post-claim, pre-despacho)
    try {
      const isSupp = await this.suppressionStore.isSuppressed(phone, campaign.organizationId)
      if (isSupp) {
        this.db.prepare(`
          UPDATE campaign_items
          SET status = 'SUPPRESSED', error_reason = 'Baja / Opt-out detectada Just-In-Time'
          WHERE id = ? AND status = 'DISPATCHING'
        `).run(nextItem.id)
        this.db.prepare('UPDATE campaigns SET skipped_count = skipped_count + 1 WHERE id = ?').run(campaignId)
        return { processed: true, status: 'SUPPRESSED' }
      }
    } catch (suppErr: any) {
      // Fail-closed estricto si falla la verificación de supresión
      this.db.prepare(`
        UPDATE campaign_items
        SET status = 'SKIPPED_SUPPRESSION_UNAVAILABLE', error_reason = ?
        WHERE id = ? AND status = 'DISPATCHING'
      `).run(`Error consultando supresiones (Fail-Closed): ${suppErr.message}`, nextItem.id)
      this.db.prepare('UPDATE campaigns SET skipped_count = skipped_count + 1 WHERE id = ?').run(campaignId)
      return { processed: true, status: 'SKIPPED_SUPPRESSION_UNAVAILABLE' }
    }

    // F2. FASE 2: Comprobación Just-In-Time de Locks (post-claim, pre-despacho)
    const lockRes = await this.lockChecker.checkLock(phone)

    if (!lockRes.available) {
      // 1. Si Capa 2A reporta lock activo: se aborta el despacho
      if (lockRes.state) {
        this.db.prepare(`
          UPDATE campaign_items
          SET status = 'ABORTED_LOCK_ACTIVE', lock_checked_at = ?, error_reason = ?
          WHERE id = ? AND status = 'DISPATCHING'
        `).run(checkNow, `Lock activo en 2A (${lockRes.state}) detectado Just-In-Time`, nextItem.id)
        this.db.prepare('UPDATE campaigns SET skipped_count = skipped_count + 1 WHERE id = ?').run(campaignId)
        return { processed: true, status: 'ABORTED_LOCK_ACTIVE' }
      }

      // 2. Fail-Closed estricto: si 2A dio error o timeout, NUNCA despachar
      this.db.prepare(`
        UPDATE campaign_items
        SET status = 'SKIPPED_LOCK_UNAVAILABLE', lock_checked_at = ?, error_reason = ?
        WHERE id = ? AND status = 'DISPATCHING'
      `).run(checkNow, lockRes.error || 'Servicio de locks 2A no disponible (Fail-Closed)', nextItem.id)
      this.db.prepare('UPDATE campaigns SET skipped_count = skipped_count + 1 WHERE id = ?').run(campaignId)
      return { processed: true, status: 'SKIPPED_LOCK_UNAVAILABLE' }
    }

    // G. Generación determinista de Spintax con semilla por contacto
    const seed = `${campaignId}_${phone}`
    const variables: Record<string, string> = nextItem.variables_json ? JSON.parse(nextItem.variables_json) : {}
    if (nextItem.contact_name) {
      variables.name = nextItem.contact_name
      // Alias: las plantillas del Campaign Studio usan {{nombre}} (el CSV usa {{name}})
      if (!variables.nombre) variables.nombre = nextItem.contact_name
    }

    const renderedText = renderSpintax(campaign.templateSpintax, { seed, variables })

    // H. Registrar el texto renderizado (el estado DISPATCHING ya se fijó en el claim atómico)
    this.db.prepare(`
      UPDATE campaign_items
      SET rendered_text = ?
      WHERE id = ? AND status = 'DISPATCHING'
    `).run(renderedText, nextItem.id)

    // I. Despacho a través de la Interfaz del CRM
    const dispatchRes = await this.dispatcher.dispatch(phone, renderedText)
    const dispatchTime = Math.floor(Date.now() / 1000)

    if (dispatchRes.success) {
      const sent = this.db.prepare(`
        UPDATE campaign_items
        SET status = 'SENT', dispatched_at = ?, message_id = ?
        WHERE id = ? AND status = 'DISPATCHING'
      `).run(dispatchTime, dispatchRes.messageId || null, nextItem.id)
      if (sent.changes === 0) {
        // El ítem ya no está bajo nuestro claim (no debería ocurrir): jamás contar dos veces.
        return { processed: false, status: 'CLAIM_LOST' }
      }

      this.db.prepare('UPDATE campaigns SET sent_count = sent_count + 1 WHERE id = ?').run(campaignId)
      this.fatigueManager.recordBroadcast(phone, campaignId, campaign.organizationId)
      this.throttler.registerDispatch()

      return { processed: true, status: 'SENT', nextPacingDelayMs: this.throttler.nextPacingDelayMs() }
    } else if (dispatchRes.uncertain) {
      // RESULTADO INCIERTO (timeout / desconexión): el daemon pudo haber enviado el mensaje.
      // REGLA OBLIGATORIA: Bloquear reintentos automáticos a ciegas para impedir duplicidad en WhatsApp.
      this.db.prepare(`
        UPDATE campaign_items
        SET status = 'UNCERTAIN_DISPATCH', error_reason = ?
        WHERE id = ? AND status = 'DISPATCHING'
      `).run(dispatchRes.error || 'Resultado incierto de despacho (Requiere reconciliación previa)', nextItem.id)

      this.db.prepare('UPDATE campaigns SET failed_count = failed_count + 1 WHERE id = ?').run(campaignId)
      return { processed: true, status: 'UNCERTAIN_DISPATCH', error: dispatchRes.error }
    } else {
      // Fallo confirmado por el daemon (400, auth, etc.): reconciliación CONTROLADA —
      // máximo 3 intentos vía claim condicional; después → FAILED permanente (contrato §5).
      const attempts = nextItem.retry_count + 1
      const newStatus = attempts < 3 ? 'FAILED_RETRYABLE' : 'FAILED'

      this.db.prepare(`
        UPDATE campaign_items
        SET status = ?, error_reason = ?, retry_count = ?
        WHERE id = ? AND status = 'DISPATCHING'
      `).run(newStatus, dispatchRes.error || 'Fallo de despacho saliente confirmado', attempts, nextItem.id)

      this.db.prepare('UPDATE campaigns SET failed_count = failed_count + 1 WHERE id = ?').run(campaignId)
      return { processed: true, status: newStatus, error: dispatchRes.error }
    }
  }

  /**
   * Reconciliación CONTROLADA de reintentos (contrato §5): re-encola UN ítem
   * FAILED_RETRYABLE mediante claim condicional. Solo reencola si aún no agotó
   * sus 3 intentos. Jamás toca UNCERTAIN_DISPATCH (reconciliación manual).
   */
  requeueRetryable(campaignId: string): number {
    const res = this.db.prepare(`
      UPDATE campaign_items SET status = 'PENDING'
      WHERE id = (
        SELECT id FROM campaign_items
        WHERE campaign_id = ? AND status = 'FAILED_RETRYABLE' AND retry_count < 3
        ORDER BY rowid ASC LIMIT 1
      ) AND status = 'FAILED_RETRYABLE' AND retry_count < 3
    `).run(campaignId)
    return Number(res.changes)
  }

  /**
   * Procedimiento de Recuperación ante Caídas (Crash Recovery)
   */
  recoverFromCrash() {
    // Cualquier ítem que quedó en estado transitorio 'DISPATCHING' cuando el proceso cayó
    // NO debe reintentarse ciegamente (pudo haberse enviado al socket antes de la caída).
    // Se marca 'UNCERTAIN_DISPATCH' exigiendo reconciliación controlada.
    const result = this.db.prepare(`
      UPDATE campaign_items
      SET status = 'UNCERTAIN_DISPATCH', error_reason = 'Proceso interrumpido durante despacho (Resultado Incierto - Bloqueado contra reenvío ciego)'
      WHERE status = 'DISPATCHING'
    `).run()

    return { recoveredCount: result.changes }
  }
}
