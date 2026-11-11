/**
 * persistent-worker.ts — PROCESO PERSISTENTE de Capa 2B
 * (OLEADA 2: procesos persistentes ULTRA — decisión de negocio 2026-11-11).
 *
 * Hasta ahora `BroadcastEngine.processNextItem(campaignId)` solo se invocaba
 * de forma puntual (API/piloto): la cola no avanzaba sin un llamador externo.
 * Este módulo añade el bucle PERSISTENTE que convierte ULTRA en un servicio:
 *
 *   - `runOnce()`  → un tick: mantenimiento (reconciliación de claims
 *                    expirados + cuarentena B4) y consumo ROUND-ROBIN de
 *                    campañas RUNNING agrupadas por organización (equidad
 *                    multi-empresa: una org con 1000 ítems no espera detrás
 *                    de otra con 10).
 *   - `start()`    → bucle por intervalo con guard de solapamiento (un tick
 *                    largo jamás encadena otro encima de sí mismo).
 *   - `stop()`     → parada graciosa: deja de programar y espera el tick en
 *                    vuelo (los ítems DISPATCHING terminan su ciclo).
 *
 * REGLAS QUE EL WORKER NO ROMPE (heredadas, verificadas en pruebas):
 *   - NO auto-arranca campañas DRAFT (la puesta en marcha es una decisión
 *     explícita de la org vía API; el worker solo consume RUNNING).
 *   - NO reanuda campañas PAUSED_* (PAUSED / PAUSED_OFF_HOURS / PAUSED_COOLDOWN)
 *     por su cuenta (pausas respetadas; las transiciones de estado siguen siendo
 *     CONDICIONALES vía transitionCampaignStatus).
 *   - Cada despacho pasa por processNextItem: claim atómico, supresión JIT,
 *     lock 2A JIT, re-check de estado/ownership pre-despacho, cuarentena B4
 *     y clasificación honesta SENT/UNCERTAIN/FAILED.
 */
import type { BroadcastEngine } from './broadcast-worker.ts'

export interface TickSummary {
  tickAt: number
  durationMs: number
  /** Campañas visitadas en este tick (id → organización). */
  campaignsVisited: Array<{ campaignId: string; organizationId: string; itemsProcessed: number }>
  reconciledStaleClaims: number
  quarantinedOrgless: number
  /** Conteo por resultado de ítem (SENT, UNCERTAIN_DISPATCH, …). */
  itemOutcomes: Record<string, number>
  errors: string[]
}

export interface PersistentWorkerOptions {
  engine: BroadcastEngine
  /** Intervalo entre ticks (ms). Default 5_000; mínimo 250. */
  tickIntervalMs?: number
  /** Máximo de ítems por campaña y tick (equidad intra-org). Default 5. */
  itemsPerCampaignPerTick?: number
  /** Máximo de campañas distintas atendidas por tick. Default 20. */
  maxCampaignsPerTick?: number
  /** Antigüedad (s) a partir de la cual un claim DISPATCHING se reconcilia. Default 900. */
  staleClaimSeconds?: number
  /** Reloj inyectable (pruebas de horario comercial). Default: hora actual. */
  now?: () => Date
  logger?: (line: string) => void
}

export class PersistentBroadcastWorker {
  private engine: BroadcastEngine
  private tickIntervalMs: number
  private itemsPerCampaignPerTick: number
  private maxCampaignsPerTick: number
  private staleClaimSeconds: number
  private now: () => Date
  private logger: (line: string) => void

  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight: Promise<TickSummary> | null = null
  private ticksStarted = 0
  private stopped = false

  constructor(options: PersistentWorkerOptions) {
    this.engine = options.engine
    this.tickIntervalMs = Math.max(250, options.tickIntervalMs ?? 5_000)
    this.itemsPerCampaignPerTick = Math.max(1, options.itemsPerCampaignPerTick ?? 5)
    this.maxCampaignsPerTick = Math.max(1, options.maxCampaignsPerTick ?? 20)
    this.staleClaimSeconds = Math.max(30, options.staleClaimSeconds ?? 900)
    this.now = options.now ?? (() => new Date())
    this.logger = options.logger ?? (() => {})
  }

  /** Campañas RUNNING (FIFO por arranque). DRAFT/PAUSED* jamás se consumen aquí. */
  listDispatchableCampaigns(): Array<{ id: string; organizationId: string }> {
    const db = (this.engine as unknown as { db: import('node:sqlite').DatabaseSync }).db
    const rows = db.prepare(`
      SELECT id, organization_id FROM campaigns
      WHERE status = 'RUNNING'
      ORDER BY COALESCE(started_at, created_at) ASC, id ASC
    `).all() as Array<{ id: string; organization_id: string }>
    return rows.map((r) => ({ id: r.id, organizationId: r.organization_id }))
  }

