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
import vm from 'node:vm'
import { createBroadcastServer } from '../src/server.ts'
import { createBroadcastDatabase } from '../src/db.ts'
import { signWebhookPayload } from '../src/security.ts'
import { renderDashboardAppHtml } from '../src/studio/dashboard-html.ts'

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
      const csv = 'phone,name\n3000000001,Contacto Demo\n573000000001,Contacto Duplicado\n3001234567,Carlos Perez\ninvalido123,Descartado'
      const first = await api(h, '/api/contacts/import-csv', { method: 'POST', body: { csvContent: csv } })
      assert.equal(first.status, 200)
      assert.equal(first.data.inserted, 2)
      assert.equal(first.data.invalidCount, 1)
      assert.ok(first.data.validCount >= 2)
      const list = await api(h, '/api/contacts?q=Contacto')
      assert.equal(list.data.contacts.length, 1)
      assert.equal(list.data.contacts[0].phone, '573000000001')
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
      const fail = await api(h, '/api/integrations/transport/test', { method: 'POST', body: { engine: 'daemon', daemonUrl: `http://127.0.0.1:${stubPort}` } })
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

describe('DASHBOARD PARIDAD — flujos F2/F8/F9/F12 (cierre de panel)', () => {
  // F2: Onboarding saltable, no vuelve a salir, lleva al Resumen
  it('DP-23 (F2): onboarding se puede saltar y no vuelve a aparecer', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      // Al inicio, onboarding NO está completado
      let s = await api(h, '/api/settings')
      assert.equal(s.status, 200)
      assert.equal(s.data.onboardingCompletedAt, null, 'onboarding pendiente al inicio')
      // Marcar como completado (equivale a "saltar" o "terminar")
      const put = await api(h, '/api/settings', { method: 'PUT', body: { onboardingCompleted: true } })
      assert.equal(put.status, 200)
      assert.ok(put.data.onboardingCompletedAt > 0, 'queda registrado con timestamp')
      // Volver a pedir settings: ya no aparece como pendiente
      s = await api(h, '/api/settings')
      assert.ok(s.data.onboardingCompletedAt > 0, 'no vuelve a salir')
    } finally { await h.close() }
  })

  // F8: Historial de campañas carga la lista real
  it('DP-24 (F8): historial de campañas lista campañas reales con sus contadores', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      // Crear dos campañas
      await api(h, '/api/campaigns', { method: 'POST', body: { name: 'Hist A', templateSpintax: 'Hola', csvContent: 'phone,name\n573001112200,A' } })
      await api(h, '/api/campaigns', { method: 'POST', body: { name: 'Hist B', templateSpintax: 'Hola', csvContent: 'phone,name\n573001112201,B' } })
      // GET /api/campaigns devuelve {campaigns: [...]} (lo que usa loadCampaignsList)
      const lista = await api(h, '/api/campaigns')
      assert.equal(lista.status, 200)
      const arr = lista.data.campaigns || lista.data
      assert.ok(Array.isArray(arr))
      assert.equal(arr.length, 2, 'historial muestra las dos campañas')
      const nombres = arr.map((c: any) => c.name).sort()
      assert.deepEqual(nombres, ['Hist A', 'Hist B'])
    } finally { await h.close() }
  })

  // F9: Supresión (bajas) con alta y listado real
  it('DP-25 (F9): alta y listado de supresión (bajas) funciona contra el endpoint real', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      // Alta de un número en la lista de supresión (devuelve 201 Created)
      const alta = await api(h, '/api/suppression', { method: 'POST', body: { phone: '573009998877', reason: 'Solicitó baja en chat' } })
      assert.ok(alta.status === 200 || alta.status === 201, 'alta responde 200 o 201')
      // Listado trae el número dado de baja
      const lista = await api(h, '/api/suppression')
      assert.equal(lista.status, 200)
      const arr = lista.data.suppression || lista.data || []
      const phones = arr.map((s: any) => s.phone)
      assert.ok(phones.includes('573009998877'), 'el número dado de baja aparece en la lista')
    } finally { await h.close() }
  })

  // F12: Cada endpoint real tiene los 3 estados (vacío, con datos, error)
  it('DP-26 (F12): estado vacío real — sin datos, summary devuelve ceros (no inventa)', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      const s = await api(h, '/api/dashboard/summary')
      assert.equal(s.status, 200)
      // Sin campañas ni contactos, los contadores son 0 (no inventados)
      assert.equal(s.data.campaignsTotal, 0)
      assert.equal(s.data.contactsTotal, 0)
      assert.equal(s.data.sentTotal, 0)
      assert.equal(s.data.clicks, 0)
      // La lista de contactos también está vacía
      const c = await api(h, '/api/contacts')
      assert.equal(c.status, 200)
      assert.equal((c.data.contacts || c.data || []).length, 0, 'sin contactos inventados')
    } finally { await h.close() }
  })
})

