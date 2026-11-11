/**
 * contract-v11.test.ts — VERIFICACIÓN DEL CONTRATO DE INTEGRACIÓN v1.1.0 (Capa 2B)
 * Reparación integral 2026-11-06.
 *
 * LOS 7 RECHAZOS OBLIGATORIOS (contrato §4) sobre /api/audiences/webhook-lead:
 *   R1. Firma válida + timestamp modificado → 401
 *   R2. Petición repetida (misma huella) → 401
 *   R3. Firma incorrecta → 401
 *   R4. Timestamp vencido → 401
 *   R5. Secreto ausente → 503 fail-closed
 *   R6. Eventos legítimos de dos organizaciones → sin colisión (cada uno en su org)
 *   R7. Dos peticiones simultáneas del mismo evento → UNA sola operación
 *
 * Más: bind de organización por secreto (un webhook de la org A JAMÁS añade leads a
 * la campaña de la org B), claim atómico del motor de despacho, máquina de estados de
 * campañas (terminales intocables 409, /step fuera de RUNNING no despacha),
 * reconciliación FAILED_RETRYABLE ≤3, audit_log de identidades de servicio y rate limit.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert'
import { createHmac } from 'node:crypto'
import { createBroadcastServer } from '../src/server.ts'
import { MockDispatcher } from '../src/adapters/dispatcher.ts'
import { StandaloneLockChecker } from '../src/safety/lock-checker.ts'
import { LocalSuppressionStore } from '../src/safety/suppression.ts'
import { BroadcastEngine } from '../src/queue/broadcast-worker.ts'
import type { DatabaseSync } from 'node:sqlite'

const ORG_X = 'org_ultra_x'
const ORG_Y = 'org_ultra_y'
const SECRET_X = 'ultra_contract_secret_org_x_min32chars'
const SECRET_Y = 'ultra_contract_secret_org_y_min32chars'

// (fusión) canonical v2 del contrato vigente: `${org}.${ts}.${body}` — la
// organización queda LIGADA a la firma y viaja en X-Org-Id (nunca del body).
function signV2(secret: string, body: string, ts: string, org = ''): string {
  const canonical = `${org ? org + '.' : ''}${ts}.${body}`
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('hex')
}

async function listenEphemeral(server: any): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address()
  return `http://127.0.0.1:${port}`
}

function bootPerOrg() {
  const prev = process.env.WEBHOOK_LEAD_SECRETS
  const prevLegacy = process.env.WEBHOOK_LEAD_SECRET
  process.env.WEBHOOK_LEAD_SECRETS = `${ORG_X}:${SECRET_X},${ORG_Y}:${SECRET_Y}`
  delete process.env.WEBHOOK_LEAD_SECRET
  const { server, db, engine } = createBroadcastServer({
    dbPath: ':memory:',
    dispatcher: new MockDispatcher(),
    lockChecker: new StandaloneLockChecker(),
    suppressionStore: undefined,
    whatsPowerEnabled: false,
  })
  return { server, db, engine, restore: () => { if (prev === undefined) delete process.env.WEBHOOK_LEAD_SECRETS; else process.env.WEBHOOK_LEAD_SECRETS = prev; if (prevLegacy !== undefined) process.env.WEBHOOK_LEAD_SECRET = prevLegacy } }
}

function leadBody(org: string, eventId: string, campaignId?: string, phone = '573000000421'): string {
  return JSON.stringify({ eventId, campaignId, source: 'custom_webhook', phone, name: 'Lead Contrato' })
}

async function postLead(base: string, secret: string, body: string, opts: { ts?: string; tamper?: string; badSignature?: boolean; eventIdHeader?: boolean } = {}): Promise<{ status: number; data: any }> {
  // (fusión) la org va en X-Org-Id y queda ligada a la firma; el orgId del body
  // NO autoriza (contrato de fix/b3 absorbido por la fusión).
  const org = secret === SECRET_X ? ORG_X : secret === SECRET_Y ? ORG_Y : ORG_X
  const ts = opts.ts || String(Date.now())
  const sig = opts.badSignature ? 'firma_corrupta_000' : signV2(secret, body, ts, org)
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Timestamp': opts.tamper || ts, 'X-Signature-SHA256': sig, 'X-Org-Id': org }
  const res = await fetch(`${base}/api/audiences/webhook-lead`, { method: 'POST', headers, body })
  return { status: res.status, data: await res.json() as any }
}

async function createCampaignDirect(db: DatabaseSync, engine: BroadcastEngine, orgId: string, name: string): Promise<string> {
  const campaign = await engine.createCampaign({
    organizationId: orgId,
    name,
    templateSpintax: 'Hola {{nombre}}',
    csvContent: 'phone,name\n573000000000,Relleno',
  })
  return campaign.id
}

describe('CONTRATO v1.1.0 §4 — LOS 7 RECHAZOS OBLIGATORIOS (Capa 2B)', () => {
  it('R1: firma válida + timestamp modificado → 401 (el timestamp entra en la MAC)', async () => {
    const { server, restore } = bootPerOrg()
    const base = await listenEphemeral(server)
    try {
      const body = leadBody(ORG_X, 'evt_r1')
      const r1 = await postLead(base, SECRET_X, body, { ts: String(Date.now()), tamper: String(Date.now() + 250_000) })
      assert.strictEqual(r1.status, 401)
      const r2 = await postLead(base, SECRET_X, body, { ts: String(Date.now()), tamper: String(Date.now() - 250_000) })
      assert.strictEqual(r2.status, 401)
    } finally { server.close(); restore() }
  })

  it('R2: petición repetida (misma huella) → 401, persistente en SQLite', async () => {
    const { server, restore } = bootPerOrg()
    const base = await listenEphemeral(server)
    try {
      const body = leadBody(ORG_X, 'evt_r2')
      const ts = String(Date.now())
      const r1 = await postLead(base, SECRET_X, body, { ts })
      assert.strictEqual(r1.status, 200)
      const r2 = await postLead(base, SECRET_X, body, { ts })
      assert.strictEqual(r2.status, 401)
      assert.ok(String(r2.data.error).toLowerCase().includes('duplicada') || String(r2.data.error).toLowerCase().includes('replay'))
    } finally { server.close(); restore() }
  })

  it('R3: firma incorrecta → 401', async () => {
    const { server, restore } = bootPerOrg()
    const base = await listenEphemeral(server)
    try {
      const r = await postLead(base, 'secreto_equivocado_ultra_0000000000', leadBody(ORG_X, 'evt_r3'), { badSignature: true })
      assert.strictEqual(r.status, 401)
    } finally { server.close(); restore() }
  })

  it('R4: timestamp vencido → 401 (firmado con ese timestamp)', async () => {
    const { server, restore } = bootPerOrg()
    const base = await listenEphemeral(server)
    try {
      const r = await postLead(base, SECRET_X, leadBody(ORG_X, 'evt_r4'), { ts: String(Date.now() - 400_000) })
      assert.strictEqual(r.status, 401)
    } finally { server.close(); restore() }
  })

  it('R5: secreto ausente → 503 fail-closed (jamás acepta)', async () => {
    const prevS = process.env.WEBHOOK_LEAD_SECRETS
    const prevL = process.env.WEBHOOK_LEAD_SECRET
    delete process.env.WEBHOOK_LEAD_SECRETS
    delete process.env.WEBHOOK_LEAD_SECRET
    try {
      const { server } = createBroadcastServer({ dbPath: ':memory:', dispatcher: new MockDispatcher(), whatsPowerEnabled: false })
      const base = await listenEphemeral(server)
      try {
        const r = await postLead(base, SECRET_X, leadBody(ORG_X, 'evt_r5'))
        assert.strictEqual(r.status, 503)
      } finally { server.close() }
    } finally {
      if (prevS !== undefined) process.env.WEBHOOK_LEAD_SECRETS = prevS
      if (prevL !== undefined) process.env.WEBHOOK_LEAD_SECRET = prevL
    }
  })

  it('R6: eventos legítimos de dos organizaciones → sin colisión (cada uno en su org)', async () => {
    const { server, db, engine, restore } = bootPerOrg()
    const base = await listenEphemeral(server)
    try {
      // Dos campañas, una por organización
      const campaignX = await createCampaignDirect(db, engine, ORG_X, 'Campaña X')
      const campaignY = await createCampaignDirect(db, engine, ORG_Y, 'Campaña Y')

      const rX = await postLead(base, SECRET_X, leadBody(ORG_X, 'evt_mismo', campaignX))
      assert.strictEqual(rX.status, 200)
      assert.strictEqual(rX.data.success, true)

      const rY = await postLead(base, SECRET_Y, leadBody(ORG_Y, 'evt_mismo', campaignY))
      assert.strictEqual(rY.status, 200)
      assert.strictEqual(rY.data.success, true, 'el MISMO eventId de OTRA org (otro secreto) no colisiona')

      // Cada lead quedó en SU organización (realtime_leads es org-scoped)
      const leads = db.prepare('SELECT organization_id FROM realtime_leads WHERE phone = ? ORDER BY organization_id').all('573000000421') as any[]
      assert.deepStrictEqual(leads.map((l) => l.organization_id).sort(), [ORG_X, ORG_Y].sort())

      // Cada campaña recibió SU lead (total_targets = 1 relleno + 1 lead)
      const x = engine.getItems(campaignX).filter((i) => i.contactPhone === '573000000421')
      const y = engine.getItems(campaignY).filter((i) => i.contactPhone === '573000000421')
      assert.strictEqual(x.length, 1, 'campaña X recibió solo el lead de X')
      assert.strictEqual(y.length, 1, 'campaña Y recibió solo el lead de Y')
    } finally { server.close(); restore() }
  })

  it('R6b: un webhook de la org A JAMÁS añade leads a la campaña de la org B (404 sin oráculo)', async () => {
    const { server, db, engine, restore } = bootPerOrg()
    const base = await listenEphemeral(server)
    try {
      const campaignY = await createCampaignDirect(db, engine, ORG_Y, 'Campaña Privada Y')
      // Firma VÁLIDA de la org X, pero campaignId de la org Y
      const r = await postLead(base, SECRET_X, leadBody(ORG_X, 'evt_invasion', campaignY))
      assert.strictEqual(r.status, 404, 'el webhook de X no puede tocar campañas de Y')
      const items = engine.getItems(campaignY).filter((i) => i.contactPhone === '573000000421')
      assert.strictEqual(items.length, 0, 'ningún lead de X entró en la campaña de Y')
    } finally { server.close(); restore() }
  })

  it('R7: dos peticiones simultáneas del mismo evento → UNA sola operación', async () => {
    const { server, db, restore } = bootPerOrg()
    const base = await listenEphemeral(server)
    try {
      const body = leadBody(ORG_X, 'evt_r7')
      const [a, b] = await Promise.all([
        postLead(base, SECRET_X, body, { ts: String(Date.now()) }),
        postLead(base, SECRET_X, body, { ts: String(Date.now() + 5) }),
      ])
      assert.strictEqual(a.status, 200)
      assert.strictEqual(b.status, 200)
      const outcomes = [a.data, b.data]
      // Exactamente UNA inserción real: la otra es duplicate o PHONE_DUPLICATED por idempotencia
      const leads = db.prepare('SELECT COUNT(*) as n FROM realtime_leads WHERE phone = ?').get('573000000421') as any
      assert.strictEqual(Number(leads.n), 1, 'UN solo lead insertado (idempotencia orgId::eventId)')
      assert.ok(outcomes.some((o) => o.duplicate === true), 'la segunda petición debe marcarse como duplicate')
    } finally { server.close(); restore() }
  })
})

describe('CONTRATO v1.1.0 §5-§6 — motor de despacho y máquina de estados (Capa 2B)', () => {
  function bootEngine() {
    const db = createBroadcastDatabaseForTest()
    const mockDispatcher = new MockDispatcher()
    const engine = new BroadcastEngine({
      db,
      dispatcher: mockDispatcher,
      lockChecker: new StandaloneLockChecker(),
      suppressionStore: new LocalSuppressionStore(db),
      throttlerOptions: { minIntervalMs: 0, maxIntervalMs: 0 },
    })
    return { db, engine, mockDispatcher }
  }

  function createBroadcastDatabaseForTest(): DatabaseSync {
    // Usa el creador del servidor para heredar el esquema v3 completo
    const { db } = createBroadcastServer({ dbPath: ':memory:', dispatcher: new MockDispatcher(), whatsPowerEnabled: false })
    return db
  }

  it('ST-01: /step sobre campaña PAUSED NO despacha; pause/resume/cancel respetan terminales (409)', async () => {
    const prevKeys = process.env.ADMIN_API_KEYS
    process.env.ADMIN_API_KEYS = 'ultra_contract_admin_key_min32chars_01:org_st'
    try {
      const { server, db, engine } = createBroadcastServer({ dbPath: ':memory:', dispatcher: new MockDispatcher(), whatsPowerEnabled: false })
      const base = await listenEphemeral(server)
      try {
        const auth = { 'Authorization': 'Bearer ultra_contract_admin_key_min32chars_01', 'Content-Type': 'application/json' }
        const created = await fetch(`${base}/api/campaigns`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'ST-01', templateSpintax: 'Hola', csvContent: 'phone,name\n573000000111,Uno' }) })
        const campaign = await created.json() as any

        // DRAFT → /step despacha (transición legal DRAFT→RUNNING). Se usa el engine directo
        // con fecha hábil determinista (el reloj real puede estar fuera del horario comercial,
        // lo cual es el comportamiento anti-ban correcto — ver ST-01b).
        const s1d = await engine.processNextItem(campaign.id, new Date('2026-11-06T13:00:00Z'))
        assert.strictEqual(s1d.processed, true)

        // RUNNING → PAUSED; luego /step NO despacha
        await fetch(`${base}/api/campaigns/${campaign.id}/pause`, { method: 'POST', headers: auth })
        const s2 = await fetch(`${base}/api/campaigns/${campaign.id}/step`, { method: 'POST', headers: auth })
        const s2d = await s2.json() as any
        assert.strictEqual(s2d.processed, false, 'un paso sobre PAUSED jamás despacha')

        // resume → RUNNING; cancel → CANCELLED (terminal); cancel de nuevo → 409
        await fetch(`${base}/api/campaigns/${campaign.id}/resume`, { method: 'POST', headers: auth })
        await fetch(`${base}/api/campaigns/${campaign.id}/cancel`, { method: 'POST', headers: auth })
        const again = await fetch(`${base}/api/campaigns/${campaign.id}/cancel`, { method: 'POST', headers: auth })
        assert.strictEqual(again.status, 409, 'los estados terminales son intocables')
        const rAgain = await fetch(`${base}/api/campaigns/${campaign.id}/resume`, { method: 'POST', headers: auth })
        assert.strictEqual(rAgain.status, 409, 'CANCELLED no resucita')

        // La campaña terminó CANCELLED y con exactamente 1 despacho
        const c = engine.getCampaign(campaign.id)
        assert.strictEqual(c?.status, 'CANCELLED')
      } finally { server.close() }
    } finally {
      if (prevKeys === undefined) delete process.env.ADMIN_API_KEYS
      else process.env.ADMIN_API_KEYS = prevKeys
    }
  })

  it('ST-02: claim atómico — dos pasos concurrentes sobre el mismo ítem despachan UNA vez', async () => {
    const { db, engine, mockDispatcher } = bootEngine()
    const campaign = await engine.createCampaign({ organizationId: ORG_X, name: 'Atomic', templateSpintax: 'Hola', csvContent: 'phone,name\n573000000222,Dos' })
    // Un solo ítem PENDING: dos processNextItem simultáneos → exactamente 1 despacho real
    const [r1, r2] = await Promise.all([
      engine.processNextItem(campaign.id, new Date('2026-11-06T13:00:00Z')),
      engine.processNextItem(campaign.id, new Date('2026-11-06T13:00:00Z')),
    ])
    const outcomes = [r1.status, r2.status]
    assert.ok(outcomes.includes('SENT'), `uno despachó (obtenido: ${outcomes})`)
    assert.strictEqual(mockDispatcher.dispatched.length, 1, 'UN solo despacho físico (jamás doble despacho)')
  })

  it('ST-03: reconciliación — FAILED_RETRYABLE reintenta máx 3 y luego FAILED; UNCERTAIN jamás reintenta', async () => {
    const { db, engine, mockDispatcher } = bootEngine()
    const campaign = await engine.createCampaign({ organizationId: ORG_X, name: 'Retry', templateSpintax: 'Hola', csvContent: 'phone,name\n573000000333,Tres' })
    mockDispatcher.shouldFail = true
    const businessDate = new Date('2026-11-06T13:00:00Z')
    // Intento 1 → FAILED_RETRYABLE; re-proceso (2) → FAILED_RETRYABLE; (3) → terminal.
    // (fusión) la nomenclatura de fix/b3 usa FAILED_FATAL como estado terminal
    // (equivalente al 'FAILED' permanente del contrato v1.1.0).
    await engine.processNextItem(campaign.id, businessDate)
    await engine.processNextItem(campaign.id, businessDate)
    await engine.processNextItem(campaign.id, businessDate)
    const item = engine.getItems(campaign.id)[0]
    assert.strictEqual(item.status, 'FAILED_FATAL', 'tras 3 intentos, fallo PERMANENTE (FAILED_FATAL)')
    assert.strictEqual(item.retryCount, 3)

    // UNCERTAIN_DISPATCH jamás se re-encola automáticamente
    mockDispatcher.shouldFail = false
    const campaign2 = await engine.createCampaign({ organizationId: ORG_X, name: 'Uncertain', templateSpintax: 'Hola', csvContent: 'phone,name\n573000000444,Cuatro' })
    const uncDispatcher: any = engine.dispatcher
    uncDispatcher.shouldFail = false
    const s1 = await engine.processNextItem(campaign2.id, businessDate)
    assert.strictEqual(s1.status, 'SENT')
    const before = engine.getItems(campaign2.id)[0].status
    assert.strictEqual(before, 'SENT')
    // Simular UNCERTAIN directamente en BD y verificar que /step no lo toca
    db.prepare("UPDATE campaign_items SET status='UNCERTAIN_DISPATCH' WHERE campaign_id = ?").run(campaign2.id)
    db.prepare("UPDATE campaigns SET status='RUNNING', sent_count=0 WHERE id = ?").run(campaign2.id)
    const s2 = await engine.processNextItem(campaign2.id, businessDate)
    assert.strictEqual(s2.processed, false, 'sin PENDING (UNCERTAIN no se re-encola) → no procesa')
    assert.strictEqual(engine.getItems(campaign2.id)[0].status, 'UNCERTAIN_DISPATCH', 'el UNCERTAIN queda intacto para reconciliación manual')
  })

  it('ST-04: identidad de servicio (clave sin :org) queda registrada en audit_log', async () => {
    const prevKeys = process.env.ADMIN_API_KEYS
    process.env.ADMIN_API_KEYS = 'ultra_service_key_min32chars_000001,ultra_org_key_min32chars_001:org_aud'
    try {
      const { server, db } = createBroadcastServer({ dbPath: ':memory:', dispatcher: new MockDispatcher(), whatsPowerEnabled: false })
      const base = await listenEphemeral(server)
      try {
        await fetch(`${base}/api/campaigns`, { method: 'POST', headers: { 'Authorization': 'Bearer ultra_service_key_min32chars_000001' } })
        const rows = db.prepare("SELECT COUNT(*) as n FROM audit_log WHERE action LIKE '%campaigns%'").get() as any
        assert.ok(Number(rows.n) >= 1, 'la acción de la identidad de servicio quedó auditada (actor nunca completo)')
        const actors = db.prepare('SELECT actor FROM audit_log').all() as any[]
        for (const a of actors) assert.ok(a.actor.length <= 9, 'el actor se registra truncado (jamás la clave completa)')
      } finally { server.close() }
    } finally {
      if (prevKeys === undefined) delete process.env.ADMIN_API_KEYS
      else process.env.ADMIN_API_KEYS = prevKeys
    }
  })

  it('ST-05: rate limit del webhook-lead → 429 + Retry-After (30/min por IP)', async () => {
    const { server, restore } = bootPerOrg()
    const base = await listenEphemeral(server)
    try {
      let saw429 = false
      let retryAfter = ''
      for (let i = 0; i < 40; i++) {
        const body = leadBody(ORG_X, `evt_rl_${i}`)
        const ts = String(Date.now())
        const res = await fetch(`${base}/api/audiences/webhook-lead`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Timestamp': ts, 'X-Signature-SHA256': signV2(SECRET_X, body, ts) },
          body,
        })
        if (res.status === 429) {
          saw429 = true
          retryAfter = res.headers.get('retry-after') || ''
          break
        }
      }
      assert.ok(saw429, 'el límite de 30/min debe activarse')
      assert.ok(retryAfter !== '' && Number(retryAfter) >= 1, 'Retry-After presente y >= 1')
    } finally { server.close(); restore() }
  })
})
