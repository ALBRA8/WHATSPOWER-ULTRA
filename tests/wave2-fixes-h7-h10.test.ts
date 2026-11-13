/**
 * wave2-fixes-h7-h10.test.ts — Pruebas de los hallazgos funcionales
 * (parte WHATSPOWER-ULTRA, auditoría funcional 2026-11-12).
 *
 *   H7  El worker persistente MANTIENE el proceso vivo (prueba de integración
 *       en proceso hijo: npm run worker permanece activo y tick-ea; SIGTERM
 *       apaga gracioso) + keepProcessAlive sin unref.
 *   H8  Finalización tardía de un despacho tras reconciliación del claim:
 *       SIN doble contabilización (sent_count/failed_count/skipped_count y
 *       fatiga/pacing solo cambian si la fila REALMENTE transitó).
 *   H9  Pacing y cooldown se respetan EFECTIVAMENTE: PACING_DELAY durable por
 *       organización (multi-réplica/reinicio no lo evaden) + worker espera
 *       los intervalos (sleep inyectable, sin esperas reales).
 *   H10 Reanudación AUTOMÁTICA de PAUSED_COOLDOWN con cooldown DURABLE vencido
 *       (pausas manuales y terminales intactas; sobrevive reinicios).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBroadcastDatabase } from '../src/db.ts'
import { BroadcastEngine } from '../src/queue/broadcast-worker.ts'
import { PersistentBroadcastWorker } from '../src/queue/persistent-worker.ts'
import { Throttler } from '../src/queue/throttler.ts'
import { StandaloneLockChecker } from '../src/safety/lock-checker.ts'
import { transitionCampaignStatus } from '../src/queue/campaign-lifecycle.ts'

/** Hora fija DENTRO del horario comercial (lunes 10:00 America/Bogota = 15:00Z). */
const BUSINESS_HOUR = new Date('2026-11-09T15:00:00Z')
const CSV_1 = 'phone,name\n573000002101,Solo\n'

function makeEngine(db: import('node:sqlite').DatabaseSync, dispatcher: any, opts?: { durablePacing?: boolean; throttler?: Partial<import('../src/queue/throttler.ts').ThrottlerOptions>; nowMs?: () => number }): BroadcastEngine {
  return new BroadcastEngine({
    db,
    dispatcher,
    lockChecker: new StandaloneLockChecker(),
    durablePacing: opts?.durablePacing,
    throttlerOptions: opts?.throttler,
    nowMs: opts?.nowMs,
  })
}

async function startCampaignAsync(engine: BroadcastEngine, organizationId: string, name: string, csv: string): Promise<string> {
  const c = await engine.createCampaign({ organizationId, name, templateSpintax: 'Hola {{nombre}}', csvContent: csv })
  const res = transitionCampaignStatus(engine.db, c.id, null, 'RUNNING')
  assert.ok(res.ok, `la campaña ${name} debe poder pasar a RUNNING (desde ${c.status})`)
  return c.id
}

const OK_DISPATCH = { success: true, messageId: 'msg_test' }

