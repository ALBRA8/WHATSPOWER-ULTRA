/**
 * CUARTA REPARACIÓN — B4: ÍTEMS DE CAMPAÑA SIN ORGANIZACIÓN (Capa 2B).
 *
 * Problema reproducido: campaign_items podía contener filas históricas sin
 * organización (organization_id NULL, p. ej. de migraciones o importaciones
 * viejas). El claim atómico las tomaba y el worker las despachaba sin
 * identidad: el daemon no sabía de qué organización era el envío.
 *
 * Contrato verificado:
 *  N-B4-01  Migración: ítems históricos heredan la organización de SU campaña;
 *           los huérfanos (sin campaña) quedan NULL.
 *  N-B4-02  CUARENTENA al arrancar: filas NULL en estado activo →
 *           QUARANTINED_NO_ORG (idempotente; jamás reintentos automáticos).
 *  N-B4-03  CLAIM (verificación 1/2): un ítem NULL u OTRA organización jamás
 *           se reclama; los sin-identidad no bloquean el drenaje de la cola.
 *  N-B4-04  PRE-DESPACHO (verificación 2/2): un ítem forzado a DISPATCHING con
 *           organización NULL o ajena → CUARENTENA sin despacho (0 envíos).
 *  N-B4-05  SIN sobre-bloqueo: un ítem con la organización correcta se
 *           despacha exactamente una vez (regresión de la funcionalidad sana).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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

const CSV = 'phone,name\n573000001122,Uno\n'

/** Siembra una campaña + un ítem crudo con organización arbitraria (simula fila histórica). */
function seedLegacyRow(db: DatabaseSync, opts: { itemOrg: string | null; campaignOrg?: string; withCampaign?: boolean; status?: string }): { campaignId: string; itemId: string } {
  const campaignId = opts.withCampaign === false ? `cmp_orphan_${Math.random().toString(36).slice(2, 9)}` : `cmp_${Math.random().toString(36).slice(2, 9)}`
  const itemId = `itm_${Math.random().toString(36).slice(2, 9)}`
  // Simulación de fila histórica huérfana (campaña ya eliminada): la FK se
  // desactiva SOLO en la siembra del laboratorio para reproducir el estado
  // legacy que la migración encuentra en BD viejas.
  db.exec('PRAGMA foreign_keys = OFF')
  if (opts.withCampaign !== false) {
    db.prepare(`
      INSERT INTO campaigns (id, organization_id, name, template_spintax, status, total_targets, created_at)
      VALUES (?, ?, 'C legacy', 'Hola', 'RUNNING', 1, strftime('%s','now'))
    `).run(campaignId, opts.campaignOrg ?? 'org_legacy')
  }
  db.prepare(`
    INSERT INTO campaign_items (id, campaign_id, contact_phone, status, retry_count, idempotency_key, organization_id)
    VALUES (?, ?, '573000001122', ?, 0, ?, ?)
  `).run(itemId, campaignId, opts.status ?? 'PENDING', `idem_${itemId}`, opts.itemOrg)
  db.exec('PRAGMA foreign_keys = ON')
  return { campaignId, itemId }
}

