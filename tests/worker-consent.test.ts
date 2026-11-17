/**
 * worker-consent.test.ts — (reparación 2026-11-17) ConsentStore OBLIGATORIO.
 *
 * Reparación FASE 1.A: `npm run worker` (worker-main.ts) construía
 * BroadcastEngine SIN ConsentStore → el chequeo Just-In-Time de consentimiento
 * (Ley 1581) se saltaba por completo y las bajas no revocaban consentimiento.
 *
 * Contrato verificado aquí:
 *  1. BroadcastEngine NO se construye sin ConsentStore (fail-closed al arrancar).
 *  2. Un contacto sin consentimiento previo vigente NUNCA se despacha
 *     (SKIPPED_NO_CONSENT), aunque la campaña esté RUNNING y el lock libre.
 *  3. Una baja/opt-out procesada con la misma cadena de supresión del worker
 *     REVOKA el consentimiento en el ConsentStore (y el siguiente despacho
 *     del contacto queda SKIPPED_NO_CONSENT).
 *  4. El cableado del worker real (worker-main.ts) contiene el ConsentStore
 *     (inspección estática del código fuente — el proceso completo no se
 *     ejecuta para no abrir puertos ni tocar .wa-auth).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBroadcastDatabase } from '../src/db.ts'
import { BroadcastEngine } from '../src/queue/broadcast-worker.ts'
import { ConsentStore } from '../src/safety/consent-store.ts'
import { LocalSuppressionStore } from '../src/safety/suppression.ts'
import { seedConsentPhone } from './helpers/consent.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BUSINESS_DATE = new Date('2026-11-17T14:00:00Z') // horario comercial

function makeDispatcherSent() {
  return { dispatch: async () => ({ success: true as const, messageId: 'msg_test_001' }) }
}

function makeLockFree() {
  return { checkLock: async () => ({ available: true as const }) }
}

test('FASE 1.A — ConsentStore obligatorio en BroadcastEngine y worker', async (t) => {
  await t.test('1.A.1 El constructor FALLA (fail-closed) si falta el ConsentStore', () => {
    const db = createBroadcastDatabase(':memory:')
    assert.throws(
      () => new BroadcastEngine({
        db,
        dispatcher: makeDispatcherSent() as any,
        lockChecker: makeLockFree() as any,
        // sin consentStore
      } as any),
      /CONSENT_STORE_REQUIRED/,
      'Sin ConsentStore el engine NO debe construirse (fail-closed)'
    )
  })

  await t.test('1.A.2 Contacto sin consentimiento previo → SKIPPED_NO_CONSENT (nunca despacha)', async () => {
    const db = createBroadcastDatabase(':memory:')
    const consentStore = new ConsentStore(db)
    const engine = new BroadcastEngine({
      db,
      dispatcher: makeDispatcherSent() as any,
      lockChecker: makeLockFree() as any,
      consentStore,
    })

    const orgId = 'org_test'
    const campaign = await engine.createCampaign({
      organizationId: orgId,
      name: 'Campaña de prueba sin consentimiento',
      templateSpintax: 'Hola {amigo|cliente}',
      csvContent: 'phone,name\n+573000000000,Usuario Demo',
    })

    const res = await engine.processNextItem(campaign.id, BUSINESS_DATE)
    assert.equal(res.status, 'SKIPPED_NO_CONSENT')

    // El despacho NUNCA ocurrió: el ítem quedó marcado y sin messageId
    const item = engine.getItems(campaign.id)[0]
    assert.equal(item.status, 'SKIPPED_NO_CONSENT')
    assert.equal(item.messageId, undefined)
    const counters = engine.getCampaign(campaign.id)!
    assert.equal(counters.sentCount, 0)
    assert.equal(counters.skippedCount, 1)
  })

  await t.test('1.A.3 Con consentimiento vigente el despacho procede (SENT)', async () => {
    const db = createBroadcastDatabase(':memory:')
    const consentStore = new ConsentStore(db)
    const engine = new BroadcastEngine({
      db,
      dispatcher: makeDispatcherSent() as any,
      lockChecker: makeLockFree() as any,
      consentStore,
    })

    const orgId = 'org_test'
    seedConsentPhone(consentStore, orgId, '573000000000')
    const campaign = await engine.createCampaign({
      organizationId: orgId,
      name: 'Campaña de prueba con consentimiento',
      templateSpintax: 'Hola {amigo|cliente}',
      csvContent: 'phone,name\n+573000000000,Usuario Demo',
    })

    const res = await engine.processNextItem(campaign.id, BUSINESS_DATE)
    assert.equal(res.status, 'SENT')
    assert.equal(engine.getCampaign(campaign.id)!.sentCount, 1)
  })

  await t.test('1.A.4 Baja/opt-out procesada en el worker REVOKA el consentimiento', async () => {
    const db = createBroadcastDatabase(':memory:')
    const consentStore = new ConsentStore(db)
    // MISMA cadena que cablea worker-main.ts: LocalSuppressionStore(db, consentStore)
    const suppression = new LocalSuppressionStore(db, consentStore)
    const engine = new BroadcastEngine({
      db,
      dispatcher: makeDispatcherSent() as any,
      lockChecker: makeLockFree() as any,
      suppressionStore: suppression,
      consentStore,
    })

    const orgId = 'org_test'
    const phone = '+573000000000'
    seedConsentPhone(consentStore, orgId, phone)

    const campaign = await engine.createCampaign({
      organizationId: orgId,
      name: 'Campaña con baja posterior',
      templateSpintax: 'Hola {amigo|cliente}',
      csvContent: `phone,name\n${phone},Usuario Demo`,
    })

    const first = await engine.processNextItem(campaign.id, BUSINESS_DATE)
    assert.equal(first.status, 'SENT')

    // El contacto pide baja por el canal de supresión del worker
    // (mismo teléfono normalizado que el CSV importa: 573000000000)
    await suppression.addSuppression(orgId, '573000000000', 'STOP')

    // El consentimiento quedó REVOCADO en el ConsentStore (no solo suprimido)
    assert.equal(consentStore.hasActiveConsent(orgId, phone), false, 'La baja debe revocar el consentimiento en ConsentStore')
    const audit = consentStore.getAuditLog(orgId, phone)
    assert.ok(audit.some((a) => a.action === 'REVOKE'), 'La revocación debe quedar auditada')

    // Un segundo intento de contacto (re-alta de campaña) queda SIN consentimiento
    const campaign2 = await engine.createCampaign({
      organizationId: orgId,
      name: 'Campaña posterior a la baja',
      templateSpintax: 'Hola {amigo|cliente}',
      csvContent: `phone,name\n${phone},Usuario Demo`,
    })
    // El pre-filtrado por supresión marca el ítem SUPPRESSED en importación…
    const items = engine.getItems(campaign2.id)
    assert.equal(items[0].status, 'SUPPRESSED')
    // …y el store ya no otorga consentimiento activo para ese contacto
    assert.equal(consentStore.hasActiveConsent(orgId, phone), false)
  })

  await t.test('1.A.5 worker-main.ts cablea el ConsentStore (inspección estática)', () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'worker-main.ts'), 'utf8')
    assert.match(source, /new ConsentStore\(db\)/, 'worker-main debe instanciar el ConsentStore')
    assert.match(source, /new LocalSuppressionStore\(db, consentStore\)/, 'Las supresiones locales del worker deben recibir el consentStore (las bajas revocan consentimiento)')
    const engineBlock = source.slice(source.indexOf('new BroadcastEngine'))
    assert.match(engineBlock, /consentStore,/, 'El engine del worker debe recibir el consentStore')
  })
})