// ---------------------------------------------------------------------------
// PANEL USABLE — paginación del hilo (F4), export completo (F6), motivo de
// fallo (F5), embudo filtrable (F7), sesión (F10), consentimiento (F9) y
// accesibilidad/móvil (F11).
// ---------------------------------------------------------------------------

function seedPanelThread(h: Handle, phone: string, count: number) {
  const now = Math.floor(Date.now() / 1000)
  h.db.prepare('INSERT OR REPLACE INTO contacts (organization_id, phone, name, source, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run('org_test', phone, 'Hilo', 'manual', now, now)
  h.db.prepare('INSERT OR REPLACE INTO conversations (organization_id, contact_phone, contact_name, last_message_at, last_message_text, last_direction, unread, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('org_test', phone, 'Hilo', now + count, 'hola', 'inbound', 0, now)
  for (let i = 0; i < count; i++) {
    h.db.prepare('INSERT INTO messages (organization_id, id, conversation_phone, direction, text, status, source, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('org_test', `msg_${phone}_${i}`, phone, 'inbound', `hola ${i}`, 'RECEIVED', 'webhook', now + i)
  }
}

function seedPanelContacts(h: Handle, count: number, stageId: string) {
  const now = Math.floor(Date.now() / 1000)
  const stmt = h.db.prepare('INSERT OR REPLACE INTO contacts (organization_id, phone, name, stage_id, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
  for (let i = 1; i <= count; i++) {
    stmt.run('org_test', '573' + String(100000000 + i), 'Contacto ' + i, stageId, 'manual', now, now)
  }
}

describe('PANEL USABLE — hilo paginado, export completo, embudo, sesión y consentimiento', () => {
  it('DP-27: el hilo sirve los 50 mensajes más recientes y pagina hacia atrás sin repetir ni perder', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      seedPanelThread(h, '573001112233', 60)
      const p1 = await api(h, '/api/conversations/573001112233')
      assert.equal(p1.status, 200)
      assert.equal(p1.data.messages.length, 50)
      assert.equal(p1.data.hasMore, true)
      assert.equal(p1.data.messages[0].text, 'hola 10')
      assert.equal(p1.data.messages[49].text, 'hola 59')
      const p2 = await api(h, '/api/conversations/573001112233?limit=50&before=' + encodeURIComponent(p1.data.oldestMessageId))
      assert.equal(p2.status, 200)
      assert.equal(p2.data.messages.length, 10)
      assert.equal(p2.data.hasMore, false)
      assert.equal(p2.data.messages[0].text, 'hola 0')
      assert.equal(p2.data.messages[9].text, 'hola 9')
      const ids1 = new Set(p1.data.messages.map((m: any) => m.id))
      assert.ok(p2.data.messages.every((m: any) => !ids1.has(m.id)))
      const small = await api(h, '/api/conversations/573001112233?limit=5')
      assert.equal(small.data.messages.length, 5)
      assert.equal(small.data.hasMore, true)
      assert.equal(small.data.messages[4].text, 'hola 59')
    } finally { await h.close() }
  })

  it('DP-28: export.csv sale COMPLETO (más de 200 filas) y respeta el filtro de la pantalla', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      seedPanelContacts(h, 250, '')
      const res = await fetch(`${h.url}/api/contacts/export.csv`, { headers: { Cookie: h.cookie() } })
      assert.equal(res.status, 200)
      assert.ok((res.headers.get('content-type') || '').includes('text/csv'))
      const text = await res.text()
      const lines = text.trim().split('\n')
      assert.equal(lines[0], 'phone,name,email,stage,source,created_at')
      assert.equal(lines.length, 251)
      assert.ok(text.includes('573100000001'))
      assert.ok(text.includes('573100000250'))
      const filtrado = await fetch(`${h.url}/api/contacts/export.csv?q=Contacto%20123`, { headers: { Cookie: h.cookie() } })
      assert.equal(filtrado.status, 200)
      const fLines = (await filtrado.text()).trim().split('\n')
      assert.equal(fLines.length, 2)
      assert.ok(fLines[1].startsWith('573100000123,Contacto 123,'))
    } finally { await h.close() }
  })

  it('DP-29: un envío fallido llega al panel con el motivo real del transporte', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      seedPanelThread(h, '573001112244', 1)
      const now = Math.floor(Date.now() / 1000)
      h.db.prepare('INSERT INTO messages (organization_id, id, conversation_phone, direction, text, status, source, error, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run('org_test', 'msg_fail_1', '573001112244', 'outbound', 'aviso', 'FAILED', 'campaign', '131026: recipient cannot receive', now + 5)
      const r = await api(h, '/api/conversations/573001112244')
      assert.equal(r.status, 200)
      const failed = r.data.messages.find((m: any) => m.id === 'msg_fail_1')
      assert.ok(failed, 'el mensaje fallido debe aparecer en el hilo')
      assert.equal(failed.status, 'FAILED')
      assert.equal(failed.error, '131026: recipient cannot receive')
    } finally { await h.close() }
  })

  it('DP-30: el embudo pagina cada columna, filtra por nombre y mover dos veces no duplica', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      const st = await api(h, '/api/pipeline/stages')
      assert.equal(st.status, 200)
      const stage = st.data.stages[0]
      assert.ok(stage && stage.id, 'debe haber al menos una etapa')
      seedPanelContacts(h, 60, stage.id)
      const first = await api(h, '/api/contacts?limit=50&offset=0&stageId=' + encodeURIComponent(stage.id))
      assert.equal(first.data.contacts.length, 50)
      const second = await api(h, '/api/contacts?limit=50&offset=50&stageId=' + encodeURIComponent(stage.id))
      assert.equal(second.data.contacts.length, 10)
      const idsA = new Set(first.data.contacts.map((c: any) => c.phone))
      assert.ok(second.data.contacts.every((c: any) => !idsA.has(c.phone)))
      const busca = await api(h, '/api/contacts?limit=50&offset=0&stageId=' + encodeURIComponent(stage.id) + '&q=Contacto%2057')
      assert.equal(busca.data.contacts.length, 1)
      assert.equal(busca.data.contacts[0].name, 'Contacto 57')
      const phone = busca.data.contacts[0].phone
      const destino = st.data.stages[1]
      assert.ok(destino && destino.id, 'deben existir al menos dos etapas para mover')
      const move1 = await api(h, '/api/pipeline/move', { method: 'POST', body: { phone, stageId: destino.id, eventId: 'ev_dp30' } })
      assert.equal(move1.status, 200)
      assert.ok(!move1.data.duplicate)
      const movido = await api(h, '/api/contacts/' + encodeURIComponent(phone))
      assert.equal(movido.data.contact.stage_id, destino.id)
      const move2 = await api(h, '/api/pipeline/move', { method: 'POST', body: { phone, stageId: destino.id, eventId: 'ev_dp30' } })
      assert.equal(move2.status, 200)
      assert.equal(move2.data.duplicate, true)
      const sinEvento = await api(h, '/api/pipeline/move', { method: 'POST', body: { phone, stageId: destino.id } })
      assert.equal(sinEvento.status, 400)
    } finally { await h.close() }
  })

  it('DP-31: /api/session dice cuándo caduca la sesión del panel', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      const s = await api(h, '/api/session')
      assert.equal(s.status, 200)
      assert.equal(s.data.authenticated, true)
      assert.equal(s.data.ttlSeconds, 3600)
      assert.ok(s.data.expiresAt > s.data.now)
      assert.ok(s.data.expiresAt - s.data.now <= 3600 * 1000 + 2000)
      const anon = await fetch(`${h.url}/api/session`)
      assert.equal(anon.status, 401)
    } finally { await h.close() }
  })

  it('DP-32: el consentimiento del panel se guarda en el servidor y un payload inválido da 400', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      const ok = await api(h, '/api/compliance/consent', {
        method: 'POST',
        body: { contactPhone: '+57 300 111 2233', whoAuthorized: 'Ana', channel: 'whatsapp', textShown: 'Acepto recibir mensajes', source: 'panel' },
      })
      assert.equal(ok.status, 201)
      assert.equal(ok.data.ok, true)
      const row = h.db.prepare('SELECT contact_phone, status, channel FROM consent_records WHERE contact_phone = ?').get('573001112233') as any
      assert.ok(row, 'el consentimiento debe quedar en consent_records')
      assert.equal(row.status, 'ACTIVE')
      assert.equal(row.channel, 'whatsapp')
      const bad = await api(h, '/api/compliance/consent', { method: 'POST', body: { contactPhone: '', whoAuthorized: '', channel: '', textShown: '' } })
      assert.equal(bad.status, 400)
    } finally { await h.close() }
  })

  it('DP-33: el HTML del panel trae salto de contenido, foco visible y su script compila', async () => {
    const h = await startDashboardServer()
    try {
      const res = await fetch(`${h.url}/`)
      const html = await res.text()
      assert.equal(res.status, 200)
      assert.ok(html.includes('class="skip-link" href="#viewRoot"'))
      assert.ok(html.includes(':focus-visible'))
      assert.ok(html.includes('max-width: 700px'))
      assert.ok(html.includes('aria-label'))
      assert.ok(html.includes("olderBar.id = 'threadMore'"))
      assert.ok(html.includes("jump.id = 'ctJump'"))
      const m = html.match(/<script>([\s\S]*?)<\/script>/)
      assert.ok(m, 'el panel debe servir su script')
      new vm.Script(m![1], { filename: 'panel.js' })
    } finally { await h.close() }
  })
})

