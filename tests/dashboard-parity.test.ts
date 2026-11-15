/**
 * dashboard-parity.test.ts — Pruebas de la Fase 3 de paridad (parity/matriz.md)
 *
 * Cubre el dashboard completo añadido por el encargo:
 *  - LOGIN/SESIÓN: página /login, canje /studio/login, /logout, 401 fail-closed.
 *  - AJUSTES/ONBOARDING: org_settings con validación de ritmo.
 *  - CONTACTOS: CRUD, unicidad por org, importación CSV PERSISTENTE, export CSV.
 *  - ETIQUETAS: CRUD + unicidad + asignación con cascada al borrar.
 *  - RESPUESTAS RÁPIDAS: CRUD con atajo único.
 *  - AGENTES: CRUD con rol válido y desasignación al borrar.
 *  - EMBUDO: etapas por defecto, mover con eventId IDEMPOTENTE, auditoría,
 *            borrado de etapa con reubicación de contactos.
 *  - CHAT: inbound real por webhook HMAC v2, bandeja, hilo marcar-leído,
 *          envío que pasa por supresión + lock 2A + transporte REAL (mock del
 *          dispatcher) y registra el mensaje outbound con su estado.
 *  - TRANSPORTE: config por org con secretos SOLO enmascarados + prueba de
 *          conexión REAL contra un daemon stub local.
 *  - CAMPAÑAS: borrado solo en terminal (409 si activa) + reintento de FAILED.
 *
 * Los 174 tests previos del motor NO cambian: todo lo nuevo es aditivo.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { createBroadcastServer } from '../src/server.ts'
import { createBroadcastDatabase } from '../src/db.ts'
import { signWebhookPayload } from '../src/security.ts'

process.env.ADMIN_API_KEYS = 'org_test:dashboard-test-key-000000000000'
process.env.WEBHOOK_LEAD_SECRETS = 'org_test:whmsg-secret-test-000000000000000000'
process.env.WEBHOOK_LEAD_SECRET = 'whmsg-secret-legacy-000000000000000000'

const ORG_SECRET = 'dashboard-test-key-000000000000'

interface Handle {
  url: string
  close: () => Promise<void>
  cookie: () => string
  login: () => Promise<void>
  dispatches: Array<{ to: string; text: string }>
  db: any
  busyPhones: Set<string>
}

async function startDashboardServer(): Promise<Handle> {
  const dispatches: Array<{ to: string; text: string }> = []
  const busyPhones = new Set<string>()
  const dispatcher = {
    async dispatch(phone: string, text: string, _org?: string) {
      dispatches.push({ to: phone, text })
      return { success: true, status: 'SENT', messageId: `m_${phone}_${dispatches.length}` }
    },
  }
  const lockChecker = {
    async checkLock(phone: string, _org?: string) {
      if (busyPhones.has(phone)) return { available: false, state: 'IN_FLOW_2A' }
      return { available: true }
    },
  }
  const { server, db } = createBroadcastServer({
    dbPath: ':memory:',
    dispatcher,
    lockChecker,
    whatsPowerEnabled: false,
  })
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port))
  })
  let sessionCookie = ''
  const handle: Handle = {
    url: `http://127.0.0.1:${port}`,
    dispatches,
    busyPhones,
    db,
    cookie: () => sessionCookie,
    async login() {
      const res = await fetch(`${handle.url}/studio/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: ORG_SECRET }),
      })
      assert.equal(res.status, 200)
      const setCookie = res.headers.get('set-cookie') || ''
      sessionCookie = setCookie.split(';')[0]
      assert.ok(sessionCookie.startsWith('wp_ultra_studio_session='))
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
  return handle
}

async function api(h: Handle, path: string, options: any = {}) {
  const res = await fetch(`${h.url}${path}`, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json', Cookie: h.cookie(), ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
    redirect: 'manual',
  })
  let data: any = null
  try { data = await res.json() } catch { /* csv u otros */ }
  return { status: res.status, data, headers: res.headers }
}

