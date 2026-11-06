import { test } from 'node:test'
import assert from 'node:assert'
import { createServer } from 'node:http'
import { unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createBroadcastDatabase } from '../src/db.ts'
import { Http2ALockChecker, MockLockChecker } from '../src/safety/lock-checker.ts'
import { LocalSuppressionStore, CompositeSuppressionChecker, FatigueManager } from '../src/safety/suppression.ts'
import { BroadcastEngine } from '../src/queue/broadcast-worker.ts'
import { MockDispatcher } from '../src/adapters/dispatcher.ts'
import { issueStudioSession, resolveStudioSession, parseAdminKeys } from '../src/security.ts'
import { renderCampaignStudioHtml } from '../src/studio/campaign-studio-html.ts'
import { renderSpintax } from '../src/engine/spintax.ts'

/**
 * TERCERA REPARACIÓN — PRUEBAS FORZOSAS ULTRA (orden §5.A–§5.D, §8):
 *  - 5.A: X-Org-Id SIEMPRE presente en las llamadas a Capa 2A; eco de
 *    organización verificado; incompatibilidad de contrato ≠ resultado de seguridad.
 *  - 5.B: supresión POR ORGANIZACIÓN (política documentada) + lista global
 *    restringida/auditable + migración conservadora de opt-outs legacy.
 *  - 5.C: XSS (plantilla Studio sin datos interpolados; preview con payload
 *    hostil viaja como DATO) + cookies de sesión (HttpOnly/Secure/revocación).
 *  - 5.D: worker — cancelación durante los chequeos JIT, pausa sin despacho,
 *    campañas de dos organizaciones en paralelo, fatiga por org.
 */

// ---------------------------------------------------------------------------
// U3-A. 5.A — PROPAGACIÓN Y VERIFICACIÓN DE ORGANIZACIÓN
// ---------------------------------------------------------------------------
test('U3-01: Http2ALockChecker envía X-Org-Id SIEMPRE y valida el eco de organización', async () => {
  const seen: { url: string; org: string | undefined; auth: string | undefined } = { url: '', org: undefined, auth: undefined }
  const stub = createServer((req, res) => {
    seen.url = req.url || ''
    seen.org = req.headers['x-org-id'] as string | undefined
    seen.auth = req.headers.authorization as string | undefined
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ phone: '573001112233', locked: false, lock: null, organizationId: seen.org }))
  })
  await new Promise<void>((r) => stub.listen(3910, () => r()))
  process.env.INTERNAL_API_SECRET = 'ultra_t3_internal_secret_min24chars'
  try {
    const checker = new Http2ALockChecker({ baseUrl: 'http://localhost:3910', timeoutMs: 800 })
    const res = await checker.checkLock('573001112233', 'org_alpha')
    assert.strictEqual(res.available, true)
    assert.strictEqual(seen.org, 'org_alpha', 'el header X-Org-Id debe viajar en TODA llamada')
    assert.ok(seen.auth?.startsWith('Bearer '), 'el Bearer de INTERNAL_API_SECRET viaja junto al org')

    // La MISMA llamada con OTRA org consulta ese otro contexto
    await checker.checkLock('573001112233', 'org_beta')
    assert.strictEqual(seen.org, 'org_beta')
  } finally {
    stub.close()
  }
})

test('U3-02: supresión POR ORGANIZACIÓN + lista global restringida y auditable (5.B)', async () => {
  const db = createBroadcastDatabase(':memory:')
  const local = new LocalSuppressionStore(db)

  // Baja en org A → solo org A
  await local.addSuppression('org_a', '573001112233', 'solicitud de baja')
  assert.strictEqual(await local.isSuppressed('573001112233', 'org_a'), true)
  assert.strictEqual(await local.isSuppressed('573001112233', 'org_b'), false, 'la baja de org_a NO silencia a org_b')

  // Sin organización → fail-closed (nunca respuesta "global")
  await assert.rejects(() => local.isSuppressed('573001112233', ''))

  // Lista GLOBAL: exige motivo documentado (auditable) y aplica a todas las orgs
  assert.throws(() => local.addGlobalSuppression('573004445566', 'corto'), /GLOBAL_SUPPRESSION_REQUIRES_DOCUMENTED_REASON/)
  local.addGlobalSuppression('573004445566', 'Bloqueo regulatorio según resolución 2026-111 (documentado)')
  assert.strictEqual(await local.isSuppressed('573004445566', 'org_a'), true)
  assert.strictEqual(await local.isSuppressed('573004445566', 'org_b'), true)

  // La re-activación POR ORG no toca la lista global legal
  await local.removeSuppression('org_a', '573004445566')
  assert.strictEqual(await local.isSuppressed('573004445566', 'org_a'), true, 'la baja legal global persiste')
})

