/**
 * wave2-persistent-worker.test.ts — Pruebas del PROCESO PERSISTENTE de ULTRA
 * (OLEADA 2: procesos persistentes — decisión de negocio 2026-11-11).
 *
 * Garantías verificadas:
 *   W2P-01  runOnce drena campañas RUNNING de VARIAS organizaciones; cada
 *           despacho lleva la organización de su campaña (identidad extremo a
 *           extremo) y el resumen es exacto.
 *   W2P-02  Equidad round-robin: con una org saturada y otra con 1 ítem, la
 *           segunda se atiende en el MISMO tick (una org no bloquea al resto).
 *   W2P-03  PAUSED jamás se consume (las pausas se respetan).
 *   W2P-04  DRAFT jamás se auto-arranca (la puesta en marcha es decisión de la org).
 *   W2P-05  Mantenimiento por tick: claims expirados → UNCERTAIN_DISPATCH
 *           (jamás reintento a ciegas); los FAILED_RETRYABLE vigentes SÍ se
 *           reprocesan en ticks siguientes.
 *   W2P-06  Bucle persistente: start() tick-ea periódicamente y stop() es
 *           gracioso (no deja ticks colgados).
 *   W2P-07  Aislamiento de fallos: una campaña que revienta NO detiene al
 *           worker ni a las demás organizaciones.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert'
import { createBroadcastDatabase } from '../src/db.ts'
import { BroadcastEngine } from '../src/queue/broadcast-worker.ts'
import { PersistentBroadcastWorker } from '../src/queue/persistent-worker.ts'
import { StandaloneLockChecker } from '../src/safety/lock-checker.ts'
import { transitionCampaignStatus } from '../src/queue/campaign-lifecycle.ts'

/** Hora fija DENTRO del horario comercial (lunes 10:00 America/Bogota = 15:00Z). */
const BUSINESS_HOUR = new Date('2026-11-09T15:00:00Z')

function makeEngine(dbPath: string | import('node:sqlite').DatabaseSync, dispatcher: any): BroadcastEngine {
  return new BroadcastEngine({
    db: typeof dbPath === 'string' ? createBroadcastDatabase(dbPath) : dbPath,
    dispatcher,
    lockChecker: new StandaloneLockChecker(),
  })
}

async function startCampaignAsync(engine: BroadcastEngine, organizationId: string, name: string, csv: string): Promise<string> {
  const c = await engine.createCampaign({ organizationId, name, templateSpintax: 'Hola {{nombre}}', csvContent: csv })
  const res = transitionCampaignStatus(engine.db, c.id, null, 'RUNNING')
  assert.ok(res.ok, `la campaña ${name} debe poder pasar a RUNNING (desde ${c.status})`)
  return c.id
}

const CSV_3 = 'phone,name\n573000001101,Uno\n573000001102,Dos\n573000001103,Tres\n'
const CSV_1 = 'phone,name\n573000001201,Solo\n'