describe('DASHBOARD PARIDAD — login, sesión y páginas', () => {
  it('DP-01: GET /login sirve la página de acceso dedicada (no un prompt)', async () => {
    const h = await startDashboardServer()
    try {
      const res = await fetch(`${h.url}/login`)
      const html = await res.text()
      assert.equal(res.status, 200)
      assert.ok(html.includes('Secreto administrativo'))
      assert.ok(html.includes('/studio/login'))
      assert.ok(!html.includes('window.prompt'))
    } finally { await h.close() }
  })

  it('DP-02: GET / sirve la app del dashboard y el studio legado queda en /studio', async () => {
    const h = await startDashboardServer()
    try {
      const app = await (await fetch(`${h.url}/`)).text()
      assert.ok(app.includes('WhatsPower-Ultra'))
      assert.ok(app.includes('viewRoot'))
      const legacy = await (await fetch(`${h.url}/studio`)).text()
      assert.ok(legacy.includes('Creador de Difusión'))
    } finally { await h.close() }
  })

  it('DP-03: sin sesión, la API del dashboard responde 401 (fail-closed)', async () => {
    const h = await startDashboardServer()
    try {
      const r = await api(h, '/api/contacts')
      assert.equal(r.status, 401)
    } finally { await h.close() }
  })

  it('DP-04: el canje de sesión habilita la API y /logout la revoca', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      const ok = await api(h, '/api/settings')
      assert.equal(ok.status, 200)
      const logout = await api(h, '/logout', { method: 'POST' })
      assert.equal(logout.status, 200)
      const setCookie = logout.headers.get('set-cookie') || ''
      assert.ok(setCookie.includes('Max-Age=0'))
    } finally { await h.close() }
  })
})

describe('DASHBOARD PARIDAD — ajustes y onboarding', () => {
  it('DP-05: settings roundtrip + validación de ritmo', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      const initial = await api(h, '/api/settings')
      assert.equal(initial.status, 200)
      assert.equal(initial.data.onboardingCompletedAt, null)
      const saved = await api(h, '/api/settings', {
        method: 'PUT',
        body: { brandName: 'ALBRA Store', country: 'CO', pacingMinSeconds: 20, pacingMaxSeconds: 45, cooldownBatchSize: 25 },
      })
      assert.equal(saved.status, 200)
      assert.equal(saved.data.brandName, 'ALBRA Store')
      const done = await api(h, '/api/settings', { method: 'PUT', body: { onboardingCompleted: true } })
      assert.ok(done.data.onboardingCompletedAt > 0)
      const bad = await api(h, '/api/settings', { method: 'PUT', body: { pacingMinSeconds: 900 } })
      assert.equal(bad.status, 400)
      assert.ok(String(bad.data.error).includes('RITMO_INVALIDO'))
    } finally { await h.close() }
  })
})