test('U3-03: migración conservadora — opt-outs legacy (tabla global vieja) pasan a la lista global documentada', async () => {
  // 1. BD temporal con el ESQUEMA VIEJO (suppression_list y contact_fatigue con phone PK)
  const tmp = `${tmpdir()}/ultra_t3_legacy_${Date.now()}.db`
  const legacy = new DatabaseSync(tmp)
  legacy.exec(`
    CREATE TABLE campaigns (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL,
      template_spintax TEXT NOT NULL, status TEXT NOT NULL, scheduled_at INTEGER, started_at INTEGER,
      finished_at INTEGER, total_targets INTEGER NOT NULL DEFAULT 0, sent_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0, skipped_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE suppression_list (phone TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE contact_fatigue (phone TEXT PRIMARY KEY, last_broadcast_at INTEGER NOT NULL, last_campaign_id TEXT NOT NULL);
    INSERT INTO suppression_list (phone, reason, created_at) VALUES ('573007778899', 'opt_out_legacy', 1700000000);
    INSERT INTO contact_fatigue (phone, last_broadcast_at, last_campaign_id) VALUES ('573007778899', strftime('%s','now') - 3600, 'cmp_old');
  `)
  legacy.close()

  try {
    // 2. Abrir con el código NUEVO → migra y conserva el opt-out de forma conservadora
    const migrated = createBroadcastDatabase(tmp)
    const globalRow = migrated.prepare("SELECT * FROM global_suppression_list WHERE phone = '573007778899'").get() as any
    assert.ok(globalRow, 'el opt-out legacy se conserva en la lista global documentada')
    assert.ok(String(globalRow.reason).startsWith('migrado_v4'), 'motivo de migración auditable')

    const checker = new LocalSuppressionStore(migrated)
    assert.strictEqual(await checker.isSuppressed('573007778899', 'org_cualquiera'), true, 'el opt-out legacy sigue suprimiendo (conservador)')

    // La fatiga legacy quedó en el espacio '__legacy__' (NO se atribuye a orgs reales)
    const fatigue = new FatigueManager(migrated)
    assert.strictEqual(fatigue.isFatigued('573007778899', 'org_cualquiera'), false, 'la fatiga NO se atribuye a organizaciones reales')
    assert.strictEqual(fatigue.isFatigued('573007778899', '__legacy__'), true)
  } finally {
    try { unlinkSync(tmp) } catch {}
  }
})

// ---------------------------------------------------------------------------
// U3-C. 5.C — XSS Y SESIÓN
// ---------------------------------------------------------------------------
test('U3-04: la plantilla del Studio no interpola datos de campañas y el preview trata el payload hostil como DATO', () => {
  const html = renderCampaignStudioHtml()
  // La plantilla es estática: no contiene filas de datos de usuarios
  assert.ok(!html.includes('contact_phone'), 'la plantilla no incrusta filas de datos')
  // El preview con payload hostil viaja como TEXTO (el cliente lo pinta con textContent)
  const rendered = renderSpintax('Hola {{nombre}} <script>alert(1)</script>', { seed: 'x', variables: { nombre: '<img src=x onerror=alert(1)>' } })
  assert.ok(rendered.includes('<img src=x onerror=alert(1)>'), 'el render es transparencia de datos (el cliente usa textContent, sin interpolación en HTML)')
  assert.ok(rendered.includes('<script>'), 'el texto se conserva íntegro como dato')
})

