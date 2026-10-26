import assert from 'node:assert'
import { createBroadcastDatabase } from '../src/db.ts'
import { BroadcastEngine } from '../src/queue/broadcast-worker.ts'
import { Http2ASuppressionChecker, CompositeSuppressionChecker, LocalSuppressionStore } from '../src/safety/suppression.ts'
import { registerSuppressionInAgentic2A } from '../../../audit_repos/CRM-ALBRA/src/lib/agentic-2a-bridge.ts'

async function runBajasCircuitTest() {
  console.log('\n============================================================')
  console.log('  ALBRA: PRUEBA DEL CIRCUITO DE BAJAS CON 2A DESACTIVADO')
  console.log('  CRM (Capa 1) ➔ Capa 2A (Persistencia) ➔ Capa 2B (Bloqueo JIT)')
  console.log('  Modo: SALA LIMPIA (0 envíos reales)')
  console.log('============================================================\n')

  const TEST_PHONE = '573999888777'
  const secret = process.env.INTERNAL_API_SECRET || 'crm_albra_internal_secret_key_fixed_length_for_daemon_2026'

  // Limpieza inicial por si acaso
  await fetch(`http://localhost:3003/api/internal/suppression/${TEST_PHONE}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${secret}` },
  }).catch(() => {})

  try {
    // 1. Verificar estado inicial: no suprimido
    const checkInitial = await fetch(`http://localhost:3003/api/internal/suppression/${TEST_PHONE}`)
    const initData = await checkInitial.json() as any
    assert.strictEqual(initData.suppressed, false, 'El número no debe estar suprimido inicialmente')
    console.log('  ✅ [PASS] 1. Estado inicial verificado: contacto no suprimido')

    // 2. Simular llegada de "BAJA" al CRM cuando AGENTIC_2A_ENABLED=false
    // El CRM invoca registerSuppressionInAgentic2A() directamente por HTTP autenticado interno
    const registerRes = await registerSuppressionInAgentic2A(TEST_PHONE, 'Opt-out voluntario "BAJA" vía CRM')
    assert.strictEqual(registerRes.success, true, 'Registro de baja desde CRM a 2A debe ser exitoso')
    console.log('  ✅ [PASS] 2. CRM registró baja en Capa 2A vía API interna sin activar el agente conversacional')

    // 3. Confirmar que 2A persistió la baja en su tabla autoritativa
    const checkAfter = await fetch(`http://localhost:3003/api/internal/suppression/${TEST_PHONE}`)
    const afterData = await checkAfter.json() as any
    assert.strictEqual(afterData.suppressed, true, '2A debe reportar suprimido = true')
    console.log('  ✅ [PASS] 3. Capa 2A confirma persistencia en suppression_list autoritativa')

    // 4. Verificar bloqueo en Capa 2B durante la comprobación Just-In-Time (JIT)
    const db = createBroadcastDatabase(':memory:')
    const localStore = new LocalSuppressionStore(db)
    const remoteChecker = new Http2ASuppressionChecker({ baseUrl: 'http://localhost:3003' })
    const compositeSuppression = new CompositeSuppressionChecker(localStore, remoteChecker)

    let dispatchesAttempted = 0
    const mockDispatcher = {
      async dispatch(to: string, text: string) {
        dispatchesAttempted++
        return { success: true, messageId: 'unexpected' }
      },
    }

    const mockLockChecker = {
      async checkLock(phone: string) {
        return { available: true }
      },
    }

    const engine = new BroadcastEngine({
      db,
      dispatcher: mockDispatcher,
      lockChecker: mockLockChecker,
      suppressionStore: compositeSuppression,
      throttlerOptions: { minIntervalMs: 0, maxIntervalMs: 0 },
    })

    // Encolar manualmente una campaña donde este contacto está en PENDING
    const campaign = await engine.createCampaign({
      organizationId: 'org_test',
      name: 'Campaña Piloto Test',
      templateSpintax: 'Hola mundo',
      csvContent: `phone,name\n${TEST_PHONE},Usuario Baja`,
    })

    // Como ya estaba suprimido al crear la campaña, el pre-filtrado debió excluirlo
    const items = engine.getItems(campaign.id)
    assert.strictEqual(items[0].status, 'SUPPRESSED', 'Pre-filtrado debe marcar SUPPRESSED')
    console.log('  ✅ [PASS] 4. Pre-filtrado de campaña en 2B excluyó al contacto suprimido')

    // Ahora simular que el contacto estaba PENDING (ingresó antes de la baja)
    db.prepare("UPDATE campaign_items SET status = 'PENDING', error_reason = NULL WHERE id = ?").run(items[0].id)
    assert.strictEqual(engine.getItems(campaign.id)[0].status, 'PENDING', 'Item forzado a PENDING para probar JIT')

    // Ejecutar despacho Just-In-Time
    const businessDate = new Date('2026-10-24T11:00:00-05:00')
    const processRes = await engine.processNextItem(campaign.id, businessDate)

    assert.strictEqual(processRes.status, 'SUPPRESSED', 'JIT pre-dispatch debió abortar como SUPPRESSED')
    assert.strictEqual(dispatchesAttempted, 0, 'CERO llamadas de despacho físico deben haberse emitido')
    assert.strictEqual(engine.getItems(campaign.id)[0].status, 'SUPPRESSED', 'Item debe quedar en SUPPRESSED en la BD')
    console.log('  ✅ [PASS] 5. Comprobación JIT en 2B interceptó la baja pre-despacho y bloqueó el envío (0 llamadas de red)')

  } finally {
    // Limpieza del registro de prueba en 2A
    await fetch(`http://localhost:3003/api/internal/suppression/${TEST_PHONE}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${secret}` },
    }).catch(() => {})
    console.log('  🧹 Registro de prueba eliminado de Capa 2A.')
  }

  console.log('\n============================================================')
  console.log('  CIRCUITO DE BAJAS COMPROBADO AL 100% CON ÉXITO')
  console.log('============================================================\n')
}

runBajasCircuitTest().catch((err) => {
  console.error('Error en prueba de bajas:', err)
  process.exit(1)
})
