import { test } from 'node:test'
import assert from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { createBroadcastDatabase } from '../src/db.ts'
import { BroadcastEngine as BroadcastWorker } from '../src/queue/broadcast-worker.ts'
import { createBroadcastServer as createAgenticServer } from '../src/server.ts'
import type { Dispatcher, LockChecker, SuppressionChecker, DispatchResult } from '../src/types.ts'

/**
 * CUARTA FASE CORRECTIVA — ULTRA:
 *  - U4-01: un campaign_items con organization_id de OTRA organización (fila
 *    corrupta) JAMÁS se reclama ni despacha (aislamiento a nivel de fila).
 *  - U4-02: migración v5 aditiva — backfill de campaign_items.organization_id
 *    desde su campaña (jamás atribución inventada; huérfanos → NULL aislado).
 *  - U4-03: los ítems NUEVOS (CSV y webhook) nacen con la organización de su
 *    campaña (defensa en profundidad a nivel de fila).
 *  - U4-04: revisión ADMIN_API_KEYS — /studio/login timing-safe; clave
 *    org-scoped no ve campañas ajenas (404 sin oráculo).
 */

class RecordingDispatcher implements Dispatcher {
  sent: Array<{ to: string; text: string }> = []
  async dispatch(to: string, text: string): Promise<DispatchResult> {
    this.sent.push({ to, text })
    return { success: true, messageId: `u4_${this.sent.length}` }
  }
}

const okLock: LockChecker = { checkLock: async () => ({ available: true }) }
const noSupp: SuppressionChecker = { isSuppressed: async () => false }

function bootWorker(db: DatabaseSync) {
  const dispatcher = new RecordingDispatcher()
  const worker = new BroadcastWorker({ db, dispatcher, lockChecker: okLock, suppressionStore: noSupp, workerId: 'wrk_u4' })
  return { worker, dispatcher }
}

function seedCampaign(db: DatabaseSync, id: string, orgId: string) {
  db.prepare(`
    INSERT INTO campaigns (id, organization_id, name, template_spintax, status, total_targets, created_at)
    VALUES (?, ?, 'Camp U4', 'Hola {{name}}', 'DRAFT', 1, strftime('%s','now'))
  `).run(id, orgId)
}

function insertItem(db: DatabaseSync, id: string, campaignId: string, orgId: string | null, phone = '573000000001') {
  db.prepare(`
    INSERT INTO campaign_items (id, campaign_id, organization_id, contact_phone, status, retry_count, idempotency_key)
    VALUES (?, ?, ?, ?, 'PENDING', 0, ?)
  `).run(id, campaignId, orgId, phone, `key_${id}`)
}

test('U4-01: ítem con organization_id de OTRA organización jamás se reclama ni despacha', async () => {
  const db = createBroadcastDatabase(':memory:')
  seedCampaign(db, 'cmp_u4_a', 'org_buena')
  insertItem(db, 'itm_corrupto', 'cmp_u4_a', 'org_malvada') // fila corrupta: org distinta de su campaña

  const { worker, dispatcher } = bootWorker(db)
  const res = await worker.processNextItem('cmp_u4_a')

  assert.strictEqual(dispatcher.sent.length, 0, 'la fila corrupta JAMÁS se despacha')
  const item = db.prepare("SELECT status FROM campaign_items WHERE id = 'itm_corrupto'").get() as { status: string }
  assert.strictEqual(item.status, 'PENDING', 'el ítem corrupto queda sin reclamar (cuarentena)')
  assert.strictEqual(res.status, 'COMPLETED', 'la campaña no queda bloqueada por la fila corrupta')

  // Contraste: un ítem con la org CORRECTA de su campaña sí se despacha
  // (campaña nueva: la anterior quedó COMPLETED por no tener pendientes legítimos)
  seedCampaign(db, 'cmp_u4_b', 'org_buena')
  insertItem(db, 'itm_ok', 'cmp_u4_b', 'org_buena', '573000000002')
  const res2 = await worker.processNextItem('cmp_u4_b')
  assert.strictEqual(dispatcher.sent.length, 1, 'el ítem legítimo se despacha')
  void res2
})