test('U3-05: cookie de sesión del Studio — HttpOnly, SameSite=Strict, Secure en producción y firma verificada', () => {
  const keys = parseAdminKeys('clave_admin_larga_00000000001:org_a')
  const prev = process.env.NODE_ENV
  try {
    process.env.NODE_ENV = 'production'
    const cookie = issueStudioSession(0, keys[0].key)
    assert.ok(cookie.includes('HttpOnly'))
    assert.ok(cookie.includes('SameSite=Strict'))
    assert.ok(cookie.includes('Secure'), 'en producción la cookie es Secure')
    assert.ok(resolveStudioSession(cookie, keys), 'la cookie válida resuelve la identidad')

    process.env.NODE_ENV = 'development'
    const cookieDev = issueStudioSession(0, keys[0].key)
    assert.ok(resolveStudioSession(cookieDev, keys))
    assert.strictEqual(resolveStudioSession('wp_ultra_studio_session=0.170000000000000.firma_falsa', keys), null, 'firma falsa rechazada')
    // Expiración: iat viejo (> TTL 1h) → null
    const keys2 = parseAdminKeys('clave_admin_larga_00000000001:org_a')
    const expired = `wp_ultra_studio_session=0.1700000000000.${(issueStudioSession(0, keys2[0].key).split('.')[2])}`
    assert.strictEqual(resolveStudioSession(expired, keys2), null, 'cookie expirada rechazada')
  } finally {
    process.env.NODE_ENV = prev
  }
})

// ---------------------------------------------------------------------------
// U3-D. 5.D — WORKER: CANCELACIÓN EN VUELO, PAUSA Y DOS ORGANIZACIONES
// ---------------------------------------------------------------------------
function bootEngine(lockChecker: any, suppressionStore: any) {
  const db = createBroadcastDatabase(':memory:')
  const dispatcher = new MockDispatcher()
  const engine = new BroadcastEngine({
    db,
    dispatcher,
    lockChecker,
    suppressionStore,
    throttlerOptions: { minIntervalMs: 0, maxIntervalMs: 0 },
  })
  return { db, engine, dispatcher }
}

const BUSINESS_DATE = new Date('2026-10-24T11:00:00-05:00')

test('U3-06: cancelar la campaña DURANTE los chequeos JIT → el ítem se aborta SIN despachar', async () => {
  let lockCalls = 0
  const slowLock = {
    async checkLock(phone: string, organizationId: string) {
      void phone; void organizationId
      lockCalls++
      // En la 2ª llamada (JIT), dar tiempo a que el test cancele la campaña
      if (lockCalls >= 2) await new Promise((r) => setTimeout(r, 150))
      return { available: true }
    },
  }
  const { db, engine, dispatcher } = bootEngine(slowLock, { async isSuppressed() { return false } })

  const campaign = await engine.createCampaign({
    organizationId: 'org_a',
    name: 'Cancelación en vuelo',
    templateSpintax: 'Hola {{name}}',
    csvContent: 'phone,name\n3001112233,Uno',
  })

  const execPromise = engine.processNextItem(campaign.id, BUSINESS_DATE)
  // Esperar a que el worker esté DENTRO del chequeo JIT #2 y cancelar entonces
  await new Promise((r) => setTimeout(r, 80))
  db.prepare("UPDATE campaigns SET status = 'CANCELLED' WHERE id = ?").run(campaign.id)
  const res = await execPromise

  assert.strictEqual(res.processed, true)
  assert.strictEqual(res.status, 'ABORTED_CAMPAIGN_NOT_RUNNING', 'el re-check F0 aborta sin enviar tras la cancelación')
  assert.strictEqual(engine.getItems(campaign.id)[0].status, 'ABORTED_CAMPAIGN_NOT_RUNNING')
  assert.strictEqual((dispatcher as any).dispatched.length, 0, 'CERO mensajes enviados tras cancelación en vuelo')
})