describe('PANEL USABLE — F3 refresco del resumen, F9 consentimiento en pantalla, F10 contrato del webhook', () => {
  it('DP-34: el resumen se refresca cada 15 s, no acumula temporizadores y se detiene al salir', async () => {
    const h = await startDashboardServer()
    try {
      const res = await fetch(`${h.url}/`)
      const html = await res.text()
      const m = html.match(/<script>([\s\S]*?)<\/script>/)
      assert.ok(m, 'el panel debe servir su script')
      const js = m![1]
      const marca = js.indexOf('B6: Auto-refresco del resumen cada 15s')
      assert.ok(marca > 0, 'el auto-refresco del resumen debe existir en el script')
      const bloque = js.slice(marca, marca + 1600)
      assert.ok(bloque.includes('}, 15000);'), 'el intervalo debe ser de 15 s')
      assert.ok(bloque.includes('if (window._summaryTimer) clearInterval(window._summaryTimer);'), 'no debe acumular temporizadores al volver')
      assert.ok(bloque.includes("if (location.hash !== '#/summary' && location.hash !== '')"), 'debe comprobar que seguimos en el resumen')
      assert.ok(bloque.includes('clearInterval(window._summaryTimer);'), 'debe parar el temporizador al salir')
      assert.ok(bloque.includes('window._summaryTimer = null;'), 'debe olvidar el temporizador parado')
      assert.ok(bloque.includes("api('/api/dashboard/summary')"), 'debe repintar con datos reales')
      assert.equal((js.match(/window\._summaryTimer = setInterval/g) || []).length, 1, 'un solo temporizador de resumen')
      assert.ok(/function doLogout\(\)\s*\{/.test(js), 'la tarjeta de sesión necesita doLogout()')
      assert.ok(js.includes("api('/api/session')"), 'la tarjeta de sesión debe leer /api/session')
      assert.ok(js.includes("getElementById('sSessionRefresh')") && js.includes("getElementById('sSessionLogout')"), 'la tarjeta de sesión debe ofrecer refrescar y salir')
      assert.ok(js.includes("getElementById('sSessionInfo')"), 'la tarjeta de sesión debe mostrar la caducidad')
    } finally { await h.close() }
  })

  it('DP-35: integraciones muestra el contrato del webhook HMAC, la prueba de conexión y la máscara del secreto', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      const res = await fetch(`${h.url}/`)
      const html = await res.text()
      assert.ok(html.includes('Webhook de mensajes entrantes (HMAC v2)'))
      assert.ok(html.includes('POST /api/audiences/webhook-message'))
      assert.ok(html.includes('X-Signature-SHA256'))
      assert.ok(html.includes('HMAC-SHA256(secreto_de_la_org'))
      assert.ok(html.includes('WEBHOOK_LEAD_SECRETS'))
      assert.ok(html.includes('anti-replay'))
      assert.ok(html.includes('Probar conexión (real)'))
      assert.ok(html.includes('solo se guarda la máscara de los últimos 4'))
      assert.ok(html.includes('/api/integrations/transport/test'))
      const cfg = await api(h, '/api/integrations/transport')
      assert.equal(cfg.status, 200)
      const plano = JSON.stringify(cfg.data)
      assert.ok(!/"[A-Za-z0-9_]{24,}"/.test(plano.replace(/http[^"]+/g, '')), 'la configuración no debe devolver secretos largos en claro')
    } finally { await h.close() }
  })
})

// ---------------------------------------------------------------------------
// Pantalla de mentira: monta el panel sin navegador (DOM y fetch mínimos) para
// poder pulsar sus botones y mirar lo que dibuja. No sustituye a un navegador
// real: comprueba la vista, no los estilos ni el tamaño.
// ---------------------------------------------------------------------------
function crearNodo(tag: string = 'div', registro?: Map<string, any>): any {
  const n: any = {
    tagName: String(tag).toUpperCase(),
    _id: '',
    _attrs: {} as Record<string, string>,
    className: '',
    style: { cssText: '', setProperty() {}, getPropertyValue() { return '' } },
    children: [] as any[],
    parentNode: null,
    dataset: {},
    _texto: '',
    value: '',
    checked: false,
    disabled: false,
    title: '',
    placeholder: '',
    type: '',
    href: '',
    _ev: {} as Record<string, Array<(ev?: any) => void>>,
    classList: {
      _s: new Set<string>(),
      add(c: string) { this._s.add(c) },
      remove(c: string) { this._s.delete(c) },
      contains(c: string) { return this._s.has(c) || String(n.className).split(' ').includes(c) },
      toggle() {},
    },
    appendChild(c: any) { c.parentNode = n; n.children.push(c); return c },
    insertBefore(c: any, ref: any) {
      c.parentNode = n
      const i = n.children.indexOf(ref)
      if (i < 0) n.children.push(c)
      else n.children.splice(i, 0, c)
      return c
    },
    removeChild(c: any) { n.children = n.children.filter((x: any) => x !== c); return c },
    remove() {},
    setAttribute(k: string, v: unknown) { n._attrs[k] = String(v) },
    getAttribute(k: string) { return Object.prototype.hasOwnProperty.call(n._attrs, k) ? n._attrs[k] : null },
    removeAttribute(k: string) { delete n._attrs[k] },
    addEventListener(tipo: string, fn: (ev?: any) => void) { (n._ev[tipo] = n._ev[tipo] || []).push(fn) },
    removeEventListener(tipo: string, fn: (ev?: any) => void) { n._ev[tipo] = (n._ev[tipo] || []).filter((f: any) => f !== fn) },
    dispara(tipo: string, ev?: any) {
      const evento = ev || { type: tipo, stopPropagation() {}, preventDefault() {} }
      ;(n._ev[tipo] || []).forEach((f: any) => f(evento))
    },
    click() { n.dispara('click') },
    // el HTML puesto con innerHTML no se interpreta: se devuelve un nodo vacío
    querySelector() { return crearNodo('div') },
    querySelectorAll() { return [] },
    closest() { return null },
    focus() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 } },
    getContext() {
      const nada = () => {}
      return {
        fillRect: nada, clearRect: nada, beginPath: nada, moveTo: nada, lineTo: nada,
        stroke: nada, fill: nada, arc: nada, closePath: nada, fillText: nada, strokeText: nada,
        save: nada, restore: nada, translate: nada, scale: nada, setLineDash: nada,
        measureText: () => ({ width: 0 }),
        createLinearGradient: () => ({ addColorStop: nada }),
      }
    },
    toDataURL() { return '' },
    insertAdjacentHTML() {},
  }
  Object.defineProperty(n, 'id', {
    get() { return n._id },
    set(v: unknown) { n._id = String(v); if (registro) registro.set(String(v), n) },
  })
  Object.defineProperty(n, 'textContent', {
    get() { return n._texto },
    set(v: unknown) { n._texto = String(v); if (String(v) === '') n.children = [] },
  })
  Object.defineProperty(n, 'innerHTML', { get() { return n._texto }, set(v: unknown) { n._texto = String(v) } })
  return n
}

async function montarPanel(puente?: (path: string, options: any) => Promise<any>): Promise<any> {
  const registro = new Map<string, any>()
  const htmlEl = crearNodo('html', registro)
  const bodyEl = crearNodo('body', registro)
  htmlEl.appendChild(bodyEl)
  const documento: any = {
    title: '', cookie: '', readyState: 'complete', documentElement: htmlEl, body: bodyEl,
    getElementById(id: string) {
      if (!registro.has(id)) { const n = crearNodo('div', registro); n.id = id }
      return registro.get(id)
    },
    createElement(tag: string) { return crearNodo(tag, registro) },
    createTextNode(txt: string) { const n = crearNodo('#text', registro); n._texto = String(txt); return n },
    querySelector() { return crearNodo('div', registro) },
    querySelectorAll() { return [] },
    addEventListener() {},
    removeEventListener() {},
  }
  const pedidas: Array<{ url: string; metodo: string }> = []
  const fetchFalso = async (url: any, opciones: any = {}) => {
    pedidas.push({ url: String(url), metodo: opciones.method || 'GET' })
    if (puente) return puente(String(url), opciones)
    return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }
  }
  const ventana: any = {
    document: documento,
    location: { hash: '', href: '/' },
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {},
    scrollTo() {},
  }
  const ctx: any = vm.createContext({
    window: ventana, document: documento, console, fetch: fetchFalso,
    crypto: { randomUUID: () => 'uuid-de-prueba' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: ventana.location, navigator: { clipboard: { writeText: async () => {} } },
    setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    alert() {}, confirm: () => true,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    URLSearchParams, Date, Math, JSON, Number, String, Object, Array, Boolean, Error,
    encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN, Map, Set, Promise, Intl,
    requestAnimationFrame: (f: any) => f(0),
  })
  const html = renderDashboardAppHtml()
  const m = html.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(m, 'el panel debe servir su script')
  vm.runInContext(m![1], ctx, { filename: 'panel.js' })
  const esperar = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)) }
  await esperar() // deja terminar el arranque: /api/settings y la primera vista

  const recorrer = (raiz: any, fn: (n: any) => void) => {
    ;(function anda(n: any) { fn(n); (n.children || []).forEach(anda) })(raiz)
  }
  const buscar = (raiz: any, id: string) => { const a: any[] = []; recorrer(raiz, (n) => { if (n._id === id) a.push(n) }); return a }
  const porClase = (raiz: any, clase: string) => { const a: any[] = []; recorrer(raiz, (n) => { if (String(n.className).split(' ').includes(clase)) a.push(n) }); return a }
  const porTag = (raiz: any, tag: string) => { const a: any[] = []; recorrer(raiz, (n) => { if (n.tagName === tag.toUpperCase()) a.push(n) }); return a }
  const texto = (raiz: any) => { let s = ''; recorrer(raiz, (n) => { if (n._texto) s += n._texto + ' ' }); return s }

  return { ctx, documento, pedidas, esperar, buscar, porClase, porTag, texto, registro }
}