describe('DASHBOARD PARIDAD — contactos', () => {
  it('DP-06: CRUD con unicidad por org y validación E.164', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      const created = await api(h, '/api/contacts', { method: 'POST', body: { phone: '573001112233', name: 'Carlos Perez' } })
      assert.equal(created.status, 201)
      assert.equal(created.data.contact.phone, '573001112233')
      const dup = await api(h, '/api/contacts', { method: 'POST', body: { phone: '+57 300 111 2233', name: 'Otro' } })
      assert.equal(dup.status, 409)
      const bad = await api(h, '/api/contacts', { method: 'POST', body: { phone: 'no-es-telefono' } })
      assert.equal(bad.status, 400)
      const updated = await api(h, `/api/contacts/${created.data.contact.phone}`, { method: 'PUT', body: { name: 'Carlos P. Editado' } })
      assert.equal(updated.status, 200)
      assert.equal(updated.data.contact.name, 'Carlos P. Editado')
      const deleted = await api(h, `/api/contacts/${created.data.contact.phone}`, { method: 'DELETE' })
      assert.equal(deleted.status, 200)
      const gone = await api(h, `/api/contacts/${created.data.contact.phone}`)
      assert.equal(gone.status, 404)
    } finally { await h.close() }
  })

  it('DP-07: importación CSV PERSISTE, normaliza +57 y dedupe en re-importación', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      const csv = 'phone,name\n3017543786,Johan Bravo\n573017543786,Johan Duplicado\n3001234567,Carlos Perez\ninvalido123,Descartado'
      const first = await api(h, '/api/contacts/import-csv', { method: 'POST', body: { csvContent: csv } })
      assert.equal(first.status, 200)
      assert.equal(first.data.inserted, 2)
      assert.equal(first.data.invalidCount, 1)
      assert.ok(first.data.validCount >= 2)
      const list = await api(h, '/api/contacts?q=Johan')
      assert.equal(list.data.contacts.length, 1)
      assert.equal(list.data.contacts[0].phone, '573017543786')
      const second = await api(h, '/api/contacts/import-csv', { method: 'POST', body: { csvContent: csv } })
      assert.equal(second.data.inserted, 0)
      assert.ok(second.data.skippedExisting >= 2)
      assert.equal(second.data.inserted + second.data.skippedExisting, first.data.inserted + first.data.skippedExisting)
    } finally { await h.close() }
  })

  it('DP-08: exportación CSV con cabecera y filas', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      await api(h, '/api/contacts', { method: 'POST', body: { phone: '573001112233', name: 'Export Test' } })
      const res = await fetch(`${h.url}/api/contacts/export.csv`, { headers: { Cookie: h.cookie() } })
      const text = await res.text()
      assert.equal(res.status, 200)
      assert.ok(text.startsWith('phone,name,email,stage,source,created_at'))
      assert.ok(text.includes('573001112233,Export Test'))
    } finally { await h.close() }
  })
})

describe('DASHBOARD PARIDAD — etiquetas', () => {
  it('DP-09: CRUD + unicidad + asignación + cascada al borrar', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      await api(h, '/api/contacts', { method: 'POST', body: { phone: '573004445555', name: 'Etiquetado' } })
      const tag = await api(h, '/api/tags', { method: 'POST', body: { name: 'VIP', color: '#10b981' } })
      assert.equal(tag.status, 201)
      const dup = await api(h, '/api/tags', { method: 'POST', body: { name: 'vip' } })
      assert.equal(dup.status, 409)
      const assigned = await api(h, `/api/contacts/573004445555/tags/${tag.data.id}`, { method: 'POST' })
      assert.equal(assigned.status, 200)
      const contact = await api(h, '/api/contacts/573004445555')
      assert.equal(contact.data.contact.tags.length, 1)
      assert.equal(contact.data.contact.tags[0].name, 'VIP')
      const listFiltered = await api(h, `/api/contacts?tagId=${tag.data.id}`)
      assert.equal(listFiltered.data.total, 1)
      const removed = await api(h, `/api/contacts/573004445555/tags/${tag.data.id}`, { method: 'DELETE' })
      assert.equal(removed.status, 200)
      const contactUntagged = await api(h, '/api/contacts/573004445555')
      assert.equal(contactUntagged.data.contact.tags.length, 0)
      const tagDeleted = await api(h, `/api/tags/${tag.data.id}`, { method: 'DELETE' })
      assert.equal(tagDeleted.status, 200)
      const afterDelete = await api(h, '/api/tags')
      assert.equal(afterDelete.data.tags.length, 0)
    } finally { await h.close() }
  })
})