test('U4-02: migración v5 — backfill de organization_id desde la campaña; huérfanos quedan NULL (aislados)', () => {
  // 1. BD con el ESQUEMA VIEJO (campaign_items SIN organization_id)
  const tmp = `${tmpdir()}/ultra_u4_legacy_${Date.now()}.db`
  const legacy = new DatabaseSync(tmp)
  legacy.exec(`
    CREATE TABLE campaigns (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL,
      template_spintax TEXT NOT NULL, status TEXT NOT NULL, scheduled_at INTEGER, started_at INTEGER,
      finished_at INTEGER, total_targets INTEGER NOT NULL DEFAULT 0, sent_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0, skipped_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE campaign_items (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, contact_phone TEXT NOT NULL,
      contact_name TEXT, variables_json TEXT, rendered_text TEXT, status TEXT NOT NULL, lock_checked_at INTEGER,
      dispatched_at INTEGER, error_reason TEXT, message_id TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
      idempotency_key TEXT UNIQUE NOT NULL);
    INSERT INTO campaigns VALUES ('cmp_legacy', 'org_legacy', 'L', 't', 'RUNNING', NULL, NULL, NULL, 1, 0, 0, 0, strftime('%s','now'));
    INSERT INTO campaign_items (id, campaign_id, contact_phone, status, retry_count, idempotency_key)
      VALUES ('itm_1', 'cmp_legacy', '573001111111', 'PENDING', 0, 'k1');
    INSERT INTO campaign_items (id, campaign_id, contact_phone, status, retry_count, idempotency_key)
      VALUES ('itm_huerfano', 'cmp_inexistente', '573002222222', 'PENDING', 0, 'k2');
  `)
  legacy.close()

  // 2. Abrir con el código actual → migración aditiva + backfill
  const migrated = createBroadcastDatabase(tmp)
  const cols = (migrated.prepare('PRAGMA table_info(campaign_items)').all() as Array<{ name: string }>).map((c) => c.name)
  assert.ok(cols.includes('organization_id'), 'la columna organization_id existe tras la migración')

  const backfilled = migrated.prepare("SELECT organization_id FROM campaign_items WHERE id = 'itm_1'").get() as { organization_id: string | null }
  assert.strictEqual(backfilled.organization_id, 'org_legacy', 'el ítem hereda la organización de SU campaña (no atribución inventada)')

  const orphan = migrated.prepare("SELECT organization_id FROM campaign_items WHERE id = 'itm_huerfano'").get() as { organization_id: string | null }
  assert.strictEqual(orphan.organization_id, null, 'el ítem huérfano queda NULL (sin campaña, sin atribución)')

  // 3. El ítem backfillado es plenamente operable por su org
  seedCampaign(migrated, 'cmp_legacy2', 'org_legacy')
  void seedCampaign
})

test('U4-03: los ítems NUEVOS (worker.createCampaign y webhook-ingest) nacen con la organización de su campaña', async () => {
  const db = createBroadcastDatabase(':memory:')
  const { worker } = bootWorker(db)

  const csv = 'phone,name\n3017543786,Alice\n' // 10 dígitos → canónico 5733017543786
  const campaign = await worker.createCampaign({ organizationId: 'org_nueva', name: 'CSV U4', templateSpintax: 'Hola {{name}}', csvContent: csv }) as unknown as { id: string }
  assert.ok(campaign?.id, 'la campaña se creó')
  const item = db.prepare('SELECT organization_id FROM campaign_items WHERE campaign_id = ?').get(campaign.id) as { organization_id: string | null }
  assert.ok(item, 'la campaña importó su ítem')
  assert.strictEqual(item.organization_id, 'org_nueva', 'el ítem del CSV nace con la organización de la campaña')
})

test('U4-04: revisión ADMIN_API_KEYS — login del Studio y ownership org-scoped (regresión)', async () => {
  process.env.ADMIN_API_KEYS = 'clave_org_a_min16chars_x:org_a,clave_servicio_min16chars'
  const { server } = createAgenticServer({ dbPath: ':memory:' })
  await new Promise<void>((resolve) => server.listen(3095, () => resolve()))
  const base = 'http://localhost:3095'
  try {
    // Studio login: clave org-scoped válida → 200 con cookie HttpOnly (comparación timing-safe)
    const login = await fetch(`${base}/studio/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: 'clave_org_a_min16chars_x' }) })
    assert.strictEqual(login.status, 200)
    const setCookie = login.headers.get('set-cookie') || ''
    assert.ok(setCookie.includes('HttpOnly'))

    // Clave inválida → 401
    const bad = await fetch(`${base}/studio/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: 'clave_erronea_min16chars' }) })
    assert.strictEqual(bad.status, 401)

    // Ownership org-scoped: la clave de org_a NO ve campañas de org_b (404 sin oráculo)
    const createRes = await fetch(`${base}/api/campaigns`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer clave_servicio_min16chars', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'De org_b', organizationId: 'org_b', templateSpintax: 'hola {{name}}', csvContent: 'phone,name\n5730044444444,Bob\n' }),
    })
    assert.ok(createRes.status < 300, 'la identidad de servicio crea la campaña de org_b')
    const created = await createRes.json() as { campaign?: { id?: string }; id?: string }
    const campaignId = created.campaign?.id || created.id
    assert.ok(campaignId)

    const foreign = await fetch(`${base}/api/campaigns/${campaignId}`, { headers: { 'Authorization': 'Bearer clave_org_a_min16chars_x' } })
    assert.strictEqual(foreign.status, 404, 'la clave org-scoped no puede leer una campaña ajena (404 sin oráculo)')

    // Con la cookie de sesión de org_a: la org se PRESERVA (sin escalada a servicio)
    const cookie = setCookie.split(';')[0]
    const viaCookie = await fetch(`${base}/api/campaigns/${campaignId}`, { headers: { 'Cookie': cookie } })
    assert.strictEqual(viaCookie.status, 404, 'la sesión derivada de clave org-scoped conserva el límite de org')
  } finally {
    delete process.env.ADMIN_API_KEYS
    server.close()
  }
})
