/**
 * queue-claim.test.ts — Pruebas del claim atómico del worker (reparación integral 2026-11-06)
 *
 * Garantías verificadas:
 *  - CLAIM-01: dos workers concurrentes NO despachan el mismo ítem (solo un SENT por ítem).
 *  - CLAIM-02: la primitiva claimNextItem es exclusiva (el segundo claim toma OTRO ítem o nada).
 *  - CLAIM-03: el claim queda registrado (claimed_by/claimed_at) para trazabilidad.
 *  - CLAIM-04: reconciliación controlada de claims expirados → UNCERTAIN_DISPATCH (nunca PENDING).
 *  - CLAIM-05: los claims recientes NO se tocan por la reconciliación.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert'
import type { DatabaseSync } from 'node:sqlite'
import { createBroadcastDatabase } from '../src/db.ts'
import { BroadcastEngine } from '../src/queue/broadcast-worker.ts'
import { StandaloneLockChecker } from '../src/safety/lock-checker.ts'

function makeEngine(db: string | DatabaseSync, dispatcher: any, workerId?: string): BroadcastEngine {
  return new BroadcastEngine({
    db: typeof db === 'string' ? createBroadcastDatabase(db) : db,
    dispatcher,
    lockChecker: new StandaloneLockChecker(),
    workerId,
  })
}

const CSV = 'phone,name\n573000001122,Uno\n573000001133,Dos\n573000001144,Tres\n'

describe('CLAIM: cola con claim atómico — un ítem, un worker', () => {
  it('CLAIM-01: dos workers sobre la misma campaña despachan cada ítem exactamente una vez', async () => {
    const dispatchCalls: string[] = []
    let releaseA: (() => void) | null = null
    const gateA = new Promise<void>((resolve) => { releaseA = resolve })

    // Worker A: se "congela" dentro del despacho del primer ítem (await intermedio real)
    const engineA = makeEngine(':memory:', {
      dispatch: async (phone: string) => {
        dispatchCalls.push(`A:${phone}`)
        if (dispatchCalls.length === 1) await gateA // ventana de carrera real
        return { success: true, messageId: `m_${phone}` }
      },
    }, 'worker_A')
    await engineA.createCampaign({ organizationId: 'org_test', name: 'C1', templateSpintax: 'Hola', csvContent: CSV })

    // Worker B arranca MIENTRAS A está dentro del dispatch del primer ítem
    const engineB = makeEngine(engineA.db, {
      dispatch: async (phone: string) => {
        dispatchCalls.push(`B:${phone}`)
        return { success: true, messageId: `m_${phone}` }
      },
    }, 'worker_B')

    const pA = engineA.processNextItem((engineA.db.prepare('SELECT id FROM campaigns LIMIT 1').get() as any).id, new Date('2026-10-26T14:00:00'))
    // A ya reclamó el primer ítem (claim atómico ocurre antes de los checks y del dispatch)
    const campaignId = (engineA.db.prepare('SELECT id FROM campaigns LIMIT 1').get() as any).id
    const pB = engineB.processNextItem(campaignId, new Date('2026-10-26T14:00:00'))

    releaseA!()
    const rA = await pA
    const rB = await pB

    assert.strictEqual(rA.status, 'SENT', 'worker A completa su ítem')
    assert.ok(['SENT', 'COMPLETED'].includes(rB.status as string), 'worker B procesa OTRO ítem o no queda nada')
    // Ningún teléfono despachado dos veces:
    const phones = dispatchCalls.map((c) => c.split(':')[1])
    assert.strictEqual(new Set(phones).size, phones.length, 'cero despachos duplicados')
    // El ítem de A quedó con su claim registrado
    const first = engineA.db.prepare(
      "SELECT claimed_by, status FROM campaign_items WHERE status IN ('SENT','UNCERTAIN_DISPATCH') LIMIT 1"
    ).get() as any
    assert.ok(first, 'hay ítem terminal con trazabilidad')
  })

  it('CLAIM-02: claimNextItem es exclusivo — dos claims seguidos toman ítems DISTINTOS', async () => {
    const engine = makeEngine(':memory:', { dispatch: async () => ({ success: true }) }, 'worker_X')
    await engine.createCampaign({ organizationId: 'org_test', name: 'C2', templateSpintax: 'Hola', csvContent: CSV })

    const c1 = engine.claimNextItem((engine.db.prepare('SELECT id FROM campaigns LIMIT 1').get() as any).id)
    const c2 = engine.claimNextItem((engine.db.prepare('SELECT id FROM campaigns LIMIT 1').get() as any).id)
    assert.ok(c1.claimed && c2.claimed)
    assert.notStrictEqual((c1 as any).item.id, (c2 as any).item.id, 'nunca el mismo ítem dos veces')
    const pending = engine.db.prepare(
      "SELECT COUNT(*) AS n FROM campaign_items WHERE status = 'PENDING'"
    ).get() as any
    assert.strictEqual(pending.n, 1, 'queda exactamente un ítem PENDING')
  })

  it('CLAIM-03: el claim registra claimed_by y claimed_at', async () => {
    const engine = makeEngine(':memory:', { dispatch: async () => ({ success: true }) }, 'worker_traz')
    await engine.createCampaign({ organizationId: 'org_test', name: 'C3', templateSpintax: 'Hola', csvContent: CSV })
    const campaignId = (engine.db.prepare('SELECT id FROM campaigns LIMIT 1').get() as any).id
    const c = engine.claimNextItem(campaignId)
    assert.ok(c.claimed)
    const row = engine.db.prepare('SELECT claimed_by, claimed_at, status FROM campaign_items WHERE id = ?').get((c as any).item.id) as any
    assert.strictEqual(row.claimed_by, 'worker_traz')
    assert.ok(typeof row.claimed_at === 'number' && row.claimed_at > 0)
    assert.strictEqual(row.status, 'DISPATCHING')
  })

  it('CLAIM-04: reconciliación controlada de claims expirados → UNCERTAIN_DISPATCH (jamás PENDING)', async () => {
    const engine = makeEngine(':memory:', { dispatch: async () => ({ success: true }) }, 'worker_muerto')
    await engine.createCampaign({ organizationId: 'org_test', name: 'C4', templateSpintax: 'Hola', csvContent: CSV })
    const campaignId = (engine.db.prepare('SELECT id FROM campaigns LIMIT 1').get() as any).id
    const c = engine.claimNextItem(campaignId)
    assert.ok(c.claimed)
    // Simular que el worker murió hace 1 hora con el ítem en DISPATCHING
    engine.db.prepare('UPDATE campaign_items SET claimed_at = claimed_at - 3600 WHERE id = ?').run((c as any).item.id)

    const res = engine.reconcileStaleClaims(900)
    assert.strictEqual(res.reconciledCount, 1)
    const row = engine.db.prepare('SELECT status, error_reason FROM campaign_items WHERE id = ?').get((c as any).item.id) as any
    assert.strictEqual(row.status, 'UNCERTAIN_DISPATCH', 'estado incierto, exige resolución')
    assert.ok(!/PENDING/.test(row.status))
    // Y el worker JAMÁS lo volverá a tomar automáticamente:
    const again = engine.claimNextItem(campaignId)
    if (again.claimed) assert.notStrictEqual((again as any).item.id, (c as any).item.id)
  })

  it('CLAIM-05: la reconciliación NO toca claims recientes', async () => {
    const engine = makeEngine(':memory:', { dispatch: async () => ({ success: true }) }, 'worker_vivo')
    await engine.createCampaign({ organizationId: 'org_test', name: 'C5', templateSpintax: 'Hola', csvContent: CSV })
    const campaignId = (engine.db.prepare('SELECT id FROM campaigns LIMIT 1').get() as any).id
    const c = engine.claimNextItem(campaignId)
    assert.ok(c.claimed)
    const res = engine.reconcileStaleClaims(900)
    assert.strictEqual(res.reconciledCount, 0, 'claim fresco no se toca')
    const row = engine.db.prepare('SELECT status FROM campaign_items WHERE id = ?').get((c as any).item.id) as any
    assert.strictEqual(row.status, 'DISPATCHING')
  })
})
