/**
 * e2e-cross-flow.test.ts — (reparación 2026-11-17, FASE 4.2)
 *
 * SIMULACIÓN DE FLUJO CRUZADO (contrato real entre capas, SIN envío real):
 *
 *   CRM captura lead y registra consentimiento (POST /api/compliance/consent)
 *     → campaña en ULTRA al contacto → despacho SENT (dispatcher simulado)
 *       → mensaje entrante simulado "STOP" (circuito de bajas del canal)
 *         → POST /api/compliance/opt-out → consentimiento REVOCADO en ConsentStore
 *           → nueva campaña en ULTRA al MISMO teléfono → ítem pre-filtrado SUPPRESSED
 *           → contacto SIN consentimiento (sin baja) → JIT: SKIPPED_NO_CONSENT
 *
 * Garantías verificadas: ALLOW_REAL_DISPATCH=false (salvaguarda física),
 * aislamiento por organización (la baja NO contamina otra org), persistencia
 * del consentimiento tras "reiniciar" el proceso (mismo archivo BD, nuevo engine).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBroadcastServer } from '../src/server.ts'
import { BroadcastEngine } from '../src/queue/broadcast-worker.ts'
import { ConsentStore } from '../src/safety/consent-store.ts'
import { LocalSuppressionStore } from '../src/safety/suppression.ts'
import { HttpCrmDaemonDispatcher } from '../src/adapters/dispatcher.ts'
import { createBroadcastDatabase } from '../src/db.ts'

const BUSINESS_DATE = new Date('2026-11-17T14:00:00Z') // horario comercial
const ORG_A = 'org_cross_a'
const ORG_B = 'org_cross_b'

function apiCall(port: number, path: string, method: string, headers: Record<string, string>, body?: string): Promise<{ status: number | undefined; json: any }> {
  return new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, { method, headers }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => {
        let json: any = null
        try { json = JSON.parse(data) } catch {}
        resolve({ status: res.statusCode, json })
      })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

test('FASE 4.2 — simulación de flujo cruzado CRM → ULTRA con salvaguarda de consentimiento', async (t) => {
  // BD en ARCHIVO (no ':memory:'): permite verificar persistencia tras "reinicio"
  const dir = mkdtempSync(join(tmpdir(), 'e2e-cross-'))
  const dbPath = join(dir, 'cross-flow.db')
  process.env.ADMIN_API_KEYS = 'ultra_e2e_admin_key_min32chars_01:org_cross_a,ultra_e2e_admin_key_min32chars_02:org_cross_b'

  // Dispatcher SIMULADO (transporte de prueba): el flujo cruzado verifica el
  // CONTRATO y las salvaguardas, no la red. La salvaguarda física real
  // (ALLOW_REAL_DISPATCH=false) se verifica aparte en 4.2.7.
  const mockDispatcher = { dispatch: async () => ({ success: true, messageId: 'msg_e2e_cross_test' }) }

  const { server, db, engine } = createBroadcastServer({ dbPath, whatsPowerEnabled: false, dispatcher: mockDispatcher })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as any).port
  const authA = { 'Authorization': 'Bearer ultra_e2e_admin_key_min32chars_01', 'Content-Type': 'application/json' }

  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))

  await t.test('4.2.1 CRM registra consentimiento del lead (contrato /api/compliance/consent)', async () => {
    const res = await apiCall(port, '/api/compliance/consent', 'POST', authA, JSON.stringify({
      contactPhone: '+573000000000',
      whoAuthorized: 'Usuario Demo',
      channel: 'WEB_FORM',
      textShown: 'Autorizo recibir comunicaciones de la organización (datos de prueba)',
      source: 'crm_lead_form',
    }))
    assert.equal(res.status, 201, `consentimiento registrado vía contrato (${res.status})`)
    assert.equal(res.json?.ok, true)
  })

  await t.test('4.2.2 Campaña ULTRA al contacto con consentimiento → despacha (SENT, sin envío real)', async () => {
    const campaign = await engine.createCampaign({
      organizationId: ORG_A,
      name: 'Campaña posterior al consentimiento (datos ficticios)',
      templateSpintax: 'Hola {amigo|cliente}',
      csvContent: 'phone,name\n+573000000000,Usuario Demo',
    })
    const res = await engine.processNextItem(campaign.id, BUSINESS_DATE)
    assert.equal(res.status, 'SENT', 'con consentimiento vigente el despacho procede')
    assert.equal(engine.getCampaign(campaign.id)!.sentCount, 1)
  })

  await t.test('4.2.3 Mensaje entrante simulado "STOP" → baja por contrato → consentimiento REVOCADO', async () => {
    // El canal (WP/Cap 2A) procesa el "STOP" del cliente y notifica la baja:
    // el endpoint equivalente en ULTRA es /api/compliance/opt-out.
    const res = await apiCall(port, '/api/compliance/opt-out', 'POST', authA, JSON.stringify({
      contactPhone: '+573000000000',
      reason: 'STOP',
    }))
    assert.equal(res.status, 200, 'baja registrada')
    assert.equal(res.json?.suppressed, true)
    assert.equal(res.json?.consentRevoked, true, 'la baja REVOKA el consentimiento (no solo suprime)')
  })

  await t.test('4.2.4 Nueva campaña al mismo contacto → pre-filtrado SUPPRESSED (JIT anti-baja)', async () => {
    const campaign = await engine.createCampaign({
      organizationId: ORG_A,
      name: 'Campaña tras la baja (datos ficticios)',
      templateSpintax: 'Hola {amigo|cliente}',
      csvContent: 'phone,name\n+573000000000,Usuario Demo',
    })
    const items = engine.getItems(campaign.id)
    assert.equal(items[0].status, 'SUPPRESSED', 'el pre-filtrado de importación excluye al contacto de baja')
    assert.equal(engine.getCampaign(campaign.id)!.skippedCount, 1)
  })

  await t.test('4.2.5 Contacto de OTRA organización SIN consentimiento → SKIPPED_NO_CONSENT (aislamiento)', async () => {
    // El mismo teléfono en org B NO hereda consent ni bajas de org A (política 5.B)
    const campaign = await engine.createCampaign({
      organizationId: ORG_B,
      name: 'Campaña org B sin consentimiento (datos ficticios)',
      templateSpintax: 'Hola {amigo|cliente}',
      csvContent: 'phone,name\n+573000000000,Usuario Demo',
    })
    const res = await engine.processNextItem(campaign.id, BUSINESS_DATE)
    assert.equal(res.status, 'SKIPPED_NO_CONSENT', 'sin consentimiento EN SU organización no se despacha (Ley 1581)')
    const item = engine.getItems(campaign.id)[0]
    assert.equal(item.status, 'SKIPPED_NO_CONSENT')
    assert.equal(item.messageId, undefined, 'jamás se despachó')
  })

  await t.test('4.2.6 Reinicio del proceso: el consentimiento y las bajas PERSISTEN (mismo archivo BD)', async () => {
    // Nuevo engine sobre el MISMO archivo: simula reinicio del worker/servidor
    const db2 = createBroadcastDatabase(dbPath)
    const consentStore2 = new ConsentStore(db2)
    const suppression2 = new LocalSuppressionStore(db2, consentStore2)
    assert.equal(consentStore2.hasActiveConsent(ORG_A, '+573000000000'), false, 'la baja revocó el consentimiento y PERSISTE')
    assert.equal(await suppression2.isSuppressed('+573000000000', ORG_A), true, 'la baja PERSISTE en org A')
    assert.equal(await suppression2.isSuppressed('+573000000000', ORG_B), false, 'la baja NO contamina org B')
    db2.close()
  })

  await t.test('4.2.7 Salvaguarda física: ALLOW_REAL_DISPATCH=false sigue bloqueando despachos reales', async () => {
    // El dispatcher por defecto del server se crea con allowRealDispatch del env:
    // con la variable ausente/false NINGÚN envío sale aunque el flujo diga SENT.
    const d = new HttpCrmDaemonDispatcher({ allowRealDispatch: false })
    const r = await d.dispatch('+573000000000', 'texto de prueba (ficticio)', ORG_A)
    assert.ok(!r.success, 'sin ALLOW_REAL_DISPATCH=true el despacho real está BLOQUEADO')
  })
})