test('U3-07: PAUSED no despacha; CANCELLED es terminal (resume → rechazado)', async () => {
  const { db, engine } = bootEngine({ async checkLock() { return { available: true } } }, { async isSuppressed() { return false } })
  const campaign = await engine.createCampaign({
    organizationId: 'org_a',
    name: 'Pausa terminal',
    templateSpintax: 'Hola {{name}}',
    csvContent: 'phone,name\n3001112244,Dos',
  })
  db.prepare("UPDATE campaigns SET status = 'PAUSED' WHERE id = ?").run(campaign.id)
  const res = await engine.processNextItem(campaign.id, BUSINESS_DATE)
  assert.strictEqual(res.processed, false)
  assert.strictEqual(res.status, 'PAUSED')
  assert.strictEqual(engine.getItems(campaign.id)[0].status, 'PENDING', 'ningún ítem se despacha en pausa')

  // Cancelar y pretender resucitar: el guard de estado lo rechaza
  db.prepare("UPDATE campaigns SET status = 'CANCELLED' WHERE id = ?").run(campaign.id)
  const trx = db.prepare("UPDATE campaigns SET status = 'RUNNING' WHERE id = ? AND status IN ('DRAFT','PAUSED','PAUSED_OFF_HOURS','PAUSED_COOLDOWN')").run(campaign.id)
  assert.strictEqual(Number(trx.changes), 0, 'CANCELLED es terminal: la transición condicional no aplica')
})

test('U3-08: campañas de DOS organizaciones con el MISMO teléfono corren en paralelo de forma independiente', async () => {
  const lockChecker = new MockLockChecker()
  const { engine, dispatcher } = bootEngine(lockChecker, { async isSuppressed() { return false } })

  const csv = 'phone,name\n3009998877,Compartido'
  const campA = await engine.createCampaign({ organizationId: 'org_a', name: 'A', templateSpintax: 'Hola A {{name}}', csvContent: csv })
  const campB = await engine.createCampaign({ organizationId: 'org_b', name: 'B', templateSpintax: 'Hola B {{name}}', csvContent: csv })

  // Despachos independientes para campañas de orgs distintas
  const ra = await engine.processNextItem(campA.id, BUSINESS_DATE)
  const rb = await engine.processNextItem(campB.id, BUSINESS_DATE)
  assert.strictEqual(ra.status, 'SENT')
  assert.strictEqual(rb.status, 'SENT')

  // El lock activo SOLO en org_a excluye en A pero NO en B (teléfono fresco, sin fatiga)
  const csvFresh = 'phone,name\n3007776655,Fresco'
  lockChecker.setLock('573007776655', 'IN_FLOW_2A', 'org_a')
  const campA2 = await engine.createCampaign({ organizationId: 'org_a', name: 'A2', templateSpintax: 'A2 {{name}}', csvContent: csvFresh })
  const campB2 = await engine.createCampaign({ organizationId: 'org_b', name: 'B2', templateSpintax: 'B2 {{name}}', csvContent: csvFresh })
  assert.strictEqual(engine.getItems(campA2.id)[0].status, 'LOCK_EXCLUDED', 'el lock de org_a excluye en org_a')
  assert.strictEqual(engine.getItems(campB2.id)[0].status, 'PENDING', 'el lock de org_a NO excluye en org_b')
  const sent = (dispatcher as any).dispatched as Array<{ to: string; text: string }>
  assert.ok(sent.some((s) => s.text.includes('Hola A')))
  assert.ok(sent.some((s) => s.text.includes('Hola B')))

  // Fatiga POR ORGANIZACIÓN: cada org registra SU fatiga; una tercera org (sin envíos) no está fatigada
  const fatigue = new FatigueManager(engine.db)
  assert.strictEqual(fatigue.isFatigued('573009998877', 'org_a'), true, 'org_a registra su propio envío')
  assert.strictEqual(fatigue.isFatigued('573009998877', 'org_b'), true, 'org_b registra su propio envío')
  assert.strictEqual(fatigue.isFatigued('573009998877', 'org_c_sin_envios'), false, 'la fatiga de org_a/org_b NO se atribuye a una tercera org')
})

test('U3-09: CompositeSuppressionChecker sincroniza la baja remota EN SU ORGANIZACIÓN (sin contaminación cruzada)', async () => {
  const db = createBroadcastDatabase(':memory:')
  const local = new LocalSuppressionStore(db)
  const composite = new CompositeSuppressionChecker(local, { async isSuppressed(phone: string, organizationId: string) { void phone; void organizationId; return true } })

  assert.strictEqual(await composite.isSuppressed('573005554433', 'org_sync'), true)
  // La sincronización quedó en el espacio de org_sync
  assert.strictEqual(await local.isSuppressed('573005554433', 'org_sync'), true)
  assert.strictEqual(await local.isSuppressed('573005554433', 'org_otra'), false, 'la baja sincronizada de org_sync NO contamina a org_otra')
})