// Puente entre el panel de mentira y el servidor real: lo que la pantalla pide
// se responde de verdad, con la cookie de sesión de la prueba.
function puenteReal(h: Handle): (path: string, options: any) => Promise<any> {
  return async (path: string, options: any = {}) => {
    const res = await fetch(`${h.url}${path}`, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', Cookie: h.cookie(), ...(options.headers || {}) },
      body: options.body,
      redirect: 'manual',
    })
    return { ok: res.ok, status: res.status, json: () => res.json(), text: () => res.text() }
  }
}

describe('PANEL USABLE — pantallas de la bandeja, etiquetas, respuestas rápidas y agentes', () => {
  it('DP-36: la bandeja filtra leídas / no leídas contra el servidor y marca leída sin abrir el hilo', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      seedPanelThread(h, '573005550001', 2)
      seedPanelThread(h, '573005550002', 1)
      h.db.prepare('UPDATE conversations SET unread = 3, contact_name = ? WHERE contact_phone = ?').run('Ana Sin Leer', '573005550001')
      h.db.prepare('UPDATE conversations SET contact_name = ? WHERE contact_phone = ?').run('Beto Leido', '573005550002')

      // 1) El filtro lo aplica la consulta, no el navegador.
      const todas = await api(h, '/api/conversations')
      assert.equal(todas.data.total, 2)
      const sinLeer = await api(h, '/api/conversations?unreadOnly=1')
      assert.equal(sinLeer.data.total, 1)
      assert.equal(sinLeer.data.conversations[0].contact_phone, '573005550001')
      assert.ok(sinLeer.data.conversations[0].unread > 0)

      // 2) La pantalla ofrece los dos botones y anuncia cuál está activo.
      const panel = await montarPanel(puenteReal(h))
      panel.ctx.viewConversations()
      await panel.esperar()
      const raiz = panel.documento.getElementById('viewRoot')
      const bTodas = panel.buscar(raiz, 'convFilterAll')[0]
      const bSin = panel.buscar(raiz, 'convFilterUnread')[0]
      assert.ok(bTodas && bSin, 'la bandeja debe ofrecer los botones Todas y No leídas')
      assert.equal(bTodas.getAttribute('aria-pressed'), 'true')
      assert.equal(bSin.getAttribute('aria-pressed'), 'false')
      assert.equal(panel.porClase(panel.documento.getElementById('convList'), 'conv-item').length, 2, 'sin filtro se ven las dos conversaciones')

      // 3) «No leídas» pide unreadOnly=1 al servidor y deja solo la que tiene mensajes sin leer.
      panel.pedidas.length = 0
      bSin.dispara('click')
      await panel.esperar()
      const pedido = panel.pedidas.map((p: any) => p.url).join(' ')
      assert.ok(pedido.includes('/api/conversations?q=&unreadOnly=1'), 'el filtro debe viajar al servidor: ' + pedido)
      assert.equal(bSin.getAttribute('aria-pressed'), 'true')
      assert.equal(bTodas.getAttribute('aria-pressed'), 'false')
      const filtradas = panel.porClase(panel.documento.getElementById('convList'), 'conv-item')
      assert.equal(filtradas.length, 1, 'el filtro deja solo la conversación sin leer')
      assert.ok(panel.texto(filtradas[0]).includes('Ana Sin Leer'))
      assert.equal(panel.porClase(panel.documento.getElementById('convList'), 'conv-unread').length, 1, 'la fila muestra los mensajes sin leer')

      // 4) Marcar leída desde la fila, sin abrir el hilo.
      const marcas = panel.porClase(panel.documento.getElementById('convList'), 'conv-mark')
      assert.equal(marcas.length, 1, 'la fila sin leer ofrece marcar como leída')
      panel.pedidas.length = 0
      marcas[0].dispara('click')
      await panel.esperar()
      assert.ok(panel.pedidas.some((p: any) => p.metodo === 'POST' && p.url === '/api/conversations/573005550001/read'), 'debe marcar leída contra el servidor')
      assert.equal(panel.porClase(panel.documento.getElementById('convList'), 'conv-item').length, 0, 'al marcarla deja de aparecer en No leídas')
      const ya = await api(h, '/api/conversations?unreadOnly=1')
      assert.equal(ya.data.total, 0, 'el servidor la da por leída')

      // 5) «Todas» vuelve a mostrarlas, sin el contador de sin leer.
      bTodas.dispara('click')
      await panel.esperar()
      assert.equal(panel.porClase(panel.documento.getElementById('convList'), 'conv-item').length, 2)
      assert.equal(panel.porClase(panel.documento.getElementById('convList'), 'conv-mark').length, 0)
      assert.equal(bTodas.getAttribute('aria-pressed'), 'true')
    } finally { await h.close() }
  })

  it('DP-37: la pantalla de etiquetas lista nombre, color y contactos, y ofrece crear', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      const creada = await api(h, '/api/tags', { method: 'POST', body: { name: 'Cliente VIP', color: '#22c55e' } })
      assert.equal(creada.status, 201)
      const panel = await montarPanel(puenteReal(h))
      panel.ctx.viewTags()
      await panel.esperar()
      const wrap = panel.documento.getElementById('tagsWrap')
      assert.ok(panel.porTag(wrap, 'table').length === 1, 'la etiqueta debe pintarse en una tabla')
      const cabeceras = panel.porTag(wrap, 'th').map((n: any) => n.textContent)
      assert.deepEqual(cabeceras, ['Nombre', 'Color', 'Contactos', 'Acciones'])
      const filas = panel.porTag(wrap, 'tr')
      assert.equal(filas.length, 2, 'una fila de cabecera y una por etiqueta')
      assert.ok(panel.texto(wrap).includes('Cliente VIP'), 'el nombre debe verse')
      assert.ok(panel.porClase(wrap, 'btn-danger').length >= 1, 'cada fila ofrece borrar')
      assert.ok(panel.texto(panel.documento.getElementById('viewRoot')).includes('＋ Nueva etiqueta'))
    } finally { await h.close() }
  })

  it('DP-38: la pantalla de respuestas rápidas muestra el atajo con su barra y su cuerpo', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      const creada = await api(h, '/api/quick-replies', { method: 'POST', body: { shortcut: 'precio', title: 'Precio del plan', body: 'El plan cuesta 49 USD al mes.' } })
      assert.equal(creada.status, 201)
      const panel = await montarPanel(puenteReal(h))
      panel.ctx.viewQuickReplies()
      await panel.esperar()
      const wrap = panel.documento.getElementById('qrWrap')
      const cabeceras = panel.porTag(wrap, 'th').map((n: any) => n.textContent)
      assert.deepEqual(cabeceras, ['Atajo', 'Título', 'Cuerpo', 'Acciones'])
      const texto = panel.texto(wrap)
      assert.ok(texto.includes('/precio'), 'el atajo debe verse con su barra')
      assert.ok(texto.includes('Precio del plan'))
      assert.ok(texto.includes('49 USD'))
      assert.ok(panel.texto(panel.documento.getElementById('viewRoot')).includes('＋ Nueva respuesta'))
    } finally { await h.close() }
  })

  it('DP-39: la pantalla de agentes muestra rol, activo y conversaciones asignadas', async () => {
    const h = await startDashboardServer()
    try {
      await h.login()
      const creado = await api(h, '/api/agents', { method: 'POST', body: { name: 'Laura', email: 'laura@albra.co', role: 'agente' } })
      assert.equal(creado.status, 201)
      const panel = await montarPanel(puenteReal(h))
      panel.ctx.viewAgents()
      await panel.esperar()
      const wrap = panel.documento.getElementById('agentsWrap')
      const cabeceras = panel.porTag(wrap, 'th').map((n: any) => n.textContent)
      assert.deepEqual(cabeceras, ['Nombre', 'Email', 'Rol', 'Activo', 'Conversaciones', 'Acciones'])
      const texto = panel.texto(wrap)
      assert.ok(texto.includes('Laura'))
      assert.ok(texto.includes('laura@albra.co'))
      assert.ok(texto.includes('agente'), 'el rol debe verse')
      const casillas = panel.porTag(wrap, 'input')
      assert.equal(casillas.length, 1, 'cada agente tiene su casilla de activo')
      assert.ok(panel.texto(panel.documento.getElementById('viewRoot')).includes('＋ Nuevo agente'))
    } finally { await h.close() }
  })
})