describe('DASHBOARD PARIDAD — respuestas rápidas y agentes', () => {
  it('DP-10: respuestas rápidas con atajo único', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      const qr = await api(h, '/api/quick-replies', { method: 'POST', body: { shortcut: 'precio', title: 'Precios', body: 'Nuestros planes: …' } })
      assert.equal(qr.status, 201)
      const dup = await api(h, '/api/quick-replies', { method: 'POST', body: { shortcut: 'PRECIO', title: 'X', body: 'Y' } })
      assert.equal(dup.status, 409)
      const missing = await api(h, '/api/quick-replies', { method: 'POST', body: { shortcut: 'x', title: '', body: 'y' } })
      assert.equal(missing.status, 400)
      const upd = await api(h, `/api/quick-replies/${qr.data.id}`, { method: 'PUT', body: { title: 'Precios 2026' } })
      assert.equal(upd.status, 200)
      const list = await api(h, '/api/quick-replies')
      assert.equal(list.data.quickReplies.length, 1)
      assert.equal(list.data.quickReplies[0].title, 'Precios 2026')
    } finally { await h.close() }
  })

  it('DP-11: agentes con rol válido y desasignación al borrar', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      const agent = await api(h, '/api/agents', { method: 'POST', body: { name: 'Ana Vendedora', role: 'agente', email: 'ana@albra.co' } })
      assert.equal(agent.status, 201)
      const badRole = await api(h, '/api/agents', { method: 'POST', body: { name: 'Mal', role: 'supervisor' } })
      assert.equal(badRole.status, 400)
      await api(h, '/api/contacts', { method: 'POST', body: { phone: '573005556666', name: 'Lead Asignado' } })
      // La conversación nace con el primer mensaje (inbound webhook o envío chat)
      await api(h, '/api/conversations/573005556666/messages', { method: 'POST', body: { text: 'Primera conversación del lead' } })
      const assigned = await api(h, `/api/conversations/573005556666/assign`, { method: 'POST', body: { agentId: agent.data.id } })
      assert.equal(assigned.status, 200)
      const deleted = await api(h, `/api/agents/${agent.data.id}`, { method: 'DELETE' })
      assert.equal(deleted.status, 200)
      const conv = await api(h, '/api/conversations/573005556666')
      assert.equal(conv.data.conversation.assigned_agent_id, null)
    } finally { await h.close() }
  })
})