describe('OLEADA 2 — proceso persistente de ULTRA (worker 2B)', () => {
  it('W2P-01: runOnce drena varias orgs y cada despacho lleva SU organización', async () => {
    const dispatched: Array<{ to: string; orgId?: string }> = []
    const engine = makeEngine(':memory:', {
      dispatch: async (to: string, _text: string, orgId?: string) => {
        dispatched.push({ to, orgId })
        return { success: true, messageId: `m_${to}` }
      },
    })
    const idA = await startCampaignAsync(engine, 'org_a', 'A', CSV_3)
    const idB = await startCampaignAsync(engine, 'org_b', 'B', CSV_1)

    const worker = new PersistentBroadcastWorker({ engine, now: () => BUSINESS_HOUR, itemsPerCampaignPerTick: 10 })
    const summary = await worker.runOnce()

    assert.equal(dispatched.length, 4, '3 ítems de org_a + 1 de org_b')
    assert.ok(dispatched.every((d) => d.orgId === 'org_a' || d.orgId === 'org_b'), 'ningún despacho sin organización')
    assert.equal(dispatched.filter((d) => d.orgId === 'org_a').length, 3)
    assert.equal(dispatched.filter((d) => d.orgId === 'org_b').length, 1)
    assert.equal(summary.itemOutcomes['SENT'], 4)
    assert.equal(summary.campaignsVisited.length, 2)
    // Campañas drenadas → COMPLETED.
    const stA = (engine.db.prepare('SELECT status FROM campaigns WHERE id = ?').get(idA) as any).status
    const stB = (engine.db.prepare('SELECT status FROM campaigns WHERE id = ?').get(idB) as any).status
    assert.equal(stA, 'COMPLETED')
    assert.equal(stB, 'COMPLETED')
  })

  it('W2P-02b: el tick atiende a TODAS las orgs aunque la primera no drene (equidad)', async () => {
    const engine = makeEngine(':memory:', { dispatch: async () => ({ success: true, messageId: 'm' }) })
    const bigCsv = 'phone,name\n' + Array.from({ length: 12 }, (_, i) => `5730000040${String(i).padStart(2, '0')},C${i}`).join('\n') + '\n'
    await startCampaignAsync(engine, 'org_grande', 'Grande', bigCsv)
    await startCampaignAsync(engine, 'org_pequena', 'Pequeña', CSV_1)

    const worker = new PersistentBroadcastWorker({
      engine, now: () => BUSINESS_HOUR,
      itemsPerCampaignPerTick: 2, // org_grande no drena: quedan 10 ítems
      maxCampaignsPerTick: 10,
    })
    const summary = await worker.runOnce()

    assert.equal(summary.campaignsVisited.length, 2, 'ambas campañas recibieron atención en el MISMO tick')
    const big = summary.campaignsVisited.find((c) => c.organizationId === 'org_grande')
    const small = summary.campaignsVisited.find((c) => c.organizationId === 'org_pequena')
    assert.equal(big?.itemsProcessed, 2, 'la org grande consumió solo su cupo por tick')
    assert.equal(small?.itemsProcessed, 1, 'la org pequeña drenó completa (no espera detrás de la grande)')
  })

  it('W2P-03: campañas PAUSED jamás se consumen', async () => {
    let dispatches = 0
    const engine = makeEngine(':memory:', { dispatch: async () => { dispatches++; return { success: true, messageId: 'm' } } })
    const id = await startCampaignAsync(engine, 'org_a', 'Pausada', CSV_3)
    transitionCampaignStatus(engine.db, id, null, 'PAUSED')

    const worker = new PersistentBroadcastWorker({ engine, now: () => BUSINESS_HOUR })
    const summary = await worker.runOnce()

    assert.equal(dispatches, 0)
    assert.equal(summary.campaignsVisited.length, 0)
  })

  it('W2P-04: campañas DRAFT jamás se auto-arrancan', async () => {
    let dispatches = 0
    const engine = makeEngine(':memory:', { dispatch: async () => { dispatches++; return { success: true, messageId: 'm' } } })
    const id = (await engine.createCampaign({ organizationId: 'org_a', name: 'Borrador', templateSpintax: 'Hola', csvContent: CSV_3 })).id

    const worker = new PersistentBroadcastWorker({ engine, now: () => BUSINESS_HOUR })
    const summary = await worker.runOnce()

    assert.equal(dispatches, 0, 'la puesta en marcha es decisión explícita de la org')
    const st = (engine.db.prepare('SELECT status FROM campaigns WHERE id = ?').get(id) as any).status
    assert.equal(st, 'DRAFT')
    assert.equal(summary.campaignsVisited.length, 0)
  })

  it('W2P-05: claims expirados → UNCERTAIN_DISPATCH (sin reenvío a ciegas) y los FAILED_RETRYABLE se reprocesan', async () => {
    const dispatched: string[] = []
    let p2Failures = 0
    const engine = makeEngine(':memory:', {
      dispatch: async (to: string) => {
        dispatched.push(to)
        if (to === '573000001102') {
          p2Failures++
          if (p2Failures === 1) return { success: false, error: 'fallo confirmado por daemon (400)' }
        }
        return { success: true, messageId: 'm' }
      },
    })
    const id = await startCampaignAsync(engine, 'org_a', 'Recuperable', CSV_3) // P1, P2, P3

    // Simular caída: P3 quedó DISPATCHING con claim de un worker muerto.
    engine.db.prepare(`
      UPDATE campaign_items SET status = 'DISPATCHING', claimed_by = 'worker_muerto', claimed_at = ?
      WHERE contact_phone = '573000001103'
    `).run(Math.floor(Date.now() / 1000) - 3600)

    const worker = new PersistentBroadcastWorker({
      engine, now: () => BUSINESS_HOUR,
      itemsPerCampaignPerTick: 1, staleClaimSeconds: 900,
    })

    // Ticks sucesivos hasta drenar (cup de 1 ítem/tick: P1, P2-falla, P2-reintento).
    const totalOutcomes: Record<string, number> = {}
    let reconciled = 0
    for (let i = 0; i < 6; i++) {
      const s = await worker.runOnce()
      reconciled += s.reconciledStaleClaims
      for (const [k, v] of Object.entries(s.itemOutcomes)) {
        totalOutcomes[k] = (totalOutcomes[k] ?? 0) + v
      }
      const st = (engine.db.prepare('SELECT status FROM campaigns WHERE id = ?').get(id) as any).status
      if (st === 'COMPLETED') break
    }

    // P3: claim expirado → reconciliado como INCIERTO, JAMÁS re-despachado.
    assert.equal(reconciled, 1, 'el claim expirado se reconcilia una vez')
    const rec = (engine.db.prepare("SELECT status FROM campaign_items WHERE claimed_by = 'worker_muerto'").get() as any).status
    assert.equal(rec, 'UNCERTAIN_DISPATCH', 'resultado incierto (pudo enviarse): jamás se reintenta a ciegas')
    assert.equal(dispatched.filter((p) => p === '573000001103').length, 0, 'el incierto NO se despacha de nuevo')

    // P1 se despacha 1 vez; P2 falla CONFIRMADO → FAILED_RETRYABLE → se repite en
    // un tick posterior (reintento real del proceso persistente) y sale SENT.
    assert.equal(totalOutcomes['SENT'], 2, 'P1 + P2 (tras su reintento)')
    assert.equal(totalOutcomes['FAILED_RETRYABLE'], 1, 'el fallo confirmado queda auditable')
    assert.equal(dispatched.filter((p) => p === '573000001102').length, 2, 'P2 se despachó exactamente 2 veces (fallo + reintento)')
    const st = (engine.db.prepare('SELECT status FROM campaigns WHERE id = ?').get(id) as any).status
    assert.equal(st, 'COMPLETED', 'drenada la cola reclamable, la campaña se completa')
  })

  it('W2P-06: start() tick-ea periódicamente y stop() es gracioso', async () => {
    const engine = makeEngine(':memory:', { dispatch: async () => ({ success: true, messageId: 'm' }) })
    await startCampaignAsync(engine, 'org_a', 'EnBucle', CSV_3)

    const worker = new PersistentBroadcastWorker({
      engine, now: () => BUSINESS_HOUR,
      tickIntervalMs: 250, itemsPerCampaignPerTick: 1,
    })
    worker.start()
    assert.ok(worker.isRunning)

    // Esperar ≥2 ticks.
    await new Promise((r) => setTimeout(r, 700))
    assert.ok(worker.tickCount >= 2, `debería haber ≥2 ticks (hay ${worker.tickCount})`)

    await worker.stop()
    assert.ok(!worker.isRunning)
    assert.ok(worker.wasStopped)
    const afterStop = worker.tickCount
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(worker.tickCount, afterStop, 'stop() detiene la programación de ticks')
  })

  it('W2P-07: una campaña que revienta NO detiene al worker ni a las demás orgs', async () => {
    const engine = makeEngine(':memory:', {
      dispatch: async (to: string) => {
        if (to.startsWith('573000005')) throw new Error('boom campaña rota')
        return { success: true, messageId: 'm' }
      },
    })
    await startCampaignAsync(engine, 'org_rota', 'Rota', 'phone,name\n573000005001,Roto\n')
    await startCampaignAsync(engine, 'org_sana', 'Sana', CSV_1)

    const worker = new PersistentBroadcastWorker({ engine, now: () => BUSINESS_HOUR, itemsPerCampaignPerTick: 5 })
    const summary = await worker.runOnce()

    assert.ok(summary.errors.length >= 1, 'el error de la org rota queda registrado')
    assert.ok(summary.campaignsVisited.some((c) => c.organizationId === 'org_sana'), 'la org sana se atendió igualmente')
    assert.equal(summary.itemOutcomes['SENT'], 1)
  })
})