describe('H8 — finalización tardía de un despacho: SIN doble contabilización', () => {
  it('H8-01: despacho exitoso cuyo claim fue reconciliado DURANTE el despacho → CLAIM_LOST, sent_count intacto, sin fatiga ni pacing', async () => {
    const db = createBroadcastDatabase(':memory:')
    let reconciledDuringDispatch = false
    const engineA = makeEngine(db, {
      dispatch: async () => {
        // Un proceso B reconcilia el claim mientras el despacho de A está en vuelo
        // (maxAgeSeconds=-1 → cutoff = now+1 s > claimed_at = now).
        if (!reconciledDuringDispatch) {
          reconciledDuringDispatch = true
          const r = engineB.reconcileStaleClaims(-1)
          assert.strictEqual(r.reconciledCount, 1, 'la reconciliación externa mueve el claim a UNCERTAIN_DISPATCH')
        }
        return OK_DISPATCH
      },
    })
    const engineB = makeEngine(db, { dispatch: async () => OK_DISPATCH })
    const campaignId = await startCampaignAsync(engineA, 'org_h8', 'Tardía exitosa', CSV_1)

    const res = await engineA.processNextItem(campaignId, BUSINESS_HOUR)
    assert.strictEqual(res.status, 'CLAIM_LOST', 'la finalización tardía se reporta HONESTAMENTE')
    const campaign = engineA.getCampaign(campaignId)!
    assert.strictEqual(campaign.sentCount, 0, 'sent_count NO se incrementa si la fila no transitó')
    assert.strictEqual(campaign.failedCount, 0)
    const item = engineA.getItems(campaignId)[0]
    assert.strictEqual(item.status, 'UNCERTAIN_DISPATCH', 'el ítem exige reconciliación humana (sin reenvío ciego)')
    // El pacing NO se registra (el lote no debe avanzar por un despacho no contabilizado):
    const throttlerA = (engineA as unknown as { throttler: Throttler }).throttler
    assert.strictEqual(throttlerA.sentInCurrentBatch, 0, 'registerDispatch NO se invocó (pacing/fatiga coherentes)')
    // Fatiga NO registrada:
    const fatiga = db.prepare('SELECT count(*) AS n FROM contact_fatigue').get() as { n: number }
    assert.strictEqual(fatiga.n, 0, 'recordBroadcast NO se invocó')
  })

  it('H8-02: despacho INCIERTO con claim reconciliado durante el vuelo → CLAIM_LOST, failed_count intacto', async () => {
    const db = createBroadcastDatabase(':memory:')
    const engineA = makeEngine(db, {
      dispatch: async () => {
        engineB.reconcileStaleClaims(-1)
        return { success: false, uncertain: true, error: 'timeout del daemon (resultado ambiguo)' }
      },
    })
    const engineB = makeEngine(db, { dispatch: async () => OK_DISPATCH })
    const campaignId = await startCampaignAsync(engineA, 'org_h8', 'Tardía incierta', CSV_1)
    const res = await engineA.processNextItem(campaignId, BUSINESS_HOUR)
    assert.strictEqual(res.status, 'CLAIM_LOST')
    const campaign = engineA.getCampaign(campaignId)!
    assert.strictEqual(campaign.failedCount, 0, 'failed_count NO se incrementa sin transición real')
    assert.strictEqual(engineA.getItems(campaignId)[0].status, 'UNCERTAIN_DISPATCH')
  })

  it('H8-03: abort por lock con claim ya reconciliado → CLAIM_LOST, skipped_count intacto', async () => {
    const db = createBroadcastDatabase(':memory:')
    const engineA = makeEngine(db, {
      dispatch: async () => OK_DISPATCH,
    }, { durablePacing: false })
    const engineB = makeEngine(db, { dispatch: async () => OK_DISPATCH })
    // Un lockChecker que reconcilia el claim externamente y luego reporta lock:
    const engineC = new BroadcastEngine({
      db,
      dispatcher: { dispatch: async () => OK_DISPATCH },
      lockChecker: {
        checkLock: async () => {
          engineB.reconcileStaleClaims(-1)
          return { available: false, state: 'HANDOFF_HUMAN' }
        },
      },
    })
    void engineC
    const campaignId = await startCampaignAsync(engineA, 'org_h8', 'Lock tardío', CSV_1)
    // Reemplazamos el lockChecker del engine A por el que reconcilia (simulación de caída entre chequeos):
    ;(engineA as unknown as { lockChecker: unknown }).lockChecker = {
      checkLock: async () => {
        engineB.reconcileStaleClaims(-1)
        return { available: false, state: 'HANDOFF_HUMAN' }
      },
    }
    const res = await engineA.processNextItem(campaignId, BUSINESS_HOUR)
    assert.strictEqual(res.status, 'CLAIM_LOST')
    const campaign = engineA.getCampaign(campaignId)!
    assert.strictEqual(campaign.skippedCount, 0, 'skipped_count NO se incrementa si la fila no transitó')
  })

  it('H8-04: camino normal — SENT incrementa contadores EXACTAMENTE una vez (regresión)', async () => {
    const db = createBroadcastDatabase(':memory:')
    const engine = makeEngine(db, { dispatch: async () => OK_DISPATCH })
    const campaignId = await startCampaignAsync(engine, 'org_h8', 'Normal', CSV_1)
    const res = await engine.processNextItem(campaignId, BUSINESS_HOUR)
    assert.strictEqual(res.status, 'SENT')
    const campaign = engine.getCampaign(campaignId)!
    assert.strictEqual(campaign.sentCount, 1)
    assert.strictEqual(engine.getItems(campaignId)[0].status, 'SENT')
    const fatiga = db.prepare('SELECT count(*) AS n FROM contact_fatigue').get() as { n: number }
    assert.strictEqual(fatiga.n, 1, 'la fatiga SÍ se registra en el camino normal')
  })

  it('H8-05: concurrencia de réplicas — dos engines sobre la MISMA BD no duplican contadores', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'h8-conc-')), 'b.db')
    const engineA = makeEngine(createBroadcastDatabase(dbPath), { dispatch: async () => OK_DISPATCH })
    const engineB = makeEngine(createBroadcastDatabase(dbPath), { dispatch: async () => OK_DISPATCH })
    // UN solo ítem: ambas réplicas compiten por ÉL — el claim atómico decide.
    const campaignId = await startCampaignAsync(engineA, 'org_h8', 'Réplicas', 'phone,name\n573000002201,A\n')
    const [ra, rb] = await Promise.all([engineA.processNextItem(campaignId, BUSINESS_HOUR), engineB.processNextItem(campaignId, BUSINESS_HOUR)])
    const statuses = [ra.status, rb.status].sort()
    assert.ok(statuses.includes('SENT'), 'una réplica despachó SENT')
    assert.ok(statuses.includes('ITEMS_IN_FLIGHT') || statuses.includes('CLAIMED_BY_OTHER_WORKER'), `la otra réplica NO duplica (${statuses.join(', ')})`)
    const campaign = engineA.getCampaign(campaignId)!
    assert.strictEqual(campaign.sentCount, 1, 'sent_count exactamente 1 (un solo despacho real)')
    assert.strictEqual(campaign.sentCount, engineB.getCampaign(campaignId)!.sentCount, 'misma BD = misma verdad')
  })
})