describe('DASHBOARD PARIDAD — embudo (kanban)', () => {
  it('DP-12: etapas por defecto, CRUD y borrado con reubicación', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      const stages = await api(h, '/api/pipeline/stages')
      assert.equal(stages.status, 200)
      assert.equal(stages.data.stages.length, 4)
      assert.equal(stages.data.stages[0].name, 'Nuevo')
      const extra = await api(h, '/api/pipeline/stages', { method: 'POST', body: { name: 'Reactivado' } })
      assert.equal(extra.status, 201)
      await api(h, '/api/contacts', { method: 'POST', body: { phone: '573006667777', name: 'Moverme' } })
      const lastStage = stages.data.stages[3]
      const del = await api(h, `/api/pipeline/stages/${lastStage.id}`, { method: 'DELETE' })
      assert.equal(del.status, 200)
      assert.equal(del.data.movedContacts, 0)
      // La última etapa restante NO se puede borrar
      const stages2 = await api(h, '/api/pipeline/stages')
      const only = stages2.data.stages[stages2.data.stages.length - 1]
      const delOnly = await api(h, `/api/pipeline/stages/${only.id}`, { method: 'DELETE' })
      assert.equal(delOnly.status, 200) // aún hay 4 etapas, no es la única
      const stages3 = await api(h, '/api/pipeline/stages')
      // borra todas menos una para probar ULTIMA_ETAPA
      for (let i = 0; i < stages3.data.stages.length - 1; i++) {
        await api(h, `/api/pipeline/stages/${stages3.data.stages[i].id}`, { method: 'DELETE' })
      }
      const last = (await api(h, '/api/pipeline/stages')).data.stages[0]
      const rejected = await api(h, `/api/pipeline/stages/${last.id}`, { method: 'DELETE' })
      assert.equal(rejected.status, 400)
      assert.ok(String(rejected.data.error).includes('ULTIMA_ETAPA'))
    } finally { await h.close() }
  })

  it('DP-13: mover tarjeta con eventId IDEMPOTENTE + auditoría', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      await api(h, '/api/contacts', { method: 'POST', body: { phone: '573007778888', name: 'Kanban Mover' } })
      const stages = (await api(h, '/api/pipeline/stages')).data.stages
      const eventId = `evt_${Date.now()}_1`
      const move1 = await api(h, '/api/pipeline/move', { method: 'POST', body: { phone: '573007778888', stageId: stages[1].id, eventId } })
      assert.equal(move1.status, 200)
      assert.notEqual(move1.data.duplicate, true)
      const move2 = await api(h, '/api/pipeline/move', { method: 'POST', body: { phone: '573007778888', stageId: stages[2].id, eventId } })
      assert.equal(move2.status, 200)
      assert.equal(move2.data.duplicate, true)
      const contact = await api(h, '/api/contacts/573007778888')
      assert.equal(contact.data.contact.stage_id, stages[1].id, 'el movimiento duplicado NO aplica')
      const noEvent = await api(h, '/api/pipeline/move', { method: 'POST', body: { phone: '573007778888', stageId: stages[0].id } })
      assert.equal(noEvent.status, 400)
      const audit = h.db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'pipeline.move' AND organization_id = 'org_test'`).get()
      assert.ok(Number(audit.n) >= 1)
      const col = (await api(h, `/api/contacts?stageId=${stages[1].id}`)).data
      assert.equal(col.total, 1)
    } finally { await h.close() }
  })
})

describe('DASHBOARD PARIDAD — chat (conversaciones reales)', () => {
  it('DP-14: inbound por webhook HMAC v2 crea contacto+conversación+mensaje (idempotente)', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      const body = JSON.stringify({ eventId: 'inb_1', phone: '573009998877', name: 'Entrante Web', text: 'Hola, quiero info', messageId: 'wamid.X1' })
      const ts = Date.now()
      const sig = signWebhookPayload(ts, body, 'whmsg-secret-test-000000000000000000', 'org_test')
      const res = await fetch(`${h.url}/api/audiences/webhook-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Org-Id': 'org_test', 'X-Timestamp': String(ts), 'X-Signature-SHA256': sig },
        body,
      })
      const data = await res.json()
      assert.equal(res.status, 200)
      assert.equal(data.contactCreated, true)
      const replay = await fetch(`${h.url}/api/audiences/webhook-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Org-Id': 'org_test', 'X-Timestamp': String(Date.now()), 'X-Signature-SHA256': signWebhookPayload(Date.now(), body, 'whmsg-secret-test-000000000000000000', 'org_test') },
        body,
      })
      assert.equal(replay.status, 200)
      assert.equal((await replay.json()).duplicate, true)
      const list = await api(h, '/api/conversations')
      assert.equal(list.data.total, 1)
      assert.equal(list.data.conversations[0].unread, 1)
      const thread = await api(h, '/api/conversations/573009998877')
      assert.equal(thread.data.messages.length, 1)
      assert.equal(thread.data.messages[0].direction, 'inbound')
      const afterRead = await api(h, '/api/conversations')
      assert.equal(afterRead.data.conversations[0].unread, 0, 'abrir el hilo marca leído')
      const contact = await api(h, '/api/contacts/573009998877')
      assert.equal(contact.status, 200)
      assert.equal(contact.data.contact.source, 'lead')
      // Firma inválida → 401
      const bad = await fetch(`${h.url}/api/audiences/webhook-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Org-Id': 'org_test', 'X-Timestamp': String(Date.now()), 'X-Signature-SHA256': 'deadbeef' },
        body: JSON.stringify({ eventId: 'inb_2', phone: '573009998877', text: 'x' }),
      })
      assert.equal(bad.status, 401)
    } finally { await h.close() }
  })

  it('DP-15: responder desde el chat despacha REAL con checks JIT y persiste outbound', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      await api(h, '/api/contacts', { method: 'POST', body: { phone: '573001234999', name: 'Chat Target' } })
      const send = await api(h, '/api/conversations/573001234999/messages', { method: 'POST', body: { text: 'Te escribo por tu interés *ahora*' } })
      assert.equal(send.status, 200)
      assert.equal(send.data.ok, true)
      assert.equal(send.data.message.status, 'SENT')
      assert.equal(h.dispatches.length, 1)
      assert.equal(h.dispatches[0].to, '573001234999')
      const thread = await api(h, '/api/conversations/573001234999')
      assert.equal(thread.data.messages.length, 1)
      assert.equal(thread.data.messages[0].direction, 'outbound')
      // (bug real V-12) RESPONDER de nuevo a la MISMA conversación no debe chocar
      // con la PK de conversations: segundo envío persiste sin 400
      const second = await api(h, '/api/conversations/573001234999/messages', { method: 'POST', body: { text: 'Segunda respuesta en el mismo hilo' } })
      assert.equal(second.status, 200)
      assert.equal(second.data.message.status, 'SENT')
      const thread2 = await api(h, '/api/conversations/573001234999')
      assert.equal(thread2.data.messages.length, 2)
      // texto vacío → 400
      const empty = await api(h, '/api/conversations/573001234999/messages', { method: 'POST', body: { text: '   ' } })
      assert.equal(empty.status, 400)
    } finally { await h.close() }
  })

  it('DP-16: contacto SUPRIMIDO no recibe chat (409, cero despachos)', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      await api(h, '/api/contacts', { method: 'POST', body: { phone: '573008889999', name: 'Bajado' } })
      await api(h, '/api/suppression', { method: 'POST', body: { phone: '573008889999', reason: 'opt_out_BAJA' } })
      const send = await api(h, '/api/conversations/573008889999/messages', { method: 'POST', body: { text: 'no debería salir' } })
      assert.equal(send.status, 409)
      assert.ok(String(send.data.error).includes('CONTACT_SUPPRESSED'))
      assert.equal(h.dispatches.length, 0)
    } finally { await h.close() }
  })

  it('DP-17: contacto con LOCK 2A activo no recibe chat (409, cero despachos)', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      await api(h, '/api/contacts', { method: 'POST', body: { phone: '573002223333', name: 'En Flujo' } })
      h.busyPhones.add('573002223333')
      const send = await api(h, '/api/conversations/573002223333/messages', { method: 'POST', body: { text: 'hola' } })
      assert.equal(send.status, 409)
      assert.ok(String(send.data.error).includes('CONTACT_LOCKED'))
      assert.equal(h.dispatches.length, 0)
    } finally { await h.close() }
  })
})