  /**
   * Orden ROUND-ROBIN entre organizaciones: intercala las campañas por org
   * (primera campaña de cada org, luego la segunda de cada org, …) para que
   * ninguna empresa monopolice el worker. Preserva FIFO dentro de cada org.
   */
  private interleaveByOrg(campaigns: Array<{ id: string; organizationId: string }>): Array<{ id: string; organizationId: string }> {
    const byOrg = new Map<string, Array<{ id: string; organizationId: string }>>()
    for (const c of campaigns) {
      const list = byOrg.get(c.organizationId) ?? []
      list.push(c)
      byOrg.set(c.organizationId, list)
    }
    const order: Array<{ id: string; organizationId: string }> = []
    let added = true
    while (added) {
      added = false
      for (const list of byOrg.values()) {
        const next = list.shift()
        if (next) {
          order.push(next)
          added = true
        }
      }
    }
    return order
  }

  /** UN tick del worker: mantenimiento + consumo. Concurrency-safe (1 a la vez). */
  async runOnce(): Promise<TickSummary> {
    if (this.inFlight) return this.inFlight
    this.ticksStarted++
    const startedAt = Date.now()
    // Arrays FRESCOS por tick (jamás spread de constantes: los arrays se
    // compartirían por referencia entre workers y tests).
    const summary: TickSummary = {
      tickAt: Math.floor(startedAt / 1000),
      durationMs: 0,
      campaignsVisited: [],
      reconciledStaleClaims: 0,
      quarantinedOrgless: 0,
      itemOutcomes: {},
      errors: [],
    }
    this.inFlight = (async () => {
      try {
        // 1. Mantenimiento: claims expirados → UNCERTAIN_DISPATCH (resultado
        //    incierto, JAMÁS reintento a ciegas) y cuarentena B4.
        const reconciled = this.engine.reconcileStaleClaims(this.staleClaimSeconds)
        const quarantined = this.engine.quarantineOrglessItems()
        summary.reconciledStaleClaims = reconciled.reconciledCount
        summary.quarantinedOrgless = quarantined.quarantined

        // 2. Consumo round-robin por organización.
        const campaigns = this.interleaveByOrg(this.listDispatchableCampaigns())
          .slice(0, this.maxCampaignsPerTick)

        for (const campaign of campaigns) {
          let processedForCampaign = 0
          for (let i = 0; i < this.itemsPerCampaignPerTick; i++) {
            let res
            try {
              res = await this.engine.processNextItem(campaign.id, this.now())
            } catch (err) {
              // Un error inesperado de UNA campaña no detiene al worker ni a
              // las demás organizaciones (aislamiento de fallos).
              summary.errors.push(`campaign ${campaign.id}: ${err instanceof Error ? err.message : String(err)}`)
              break
            }
            if (!res.processed) break // cola drenada, pausada, completada o en vuelo
            processedForCampaign++
            summary.itemOutcomes[res.status ?? 'UNKNOWN'] = (summary.itemOutcomes[res.status ?? 'UNKNOWN'] ?? 0) + 1
            // Una campaña pausada/enfriada a mitad de tick deja de consumirse.
            if (res.status && res.status.startsWith('PAUSED')) break
          }
          if (processedForCampaign > 0) {
            summary.campaignsVisited.push({ campaignId: campaign.id, organizationId: campaign.organizationId, itemsProcessed: processedForCampaign })
          }
        }

        summary.durationMs = Date.now() - startedAt
        const outcomeLine = Object.entries(summary.itemOutcomes).map(([k, v]) => `${k}=${v}`).join(' ') || 'sin ítems'
        this.logger(`[worker 2B] tick=${summary.tickAt} campañas=${summary.campaignsVisited.length} reconciliados=${summary.reconciledStaleClaims} cuarentena=${summary.quarantinedOrgless} ${outcomeLine}${summary.errors.length ? ` errores=${summary.errors.length}` : ''}`)
        return summary
      } finally {
        this.inFlight = null
      }
    })()
    return this.inFlight
  }

  /** Arranca el bucle persistente. Idempotente. El intervalo no bloquea el exit del proceso. */
  start(): void {
    if (this.timer) return
    this.stopped = false
    this.timer = setInterval(() => {
      if (this.inFlight) return // guard de solapamiento
      void this.runOnce().catch((err) => this.logger(`[worker 2B] error de tick: ${err instanceof Error ? err.message : String(err)}`))
    }, this.tickIntervalMs)
    ;(this.timer as unknown as { unref?: () => void }).unref?.()
    this.logger(`[worker 2B] bucle persistente iniciado (intervalo=${this.tickIntervalMs}ms, ítems/campaña/tick=${this.itemsPerCampaignPerTick})`)
  }

  /** Parada graciosa: deja de programar y ESPERA el tick en vuelo. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.inFlight) {
      try { await this.inFlight } catch { /* el error ya quedó logueado */ }
    }
    this.logger('[worker 2B] bucle persistente detenido (parada graciosa)')
  }

  get isRunning(): boolean { return this.timer !== null }
  get tickCount(): number { return this.ticksStarted }
  get wasStopped(): boolean { return this.stopped }
}
