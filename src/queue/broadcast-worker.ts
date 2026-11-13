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
import { isDispatchableStatus, transitionCampaignStatus, resumeCooldownExpiredCampaigns } from './campaign-lifecycle.ts'

export interface CreateCampaignOptions {
  organizationId: string
  name: string
  templateSpintax: string
  csvContent: string
}

/**
 * Clasificación de errores de despacho:
 * Errores permanentes/fatales (de configuración, autorización, tenencia o rechazo cliente 4xx)
 * pasan de inmediato a FAILED_FATAL sin reintentos inútiles.
 * Errores transitorios (red temporal, rate limit temporal 429) pasan a FAILED_RETRYABLE.
 */
export function isPermanentDispatchFailure(error: string | undefined): boolean {
  if (!error) return false
  const err = error.toUpperCase()
  if (
    err.includes('DISPATCH_BLOCKED') ||
    err.includes('ORG_REQUIRED') ||
    err.includes('NO_CONNECTED_NUMBER') ||
    err.includes('CREDENTIAL_UNAVAILABLE') ||
    err.includes('TENANT_CONTEXT') ||
    err.includes('QUARANTINED')
  ) {
    return true
  }
  if (
    err.includes('HTTP_400') ||
    err.includes('HTTP_401') ||
    err.includes('HTTP_403') ||
    err.includes('HTTP_404') ||
    err.includes('HTTP_410') ||
    err.includes('HTTP_413') ||
    err.includes('HTTP_422') ||
    err.includes('INVALID_PHONE')
  ) {
    return true
  }
  return false
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

  /** (hallazgo 9) pacing DURABLE por organización activado (worker de producción). */
  readonly durablePacing: boolean
  private nowMs: () => number
  private readonly claimLeaseRenewIntervalMs: number

  constructor(options: {
    db: DatabaseSync
    dispatcher: Dispatcher
    lockChecker: LockChecker
    suppressionStore?: SuppressionChecker
    throttlerOptions?: Partial<ThrottlerOptions>
    workerId?: string
    /** (hallazgo 9) activa el pacing durable por organización (default false
     *  por compatibilidad; worker-main lo activa en producción). */
    durablePacing?: boolean
    /** Reloj inyectable (pruebas con reloj controlado, sin esperas reales). */
    nowMs?: () => number
    /** Intervalo de renovación del lease durante un despacho en vuelo. */
    claimLeaseRenewIntervalMs?: number
  }) {
    this.db = options.db
    this.dispatcher = options.dispatcher
    this.lockChecker = options.lockChecker
    this.suppressionStore = options.suppressionStore || new LocalSuppressionStore(this.db)
    this.fatigueManager = new FatigueManager(this.db)
    this.throttler = new Throttler(options.throttlerOptions)
    this.workerId = options.workerId || `wrk_${randomUUID()}`
    this.durablePacing = options.durablePacing ?? false
    this.nowMs = options.nowMs ?? (() => Date.now())
    this.claimLeaseRenewIntervalMs = Math.max(1000, options.claimLeaseRenewIntervalMs ?? 60_000)
  }

  /** (hallazgo 8/9) libera un claim DISPATCHING devolviendo el ítem a PENDING
   *  (inverso EXACTO del claim atómico: sin efectos externos realizados). */
  private releaseClaim(itemId: string): void {
    this.db.prepare(`
      UPDATE campaign_items
      SET status = 'PENDING', claimed_by = NULL, claimed_at = NULL
      WHERE id = ? AND status = 'DISPATCHING' AND claimed_by = ?
    `).run(itemId, this.workerId)
  }

  /**
   * Crea y encola una campaña a partir de un archivo CSV aplicando la Fase 1 de Pre-filtrado
   */
  async createCampaign(opts: CreateCampaignOptions): Promise<Campaign> {
    const campaignId = `cmp_${randomUUID()}`
    const now = Math.floor(Date.now() / 1000)

    const importResult = parseAudienceCsv(opts.csvContent)
    const orgId = opts.organizationId

    // ============================================================
    // (A4-11, auditoría 2026-11-11) Dos fases:
    //  - FASE 1 (solo HTTP/lectura): clasificación de cada contacto
    //    (supresión / fatiga / lock) SIN escribir nada — un fallo de red
    //    aquí NO deja campañas a medias;
    //  - FASE 2 (transacción única): INSERT de campaña + TODOS los ítems +
    //    skipped_count en una sola transacción SQLite — un crash a mitad
    //    deja o todo o nada (antes: campaña con total_targets ≠ ítems reales).
    // ============================================================
    type Classified = { item: Parameters<BroadcastEngine['saveItem']>[0] }
    const classified: Classified[] = []
    let skippedCount = 0

    for (const contact of importResult.contacts) {
      const phone = contact.phone
      const itemId = `itm_${randomUUID()}`
      const idempotencyKey = createHash('sha256').update(`${campaignId}_${phone}`).digest('hex')

      const baseItem = {
        id: itemId,
        campaignId,
        organizationId: orgId,
        contactPhone: phone,
        contactName: contact.name,
        variables: contact.variables,
        idempotencyKey,
      }

      // 1. Pre-filtrado de Supresión (Bajas) — POR ORGANIZACIÓN (tercera reparación 5.B)
      if (await this.suppressionStore.isSuppressed(phone, orgId)) {
        classified.push({ item: { ...baseItem, status: 'SUPPRESSED', errorReason: 'Opt-out / Lista de baja activa' } })
        skippedCount++
        continue
      }

      // 2. Pre-filtrado de Fatiga (Máximo 1 broadcast cada 7 días) — por organización
      if (this.fatigueManager.isFatigued(phone, orgId)) {
        classified.push({ item: { ...baseItem, status: 'FATIGUE_EXCLUDED', errorReason: 'Regla de fatiga: ya recibió difusión en los últimos 7 días' } })
        skippedCount++
        continue
      }

      // 3. Pre-filtrado de Locks de Conversación en Capa 2A (Fase 1) — de ESTA org
      const lockRes = await this.lockChecker.checkLock(phone, orgId)
      if (!lockRes.available) {
        classified.push({ item: { ...baseItem, status: 'LOCK_EXCLUDED', errorReason: lockRes.state ? `Lock activo en 2A (${lockRes.state})` : (lockRes.error || 'Lock no disponible') } })
        skippedCount++
        continue
      }

      // 4. Contacto libre: se encola como PENDING (SIEMPRE con su organización — B4)
      classified.push({ item: { ...baseItem, status: 'PENDING' } })
    }

    // FASE 2 — transacción única (atómica).
    this.db.exec('BEGIN')
    try {
      this.db.prepare(`
        INSERT INTO campaigns (id, organization_id, name, template_spintax, status, total_targets, created_at)
        VALUES (?, ?, ?, ?, 'DRAFT', ?, ?)
      `).run(campaignId, opts.organizationId, opts.name, opts.templateSpintax, importResult.contacts.length, now)

      for (const { item } of classified) {
        this.saveItem(item)
      }

      this.db.prepare('UPDATE campaigns SET skipped_count = ? WHERE id = ?').run(skippedCount, campaignId)
      this.db.exec('COMMIT')
    } catch (err) {
      try { this.db.exec('ROLLBACK') } catch { /* rollback de cierre */ }
      throw err
    }

    return this.getCampaign(campaignId)!
  }

  private saveItem(item: {
    id: string
    campaignId: string
    organizationId: string
    contactPhone: string
    contactName?: string
    variables?: Record<string, string>
    status: string
    errorReason?: string
    idempotencyKey: string
  }) {
    this.db.prepare(`
      INSERT INTO campaign_items (
        id, campaign_id, organization_id, contact_phone, contact_name, variables_json, status, error_reason, retry_count, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      item.id,
      item.campaignId,
      item.organizationId,
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

  /** (A4-10) limit opcional: el detalle HTTP pagina los ítems (default 500
   *  en el endpoint); sin limit conserva el comportamiento completo interno. */
  getItems(campaignId: string, limit?: number): CampaignItem[] {
    const rows = (typeof limit === 'number' && limit > 0
      ? this.db.prepare('SELECT * FROM campaign_items WHERE campaign_id = ? ORDER BY rowid ASC LIMIT ?').all(campaignId, limit)
      : this.db.prepare('SELECT * FROM campaign_items WHERE campaign_id = ? ORDER BY rowid ASC').all(campaignId)) as any[]
    return rows.map((r) => ({
      id: r.id,
      campaignId: r.campaign_id,
      organizationId: r.organization_id || undefined,
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
  async processNextItem(campaignId: string, customDate?: Date): Promise<{ processed: boolean; status?: string; error?: string; retryAfterMs?: number }> {
    const campaign = this.getCampaign(campaignId)
    // (reparación integral) PAUSED tampoco puede despachar: la pausa debe respetarse.
    if (!campaign || ['COMPLETED', 'CANCELLED', 'PAUSED', 'PAUSED_OFF_HOURS', 'PAUSED_COOLDOWN'].includes(campaign.status)) {
      return { processed: false, status: campaign?.status }
    }

    // A. Validación de Horario Comercial — (hallazgo 10) transición CONDICIONAL
    //    por la máquina de estados (jamás UPDATE ciego: una campaña cancelada
    //    durante los chequeos no se "resucita" a PAUSED_*).
    if (!this.throttler.isWithinBusinessHours(customDate)) {
      const tr = transitionCampaignStatus(this.db, campaignId, campaign.organizationId, 'PAUSED_OFF_HOURS')
      if (!tr.ok) return { processed: false, status: tr.from ?? campaign.status, error: 'Fuera de horario comercial permitido (transición no aplicada)' }
      return { processed: false, status: 'PAUSED_OFF_HOURS', error: 'Fuera de horario comercial permitido' }
    }

    // B. Validación de Pausa de Enfriamiento por Lotes — (hallazgo 10) transición
    //    CONDICIONAL + timestamp DURABLE (cooldown_started_at) para que la
    //    reanudación automática respete la expiración real del cooldown incluso
    //    tras reiniciar el proceso.
    if (this.throttler.isCooldownNeeded()) {
      const pausedAt = Math.floor(this.nowMs() / 1000)
      const tr = transitionCampaignStatus(this.db, campaignId, campaign.organizationId, 'PAUSED_COOLDOWN', { cooldown_started_at: pausedAt })
      if (!tr.ok) return { processed: false, status: tr.from ?? campaign.status, error: 'Enfriamiento por lote (transición no aplicada)' }
      return { processed: false, status: 'PAUSED_COOLDOWN', error: 'En pausa de enfriamiento por lote' }
    }

    // C. CLAIM ATÓMICO (reparación integral 2026-11-06):
    // Un ítem solo puede pasar PENDING→DISPATCHING por UN worker. El UPDATE condicional
    // es la primitiva de claim: si otro worker lo tomó primero, changes === 0.
    // B4: "pendiente" = RECLAMABLE — con organización presente y vigente; los
    // sin-identidad o de otra org no cuentan (y se cuarentenan abajo).
    // (fusión integral) 'pendiente' incluye FAILED_RETRYABLE con reintentos
    // disponibles (<3): una campaña con reintentos vigentes NO se completa.
    const pendingExists = this.db.prepare(`
      SELECT 1 AS x FROM campaign_items
      WHERE campaign_id = ?
        AND (status = 'PENDING' OR (status = 'FAILED_RETRYABLE' AND retry_count < 3))
        AND organization_id IS NOT NULL
        AND organization_id = (SELECT organization_id FROM campaigns WHERE id = ?)
      LIMIT 1
    `).get(campaignId, campaignId)

    if (!pendingExists) {
      // B4: los ítems PENDING sin identidad (o de otra org) NO son reclamables:
      // se CUARENTENAN para que el estado de la cola sea honesto y la campaña
      // pueda drenar (jamás se despachan ni se reintentan automáticamente).
      this.quarantineOrglessItems()
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
        // (hallazgo 8) transición con OWNERSHIP: solo el dueño del claim move la
        // fila; el contador SOLO cambia si la fila REALMENTE transitó.
        const up = this.db.prepare(`
          UPDATE campaign_items
          SET status = 'SUPPRESSED', error_reason = 'Baja / Opt-out detectada Just-In-Time'
          WHERE id = ? AND status = 'DISPATCHING' AND claimed_by = ?
        `).run(nextItem.id, this.workerId)
        if (Number(up.changes) !== 1) return { processed: true, status: 'CLAIM_LOST', error: 'finalización tardía: el claim fue reconciliado por otro proceso (sin doble contabilización)' }
        this.db.prepare('UPDATE campaigns SET skipped_count = skipped_count + 1 WHERE id = ?').run(campaignId)
        return { processed: true, status: 'SUPPRESSED' }
      }
    } catch (suppErr: any) {
      // Fail-closed estricto si falla la verificación de supresión
      const up = this.db.prepare(`
        UPDATE campaign_items
        SET status = 'SKIPPED_SUPPRESSION_UNAVAILABLE', error_reason = ?
        WHERE id = ? AND status = 'DISPATCHING' AND claimed_by = ?
      `).run(`Error consultando supresiones (Fail-Closed): ${suppErr.message}`, nextItem.id, this.workerId)
      if (Number(up.changes) !== 1) return { processed: true, status: 'CLAIM_LOST', error: 'finalización tardía: el claim fue reconciliado por otro proceso (sin doble contabilización)' }
      this.db.prepare('UPDATE campaigns SET skipped_count = skipped_count + 1 WHERE id = ?').run(campaignId)
      return { processed: true, status: 'SKIPPED_SUPPRESSION_UNAVAILABLE' }
    }

    // D2. FASE 2: Comprobación Just-In-Time de Locks (< 50 ms antes del despacho)
    // (tercera reparación 5.A) El lock consultado es el de (org de la campaña, teléfono)
    const lockRes = await this.lockChecker.checkLock(phone, campaign.organizationId)

    if (!lockRes.available) {
      // 1. Si Capa 2A reporta lock activo: se aborta el despacho
      if (lockRes.state) {
        // (hallazgo 8) transición con OWNERSHIP + contador condicional.
        const up = this.db.prepare(`
          UPDATE campaign_items
          SET status = 'ABORTED_LOCK_ACTIVE', lock_checked_at = ?, error_reason = ?
          WHERE id = ? AND status = 'DISPATCHING' AND claimed_by = ?
        `).run(checkNow, `Lock activo en 2A (${lockRes.state}) detectado Just-In-Time`, nextItem.id, this.workerId)
        if (Number(up.changes) !== 1) return { processed: true, status: 'CLAIM_LOST', error: 'finalización tardía: el claim fue reconciliado por otro proceso (sin doble contabilización)' }
        this.db.prepare('UPDATE campaigns SET skipped_count = skipped_count + 1 WHERE id = ?').run(campaignId)
        return { processed: true, status: 'ABORTED_LOCK_ACTIVE' }
      }

      // 2. Fail-Closed estricto: si 2A dio error o timeout, NUNCA despachar
      const up = this.db.prepare(`
        UPDATE campaign_items
        SET status = 'SKIPPED_LOCK_UNAVAILABLE', lock_checked_at = ?, error_reason = ?
        WHERE id = ? AND status = 'DISPATCHING' AND claimed_by = ?
      `).run(checkNow, lockRes.error || 'Servicio de locks 2A no disponible (Fail-Closed)', nextItem.id, this.workerId)
      if (Number(up.changes) !== 1) return { processed: true, status: 'CLAIM_LOST', error: 'finalización tardía: el claim fue reconciliado por otro proceso (sin doble contabilización)' }
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
      const up = this.db.prepare(`
        UPDATE campaign_items
        SET status = 'ABORTED_CAMPAIGN_NOT_RUNNING', error_reason = ?
        WHERE id = ? AND status = 'DISPATCHING' AND claimed_by = ?
      `).run(`Campaña en estado ${freshCampaign?.status ?? 'inexistente'} al momento del despacho (pausa/cancelación respetadas)`, nextItem.id, this.workerId)
      // (hallazgo 8) contador condicional: solo si la fila transitó.
      if (Number(up.changes) === 1) {
        this.db.prepare('UPDATE campaigns SET skipped_count = skipped_count + 1 WHERE id = ?').run(campaignId)
      }
      return { processed: true, status: 'ABORTED_CAMPAIGN_NOT_RUNNING' }
    }

    // F0-bis. B4 — VERIFICACIÓN 2/2 (PRE-DESPACHO, contra estado PERSISTENTE):
    // la organización VIGENTE del ítem en BD debe existir y coincidir con la
    // organización vigente de la campaña (la copia en memoria del claim es
    // insuficiente: la identidad puede haber cambiado/corrupto durante los
    // chequeos asíncronos). Sin identidad o ajena → CUARENTENA (jamás
    // despacho, jamás reintento automático).
    const freshItemOrg = this.db.prepare('SELECT organization_id FROM campaign_items WHERE id = ?').get(nextItem.id) as { organization_id: string | null } | undefined
    if (!freshItemOrg?.organization_id || freshItemOrg.organization_id !== freshCampaign.organization_id) {
      const up = this.db.prepare(`
        UPDATE campaign_items
        SET status = 'QUARANTINED_NO_ORG', error_reason = ?
        WHERE id = ? AND status = 'DISPATCHING' AND claimed_by = ?
      `).run(
        `CUARENTENA B4: organización vigente del ítem (${freshItemOrg?.organization_id ?? 'NULL'}) ausente o distinta de la organización vigente de la campaña (${freshCampaign.organization_id}) — sin despacho ni reintento automático`,
        nextItem.id,
        this.workerId
      )
      if (Number(up.changes) === 1) {
        this.db.prepare('UPDATE campaigns SET skipped_count = skipped_count + 1 WHERE id = ?').run(campaignId)
      }
      return { processed: true, status: 'QUARANTINED_NO_ORG' }
    }

    // F0-ter. (hallazgo 9) PACING DURABLE POR ORGANIZACIÓN: el último despacho
    // SENT de ESTA organización (cualquier campaña y CUALQUIER réplica/cola,
    // vía campaign_items.dispatched_at) debe tener al menos minIntervalMs.
    // NO bloquea el procesamiento: informa PACING_DELAY con retryAfterMs — el
    // worker espera el tiempo indicado y reintenta; así reintentos ni varias
    // réplicas pueden evadir el intervalo mínimo.
    if (this.durablePacing) {
      const lastRow = this.db.prepare(`
        SELECT MAX(ci.dispatched_at) AS last_at
        FROM campaign_items ci
        JOIN campaigns c ON c.id = ci.campaign_id
        WHERE c.organization_id = ?
      `).get(freshCampaign.organization_id) as { last_at: number | null }
      const waitMs = this.throttler.pacingDelayFor(lastRow?.last_at ?? null, this.nowMs())
      if (waitMs > 0) {
        // (hallazgo 9) el claim se LIBERA: el ítem vuelve a PENDING (nadie lo
        // despachó) — jamás queda bloqueado en DISPATCHING por un pacing.
        this.releaseClaim(nextItem.id)
        return { processed: false, status: 'PACING_DELAY', error: `Pacing por organización activo (faltan ${waitMs} ms)`, retryAfterMs: waitMs }
      }
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
    // Lease renovable mientras el transporte sigue ejecutando el despacho.
    // La actualización está protegida por estado + propietario: nunca resucita
    // un claim que otra réplica ya haya reconciliado o adquirido.
    const leaseTimer = setInterval(() => {
      try {
        this.db.prepare(`
          UPDATE campaign_items SET claimed_at = ?
          WHERE id = ? AND status = 'DISPATCHING' AND claimed_by = ?
        `).run(Math.floor(this.nowMs() / 1000), nextItem.id, this.workerId)
      } catch (err) {
        console.error('[broadcast-worker] No se pudo renovar lease del despacho', err)
      }
    }, this.claimLeaseRenewIntervalMs)
    leaseTimer.unref?.()
    let dispatchRes: Awaited<ReturnType<Dispatcher['dispatch']>>
    try {
      dispatchRes = await this.dispatcher.dispatch(phone, renderedText, campaign.organizationId)
    } finally {
      clearInterval(leaseTimer)
    }
    const dispatchTime = Math.floor(this.nowMs() / 1000)

    if (dispatchRes.success) {
      // Guard: solo el worker que reclama escribe el resultado (multi-réplica seguro).
      // (hallazgo 8) el CONTADOR (y fatiga/pacing) SOLO se actualiza si la
      // transición afectó REALMENTE la fila: en finalización tardía (claim ya
      // reconciliado por otro proceso, p.ej. despacho >900s con evento pausado)
      // la fila está en UNCERTAIN_DISPATCH — exige resolución humana, jamás se
      // contabiliza como SENT ni se duplica la entrega por otro camino.
      const up = this.db.prepare(`
        UPDATE campaign_items
        SET status = 'SENT', dispatched_at = ?, message_id = ?
        WHERE id = ? AND status = 'DISPATCHING' AND claimed_by = ?
      `).run(dispatchTime, dispatchRes.messageId || null, nextItem.id, this.workerId)

      if (Number(up.changes) !== 1) {
        console.warn(
          `[broadcast-worker] CLAIM_LOST en finalización de despacho (ítem=${nextItem.id}, worker=${this.workerId}): el claim fue reconciliado durante el despacho — sin doble contabilización ni reenvío; la fila exige reconciliación humana`
        )
        return { processed: true, status: 'CLAIM_LOST', error: 'finalización tardía: el claim fue reconciliado por otro proceso (sin doble contabilización)' }
      }

      this.db.prepare('UPDATE campaigns SET sent_count = sent_count + 1 WHERE id = ?').run(campaignId)
      this.fatigueManager.recordBroadcast(phone, campaignId, campaign.organizationId)
      this.throttler.registerDispatch()

      return { processed: true, status: 'SENT' }
    } else if (dispatchRes.uncertain) {
      // RESULTADO INCIERTO (timeout / desconexión): el daemon pudo haber enviado el mensaje.
      // REGLA OBLIGATORIA: Bloquear reintentos automáticos a ciegas para impedir duplicidad en WhatsApp.
      const up = this.db.prepare(`
        UPDATE campaign_items
        SET status = 'UNCERTAIN_DISPATCH', error_reason = ?
        WHERE id = ? AND status = 'DISPATCHING' AND claimed_by = ?
      `).run(dispatchRes.error || 'Resultado incierto de despacho (Requiere reconciliación previa)', nextItem.id, this.workerId)

      // (hallazgo 8) contador condicional: sin doble contabilización si el claim se perdió.
      if (Number(up.changes) === 1) {
        this.db.prepare('UPDATE campaigns SET failed_count = failed_count + 1 WHERE id = ?').run(campaignId)
        return { processed: true, status: 'UNCERTAIN_DISPATCH', error: dispatchRes.error }
      }
      return { processed: true, status: 'CLAIM_LOST', error: 'finalización tardía: el claim fue reconciliado por otro proceso (sin doble contabilización)' }
    } else {
      // Fallo confirmado por el daemon / transport:
      // Si el fallo es permanente (rechazo 4xx, credencial inválida, etc.), no reintentar a ciegas.
      const isPermanent = isPermanentDispatchFailure(dispatchRes.error)
      const isRetryable = !isPermanent && nextItem.retryCount < 2
      const newStatus = isRetryable ? 'FAILED_RETRYABLE' : 'FAILED_FATAL'

      const up = this.db.prepare(`
        UPDATE campaign_items
        SET status = ?, error_reason = ?, retry_count = retry_count + 1
        WHERE id = ? AND status = 'DISPATCHING' AND claimed_by = ?
      `).run(newStatus, dispatchRes.error || 'Fallo de despacho saliente confirmado', nextItem.id, this.workerId)

      // (hallazgo 8) contador condicional: sin doble contabilización si el claim se perdió.
      if (Number(up.changes) === 1) {
        this.db.prepare('UPDATE campaigns SET failed_count = failed_count + 1 WHERE id = ?').run(campaignId)
        return { processed: true, status: newStatus, error: dispatchRes.error }
      }
      return { processed: true, status: 'CLAIM_LOST', error: 'finalización tardía: el claim fue reconciliado por otro proceso (sin doble contabilización)' }
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
    // B4 — VERIFICACIÓN 1/2 (CLAIM): la organización del ítem debe existir y
    // coincidir con la de la campaña. Filas organization_id NULL (históricas
    // sin identidad) o de OTRA organización JAMÁS se reclaman.
    const campaignOrg = this.db.prepare('SELECT organization_id FROM campaigns WHERE id = ?').get(campaignId) as
      | { organization_id: string }
      | undefined
    if (!campaignOrg?.organization_id) return { claimed: false }

    // (fusión integral) política de reintentos acotada: FAILED_RETRYABLE se
    // vuelve a reclamar hasta 3 intentos; el tercero lo vuelve FAILED_FATAL
    // (permanente). UNCERTAIN_DISPATCH JAMÁS se reclaima automáticamente
    // (exige reconciliación explícita). Los guards B4 de organización se
    // mantienen intactos en ambas consultas.
    const candidate = this.db.prepare(`
      SELECT id FROM campaign_items
      WHERE campaign_id = ?
        AND (status = 'PENDING' OR (status = 'FAILED_RETRYABLE' AND retry_count < 3))
        AND organization_id IS NOT NULL AND organization_id = ?
      ORDER BY CASE WHEN status = 'PENDING' THEN 0 ELSE 1 END, rowid ASC
      LIMIT 1
    `).get(campaignId, campaignOrg.organization_id) as { id: string } | undefined

    if (!candidate) return { claimed: false }

    const now = Math.floor(Date.now() / 1000)
    const claimRes = this.db.prepare(`
      UPDATE campaign_items
      SET status = 'DISPATCHING', claimed_by = ?, claimed_at = ?
      WHERE id = ?
        AND (status = 'PENDING' OR (status = 'FAILED_RETRYABLE' AND retry_count < 3))
        AND organization_id IS NOT NULL AND organization_id = ?
    `).run(this.workerId, now, candidate.id, campaignOrg.organization_id)

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
      organizationId: r.organization_id || undefined,
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
   * (hallazgo 10) Reanudación AUTOMÁTICA de campañas pausadas EXCLUSIVAMENTE
   * por cooldown DURABLE vencido. Solo toca PAUSED_COOLDOWN con timestamp
   * vencido (jamás pausas manuales ni estados terminales). Si reanudó algo,
   * reinicia el contador de lote del Throttler (el lote causante ya consumió
   * su cooldown): sin esto, isCooldownNeeded() seguiría true y nada avanzaría.
   */
  resumeCooldownExpiredCampaigns(): { resumed: number } {
    const res = resumeCooldownExpiredCampaigns(this.db, this.throttler.options.cooldownMs)
    if (res.resumed > 0) {
      this.throttler.resetCooldown()
    }
    return res
  }

  /**
   * Reconciliación CONTROLADA (nunca reintento ciego):
   * mueve a UNCERTAIN_DISPATCH los ítems DISPATCHING con claims expirados
   * (worker muerto sin pasar por recoverFromCrash). No los devuelve a PENDING jamás;
   * exigen resolución humana o del proceso de reconciliación autorizado.
   */
  reconcileStaleClaims(maxAgeSeconds: number = 900): { reconciledCount: number } {
    const cutoff = Math.floor(this.nowMs() / 1000) - maxAgeSeconds
    const res = this.db.prepare(`
      UPDATE campaign_items
      SET status = 'UNCERTAIN_DISPATCH',
          error_reason = 'Claim de worker expirado (reconciliación controlada — resultado incierto, requiere resolución manual)'
      WHERE status = 'DISPATCHING' AND claimed_at IS NOT NULL AND claimed_at < ?
    `).run(cutoff)
    return { reconciledCount: Number(res.changes) }
  }

  /**
   * B4 — CUARENTENA de ítems SIN identidad válida: toda fila campaign_items
   * en estado activo (PENDING/DISPATCHING) con organization_id NULL o con una
   * organización DISTINTA de la de SU campaña se marca QUARANTINED_NO_ORG:
   * jamás se reclama ni despacha, y NO se reintenta automáticamente (exige
   * resolución humana). Idempotente; se ejecuta en el arranque
   * (recoverFromCrash) y al drenar la cola.
   */
  quarantineOrglessItems(): { quarantined: number } {
    const res = this.db.prepare(`
      UPDATE campaign_items
      SET status = 'QUARANTINED_NO_ORG',
          error_reason = COALESCE(NULLIF(error_reason, '') || ' | ', '') || 'CUARENTENA B4: ítem sin organización o con organización ajena a su campaña — sin identidad no se despacha ni se reintenta'
      WHERE status IN ('PENDING', 'DISPATCHING')
        AND (
          organization_id IS NULL
          OR organization_id != (SELECT c.organization_id FROM campaigns c WHERE c.id = campaign_items.campaign_id)
        )
    `).run()
    return { quarantined: Number(res.changes) }
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
    const staleCutoff = Math.floor(this.nowMs() / 1000) - 900
    const result = this.db.prepare(`
      UPDATE campaign_items
      SET status = 'UNCERTAIN_DISPATCH', error_reason = 'Proceso interrumpido durante despacho (Resultado Incierto - Bloqueado contra reenvío ciego)'
      WHERE status = 'DISPATCHING' AND (claimed_at IS NULL OR claimed_at < ?)
    `).run(staleCutoff)

    // B4: los ítems sin organización quedan en CUARENTENA (nunca se reintentan)
    const quarantined = this.quarantineOrglessItems()

    return { recoveredCount: Number(result.changes), quarantinedCount: quarantined.quarantined }
  }
}
