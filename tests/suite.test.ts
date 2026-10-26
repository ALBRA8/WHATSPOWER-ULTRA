import assert from 'node:assert'
import { createBroadcastDatabase } from '../src/db.ts'
import { parseAudienceCsv, canonicalizePhone } from '../src/audiences/csv-importer.ts'
import { renderSpintax } from '../src/engine/spintax.ts'
import { MockLockChecker } from '../src/safety/lock-checker.ts'
import { LocalSuppressionStore, FatigueManager } from '../src/safety/suppression.ts'
import { MockDispatcher } from '../src/adapters/dispatcher.ts'
import { BroadcastEngine } from '../src/queue/broadcast-worker.ts'
import { Throttler } from '../src/queue/throttler.ts'

async function runBroadcastTestSuite() {
  console.log('\n============================================================')
  console.log('  EJECUTANDO SUITE DE ACEPTACIÓN: CAPA 2B (CP-B01 a CP-B10)')
  console.log('  Despacho: MockDispatcher (Sala Limpia, 0 envíos reales)')
  console.log('============================================================\n')

  let passed = 0

  // CP-B01: Ingesta y canonización estricta de CSV con de-duplicación
  {
    const csvData = `phone,name,ciudad
3017543786,Johan Bravo,Bogotá
+57 301 754 3786,Johan Repetido,Bogotá
3163301286,ALBRA Empresa,Medellín
6012345678,Fijo Invalido,Bogotá
invalido,Error,Cali
3155550106,Diego Torres,Barranquilla`

    const res = parseAudienceCsv(csvData)
    assert.strictEqual(res.totalProcessed, 6)
    assert.strictEqual(res.validCount, 3) // 573017543786, 573163301286, 573155550106
    assert.strictEqual(res.invalidCount, 2) // 6012345678 (fijo) e 'invalido'
    assert.strictEqual(res.duplicatesCount, 1) // +57 301 754 3786 es duplicado canónico

    assert.strictEqual(res.contacts[0].phone, '573017543786')
    assert.strictEqual(res.contacts[0].name, 'Johan Bravo')
    assert.strictEqual(res.contacts[0].variables?.ciudad, 'Bogotá')

    console.log('  ✅ [PASS] CP-B01: Ingesta y canonización estricta de CSV con de-duplicación')
    passed++
  }

  // CP-B02: Exclusión en pre-filtrado de contactos con lock activo en 2A
  {
    const db = createBroadcastDatabase(':memory:')
    const mockLock = new MockLockChecker()
    const mockDispatcher = new MockDispatcher()

    // Bloquear contacto en 2A
    mockLock.setLock('573017543786', 'IN_FLOW_2A')

    const engine = new BroadcastEngine({
      db,
      dispatcher: mockDispatcher,
      lockChecker: mockLock,
      throttlerOptions: { minIntervalMs: 0, maxIntervalMs: 0 },
    })

    const csvData = `phone,name\n3017543786,Johan Activo\n3155550106,Diego Libre`
    const campaign = await engine.createCampaign({
      organizationId: 'org_test_1',
      name: 'Campaña Test Pre-filtrado',
      templateSpintax: '{Hola|Buen día} {{name}}',
      csvContent: csvData,
    })

    const items = engine.getItems(campaign.id)
    const lockedItem = items.find((i) => i.contactPhone === '573017543786')
    const freeItem = items.find((i) => i.contactPhone === '573155550106')

    assert.strictEqual(lockedItem?.status, 'LOCK_EXCLUDED')
    assert.ok(lockedItem?.errorReason?.includes('Lock activo'))
    assert.strictEqual(freeItem?.status, 'PENDING')
    assert.strictEqual(campaign.skippedCount, 1)

    console.log('  ✅ [PASS] CP-B02: Exclusión en pre-filtrado de contactos con lock activo en 2A')
    passed++
  }

  // CP-B03: Cancelación Just-In-Time pre-dispatch si el contacto inicia conversación
  {
    const db = createBroadcastDatabase(':memory:')
    const mockLock = new MockLockChecker()
    const mockDispatcher = new MockDispatcher()

    const engine = new BroadcastEngine({
      db,
      dispatcher: mockDispatcher,
      lockChecker: mockLock,
      throttlerOptions: { minIntervalMs: 0, maxIntervalMs: 0 },
    })

    const csvData = `phone,name\n3017543786,Johan Dinamico`
    const campaign = await engine.createCampaign({
      organizationId: 'org_test_1',
      name: 'Campaña Test JIT',
      templateSpintax: '{Hola|Saludos} {{name}}',
      csvContent: csvData,
    })

    // Contacto estaba PENDING al encolar
    let item = engine.getItems(campaign.id)[0]
    assert.strictEqual(item.status, 'PENDING')

    // El contacto escribe a WhatsApp antes de que le toque el turno -> adquiere lock en 2A
    mockLock.setLock('573017543786', 'HANDOFF_HUMAN')

    // El worker intenta procesar el ítem
    const businessDate = new Date('2026-10-24T10:00:00-05:00') // 10:00 AM hora Bogotá
    const stepRes = await engine.processNextItem(campaign.id, businessDate)

    assert.strictEqual(stepRes.status, 'ABORTED_LOCK_ACTIVE')
    item = engine.getItems(campaign.id)[0]
    assert.strictEqual(item.status, 'ABORTED_LOCK_ACTIVE')
    assert.strictEqual(mockDispatcher.dispatched.length, 0) // CERO mensajes enviados

    console.log('  ✅ [PASS] CP-B03: Cancelación Just-In-Time pre-dispatch si el contacto inicia conversación')
    passed++
  }

  // CP-B04: Fail-Closed ante caída o timeout de Capa 2A (cero envíos a ciegas)
  {
    const db = createBroadcastDatabase(':memory:')
    const mockLock = new MockLockChecker()
    const mockDispatcher = new MockDispatcher()

    const engine = new BroadcastEngine({
      db,
      dispatcher: mockDispatcher,
      lockChecker: mockLock,
      throttlerOptions: { minIntervalMs: 0, maxIntervalMs: 0 },
    })

    const csvData = `phone,name\n3017543786,Johan FailClosed`
    const campaign = await engine.createCampaign({
      organizationId: 'org_test_1',
      name: 'Campaña Test Fail Closed',
      templateSpintax: '{Hola|Saludos} {{name}}',
      csvContent: csvData,
    })

    // Simular que Capa 2A se cayó o da timeout en la comprobación JIT
    mockLock.simulateTimeout = true

    const businessDate = new Date('2026-10-24T10:00:00-05:00')
    const stepRes = await engine.processNextItem(campaign.id, businessDate)

    assert.strictEqual(stepRes.status, 'SKIPPED_LOCK_UNAVAILABLE')
    const item = engine.getItems(campaign.id)[0]
    assert.strictEqual(item.status, 'SKIPPED_LOCK_UNAVAILABLE')
    assert.strictEqual(mockDispatcher.dispatched.length, 0) // Cero envíos sin verificación

    console.log('  ✅ [PASS] CP-B04: Fail-Closed ante caída o timeout de 2A (cero envíos a ciegas)')
    passed++
  }

  // CP-B05: Exclusión automática por opt-out (STOP/BAJA)
  {
    const db = createBroadcastDatabase(':memory:')
    const mockLock = new MockLockChecker()
    const mockDispatcher = new MockDispatcher()
    const suppressionStore = new LocalSuppressionStore(db)

    // Registrar baja previa de contacto
    suppressionStore.addSuppression('573017543786', 'Usuario solicitó BAJA')

    const engine = new BroadcastEngine({
      db,
      dispatcher: mockDispatcher,
      lockChecker: mockLock,
      suppressionStore,
      throttlerOptions: { minIntervalMs: 0, maxIntervalMs: 0 },
    })

    const csvData = `phone,name\n3017543786,Johan Baja\n3155550106,Diego Activo`
    const campaign = await engine.createCampaign({
      organizationId: 'org_test_1',
      name: 'Campaña Test Opt-Out',
      templateSpintax: 'Promoción especial',
      csvContent: csvData,
    })

    const items = engine.getItems(campaign.id)
    const suppressedItem = items.find((i) => i.contactPhone === '573017543786')
    const activeItem = items.find((i) => i.contactPhone === '573155550106')

    assert.strictEqual(suppressedItem?.status, 'SUPPRESSED')
    assert.strictEqual(activeItem?.status, 'PENDING')

    console.log('  ✅ [PASS] CP-B05: Exclusión automática por opt-out (STOP/BAJA)')
    passed++
  }

  // CP-B06: Variación de Spintax determinista por semilla
  {
    const template = '{Hola|Buenos días|Un saludo} {{name}}, {te presentamos|conoce|descubre} nuestra oferta.'
    const seed1 = 'cmp_1_573017543786'
    const seed2 = 'cmp_1_573155550106'

    const render1A = renderSpintax(template, { seed: seed1, variables: { name: 'Johan' } })
    const render1B = renderSpintax(template, { seed: seed1, variables: { name: 'Johan' } })
    const render2 = renderSpintax(template, { seed: seed2, variables: { name: 'Diego' } })

    // Idempotencia: misma semilla -> exactamente el mismo texto
    assert.strictEqual(render1A, render1B)
    assert.ok(render1A.includes('Johan'))
    assert.ok(render2.includes('Diego'))

    // Diferente semilla produce variación
    assert.notStrictEqual(render1A.replace('Johan', ''), render2.replace('Diego', ''))

    console.log('  ✅ [PASS] CP-B06: Variación de Spintax determinista por semilla')
    passed++
  }

  // CP-B07: Respeto de intervalo y jitter configurable
  {
    const throttler = new Throttler({ minIntervalMs: 15_000, maxIntervalMs: 35_000 })
    for (let i = 0; i < 20; i++) {
      const interval = throttler.calculateNextInterval()
      assert.ok(interval >= 15_000 && interval <= 35_000, `Intervalo ${interval} fuera de límites`)
    }

    console.log('  ✅ [PASS] CP-B07: Respeto de intervalo y jitter configurable (15-35s)')
    passed++
  }

  // CP-B08: Activación de pausa de enfriamiento de lote cada 25 mensajes
  {
    const throttler = new Throttler({ batchSize: 25, cooldownMs: 300_000 })
    for (let i = 0; i < 24; i++) {
      throttler.registerDispatch()
      assert.strictEqual(throttler.isCooldownNeeded(), false)
    }

    // Mensaje 25 dispara el cooldown
    throttler.registerDispatch()
    assert.strictEqual(throttler.isCooldownNeeded(), true)

    throttler.resetCooldown()
    assert.strictEqual(throttler.isCooldownNeeded(), false)

    console.log('  ✅ [PASS] CP-B08: Activación de pausa de enfriamiento de lote cada 25 mensajes')
    passed++
  }

  // CP-B09: Respeto de horario comercial (PAUSED_OFF_HOURS)
  {
    const db = createBroadcastDatabase(':memory:')
    const mockLock = new MockLockChecker()
    const mockDispatcher = new MockDispatcher()

    const engine = new BroadcastEngine({
      db,
      dispatcher: mockDispatcher,
      lockChecker: mockLock,
      throttlerOptions: { minIntervalMs: 0, maxIntervalMs: 0 },
    })

    const csvData = `phone,name\n3017543786,Johan Noche`
    const campaign = await engine.createCampaign({
      organizationId: 'org_test_1',
      name: 'Campaña Nocturna',
      templateSpintax: 'Buenas noches {{name}}',
      csvContent: csvData,
    })

    // Simular las 22:00 (10:00 PM hora Bogotá)
    const nightDate = new Date('2026-10-24T22:00:00-05:00')
    const stepRes = await engine.processNextItem(campaign.id, nightDate)

    assert.strictEqual(stepRes.status, 'PAUSED_OFF_HOURS')
    const updatedCampaign = engine.getCampaign(campaign.id)
    assert.strictEqual(updatedCampaign?.status, 'PAUSED_OFF_HOURS')
    assert.strictEqual(mockDispatcher.dispatched.length, 0) // Cero envíos nocturnos

    console.log('  ✅ [PASS] CP-B09: Respeto de horario comercial (PAUSED_OFF_HOURS)')
    passed++
  }

  // CP-B10: Recuperación tras caída del proceso sin generar dobles envíos
  {
    const db = createBroadcastDatabase(':memory:')
    const mockLock = new MockLockChecker()
    const mockDispatcher = new MockDispatcher()

    const engine = new BroadcastEngine({
      db,
      dispatcher: mockDispatcher,
      lockChecker: mockLock,
      throttlerOptions: { minIntervalMs: 0, maxIntervalMs: 0 },
    })

    const csvData = `phone,name\n3017543786,Johan Crash`
    const campaign = await engine.createCampaign({
      organizationId: 'org_test_1',
      name: 'Campaña Crash Recovery',
      templateSpintax: 'Hola {{name}}',
      csvContent: csvData,
    })

    // Simular que el ítem quedó en estado transitorio DISPATCHING cuando el proceso cayó
    const item = engine.getItems(campaign.id)[0]
    db.prepare("UPDATE campaign_items SET status = 'DISPATCHING' WHERE id = ?").run(item.id)

    // Al reiniciar el proceso, el engine ejecuta crash recovery bloqueando reenvío ciego
    const recoveryRes = engine.recoverFromCrash()
    assert.strictEqual(recoveryRes.recoveredCount, 1)

    const recoveredItem = engine.getItems(campaign.id)[0]
    assert.strictEqual(recoveredItem.status, 'UNCERTAIN_DISPATCH')
    assert.ok(recoveredItem.errorReason?.includes('Bloqueado contra reenvío ciego'))

    console.log('  ✅ [PASS] CP-B10: Recuperación tras caída del proceso sin generar dobles envíos')
    passed++
  }

  console.log('\n============================================================')
  console.log(`  RESULTADO CAPA 2B: ${passed}/10 pruebas superadas con éxito.`)
  console.log('============================================================\n')
}

runBroadcastTestSuite().catch((err) => {
  console.error('Error en suite de pruebas 2B:', err)
  process.exit(1)
})
