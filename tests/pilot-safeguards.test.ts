import assert from 'node:assert'
import { createBroadcastDatabase } from '../src/db.ts'
import { BroadcastEngine } from '../src/queue/broadcast-worker.ts'
import { HttpCrmDaemonDispatcher } from '../src/adapters/dispatcher.ts'
import { createBroadcastServer } from '../src/server.ts'
import { PILOT_SUPERVISED_CONFIG, validatePilotPreconditions } from '../src/pilot-config.ts'

async function runPilotSafeguardsSuite() {
  console.log('\n============================================================')
  console.log('  ALBRA: VERIFICACIÓN FINAL DE SALVAGUARDAS PRE-PILOTO C2B')
  console.log('  Modo: SALA LIMPIA (0 envíos reales)')
  console.log('============================================================\n')

  const TEST_2A_URL = 'http://localhost:3003'
  // FAIL-CLOSED (rotación 2026-10-27): la suite exige el secret en el entorno, sin literales publicadas
  const validSecret = process.env.INTERNAL_API_SECRET
  if (!validSecret) {
    console.error('FAIL-CLOSED: INTERNAL_API_SECRET ausente. Abortando suite.')
    process.exit(1)
  }
  const TEST_PHONE = '573999111222'

  let passed = 0

  // --------------------------------------------------------------------------
  // PRUEBA 1 & 2: Protección de Supresiones y Bloqueo de Eliminación No Autorizada
  // --------------------------------------------------------------------------
  {
    // Limpieza inicial
    await fetch(`${TEST_2A_URL}/api/internal/suppression/${TEST_PHONE}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${validSecret}` },
    }).catch(() => {})

    // 1.1 Registrar supresión autorizada
    const postRes = await fetch(`${TEST_2A_URL}/api/internal/suppression/${TEST_PHONE}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${validSecret}`,
      },
      body: JSON.stringify({ reason: 'Test salvaguarda pre-piloto' }),
    })
    assert.strictEqual(postRes.status, 200)
    const postData = await postRes.json() as any
    assert.strictEqual(postData.suppressed, true)

    // 1.2 Verificar consulta GET
    const getRes1 = await fetch(`${TEST_2A_URL}/api/internal/suppression/${TEST_PHONE}`)
    const getData1 = await getRes1.json() as any
    assert.strictEqual(getData1.suppressed, true)
    console.log('  ✅ [PASS] 1. Supresión protegida y persistida correctamente en Capa 2A')
    passed++

    // 2.1 Intento de DELETE sin cabecera de autenticación -> 401
    const delNoAuth = await fetch(`${TEST_2A_URL}/api/internal/suppression/${TEST_PHONE}`, {
      method: 'DELETE',
    })
    assert.strictEqual(delNoAuth.status, 401, 'DELETE sin autenticación debe retornar 401')

    // 2.2 Intento de DELETE con token inválido -> 401
    const delBadAuth = await fetch(`${TEST_2A_URL}/api/internal/suppression/${TEST_PHONE}`, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer token_malicioso_falso' },
    })
    assert.strictEqual(delBadAuth.status, 401, 'DELETE con token inválido debe retornar 401')

    // 2.3 Verificar que la supresión SIGUE intacta (no fue borrada)
    const getRes2 = await fetch(`${TEST_2A_URL}/api/internal/suppression/${TEST_PHONE}`)
    const getData2 = await getRes2.json() as any
    assert.strictEqual(getData2.suppressed, true, 'La supresión debe continuar activa tras intentos no autorizados')
    console.log('  ✅ [PASS] 2. Intento de eliminación no autorizado bloqueado estrictamente (401, baja intacta)')
    passed++

    // Limpieza autorizada
    await fetch(`${TEST_2A_URL}/api/internal/suppression/${TEST_PHONE}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${validSecret}` },
    })
  }

  // --------------------------------------------------------------------------
  // PRUEBA 3: Despacho Real sin Autorización Bloqueado
  // --------------------------------------------------------------------------
  {
    // Constructor por defecto (allowRealDispatch: false) apuntando al puerto real del daemon
    const safeDispatcher = new HttpCrmDaemonDispatcher({
      endpointUrl: 'http://localhost:3002/send',
    })

    const dispatchRes = await safeDispatcher.dispatch('573017543786', 'Mensaje de prueba')
    assert.strictEqual(dispatchRes.success, false)
    assert.ok(dispatchRes.error?.includes('DISPATCH_BLOCKED_BY_SAFETY_GUARD'))
    console.log('  ✅ [PASS] 3. Despacho hacia puerto real bloqueado por salvaguarda física (allowRealDispatch: false)')
    passed++
  }

  // --------------------------------------------------------------------------
  // PRUEBA 4: Servidor 2B Inicia sin Disparar Campaña
  // --------------------------------------------------------------------------
  {
    const TEST_2B_PORT = 3981
    const { server, db, engine } = createBroadcastServer({ dbPath: ':memory:' })
    await new Promise<void>((r) => server.listen(TEST_2B_PORT, r))

    try {
      // Verificar que el servidor responde healthcheck
      const healthRes = await fetch(`http://localhost:${TEST_2B_PORT}/api/health`)
      const healthData = await healthRes.json() as any
      assert.strictEqual(healthData.status, 'ok')

      // Verificar que no hay campañas corriendo en la BD al arrancar
      const activeCampaigns = db.prepare("SELECT COUNT(*) as count FROM campaigns WHERE status = 'RUNNING'").get() as any
      assert.strictEqual(activeCampaigns.count, 0)
      console.log('  ✅ [PASS] 4. Servidor 2B arranca limpiamente en modo seguro sin disparar ninguna campaña')
      passed++
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  }

  // --------------------------------------------------------------------------
  // PRUEBA 5: Campaña Configurada pero sin Autorización Explícita -> No Despacha
  // --------------------------------------------------------------------------
  {
    // 5.1 Validar que la configuración del piloto rechaza ejecución
    const checkPilot = validatePilotPreconditions(PILOT_SUPERVISED_CONFIG)
    assert.strictEqual(checkPilot.canExecute, false)
    assert.ok(checkPilot.blockers.some((b) => b.includes('PILOT_NOT_AUTHORIZED')))
    assert.ok(checkPilot.blockers.some((b) => b.includes('OPERATOR_PHONE_MISSING')))

    // 5.2 Si se crea una campaña en BD, permanece inactiva sin bucle de despacho autónomo
    const db = createBroadcastDatabase(':memory:')
    const mockDispatcher = {
      calls: 0,
      async dispatch() { this.calls++; return { success: true } },
    }
    const engine = new BroadcastEngine({
      db,
      dispatcher: mockDispatcher as any,
      lockChecker: { async checkLock() { return { available: true } } },
      suppressionStore: { async isSuppressed() { return false } },
    })

    const campaign = await engine.createCampaign({
      organizationId: 'org_test',
      name: PILOT_SUPERVISED_CONFIG.campaignName,
      templateSpintax: PILOT_SUPERVISED_CONFIG.templateSpintax,
      csvContent: 'phone,name\n3000000000,Placeholder',
    })

    assert.strictEqual(campaign.status, 'DRAFT')
    assert.strictEqual(mockDispatcher.calls, 0) // CERO llamadas de despacho
    console.log('  ✅ [PASS] 5. Campaña en DRAFT permanece bloqueada sin autorización (0 despachos)')
    passed++
  }

  // --------------------------------------------------------------------------
  // PRUEBA 6: UNCERTAIN_DISPATCH Continúa sin Reintento Automático
  // --------------------------------------------------------------------------
  {
    const db = createBroadcastDatabase(':memory:')
    let dispatchCallCount = 0
    const mockDispatcher = {
      async dispatch() {
        dispatchCallCount++
        return { success: true, messageId: 'unexpected' }
      },
    }

    const engine = new BroadcastEngine({
      db,
      dispatcher: mockDispatcher as any,
      lockChecker: { async checkLock() { return { available: true } } },
      suppressionStore: { async isSuppressed() { return false } },
      throttlerOptions: { minIntervalMs: 0, maxIntervalMs: 0 },
    })

    const campaign = await engine.createCampaign({
      organizationId: 'org_test',
      name: 'Test Reintentos Inciertos',
      templateSpintax: 'Hola',
      csvContent: 'phone,name\n573017543786,Test Contact',
    })

    const item = engine.getItems(campaign.id)[0]

    // Simular que el ítem quedó en UNCERTAIN_DISPATCH
    db.prepare("UPDATE campaign_items SET status = 'UNCERTAIN_DISPATCH', error_reason = 'Timeout de red' WHERE id = ?").run(item.id)

    // Intentar procesar siguiente ítem en la campaña
    const businessDate = new Date('2026-10-24T11:00:00-05:00')
    const processRes = await engine.processNextItem(campaign.id, businessDate)

    // El worker debe ignorar UNCERTAIN_DISPATCH y concluir que no quedan ítems PENDING
    assert.strictEqual(processRes.status, 'COMPLETED')
    assert.strictEqual(dispatchCallCount, 0, 'UNCERTAIN_DISPATCH jamás debe ser reintentado por el worker')

    // Simular reinicio y recuperación ante caídas (crash recovery)
    db.prepare("UPDATE campaign_items SET status = 'DISPATCHING' WHERE id = ?").run(item.id)
    const recoveryRes = engine.recoverFromCrash()
    assert.strictEqual(recoveryRes.recoveredCount, 1)

    const recoveredItem = engine.getItems(campaign.id)[0]
    assert.strictEqual(recoveredItem.status, 'UNCERTAIN_DISPATCH')
    console.log('  ✅ [PASS] 6. UNCERTAIN_DISPATCH aislado: inmune a reintentos automáticos y preservado tras crash')
    passed++
  }

  console.log('\n============================================================')
  console.log(`  RESULTADO: ${passed}/6 salvaguardas validadas con 100% de éxito.`)
  console.log('============================================================\n')
}

runPilotSafeguardsSuite().catch((err) => {
  console.error('Error en suite de salvaguardas:', err)
  process.exit(1)
})