describe('B4: ítems de campaña sin organización — cuarentena, nunca despacho', () => {
  it('N-B4-01: la migración hereda la organización de la campaña; huérfanos quedan NULL', () => {
    // BD en ARCHIVO con dos conexiones: la primera simula la BD legacy (filas
    // insertadas sin organización), la segunda REABRE y ejercita la migración.
    const dir = mkdtempSync(join(tmpdir(), 'b4-migr-'))
    const dbPath = join(dir, 'legacy.db')
    const legacy = createBroadcastDatabase(dbPath)
    legacy.exec('PRAGMA foreign_keys = OFF')
    legacy.prepare(`
      INSERT INTO campaigns (id, organization_id, name, template_spintax, status, total_targets, created_at)
      VALUES ('cmp_leg_1', 'org_legacy', 'C legacy', 'Hola', 'RUNNING', 2, strftime('%s','now'))
    `).run()
    // Fila legacy SIN columna de organización simulada a NULL (estado previo a B4)
    legacy.prepare(`
      INSERT INTO campaign_items (id, campaign_id, contact_phone, status, retry_count, idempotency_key, organization_id)
      VALUES ('itm_leg_1', 'cmp_leg_1', '573000001122', 'PENDING', 0, 'idem_leg_1', NULL)
    `).run()
    // Huérfano: campaña ya eliminada (solo queda la fila del ítem)
    legacy.prepare(`
      INSERT INTO campaign_items (id, campaign_id, contact_phone, status, retry_count, idempotency_key, organization_id)
      VALUES ('itm_orphan_1', 'cmp_borrada', '573000001133', 'PENDING', 0, 'idem_orphan_1', NULL)
    `).run()
    legacy.close()

    // REAPERTURA: aquí corre la migración B4 (ALTER + backfill)
    const db = createBroadcastDatabase(dbPath)
    const row = db.prepare('SELECT organization_id FROM campaign_items WHERE id = ?').get('itm_leg_1') as { organization_id: string | null }
    assert.equal(row.organization_id, 'org_legacy', 'el ítem histórico hereda la organización de SU campaña')

    const orphanRow = db.prepare('SELECT organization_id FROM campaign_items WHERE id = ?').get('itm_orphan_1') as { organization_id: string | null }
    assert.equal(orphanRow.organization_id, null, 'el ítem huérfano (sin campaña) queda sin identidad')
    rmSync(dir, { recursive: true, force: true })
  })

  it('N-B4-02: recoverFromCrash CUARENTENA los ítems sin organización (idempotente, sin reintentos)', () => {
    const db = createBroadcastDatabase(':memory:')
    const { itemId } = seedLegacyRow(db, { itemOrg: null, campaignOrg: 'org_legacy' })
    const engine = makeEngine(db, { dispatch: async () => { throw new Error('no debe despacharse') } })

    const first = engine.recoverFromCrash()
    assert.equal(first.quarantinedCount, 1, 'el ítem sin organización entra en cuarentena al arrancar')
    const st = db.prepare('SELECT status, error_reason FROM campaign_items WHERE id = ?').get(itemId) as { status: string; error_reason: string }
    assert.equal(st.status, 'QUARANTINED_NO_ORG')
    assert.match(st.error_reason, /CUARENTENA/)

    // Idempotente: segundo arranque no duplica ni revierte nada
    const second = engine.recoverFromCrash()
    assert.equal(second.quarantinedCount, 0)
    assert.equal((db.prepare('SELECT status FROM campaign_items WHERE id = ?').get(itemId) as any).status, 'QUARANTINED_NO_ORG')
  })

  it('N-B4-03: el claim JAMÁS toma un ítem NULL o de otra organización; la cola drena sin despacharlos', async () => {
    const db = createBroadcastDatabase(':memory:')
    const nullItem = seedLegacyRow(db, { itemOrg: null, campaignOrg: 'org_legacy' })
    const foreignItem = seedLegacyRow(db, { itemOrg: 'org_ajena', campaignOrg: 'org_legacy' })
    const engine = makeEngine(db, {
      dispatch: async () => { throw new Error('UN ÍTEM SIN IDENTIDAD LLEGÓ AL DESPACHO') },
    })

    const claim1 = engine.claimNextItem(nullItem.campaignId)
    assert.equal(claim1.claimed, false, 'el ítem NULL no es reclamable')
    const claim2 = engine.claimNextItem(foreignItem.campaignId)
    assert.equal(claim2.claimed, false, 'el ítem de OTRA organización no es reclamable')

    // La campaña drena: sin PENDING reclamable → COMPLETED, sin ningún despacho
    const r = await engine.processNextItem(nullItem.campaignId, new Date('2026-10-26T14:00:00'))
    assert.equal(r.processed, false)
    assert.equal(r.status, 'COMPLETED')
    const statuses = (db.prepare('SELECT status FROM campaign_items WHERE id IN (?, ?)').all(nullItem.itemId, foreignItem.itemId) as any[]).map((x) => x.status)
    assert.ok(statuses.every((s) => s !== 'SENT' && s !== 'DISPATCHING'), 'ningún ítem sin identidad llegó a despacho')
  })

  it('N-B4-04: ítem forzado a DISPATCHING con organización NULL/ajena → CUARENTENA en pre-despacho (0 envíos)', async () => {
    const db = createBroadcastDatabase(':memory:')
    // Simula fila histórica ya reclamada por un worker viejo (estado DISPATCHING)
    const legacyNull = seedLegacyRow(db, { itemOrg: null, campaignOrg: 'org_legacy', status: 'DISPATCHING' })
    const foreign = seedLegacyRow(db, { itemOrg: 'org_ajena', campaignOrg: 'org_legacy', status: 'DISPATCHING' })
    let dispatches = 0
    const engine = makeEngine(db, { dispatch: async () => { dispatches++; return { success: true, messageId: 'x' } } })

    // Las filas ya están en DISPATCHING (no pasan por claim): processNextItem no las toca
    // (no hay PENDING). Verificación 2/2 se ejercita forzando el flujo con un PENDING cuyo
    // organization_id es alterado DESPUÉS del claim (carrera de identidad).
    const fresh = seedLegacyRow(db, { itemOrg: 'org_legacy', campaignOrg: 'org_legacy', status: 'PENDING' })
    const claim = engine.claimNextItem(fresh.campaignId)
    assert.equal(claim.claimed, true)
    // Simula corrupción/migración a mitad: la organización del ítem desaparece tras el claim
    db.prepare('UPDATE campaign_items SET organization_id = NULL WHERE id = ?').run(fresh.itemId)

    const r = await engine.processNextItem(fresh.campaignId, new Date('2026-10-26T14:00:00'))
    // El ÍTEM queda en cuarentena; la campaña puede drenar (sin reclamables):
    // ambos resultados son correctos, lo innegociable es 0 despachos + cuarentena.
    assert.ok(['QUARANTINED_NO_ORG', 'COMPLETED'].includes(r.status || ''), `estado de proceso: ${r.status}`)
    assert.equal(dispatches, 0, 'NINGÚN despacho ocurrió')
    assert.equal(
      (db.prepare('SELECT status FROM campaign_items WHERE id = ?').get(fresh.itemId) as any).status,
      'QUARANTINED_NO_ORG',
      'el ítem corrupto tras el claim queda en CUARENTENA'
    )

    // Y un ítem con organización AJENA tras el claim también cae en cuarentena
    const fresh2 = seedLegacyRow(db, { itemOrg: 'org_legacy', campaignOrg: 'org_legacy', status: 'PENDING' })
    const claim2 = engine.claimNextItem(fresh2.campaignId)
    assert.equal(claim2.claimed, true)
    db.prepare("UPDATE campaign_items SET organization_id = 'org_ajena' WHERE id = ?").run(fresh2.itemId)
    const r2 = await engine.processNextItem(fresh2.campaignId, new Date('2026-10-26T14:00:00'))
    assert.ok(['QUARANTINED_NO_ORG', 'COMPLETED'].includes(r2.status || ''), `estado de proceso: ${r2.status}`)
    assert.equal(dispatches, 0)
    assert.equal(
      (db.prepare('SELECT status FROM campaign_items WHERE id = ?').get(fresh2.itemId) as any).status,
      'QUARANTINED_NO_ORG',
      'el ítem con organización ajena tras el claim queda en CUARENTENA'
    )

    // Estado final de todos los sospechosos: cuarentena, no reintentables
    for (const id of [legacyNull.itemId, foreign.itemId, fresh.itemId, fresh2.itemId]) {
      const row = db.prepare('SELECT status FROM campaign_items WHERE id = ?').get(id) as { status: string }
      assert.ok(['QUARANTINED_NO_ORG', 'DISPATCHING'].includes(row.status), `ítem ${id} jamás despachado (estado: ${row.status})`)
      assert.notEqual(row.status, 'SENT')
    }
  })

  it('N-B4-05: SIN sobre-bloqueo — ítem con organización correcta se despacha exactamente una vez', async () => {
    const db = createBroadcastDatabase(':memory:')
    let dispatches = 0
    let dispatchedOrg: string | undefined
    const engine = makeEngine(db, {
      dispatch: async (_phone: string, _text: string, organizationId?: string) => {
        dispatches++
        dispatchedOrg = organizationId
        return { success: true, messageId: `m_${dispatches}` }
      },
    })
    const camp = await engine.createCampaign({ organizationId: 'org_sana', name: 'C', templateSpintax: 'Hola', csvContent: CSV })
    const r = await engine.processNextItem(camp.id, new Date('2026-10-26T14:00:00'))
    assert.equal(r.status, 'SENT', 'el flujo sano no se rompe con el endurecido B4')
    assert.equal(dispatches, 1)
    assert.equal(dispatchedOrg, 'org_sana', 'el despacho nombra SU organización (B3)')
    const item = (engine.getItems(camp.id))[0]
    assert.equal(item.organizationId, 'org_sana')
    assert.equal(item.status, 'SENT')
  })
})