describe('DASHBOARD PARIDAD — integraciones (transporte real)', () => {
  it('DP-18: config por org con secretos SOLO enmascarados', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      const saved = await api(h, '/api/integrations/transport', {
        method: 'PUT',
        body: { engine: 'daemon', daemonUrl: 'http://localhost:3002', daemonSecret: 'internal-secret-abcd1234' },
      })
      assert.equal(saved.status, 200)
      assert.equal(saved.data.daemonUrl, 'http://localhost:3002')
      assert.equal(saved.data.daemonSecretLast4, '…1234')
      assert.ok(!JSON.stringify(saved.data).includes('abcd1234'), 'el secreto REAL jamás sale por la API')
      const bad = await api(h, '/api/integrations/transport', { method: 'PUT', body: { engine: 'smtp' } })
      assert.equal(bad.status, 400)
    } finally { await h.close() }
  })

  it('DP-19: prueba de conexión REAL contra daemon stub (OK y fallo)', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      const stub = createHttpServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"ok"}') })
      const stubPort = await new Promise<number>((r) => stub.listen(0, '127.0.0.1', () => r((stub.address() as any).port)))
      const ok = await api(h, '/api/integrations/transport/test', { method: 'POST', body: { engine: 'daemon', daemonUrl: `http://127.0.0.1:${stubPort}` } })
      assert.equal(ok.status, 200)
      assert.equal(ok.data.ok, true)
      assert.ok(ok.data.latencyMs >= 0)
      await new Promise<void>((r) => stub.close(() => r()))
      const fail = await api(h, '/api/integrations/transport/test', { method: 'POST', body: { engine: 'daemon', daemonUrl: 'http://127.0.0.1:59999' } })
      assert.equal(fail.status, 200)
      assert.equal(fail.data.ok, false)
      assert.ok(fail.data.error)
    } finally { await h.close() }
  })
})

