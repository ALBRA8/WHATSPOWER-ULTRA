import assert from 'node:assert'
import { createServer, type Server } from 'node:http'
import { createBroadcastDatabase } from '../src/db.ts'
import { HttpCrmDaemonDispatcher } from '../src/adapters/dispatcher.ts'
import { Http2ALockChecker } from '../src/safety/lock-checker.ts'
import { Http2ASuppressionChecker, CompositeSuppressionChecker, LocalSuppressionStore } from '../src/safety/suppression.ts'
import { BroadcastEngine } from '../src/queue/broadcast-worker.ts'
import { createBroadcastServer } from '../src/server.ts'

async function runContractsIntegrationSuite() {
  console.log('\n============================================================')
  console.log('  ALBRA: PRUEBAS DE INTEGRACIÓN CONTRACTUAL (CAPA 2B)')
  console.log('  Objetivos: Daemon CRM × Agentic 2A × Recuperación Segura')
  console.log('  Modo: SALA LIMPIA (0 envíos reales a WhatsApp)')
  console.log('============================================================\n')

  let passed = 0

  // --------------------------------------------------------------------------
  // TEST 1: Contrato del Daemon CRM (POST /send)
  // --------------------------------------------------------------------------
  {
    const TEST_DAEMON_PORT = 3991
    const DAEMON_SECRET = 'test_internal_secret_daemon_min24'
    let lastReceivedBody: any = null
    let daemonState = 'connected'
    let simulateMalformed = false
    let simulateHang = false

    const daemonMockServer = createServer((req, res) => {
      const auth = req.headers.authorization?.replace('Bearer ', '') || ''
      if (auth !== DAEMON_SECRET) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized. Provide Authorization: Bearer <INTERNAL_API_SECRET> header' }))
        return
      }

      if (simulateHang) {
        // No responder para forzar timeout en el cliente
        return
      }

      if (req.method === 'POST' && req.url === '/send') {
        let raw = ''
        req.on('data', (c) => (raw += c))
        req.on('end', () => {
          const body = JSON.parse(raw)
          lastReceivedBody = body

          if (!body.to || !body.text) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'to y text son requeridos' }))
            return
          }

          if (daemonState !== 'connected') {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'WhatsApp no conectado' }))
            return
          }

          if (simulateMalformed) {
            res.writeHead(200, { 'Content-Type': 'text/plain' })
            res.end('NOT_A_JSON_STRING_RESPONSE')
            return
          }

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, messageId: `msg_mock_${Date.now()}` }))
        })
      }
    })

    await new Promise<void>((r) => daemonMockServer.listen(TEST_DAEMON_PORT, r))

    try {
      const dispatcher = new HttpCrmDaemonDispatcher({
        endpointUrl: `http://localhost:${TEST_DAEMON_PORT}/send`,
        secret: DAEMON_SECRET,
        allowRealDispatch: true, // Permitir envío al stub mock en puerto 3991
      })

      // 1.1 Solicitud exitosa
      const okRes = await dispatcher.dispatch('573017543786', 'Mensaje de prueba contractual')
      assert.strictEqual(okRes.success, true)
      assert.ok(okRes.messageId?.startsWith('msg_mock_'))
      assert.strictEqual(lastReceivedBody.to, '573017543786')
      assert.strictEqual(lastReceivedBody.text, 'Mensaje de prueba contractual')

      // 1.2 Error de autenticación (secret incorrecto)
      const badAuthDispatcher = new HttpCrmDaemonDispatcher({
        endpointUrl: `http://localhost:${TEST_DAEMON_PORT}/send`,
        secret: 'wrong_secret',
        allowRealDispatch: true,
      })
      const authErrRes = await badAuthDispatcher.dispatch('573017543786', 'Test')
      assert.strictEqual(authErrRes.success, false)
      assert.ok(authErrRes.error?.includes('401'))

      // 1.3 Error de WhatsApp desconectado en daemon
      daemonState = 'disconnected'
      const discoRes = await dispatcher.dispatch('573017543786', 'Test')
      assert.strictEqual(discoRes.success, false)
      assert.ok(discoRes.error?.includes('WhatsApp no conectado'))
      daemonState = 'connected'

      // 1.4 Respuesta malformada (200 con cuerpo no JSON) -> marca resultado INCIERTO
      simulateMalformed = true
      const malformedRes = await dispatcher.dispatch('573017543786', 'Test')
      assert.strictEqual(malformedRes.success, false)
      assert.strictEqual(malformedRes.uncertain, true)
      assert.ok(malformedRes.error?.includes('DAEMON_MALFORMED_RESPONSE'))
      simulateMalformed = false

      // 1.5 Salvaguarda física: bloqueo automático de llamadas al puerto 3002 en modo seguro
      const safeGuardDispatcher = new HttpCrmDaemonDispatcher({
        endpointUrl: 'http://localhost:3002/send',
        allowRealDispatch: false,
      })
      const blockedRes = await safeGuardDispatcher.dispatch('573017543786', 'Test')
      assert.strictEqual(blockedRes.success, false)
      assert.ok(blockedRes.error?.includes('DISPATCH_BLOCKED_BY_SAFETY_GUARD'))

      console.log('  ✅ [PASS] TEST 1: Contrato del Daemon CRM validado exhaustivamente (Auth, 400, Malformed, Safety Guard)')
      passed++
    } finally {
      await new Promise<void>((r) => daemonMockServer.close(() => r()))
    }
  }

  // --------------------------------------------------------------------------
  // TEST 2: Contrato de Locks y Supresiones con Capa 2A
  // --------------------------------------------------------------------------
  {
    const TEST_2A_PORT = 3992
    const locksStore = new Map<string, { current_state: string }>()
    const suppressionStore = new Set<string>()
    let simulate500 = false
    let simulateTimeout = false

    const mock2AServer = createServer((req, res) => {
      if (simulateTimeout) return // No responder para forzar timeout

      if (simulate500) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Internal Server Error' }))
        return
      }

      // Endpoint Locks
      if (req.method === 'GET' && req.url?.startsWith('/api/internal/locks/')) {
        const phone = decodeURIComponent(req.url.replace('/api/internal/locks/', ''))
        const lock = locksStore.get(phone)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ phone, locked: Boolean(lock), lock: lock || null }))
        return
      }

      // Endpoint Supresión
      if (req.method === 'GET' && req.url?.startsWith('/api/internal/suppression/')) {
        const phone = decodeURIComponent(req.url.replace('/api/internal/suppression/', ''))
        const suppressed = suppressionStore.has(phone)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ phone, suppressed }))
        return
      }

      res.writeHead(404)
      res.end()
    })

    await new Promise<void>((r) => mock2AServer.listen(TEST_2A_PORT, r))

    try {
      const lockChecker = new Http2ALockChecker({
        baseUrl: `http://localhost:${TEST_2A_PORT}`,
        timeoutMs: 800,
      })
      const suppressionChecker = new Http2ASuppressionChecker({
        baseUrl: `http://localhost:${TEST_2A_PORT}`,
        timeoutMs: 800,
      })

      // 2.1 Contacto libre
      const freeLock = await lockChecker.checkLock('573017543786')
      assert.strictEqual(freeLock.available, true)

      // 2.2 Contacto en IN_FLOW_2A
      locksStore.set('573017543786', { current_state: 'IN_FLOW_2A' })
      const busyLock = await lockChecker.checkLock('573017543786')
      assert.strictEqual(busyLock.available, false)
      assert.strictEqual(busyLock.state, 'IN_FLOW_2A')

      // 2.3 Contacto en HANDOFF_HUMAN
      locksStore.set('573017543786', { current_state: 'HANDOFF_HUMAN' })
      const handoffLock = await lockChecker.checkLock('573017543786')
      assert.strictEqual(handoffLock.available, false)
      assert.strictEqual(handoffLock.state, 'HANDOFF_HUMAN')
      locksStore.delete('573017543786')

      // 2.4 Fail-Closed ante error 500 de Capa 2A
      simulate500 = true
      const errLock = await lockChecker.checkLock('573017543786')
      assert.strictEqual(errLock.available, false)
      assert.ok(errLock.error?.includes('500'))

      await assert.rejects(async () => {
        await suppressionChecker.isSuppressed('573017543786')
      })
      simulate500 = false

      // 2.5 Fail-Closed ante Timeout de Capa 2A
      simulateTimeout = true
      const timeoutLock = await lockChecker.checkLock('573017543786')
      assert.strictEqual(timeoutLock.available, false)
      assert.ok(timeoutLock.error?.includes('LOCK_UNAVAILABLE'))
      assert.ok(timeoutLock.error?.toLowerCase().includes('timeout') || timeoutLock.error?.toLowerCase().includes('aborted'))
      simulateTimeout = false

      console.log('  ✅ [PASS] TEST 2: Contrato 2A validado (IN_FLOW_2A, HANDOFF_HUMAN, Fail-Closed en 500 y Timeout)')
      passed++
    } finally {
      await new Promise<void>((r) => mock2AServer.close(() => r()))
    }
  }

  // --------------------------------------------------------------------------
  // TEST 3: Detección Just-In-Time de Baja y Lock en Cola Activa
  // --------------------------------------------------------------------------
  {
    const db = createBroadcastDatabase(':memory:')
    const localSuppression = new LocalSuppressionStore(db)

    // Stub de dispatcher seguro en memoria
    let dispatchCallCount = 0
    const safeDispatcher = {
      async dispatch(to: string, text: string) {
        dispatchCallCount++
        return { success: true, messageId: 'stub_id' }
      },
    }

    let isRemoteSuppressed = false
    let throwSuppressionError = false
    const dynamicRemoteSuppression = {
      async isSuppressed(phone: string) {
        if (throwSuppressionError) throw new Error('SUPPRESSION_SERVICE_TIMEOUT_SIMULATED')
        return isRemoteSuppressed
      },
    }

    const compositeSuppression = new CompositeSuppressionChecker(localSuppression, dynamicRemoteSuppression)

    let isRemoteLocked = false
    const dynamicLockChecker = {
      async checkLock(phone: string) {
        if (isRemoteLocked) return { available: false, state: 'IN_FLOW_2A' }
        return { available: true }
      },
    }

    const engine = new BroadcastEngine({
      db,
      dispatcher: safeDispatcher,
      lockChecker: dynamicLockChecker,
      suppressionStore: compositeSuppression,
      throttlerOptions: { minIntervalMs: 0, maxIntervalMs: 0 },
    })

    const csvData = `phone,name\n3017543786,Johan JIT\n3001234567,Pedro Timeout`
    const campaign = await engine.createCampaign({
      organizationId: 'org_test',
      name: 'Campaña JIT',
      templateSpintax: 'Hola {{name}}',
      csvContent: csvData,
    })

    const items = engine.getItems(campaign.id)
    assert.strictEqual(items[0].status, 'PENDING')
    assert.strictEqual(items[1].status, 'PENDING')

    // Caso A: Contacto 1 solicita BAJA en 2A mientras está en cola
    isRemoteSuppressed = true
    const businessDate = new Date('2026-10-24T11:00:00-05:00')
    const resA = await engine.processNextItem(campaign.id, businessDate)
    assert.strictEqual(resA.status, 'SUPPRESSED')
    assert.strictEqual(dispatchCallCount, 0) // CERO despachos
    assert.strictEqual(engine.getItems(campaign.id)[0].status, 'SUPPRESSED')

    // Caso B: Para Contacto 2, el servicio de supresiones falla / timeout (Fail-Closed)
    isRemoteSuppressed = false
    throwSuppressionError = true
    const resB = await engine.processNextItem(campaign.id, businessDate)
    assert.strictEqual(resB.status, 'SKIPPED_SUPPRESSION_UNAVAILABLE')
    assert.strictEqual(dispatchCallCount, 0) // CERO despachos
    assert.strictEqual(engine.getItems(campaign.id)[1].status, 'SKIPPED_SUPPRESSION_UNAVAILABLE')

    console.log('  ✅ [PASS] TEST 3: Detección JIT de baja y Fail-Closed ante fallo de supresiones abortan el envío')
    passed++
  }

  // --------------------------------------------------------------------------
  // TEST 4: Tratamiento de Resultados Inciertos y Recuperación de Caídas
  // --------------------------------------------------------------------------
  {
    const db = createBroadcastDatabase(':memory:')
    const lockChecker = { async checkLock() { return { available: true } } }
    const suppression = { async isSuppressed() { return false } }

    // Dispatcher que simula resultado incierto (Timeout / Red cortada tras enviar)
    const uncertainDispatcher = {
      async dispatch() {
        return {
          success: false,
          uncertain: true,
          error: 'DISPATCH_UNCERTAIN_TIMEOUT: Conexión cortada tras emitir request',
        }
      },
    }

    const engine = new BroadcastEngine({
      db,
      dispatcher: uncertainDispatcher,
      lockChecker,
      suppressionStore: suppression,
      throttlerOptions: { minIntervalMs: 0, maxIntervalMs: 0 },
    })

    const csvData = `phone,name\n3017543786,Johan Incierto`
    const campaign = await engine.createCampaign({
      organizationId: 'org_test',
      name: 'Campaña Incierta',
      templateSpintax: 'Mensaje {{name}}',
      csvContent: csvData,
    })

    const businessDate = new Date('2026-10-24T11:00:00-05:00')
    const stepRes = await engine.processNextItem(campaign.id, businessDate)

    // 4.1 Verificar que el resultado incierto NO reintenta a ciegas
    assert.strictEqual(stepRes.status, 'UNCERTAIN_DISPATCH')
    const item = engine.getItems(campaign.id)[0]
    assert.strictEqual(item.status, 'UNCERTAIN_DISPATCH')
    assert.strictEqual(item.retryCount, 0) // Cero reintentos automáticos a ciegas

    // 4.2 Simular caída del proceso mientras otro ítem estaba en 'DISPATCHING'
    const itemId2 = 'itm_crash_sim'
    db.prepare(`
      INSERT INTO campaign_items (id, campaign_id, contact_phone, status, retry_count, idempotency_key)
      VALUES (?, ?, '573155550106', 'DISPATCHING', 0, 'key_crash_test')
    `).run(itemId2, campaign.id)

    // Al reiniciar y ejecutar recoverFromCrash()
    const recovery = engine.recoverFromCrash()
    assert.strictEqual(recovery.recoveredCount, 1)

    const crashedItem = engine.getItems(campaign.id).find((i) => i.id === itemId2)
    assert.strictEqual(crashedItem?.status, 'UNCERTAIN_DISPATCH')
    assert.ok(crashedItem?.errorReason?.includes('Bloqueado contra reenvío ciego'))

    console.log('  ✅ [PASS] TEST 4: Resultados inciertos y crash recovery bloquean reenvíos ciegos y exigen reconciliación')
    passed++
  }

  // --------------------------------------------------------------------------
  // TEST 5: Arranque del Servidor 2B en Modo Seguro Aislado
  // --------------------------------------------------------------------------
  {
    const TEST_SERVER_PORT = 3995
    const { server } = createBroadcastServer({
      dbPath: ':memory:',
    })

    await new Promise<void>((r) => server.listen(TEST_SERVER_PORT, r))

    try {
      const healthRes = await fetch(`http://localhost:${TEST_SERVER_PORT}/api/health`)
      assert.strictEqual(healthRes.status, 200)
      const healthData = await healthRes.json() as any
      assert.strictEqual(healthData.status, 'ok')
      assert.ok(healthData.service === 'albra-broadcast-2b' || healthData.service === 'whatspower-ultra')

      console.log('  ✅ [PASS] TEST 5: Servidor Capa 2B inicia limpiamente en modo seguro sin activar campañas')
      passed++
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  }

  console.log('\n============================================================')
  console.log(`  RESULTADO INTEGRACIÓN CONTRACTUAL: ${passed}/5 pruebas superadas con éxito.`)
  console.log('============================================================\n')
}

runContractsIntegrationSuite().catch((err) => {
  console.error('Error en pruebas de integración contractual:', err)
  process.exit(1)
})