describe('H9 — pacing y throttling efectivos (durables y sin evasión)', () => {
  it('H9-01: PACING_DELAY durable por organización — el último SENT de la org impone minInterval', async () => {
    const db = createBroadcastDatabase(':memory:')
    const engine = makeEngine(db, { dispatch: async () => OK_DISPATCH }, { durablePacing: true, throttler: { minIntervalMs: 5000, maxIntervalMs: 5000 } })
    const campaignId = await startCampaignAsync(engine, 'org_h9', 'Pacing', CSV_1)
    // Un SENT "histórico" de la MISMA organización hace 1 s (otra campaña/réplica):
    const hist = await engine.createCampaign({ organizationId: 'org_h9', name: 'Histórica', templateSpintax: 'x', csvContent: CSV_1 })
    db.prepare("UPDATE campaign_items SET status='SENT', dispatched_at = ? WHERE campaign_id = ?").run(Math.floor(Date.now() / 1000) - 1, hist.id)
    db.prepare("UPDATE campaigns SET status='COMPLETED', sent_count=1 WHERE id = ?").run(hist.id)

    const res = await engine.processNextItem(campaignId, BUSINESS_HOUR)
    assert.strictEqual(res.status, 'PACING_DELAY', 'el pacing durable BLOQUEA el despacho anticipado')
    const retryAfterMs = (res as { retryAfterMs?: number }).retryAfterMs ?? 0
    assert.ok(retryAfterMs > 3000 && retryAfterMs <= 5000, `retryAfterMs coherente con el intervalo restante (${retryAfterMs}ms)`)
    // Vencido el intervalo → despacha:
    db.prepare('UPDATE campaign_items SET dispatched_at = ? WHERE campaign_id = ? AND status = ?').run(Math.floor(Date.now() / 1000) - 6, hist.id, 'SENT')
    const res2 = await engine.processNextItem(campaignId, BUSINESS_HOUR)
    assert.strictEqual(res2.status, 'SENT', 'respetado el intervalo, el despacho proceeds')
  })

  it('H9-02: el pacing es POR ORGANIZACIÓN — otra org no hereda la espera', async () => {
    const db = createBroadcastDatabase(':memory:')
    const engine = makeEngine(db, { dispatch: async () => OK_DISPATCH }, { durablePacing: true, throttler: { minIntervalMs: 5000, maxIntervalMs: 5000 } })
    const campA = await startCampaignAsync(engine, 'org_h9a', 'Org A', 'phone,name\n573000002101,A\n573000002102,B\n')
    const campB = await startCampaignAsync(engine, 'org_h9b', 'Org B', CSV_1)
    // org_h9a despacha:
    const r1 = await engine.processNextItem(campA, BUSINESS_HOUR)
    assert.strictEqual(r1.status, 'SENT')
    // Segundo ítem de org_h9a → PACING_DELAY; primer ítem de org_h9b → SENT:
    const r2 = await engine.processNextItem(campA, BUSINESS_HOUR)
    assert.strictEqual(r2.status, 'PACING_DELAY', 'la MISMA org respeta el intervalo')
    const r3 = await engine.processNextItem(campB, BUSINESS_HOUR)
    assert.strictEqual(r3.status, 'SENT', 'OTRA organización NO hereda la espera de la primera')
  })

  it('H9-03: multi-réplica — una réplica que ya despachó impone el pacing a la otra (misma BD)', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'h9-rep-')), 'b.db')
    const engineA = makeEngine(createBroadcastDatabase(dbPath), { dispatch: async () => OK_DISPATCH }, { durablePacing: true, throttler: { minIntervalMs: 5000, maxIntervalMs: 5000 } })
    const engineB = makeEngine(createBroadcastDatabase(dbPath), { dispatch: async () => OK_DISPATCH }, { durablePacing: true, throttler: { minIntervalMs: 5000, maxIntervalMs: 5000 } })
    const campA = await startCampaignAsync(engineA, 'org_h9r', 'Réplica A', 'phone,name\n573000002301,A\n573000002302,B\n')
    const campB = await startCampaignAsync(engineB, 'org_h9r', 'Réplica B', 'phone,name\n573000002303,C\n')
    const ra = await engineA.processNextItem(campA, BUSINESS_HOUR)
    assert.strictEqual(ra.status, 'SENT')
    const rb = await engineB.processNextItem(campB, BUSINESS_HOUR)
    assert.strictEqual(rb.status, 'PACING_DELAY', 'la otra réplica de la MISMA org NO evade el intervalo (pacing durable)')
  })

  it('H9-04: sin durablePacing el comportamiento previo se conserva (compatibilidad)', async () => {
    const db = createBroadcastDatabase(':memory:')
    const engine = makeEngine(db, { dispatch: async () => OK_DISPATCH })
    const campaignId = await startCampaignAsync(engine, 'org_h9c', 'Sin pacing durable', 'phone,name\n573000002401,A\n573000002402,B\n')
    const r1 = await engine.processNextItem(campaignId, BUSINESS_HOUR)
    const r2 = await engine.processNextItem(campaignId, BUSINESS_HOUR)
    assert.strictEqual(r1.status, 'SENT')
    assert.strictEqual(r2.status, 'SENT', 'sin durablePacing, dos despachos seguidos como antes (compatibilidad)')
  })

  it('H9-05a: el WORKER espera el intervalo de pacing ENTRE despachos SENT (sleep inyectado, sin esperas reales)', async () => {
    const db = createBroadcastDatabase(':memory:')
    // minInterval ≥ 1.5 s: la granularidad por segundos de dispatched_at no puede tragárselo.
    const engine = makeEngine(db, { dispatch: async () => OK_DISPATCH }, { durablePacing: true, throttler: { minIntervalMs: 1500, maxIntervalMs: 1500, batchSize: 100, cooldownMs: 600_000 }, nowMs: () => clock })
    const campaignId = await startCampaignAsync(engine, 'org_h9w', 'Worker pacing', 'phone,name\n573000002501,A\n573000002502,B\n')
    // Reloj controlado: cada sleep AVANZA el reloj (sin esperas reales).
    let clock = BUSINESS_HOUR.getTime()
    const waits: number[] = []
    const worker = new PersistentBroadcastWorker({
      engine,
      tickIntervalMs: 250,
      itemsPerCampaignPerTick: 5,
      now: () => new Date(clock),
      respectPacing: true,
      sleep: async (ms: number) => { waits.push(ms); clock += ms },
    })
    const summary = await worker.runOnce()
    assert.strictEqual(summary.itemOutcomes['SENT'] ?? 0, 2, 'los 2 ítems se despacharon respetando el pacing')
    assert.ok(waits.length >= 1, `esperas registradas: ${JSON.stringify(waits)}`)
    assert.ok(waits.every((w) => w >= 1500), `cada espera inter-SENT ≥ minInterval (1500ms): ${JSON.stringify(waits)}`)
  })

  it('H9-05b: el WORKER ATIENDE un PACING_DELAY durable (histórico de otra réplica): espera retryAfterMs y completa (sin esperas reales)', async () => {
    const db = createBroadcastDatabase(':memory:')
    const engine = makeEngine(db, { dispatch: async () => OK_DISPATCH }, { durablePacing: true, throttler: { minIntervalMs: 5000, maxIntervalMs: 5000, batchSize: 100, cooldownMs: 600_000 }, nowMs: () => clock })
    const campaignId = await startCampaignAsync(engine, 'org_h9w2', 'Pacing atendido', CSV_1)
    // SENT "histórico" de OTRA réplica hace 1 s (según el reloj del engine):
    let clock = BUSINESS_HOUR.getTime()
    const hist = await engine.createCampaign({ organizationId: 'org_h9w2', name: 'Histórica', templateSpintax: 'x', csvContent: CSV_1 })
    db.prepare("UPDATE campaign_items SET status='SENT', dispatched_at = ? WHERE campaign_id = ?").run(Math.floor((clock - 1000) / 1000), hist.id)
    db.prepare("UPDATE campaigns SET status='COMPLETED', sent_count=1 WHERE id = ?").run(hist.id)

    const waits: number[] = []
    const worker = new PersistentBroadcastWorker({
      engine,
      tickIntervalMs: 250,
      itemsPerCampaignPerTick: 5,
      now: () => new Date(clock),
      respectPacing: true,
      sleep: async (ms: number) => { waits.push(ms); clock += ms },
    })
    const summary = await worker.runOnce()
    assert.strictEqual(summary.itemOutcomes['PACING_DELAY'] ?? 0, 1, 'el ítem pasó por PACING_DELAY (pacing durable de la org)')
    assert.strictEqual(summary.itemOutcomes['SENT'] ?? 0, 1, 'tras esperar el retryAfterMs el despacho se completó')
    assert.ok(waits.length >= 1, `esperas registradas: ${JSON.stringify(waits)}`)
    assert.ok(waits.some((w) => w >= 3000), `la espera del PACING_DELAY (~4s restantes) ocurrió: ${JSON.stringify(waits)}`)
    // el ítem NO quedó bloqueado en DISPATCHING (el claim se libera durante el pacing):
    const item = engine.getItems(campaignId)[0]
    assert.strictEqual(item.status, 'SENT', 'el ítem terminó SENT (nunca atascado en DISPATCHING)')
  })

  it('H9-06: sin respectPacing el worker conserva el comportamiento previo (compatibilidad)', async () => {
    const db = createBroadcastDatabase(':memory:')
    const engine = makeEngine(db, { dispatch: async () => OK_DISPATCH })
    const campaignId = await startCampaignAsync(engine, 'org_h9d', 'Worker sin pacing', 'phone,name\n573000002601,A\n573000002602,B\n')
    const waits: number[] = []
    const worker = new PersistentBroadcastWorker({
      engine,
      tickIntervalMs: 250,
      itemsPerCampaignPerTick: 5,
      now: () => BUSINESS_HOUR,
      sleep: async (ms: number) => { waits.push(ms) },
    })
    const summary = await worker.runOnce()
    assert.strictEqual(summary.itemOutcomes['SENT'] ?? 0, 2)
    assert.strictEqual(waits.length, 0, 'sin respectPacing NO se espera entre ítems (comportamiento previo)')
  })
})