describe('DASHBOARD PARIDAD — campañas: borrar y reintentar', () => {
  it('DP-20: campaña activa NO se borra (409) y terminal sí (200, sin ítems)', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      const csv = 'phone,name\n573000111222,Uno\n573000333444,Dos'
      const created = await api(h, '/api/campaigns', { method: 'POST', body: { name: 'Para Borrar', templateSpintax: 'Hola {{nombre}}', csvContent: csv } })
      assert.equal(created.status, 201)
      const campaignId = created.data.id
      const activeDel = await api(h, `/api/campaigns/${campaignId}`, { method: 'DELETE' })
      assert.equal(activeDel.status, 409)
      const cancelled = await api(h, `/api/campaigns/${campaignId}/cancel`, { method: 'POST' })
      assert.equal(cancelled.status, 200)
      const del = await api(h, `/api/campaigns/${campaignId}`, { method: 'DELETE' })
      assert.equal(del.status, 200)
      const gone = await api(h, `/api/campaigns/${campaignId}`)
      assert.equal(gone.status, 404)
      const items = h.db.prepare('SELECT COUNT(*) AS n FROM campaign_items WHERE campaign_id = ?').get(campaignId)
      assert.equal(Number(items.n), 0)
    } finally { await h.close() }
  })

  it('DP-21: retry-failed reencola los ítems FAILED a PENDING', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      const csv = 'phone,name\n573000777888,Reintento'
      const created = await api(h, '/api/campaigns', { method: 'POST', body: { name: 'Con Fallos', templateSpintax: 'Hola {{nombre}}', csvContent: csv } })
      const campaignId = created.data.id
      h.db.prepare(`UPDATE campaign_items SET status = 'FAILED', error_reason = 'dispatch_failed' WHERE campaign_id = ?`).run(campaignId)
      const retry = await api(h, `/api/campaigns/${campaignId}/retry-failed`, { method: 'POST' })
      assert.equal(retry.status, 200)
      assert.equal(retry.data.requeued, 1)
      const pending = h.db.prepare(`SELECT COUNT(*) AS n FROM campaign_items WHERE campaign_id = ? AND status = 'PENDING'`).get(campaignId)
      assert.equal(Number(pending.n), 1)
    } finally { await h.close() }
  })
})

describe('DASHBOARD PARIDAD — resumen y aislamiento', () => {
  it('DP-22: summary agrega métricas REALES por organización', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      const csv = 'phone,name\n573001112200,SumUno\n573001112201,SumDos'
      const created = await api(h, '/api/campaigns', { method: 'POST', body: { name: 'Sumario', templateSpintax: 'Hola {{nombre}}', csvContent: csv } })
      h.db.prepare(`UPDATE campaigns SET sent_count = 10, failed_count = 2, skipped_count = 1 WHERE id = ?`).run(created.data.id)
      h.db.prepare(`INSERT INTO tracked_links (code, campaign_id, target_url, clicks, created_at) VALUES ('sumc1', ?, 'https://albra.co', 4, ?)`).run(created.data.id, Math.floor(Date.now() / 1000))
      await api(h, '/api/contacts', { method: 'POST', body: { phone: '573009990000', name: 'SumContacto' } })
      const summary = await api(h, '/api/dashboard/summary')
      assert.equal(summary.status, 200)
      assert.equal(summary.data.campaignsTotal, 1)
      assert.equal(summary.data.sentTotal, 10)
      assert.equal(summary.data.clicks, 4)
      assert.equal(summary.data.contactsTotal, 1)
      assert.equal(summary.data.ctrPercent, 40)
      // Aislamiento org: una campaña de OTRA organización (insertada directo) NO cuenta
      h.db.prepare(
        `INSERT INTO campaigns (id, organization_id, name, template_spintax, status, total_targets, sent_count, failed_count, skipped_count, created_at)
         VALUES ('cmp_ajena', 'org_otra', 'Ajena', 'x', 'COMPLETED', 1, 99, 0, 0, ?)`
      ).run(Math.floor(Date.now() / 1000))
      const stillMine = await api(h, '/api/dashboard/summary')
      assert.equal(stillMine.data.campaignsTotal, 1, 'la identidad ligada jamás ve campañas de otras orgs')
      assert.equal(stillMine.data.sentTotal, 10)
      assert.equal(stillMine.data.contactsTotal, 1, 'contactos de org_test solamente')
    } finally { await h.close() }
  })
})