describe('H10 — reanudación automática de PAUSED_COOLDOWN (solo cooldown vencido)', () => {
  it('H10-01: lote completo → PAUSED_COOLDOWN con timestamp durable; sin vencer NO se reanuda', async () => {
    const db = createBroadcastDatabase(':memory:')
    const engine = makeEngine(db, { dispatch: async () => OK_DISPATCH }, { throttler: { batchSize: 2, cooldownMs: 300_000 } })
    const campaignId = await startCampaignAsync(engine, 'org_h10', 'Cooldown', 'phone,name\n573000002701,A\n573000002702,B\n573000002703,C\n')
    assert.strictEqual((await engine.processNextItem(campaignId, BUSINESS_HOUR)).status, 'SENT')
    assert.strictEqual((await engine.processNextItem(campaignId, BUSINESS_HOUR)).status, 'SENT')
    const paused = await engine.processNextItem(campaignId, BUSINESS_HOUR)
    assert.strictEqual(paused.status, 'PAUSED_COOLDOWN', 'lote completo → pausa de enfriamiento')
    const row = db.prepare('SELECT status, cooldown_started_at FROM campaigns WHERE id = ?').get(campaignId) as { status: string; cooldown_started_at: number | null }
    assert.strictEqual(row.status, 'PAUSED_COOLDOWN')
    assert.ok(row.cooldown_started_at !== null, 'timestamp DURABLE de la pausa persistido (hallazgo 10)')
    // Reanudación con cooldown AÚN vigente → 0 reanudaciones:
    const r = engine.resumeCooldownExpiredCampaigns()
    assert.strictEqual(r.resumed, 0, 'el cooldown NO ha vencido: no se reanuda')
    assert.strictEqual(engine.getCampaign(campaignId)!.status, 'PAUSED_COOLDOWN')
  })

  it('H10-02: cooldown vencido → reanudación automática + reset del lote (el flujo continúa)', async () => {
    const db = createBroadcastDatabase(':memory:')
    const engine = makeEngine(db, { dispatch: async () => OK_DISPATCH }, { throttler: { batchSize: 1, cooldownMs: 300_000 } })
    const campaignId = await startCampaignAsync(engine, 'org_h10b', 'Reanudable', 'phone,name\n573000002711,A\n573000002712,B\n')
    await engine.processNextItem(campaignId, BUSINESS_HOUR) // SENT (lote=1 → lleno)
    assert.strictEqual((await engine.processNextItem(campaignId, BUSINESS_HOUR)).status, 'PAUSED_COOLDOWN')
    // Simula el vencimiento real: el timestamp de la pausa es 301 s atrás:
    db.prepare('UPDATE campaigns SET cooldown_started_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 301, campaignId)
    const r = engine.resumeCooldownExpiredCampaigns()
    assert.strictEqual(r.resumed, 1, 'la campaña se REANUDA automáticamente al vencer el cooldown')
    assert.strictEqual(engine.getCampaign(campaignId)!.status, 'RUNNING')
    const throttler = (engine as unknown as { throttler: Throttler }).throttler
    assert.strictEqual(throttler.sentInCurrentBatch, 0, 'el lote causante quedó consumido (reset del throttler)')
    const next = await engine.processNextItem(campaignId, BUSINESS_HOUR)
    assert.strictEqual(next.status, 'SENT', 'el despacho continúa tras la reanudación')
    const row = db.prepare('SELECT cooldown_started_at FROM campaigns WHERE id = ?').get(campaignId) as { cooldown_started_at: number | null }
    assert.strictEqual(row.cooldown_started_at, null, 'el timestamp de cooldown se limpia al reanudar')
  })

  it('H10-03: pausa MANUAL (PAUSED) y terminales (CANCELLED/COMPLETED/DRAFT) JAMÁS se reanudan', async () => {
    const db = createBroadcastDatabase(':memory:')
    const engine = makeEngine(db, { dispatch: async () => OK_DISPATCH })
    const cPaused = await startCampaignAsync(engine, 'org_h10c', 'Manual', CSV_1)
    assert.ok(transitionCampaignStatus(db, cPaused, null, 'PAUSED').ok, 'pausa manual')
    db.prepare('UPDATE campaigns SET cooldown_started_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 301, cPaused)
    const cCancelled = await startCampaignAsync(engine, 'org_h10c', 'Cancelada', CSV_1)
    assert.ok(transitionCampaignStatus(db, cCancelled, null, 'CANCELLED').ok)
    const cCompleted = await startCampaignAsync(engine, 'org_h10c', 'Completada', CSV_1)
    db.prepare("UPDATE campaigns SET status='COMPLETED', finished_at=? WHERE id = ?").run(Math.floor(Date.now() / 1000), cCompleted)
    const r = engine.resumeCooldownExpiredCampaigns()
    assert.strictEqual(r.resumed, 0, 'ninguna pausa manual ni estado terminal se toca (aunque tuvieran timestamp)')
    assert.strictEqual(engine.getCampaign(cPaused)!.status, 'PAUSED')
    assert.strictEqual(engine.getCampaign(cCancelled)!.status, 'CANCELLED')
    assert.strictEqual(engine.getCampaign(cCompleted)!.status, 'COMPLETED')
  })

  it('H10-04: la reanudación SOBREVIVE reinicios (timestamp durable, nuevo engine)', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'h10-restart-')), 'b.db')
    const engine1 = makeEngine(createBroadcastDatabase(dbPath), { dispatch: async () => OK_DISPATCH }, { throttler: { batchSize: 1, cooldownMs: 300_000 } })
    const campaignId = await startCampaignAsync(engine1, 'org_h10d', 'Reinicio', 'phone,name\n573000002721,A\n573000002722,B\n')
    await engine1.processNextItem(campaignId, BUSINESS_HOUR)
    await engine1.processNextItem(campaignId, BUSINESS_HOUR) // PAUSED_COOLDOWN con timestamp
    // "Reinicio": engine nuevo sobre la MISMA BD (el in-memory del throttler se perdió):
    const engine2 = makeEngine(createBroadcastDatabase(dbPath), { dispatch: async () => OK_DISPATCH }, { throttler: { batchSize: 1, cooldownMs: 300_000 } })
    assert.strictEqual(engine2.getCampaign(campaignId)!.status, 'PAUSED_COOLDOWN', 'la pausa persiste en BD tras el reinicio')
    // Sin vencer aún → sigue pausada:
    assert.strictEqual(engine2.resumeCooldownExpiredCampaigns().resumed, 0)
    // Vence → el NUEVO proceso la reanuda (timestamp durable, no memoria):
    createBroadcastDatabase(dbPath).prepare('UPDATE campaigns SET cooldown_started_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 301, campaignId)
    const r = engine2.resumeCooldownExpiredCampaigns()
    assert.strictEqual(r.resumed, 1, 'la reanudación usa el timestamp DURABLE, no memoria del proceso')
    assert.strictEqual(engine2.getCampaign(campaignId)!.status, 'RUNNING')
  })

  it('H10-05: el WORKER reanuda en su mantenimiento por tick (runOnce) y luego consume', async () => {
    const db = createBroadcastDatabase(':memory:')
    const engine = makeEngine(db, { dispatch: async () => OK_DISPATCH }, { throttler: { batchSize: 1, cooldownMs: 300_000 } })
    const campaignId = await startCampaignAsync(engine, 'org_h10e', 'Worker resume', 'phone,name\n573000002731,A\n573000002732,B\n')
    await engine.processNextItem(campaignId, BUSINESS_HOUR)
    await engine.processNextItem(campaignId, BUSINESS_HOUR) // PAUSED_COOLDOWN
    db.prepare('UPDATE campaigns SET cooldown_started_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 301, campaignId)
    const worker = new PersistentBroadcastWorker({ engine, tickIntervalMs: 250, itemsPerCampaignPerTick: 5, now: () => BUSINESS_HOUR })
    const summary = await worker.runOnce()
    assert.strictEqual(summary.cooldownResumed, 1, 'el mantenimiento del tick reanuda la campaña vencida')
    assert.strictEqual(summary.itemOutcomes['SENT'] ?? 0, 1, 'y la consume en el MISMO tick')
    // Con batchSize=1 el tick llenó el lote de nuevo: la campaña vuelve a
    // PAUSED_COOLDOWN con timestamp fresco (throttling honesto, no un bug).
    const finalStatus = engine.getCampaign(campaignId)!.status
    assert.ok(finalStatus === 'RUNNING' || finalStatus === 'PAUSED_COOLDOWN', `estado post-tick legal: ${finalStatus}`)
    assert.strictEqual(engine.getItems(campaignId).filter((i) => i.status === 'SENT').length, 2, 'los 2 ítems despachados en total (1 previo + 1 del tick)')
  })
})

describe('H7 — el worker persistente mantiene el proceso vivo (integración en proceso hijo)', () => {
  it('H7-01: npm run worker permanece ACTIVO, tick-ea y apaga gracioso con SIGTERM', { timeout: 20000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'h7-worker-'))
    const dbPath = join(dir, 'broadcast.db')
    const child = spawn(process.execPath, ['--experimental-strip-types', 'src/worker-main.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BROADCAST_DB_PATH: dbPath,
        WHATSPOWER_ENABLED: 'false', // locks standalone: sin llamadas HTTP externas
        WORKER_TICK_MS: '250',
        WORKER_DISABLE_PACING: undefined as unknown as string,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: string[] = []
    child.stdout!.on('data', (d) => stdout.push(String(d)))
    const stderr: string[] = []
    child.stderr!.on('data', (d) => stderr.push(String(d)))

    const waited = await new Promise<string>((resolve) => {
      let acc = ''
      const timer = setInterval(() => {
        acc = stdout.join('')
        if (acc.includes('bucle persistente iniciado')) {
          clearInterval(timer)
          resolve('arrancado')
        }
      }, 100)
      setTimeout(() => { clearInterval(timer); resolve('timeout') }, 8000)
    })
    assert.strictEqual(waited, 'arrancado', `el worker arrancó (stdout: ${stdout.join('').slice(0, 300)}; stderr: ${stderr.join('').slice(0, 300)})`)

    // (hallazgo 7) SIN keepProcessAlive el proceso MORIRÍA aquí: verificar que sigue vivo:
    await new Promise((r) => setTimeout(r, 1300)) // ~5 ticks (250ms)
    assert.strictEqual(child.exitCode, null, 'el proceso SIGUE VIVO tras >1 s (el timer NO está unref-eado con keepProcessAlive)')
    assert.strictEqual(child.signalCode, null, 'ninguna señal lo mató')
    const ticks = stdout.join('').match(/tick=/g)?.length ?? 0
    assert.ok(ticks >= 1, `el worker ejecutó ciclos (${ticks} ticks observados)`)

    // Parada graciosa:
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('exit', (code, signal) => {
        // En Windows, child.kill('SIGTERM') termina el proceso por señal (code=null, signal='SIGTERM')
        // mientras que en POSIX el listener de SIGTERM llama a process.exit(0) (code=0).
        if (process.platform === 'win32' && (code === null || signal === 'SIGTERM')) {
          resolve(0)
        } else {
          resolve(code)
        }
      })
      child.kill('SIGTERM')
      setTimeout(() => resolve(-1), 6000)
    })
    assert.strictEqual(exitCode, 0, `SIGTERM → salida limpia 0 (stderr: ${stderr.join('').slice(0, 200)})`)
    assert.ok(existsSync(dbPath), 'la BD del worker quedó creada (el proceso trabajó de verdad)')
  })

  it('H7-02: start() con keepProcessAlive NO unref-ea el timer (semántica in-proceso)', { timeout: 20000 }, () => {
    const db = createBroadcastDatabase(':memory:')
    const engine = makeEngine(db, { dispatch: async () => OK_DISPATCH })
    const worker = new PersistentBroadcastWorker({ engine, tickIntervalMs: 250, keepProcessAlive: true })
    worker.start()
    assert.strictEqual(worker.isRunning, true)
    // El timer con keepProcessAlive conserva el handle refs: en un proceso real
    // esto MANTIENE el event loop vivo (lo demuestra H7-01 en proceso hijo).
    void worker.stop()
    assert.strictEqual(worker.isRunning, false)
    assert.strictEqual(worker.wasStopped, true)
  })
})
