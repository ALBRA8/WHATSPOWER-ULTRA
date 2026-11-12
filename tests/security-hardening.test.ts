import { describe, it } from 'node:test'
import assert from 'node:assert'
import { createHmac } from 'node:crypto'
import { createBroadcastServer } from '../src/server.ts'
import { MetaCloudDispatcher } from '../src/adapters/meta-cloud-dispatcher.ts'
import { HttpCrmDaemonDispatcher } from '../src/adapters/dispatcher.ts'
import { productionConfigProblems, DurableReplayCache, parseAdminKeys, resolveIdentity } from '../src/security.ts'

/**
 * PRUEBAS DE SEGURIDAD ULTRA (orden de cierre 2026-11-06 — prioridad máxima)
 *  - AUTH-xx: ninguna operación administrativa accesible sin identidad.
 *  - ORG-xx: organizationId SOLO desde identidad; nunca del body.
 *  - ENUM-xx: sin enumeración cross-org en listados ni por ID.
 *  - OWN-xx: step/pause/resume/cancel/attribution exigen propiedad (404 sin oráculo).
 *  - WH-xx: ingesta de leads exige HMAC + timestamp + anti-replay.
 *  - TR-xx: NINGÚN adaptador envía real sin ALLOW_REAL_DISPATCH=true.
 *  - ENV-xx: guard fail-fast de producción.
 */

// Identidades de prueba: 2 orgs ligadas + 1 de servicio
process.env.ADMIN_API_KEYS = 'ultra_test_key_org_a_0000000000:org_aaa,ultra_test_key_org_b_0000000000:org_bbb,ultra_test_key_service_0000000'
const KEY_A = 'ultra_test_key_org_a_0000000000'
const KEY_B = 'ultra_test_key_org_b_0000000000'
const KEY_SVC = 'ultra_test_key_service_0000000'

async function listenEphemeral(server: any): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address()
  return `http://127.0.0.1:${port}`
}

function boot() {
  const { server } = createBroadcastServer({ dbPath: ':memory:', whatsPowerEnabled: false })
  return server
}

const authFetch = (base: string, path: string, key?: string, init: any = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { 'Authorization': `Bearer ${key}` } : {}),
      ...(init.headers || {}),
    },
  })

async function createCampaign(base: string, key: string, name: string, extra: object = {}): Promise<any> {
  const res = await authFetch(base, '/api/campaigns', key, {
    method: 'POST',
    body: JSON.stringify({ name, templateSpintax: 'Hola {{nombre}}', csvContent: 'phone,name\n573000001122,Contacto Test', ...extra }),
  })
  return { status: res.status, data: await res.json() as any }
}

describe('AUTH: superficie administrativa de despacho protegida', () => {
  const routes: Array<{ m: string; p: string; body?: object }> = [
    { m: 'GET', p: '/api/campaigns' },
    { m: 'POST', p: '/api/campaigns', body: { name: 'x' } },
    { m: 'GET', p: '/api/campaigns/cmp_inexistente' },
    { m: 'POST', p: '/api/campaigns/cmp_inexistente/step' },
    { m: 'POST', p: '/api/campaigns/cmp_inexistente/pause' },
    { m: 'POST', p: '/api/campaigns/cmp_inexistente/resume' },
    { m: 'POST', p: '/api/campaigns/cmp_inexistente/cancel' },
    { m: 'GET', p: '/api/attribution/report/cmp_inexistente' },
    { m: 'POST', p: '/api/spintax/preview', body: { template: '{a|b}' } },
    { m: 'POST', p: '/api/audiences/preview-csv', body: { csvContent: 'phone\n57300' } },
    { m: 'POST', p: '/api/ai/neuromarketing/analyze', body: { market: 'x' } },
  ]

  for (const r of routes) {
    it(`AUTH-ANON: ${r.m} ${r.p} anónimo → 401/503 (jamás opera)`, async () => {
      const server = boot()
      const base = await listenEphemeral(server)
      try {
        const res = await authFetch(base, r.p, undefined, { method: r.m, body: r.body ? JSON.stringify(r.body) : undefined })
        assert.ok([401, 503].includes(res.status), `esperado 401/503, obtenido ${res.status}`)
      } finally { server.close() }
    })

    it(`AUTH-OK: ${r.m} ${r.p} con clave válida → jamás 401/503`, async () => {
      const server = boot()
      const base = await listenEphemeral(server)
      try {
        const res = await authFetch(base, r.p, KEY_A, { method: r.m, body: r.body ? JSON.stringify(r.body) : undefined })
        assert.ok(res.status !== 401 && res.status !== 503, `con credencial válida no debe rechazarse (obtenido ${res.status})`)
      } finally { server.close() }
    })
  }

  it('AUTH-503: sin ADMIN_API_KEYS configurado, la ruta admin responde 503 fail-closed', async () => {
    const prev = process.env.ADMIN_API_KEYS
    delete process.env.ADMIN_API_KEYS
    try {
      const server = boot()
      const base = await listenEphemeral(server)
      try {
        const res = await authFetch(base, '/api/campaigns')
        assert.strictEqual(res.status, 503)
      } finally { server.close() }
    } finally {
      process.env.ADMIN_API_KEYS = prev
    }
  })

  it('AUTH-503: sin ADMIN_API_KEYS, el endpoint de DESPACHO step NO puede ejecutarse', async () => {
    const prev = process.env.ADMIN_API_KEYS
    delete process.env.ADMIN_API_KEYS
    try {
      const server = boot()
      const base = await listenEphemeral(server)
      try {
        // incluso con una campaña existente creada por servicio directo en DB
        const res = await authFetch(base, '/api/campaigns/cmp_x/step', 'ultra_test_key_service_0000000', { method: 'POST' })
        assert.strictEqual(res.status, 503)
      } finally { server.close() }
    } finally {
      process.env.ADMIN_API_KEYS = prev
    }
  })
})

describe('ORG: organizationId desde identidad, jamás del body', () => {
  it('ORG-01: clave ligada a org_bbb con body organizationId=org_aaa → 400 y NO crea', async () => {
    const server = boot()
    const base = await listenEphemeral(server)
    try {
      const { status } = await createCampaign(base, KEY_B, 'Robo de org', { organizationId: 'org_aaa' })
      assert.strictEqual(status, 400)
      const list = (await (await authFetch(base, '/api/campaigns', KEY_B)).json() as any).campaigns as any[]
      assert.strictEqual(list.length, 0, 'no debe existir la campaña')
    } finally { server.close() }
  })

  it('ORG-02: clave ligada sin organizationId en body → se usa la org de la identidad', async () => {
    const server = boot()
    const base = await listenEphemeral(server)
    try {
      const { status, data } = await createCampaign(base, KEY_A, 'De org A')
      // (A4-15) creación → 201 Created
      assert.strictEqual(status, 201)
      assert.strictEqual(data.organizationId, 'org_aaa')
    } finally { server.close() }
  })

  it('ORG-03: identidad de servicio DEBE indicar organizationId', async () => {
    const server = boot()
    const base = await listenEphemeral(server)
    try {
      const { status } = await createCampaign(base, KEY_SVC, 'Servicio sin org')
      assert.strictEqual(status, 400)
      const ok = await createCampaign(base, KEY_SVC, 'Servicio con org', { organizationId: 'org_aaa' })
      // (A4-15) creación → 201 Created
      assert.strictEqual(ok.status, 201)
      assert.strictEqual(ok.data.organizationId, 'org_aaa')
    } finally { server.close() }
  })
})

describe('ENUM/OWN: sin enumeración cross-org, ownership en cada operación', () => {
  it('ENUM-01: el listado de org_aaa no muestra campañas de org_bbb', async () => {
    const server = boot()
    const base = await listenEphemeral(server)
    try {
      await createCampaign(base, KEY_A, 'Solo A')
      await createCampaign(base, KEY_B, 'Solo B')
      const listA = ((await (await authFetch(base, '/api/campaigns', KEY_A)).json() as any).campaigns) as any[]
      const listB = ((await (await authFetch(base, '/api/campaigns', KEY_B)).json() as any).campaigns) as any[]
      assert.strictEqual(listA.length, 1)
      assert.strictEqual(listA[0].organization_id, 'org_aaa')
      assert.strictEqual(listB.length, 1)
      assert.strictEqual(listB[0].organization_id, 'org_bbb')
    } finally { server.close() }
  })

  it('OWN-01: org_bbb NO ve la campaña de org_aaa (404 sin oráculo, con teléfono/ítems protegidos)', async () => {
    const server = boot()
    const base = await listenEphemeral(server)
    try {
      const { data } = await createCampaign(base, KEY_A, 'Privada A')
      const id = data.id
      const getB = await authFetch(base, `/api/campaigns/${id}`, KEY_B)
      assert.strictEqual(getB.status, 404)
      const body = await getB.json() as any
      assert.ok(!JSON.stringify(body).includes('phone'), 'sin filtración de datos de la campaña')
    } finally { server.close() }
  })

  it('OWN-02: org_bbb NO puede step/pause/resume/cancel la campaña de org_aaa', async () => {
    const server = boot()
    const base = await listenEphemeral(server)
    try {
      const { data } = await createCampaign(base, KEY_A, 'Controlada A')
      const id = data.id
      for (const action of ['step', 'pause', 'resume', 'cancel']) {
        const res = await authFetch(base, `/api/campaigns/${id}/${action}`, KEY_B, { method: 'POST' })
        assert.strictEqual(res.status, 404, `${action} cross-org debe ser 404`)
      }
      // la campaña sigue intacta
      const detail = await (await authFetch(base, `/api/campaigns/${id}`, KEY_A)).json() as any
      assert.strictEqual(detail.campaign.status, 'DRAFT')
    } finally { server.close() }
  })

  it('OWN-03: el dueño SÍ puede operar su campaña', async () => {
    const server = boot()
    const base = await listenEphemeral(server)
    try {
      const { data } = await createCampaign(base, KEY_A, 'Mía A')
      const id = data.id
      const pause = await authFetch(base, `/api/campaigns/${id}/pause`, KEY_A, { method: 'POST' })
      assert.strictEqual(pause.status, 200)
      const resume = await authFetch(base, `/api/campaigns/${id}/resume`, KEY_A, { method: 'POST' })
      assert.strictEqual(resume.status, 200)
      const cancel = await authFetch(base, `/api/campaigns/${id}/cancel`, KEY_A, { method: 'POST' })
      assert.strictEqual(cancel.status, 200)
      const detail = await (await authFetch(base, `/api/campaigns/${id}`, KEY_A)).json() as any
      assert.strictEqual(detail.campaign.status, 'CANCELLED')
    } finally { server.close() }
  })

  it('OWN-04: atribución de org_bbb sobre campaña de org_aaa → 404', async () => {
    const server = boot()
    const base = await listenEphemeral(server)
    try {
      const { data } = await createCampaign(base, KEY_A, 'Métricas A')
      const res = await authFetch(base, `/api/attribution/report/${data.id}`, KEY_B)
      assert.strictEqual(res.status, 404)
    } finally { server.close() }
  })
})

describe('WH: ingesta de leads firmada (contrato HMAC v2 + 7 pruebas negativas)', () => {
  const SECRET_LEGACY = 'ultra_test_lead_secret_min24chars_0'
  const SEC_A = 'secreto_org_aaa_para_webhook_lead_v2'
  const SEC_B = 'secreto_org_bbb_para_webhook_lead_v2'
  const lead = JSON.stringify({
    campaignId: 'cmp_lead_test',
    source: 'custom_webhook',
    phone: '573000001122',
    name: 'Lead Firmado',
  })
  /** Firma canonical v2: hex(HMAC-SHA256(secret, `${org}.${ts}.${body}`)); org '_legacy' = secreto único v1 */
  const signV2 = (ts: string, body: string, secret: string, org: string = '_legacy') =>
    createHmac('sha256', secret).update(`${org ? org + '.' : ''}${ts}.${body}`).digest('hex')

  const postLead = (base: string, body: string, headers: Record<string, string>) =>
    authFetch(base, '/api/audiences/webhook-lead', undefined, { method: 'POST', headers, body })

  it('WH-01: webhook-lead sin firma → 401/503 (antes inyectaba leads anónimos)', async () => {
    process.env.WEBHOOK_LEAD_SECRET = SECRET_LEGACY
    try {
      const server = boot()
      const base = await listenEphemeral(server)
      try {
        const res = await postLead(base, lead, {})
        assert.ok([401, 503].includes(res.status))
      } finally { server.close() }
    } finally { delete process.env.WEBHOOK_LEAD_SECRET }
  })

  it('WH-02: webhook-lead con HMAC v2 válido → 200', async () => {
    process.env.WEBHOOK_LEAD_SECRET = SECRET_LEGACY
    try {
      const server = boot()
      const base = await listenEphemeral(server)
      try {
        const ts = String(Date.now())
        const res = await postLead(base, lead, {
          'X-Signature-SHA256': signV2(ts, lead, SECRET_LEGACY),
          'X-Timestamp': ts,
        })
        assert.strictEqual(res.status, 200)
      } finally { server.close() }
    } finally { delete process.env.WEBHOOK_LEAD_SECRET }
  })

  it('WH-03: replay exacto de webhook-lead → 401', async () => {
    process.env.WEBHOOK_LEAD_SECRET = SECRET_LEGACY
    try {
      const server = boot()
      const base = await listenEphemeral(server)
      try {
        const ts = String(Date.now())
        const headers = {
          'X-Signature-SHA256': signV2(ts, lead, SECRET_LEGACY),
          'X-Timestamp': ts,
        }
        await postLead(base, lead, headers)
        const r2 = await postLead(base, lead, headers)
        assert.strictEqual(r2.status, 401)
      } finally { server.close() }
    } finally { delete process.env.WEBHOOK_LEAD_SECRET }
  })

  // ============ 7 PRUEBAS NEGATIVAS OBLIGATORIAS (orden §3) ============

  it('NEG-1/WH-04: cuerpo alterado con firma del cuerpo original → 401 (integridad del cuerpo)', async () => {
    process.env.WEBHOOK_LEAD_SECRET = SECRET_LEGACY
    try {
      const server = boot()
      const base = await listenEphemeral(server)
      try {
        const ts = String(Date.now())
        const tampered = lead.replace('573000001122', '579999999999')
        const res = await postLead(base, tampered, {
          'X-Signature-SHA256': signV2(ts, lead, SECRET_LEGACY), // firma del ORIGINAL
          'X-Timestamp': ts,
        })
        assert.strictEqual(res.status, 401)
      } finally { server.close() }
    } finally { delete process.env.WEBHOOK_LEAD_SECRET }
  })

  it('NEG-2/WH-05: firma calculada con secreto equivocado → 401', async () => {
    process.env.WEBHOOK_LEAD_SECRET = SECRET_LEGACY
    try {
      const server = boot()
      const base = await listenEphemeral(server)
      try {
        const ts = String(Date.now())
        const res = await postLead(base, lead, {
          'X-Signature-SHA256': signV2(ts, lead, 'secreto_equivocado_totalmente_distinto_24'),
          'X-Timestamp': ts,
        })
        assert.strictEqual(res.status, 401)
      } finally { server.close() }
    } finally { delete process.env.WEBHOOK_LEAD_SECRET }
  })

  it('NEG-3/WH-06: timestamp fuera de la ventana de tolerancia → 401 (expirado)', async () => {
    process.env.WEBHOOK_LEAD_SECRET = SECRET_LEGACY
    try {
      const server = boot()
      const base = await listenEphemeral(server)
      try {
        const oldTs = String(Date.now() - 6 * 60 * 1000) // 6 min > ventana 5 min
        const res = await postLead(base, lead, {
          'X-Signature-SHA256': signV2(oldTs, lead, SECRET_LEGACY),
          'X-Timestamp': oldTs,
        })
        assert.strictEqual(res.status, 401)
      } finally { server.close() }
    } finally { delete process.env.WEBHOOK_LEAD_SECRET }
  })

  it('NEG-4/WH-07: sin secreto configurado → 503 fail-closed (nunca acepta)', async () => {
    delete process.env.WEBHOOK_LEAD_SECRET
    delete process.env.WEBHOOK_LEAD_SECRETS
    const server = boot()
    const base = await listenEphemeral(server)
    try {
      const ts = String(Date.now())
      const res = await postLead(base, lead, {
        'X-Signature-SHA256': signV2(ts, lead, 'cualquier_secreto_que_nadie_configuro'),
        'X-Timestamp': ts,
      })
      assert.strictEqual(res.status, 503)
    } finally { server.close() }
  })

  it('NEG-5/WH-08: timestamp sustituido manteniendo la firma → 401 (canonical v2 liga ts+body+org)', async () => {
    process.env.WEBHOOK_LEAD_SECRET = SECRET_LEGACY
    try {
      const server = boot()
      const base = await listenEphemeral(server)
      try {
        const ts1 = String(Date.now())
        const sig = signV2(ts1, lead, SECRET_LEGACY)
        await postLead(base, lead, { 'X-Signature-SHA256': sig, 'X-Timestamp': ts1 })
        // Ataque v1: reutilizar la misma firma con timestamp fresco distinto
        const ts2 = String(Date.now() + 1000)
        const r2 = await postLead(base, lead, { 'X-Signature-SHA256': sig, 'X-Timestamp': ts2 })
        assert.strictEqual(r2.status, 401, 'la firma v1 no debe validar con otro timestamp')
      } finally { server.close() }
    } finally { delete process.env.WEBHOOK_LEAD_SECRET }
  })

  it('NEG-6/WH-09: evento concurrente idéntico ×8 → exactamente 1 aceptado, 7 rechazados', async () => {
    process.env.WEBHOOK_LEAD_SECRET = SECRET_LEGACY
    try {
      const server = boot()
      const base = await listenEphemeral(server)
      try {
        const ts = String(Date.now())
        const headers = {
          'X-Signature-SHA256': signV2(ts, lead, SECRET_LEGACY),
          'X-Timestamp': ts,
        }
        const results = await Promise.all(
          Array.from({ length: 8 }, () => postLead(base, lead, { ...headers }))
        )
        const ok = results.filter((r) => r.status === 200).length
        const rejected = results.filter((r) => r.status === 401).length
        assert.strictEqual(ok, 1, 'solo una ejecución del evento')
        assert.strictEqual(rejected, 7, 'los duplicados concurrentes se rechazan')
      } finally { server.close() }
    } finally { delete process.env.WEBHOOK_LEAD_SECRET }
  })

  it('NEG-7/WH-10: evento legítimo de org A no colisiona con org B (cross-org)', async () => {
    process.env.WEBHOOK_LEAD_SECRETS = `org_aaa:${SEC_A},org_bbb:${SEC_B}`
    try {
      const server = boot()
      const base = await listenEphemeral(server)
      try {
        const ts = String(Date.now())
        // La misma firma SOLO vale para la org con cuyo secreto se calculó
        const sigA = signV2(ts, lead, SEC_A, 'org_aaa')
        const rA1 = await postLead(base, lead, { 'X-Signature-SHA256': sigA, 'X-Timestamp': ts, 'X-Org-Id': 'org_aaa' })
        assert.strictEqual(rA1.status, 200)
        // org_bbb intenta usar la firma de org_aaa → rechazada (no colisión de huellas ni de secretos)
        const rB = await postLead(base, lead, { 'X-Signature-SHA256': sigA, 'X-Timestamp': ts, 'X-Org-Id': 'org_bbb' })
        assert.strictEqual(rB.status, 401)
        // Repetición para org_aaa → replay detectado (huella por organización)
        const rA2 = await postLead(base, lead, { 'X-Signature-SHA256': sigA, 'X-Timestamp': ts, 'X-Org-Id': 'org_aaa' })
        assert.strictEqual(rA2.status, 401)
      } finally { server.close() }
    } finally { delete process.env.WEBHOOK_LEAD_SECRETS }
  })

  it('ORG-WH-01: lead firmado por org B hacia campaña de org A → rechazo sin inyección', async () => {
    process.env.WEBHOOK_LEAD_SECRETS = `org_aaa:${SEC_A},org_bbb:${SEC_B}`
    try {
      const server = boot()
      const base = await listenEphemeral(server)
      try {
        const camp = await createCampaign(base, KEY_A, 'Campaña org A', {})
        const campaignId = camp.data.id as string
        const ts = String(Date.now())
        const leadOrg = JSON.stringify({ campaignId, source: 'custom_webhook', phone: '573000009988', name: 'Inyección' })
        const res = await postLead(base, leadOrg, {
          'X-Signature-SHA256': signV2(ts, leadOrg, SEC_B, 'org_bbb'),
          'X-Timestamp': ts,
          'X-Org-Id': 'org_bbb',
        })
        // (fusión) 404 anti-oráculo: jamás se confirma la existencia de campañas ajenas.
        assert.strictEqual(res.status, 404, 'la firma de org B no puede inyectar en campaña de org A (404 sin oráculo)')
        // Y el flujo legítimo de org A sí inyecta
        const ts2 = String(Date.now() + 1)
        const ok = await postLead(base, leadOrg, {
          'X-Signature-SHA256': signV2(ts2, leadOrg, SEC_A, 'org_aaa'),
          'X-Timestamp': ts2,
          'X-Org-Id': 'org_aaa',
        })
        assert.strictEqual(ok.status, 200)
      } finally { server.close() }
    } finally { delete process.env.WEBHOOK_LEAD_SECRETS }
  })

  it('ORG-WH-02: rotación "actual|previo" — el secreto previo sigue válido sin interrupción', async () => {
    process.env.WEBHOOK_LEAD_SECRETS = `org_aaa:${SEC_A}|secreto_previo_orgaaa_rotado_ok`
    try {
      const server = boot()
      const base = await listenEphemeral(server)
      try {
        const ts = String(Date.now())
        // Firmado con el secreto PREVIO (en rotación) → aceptado
        const rPrev = await postLead(base, lead, {
          'X-Signature-SHA256': signV2(ts, lead, 'secreto_previo_orgaaa_rotado_ok', 'org_aaa'),
          'X-Timestamp': ts,
          'X-Org-Id': 'org_aaa',
        })
        assert.strictEqual(rPrev.status, 200)
        // Firmado con el ACTUAL → aceptado
        const ts2 = String(Date.now() + 1)
        const rCur = await postLead(base, lead, {
          'X-Signature-SHA256': signV2(ts2, lead, SEC_A, 'org_aaa'),
          'X-Timestamp': ts2,
          'X-Org-Id': 'org_aaa',
        })
        assert.strictEqual(rCur.status, 200)
      } finally { server.close() }
    } finally { delete process.env.WEBHOOK_LEAD_SECRETS }
  })

  it('ORG-WH-03: secreto v1 "_legacy" no puede ligar leads a campañas (fail-closed de legado)', async () => {
    process.env.WEBHOOK_LEAD_SECRET = SECRET_LEGACY
    try {
      const server = boot()
      const base = await listenEphemeral(server)
      try {
        const camp = await createCampaign(base, KEY_A, 'Campaña org A legacy', {})
        const campaignId = camp.data.id as string
        const ts = String(Date.now())
        const leadOrg = JSON.stringify({ campaignId, source: 'custom_webhook', phone: '573000007766', name: 'Legacy' })
        const res = await postLead(base, leadOrg, {
          'X-Signature-SHA256': signV2(ts, leadOrg, SECRET_LEGACY),
          'X-Timestamp': ts,
        })
        // (fusión) 404 anti-oráculo unificado para el rechazo cross-org.
          assert.strictEqual(res.status, 404, 'el secreto único v1 no puede inyectar en campañas de organizaciones (404 sin oráculo)')
      } finally { server.close() }
    } finally { delete process.env.WEBHOOK_LEAD_SECRET }
  })

  it('REPLAY-DUR-01: DurableReplayCache sobrevive reinicio del proceso (persistencia)', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'replay-durable-'))
    try {
      const dbPath = join(dir, 'replay.db')
      const c1 = new DurableReplayCache(dbPath)
      assert.strictEqual(c1.register('huella_reinicio_01'), true)
      c1.close()
      // "Reinicio": nueva instancia sobre el mismo archivo
      const c2 = new DurableReplayCache(dbPath)
      assert.strictEqual(c2.register('huella_reinicio_01'), false, 'la huella debe sobrevivir al reinicio')
      assert.strictEqual(c2.register('huella_nueva_02'), true)
      c2.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('TR: salvaguardas de despacho real en TODOS los adaptadores', () => {
  it('TR-01: MetaCloudDispatcher con token real BLOQUEA el envío sin ALLOW_REAL_DISPATCH=true (no llama fetch)', async () => {
    const prev = process.env.ALLOW_REAL_DISPATCH
    delete process.env.ALLOW_REAL_DISPATCH
    let fetchCalled = 0
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => { fetchCalled++; throw new Error('fetch NO debió llamarse') }) as any
    try {
      // (A5-02) La credencial global ya no existe en MetaCloudConfig (Oleada 2
      // por-org): el guard ALLOW_REAL_DISPATCH bloquea ANTES de cualquier
      // resolución de credenciales, así que basta mockMode:false.
      const d = new MetaCloudDispatcher({ mockMode: false })
      const r = await d.dispatch('573001112233', 'hola')
      assert.strictEqual(r.success, false)
      assert.ok(r.error!.includes('DISPATCH_BLOCKED_BY_SAFETY_GUARD'))
      assert.strictEqual(fetchCalled, 0, 'ninguna llamada a Meta salió')
    } finally {
      globalThis.fetch = origFetch
      if (prev !== undefined) process.env.ALLOW_REAL_DISPATCH = prev
    }
  })

  it('TR-02: MetaCloudDispatcher con ALLOW_REAL_DISPATCH=true SÍ despacha con las credenciales DE LA ORGANIZACIÓN', async () => {
    process.env.ALLOW_REAL_DISPATCH = 'true'
    let fetchCalled = 0
    let sentAuth = ''
    let sentPhoneId = ''
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalled++
      sentAuth = (init?.headers as Record<string, string>)['Authorization']
      sentPhoneId = String(input).match(/graph\.facebook\.com\/v[\d.]+\/(\d+)\/messages/)![1]
      return new Response(JSON.stringify({ messages: [{ id: 'wamid_test' }] }), { status: 200 })
    }) as any
    const { OrgWaCredentialRegistry, EnvOrgWaSource } = await import('../src/org-wa-credentials.ts')
    const registry = new OrgWaCredentialRegistry([new EnvOrgWaSource({
      metaOrgNumbers: 'org-a:111000111',
      metaOrgCredentials: 'org-a:111000111:token-ORG-A-0123456789abcdef',
    })])
    try {
      const d = new MetaCloudDispatcher({ registry, mockMode: false })
      const r = await d.dispatch('573001112233', 'hola', 'org-a')
      assert.strictEqual(r.success, true)
      assert.strictEqual(fetchCalled, 1)
      // el token usado es el DE LA ORGANIZACIÓN (no una credencial global)
      assert.strictEqual(sentAuth, 'Bearer token-ORG-A-0123456789abcdef')
      assert.strictEqual(sentPhoneId, '111000111')
    } finally {
      globalThis.fetch = origFetch
      delete process.env.ALLOW_REAL_DISPATCH
    }
  })

  it('TR-01b: la credencial global META_ACCESS_TOKEN YA NO despacha — org sin conexión propia → REJECTED (decisión #2)', async () => {
    const prev = process.env.ALLOW_REAL_DISPATCH
    process.env.ALLOW_REAL_DISPATCH = 'true'
    process.env.META_ACCESS_TOKEN = 'EAAG_token_global_ignorado_0123456789'
    let fetchCalled = 0
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => { fetchCalled++; throw new Error('fetch NO debió llamarse') }) as any
    const { OrgWaCredentialRegistry, EnvOrgWaSource } = await import('../src/org-wa-credentials.ts')
    try {
      // registro VACÍO: org-a no tiene conexión propia declarada
      const d = new MetaCloudDispatcher({ registry: new OrgWaCredentialRegistry([new EnvOrgWaSource({ metaOrgNumbers: '', metaOrgCredentials: '' })]), mockMode: false })
      const r = await d.dispatch('573001112233', 'hola', 'org-a')
      assert.strictEqual(r.success, false)
      assert.ok(r.error!.includes('NO_CONNECTED_NUMBER'))
      assert.strictEqual(fetchCalled, 0, 'el token global NO debe producir ningún envío')
    } finally {
      globalThis.fetch = origFetch
      if (prev !== undefined) process.env.ALLOW_REAL_DISPATCH = prev
      delete process.env.META_ACCESS_TOKEN
    }
  })

  it('TR-03: HttpCrmDaemonDispatcher con allowRealDispatch=false BLOQUEA incluso si la URL NO es :3002 (bypass corregido)', async () => {
    let fetchCalled = 0
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => { fetchCalled++; throw new Error('fetch NO debió llamarse') }) as any
    try {
      const d = new HttpCrmDaemonDispatcher({ endpointUrl: 'http://daemon-interno:8080/send', allowRealDispatch: false })
      const r = await d.dispatch('573001112233', 'hola')
      assert.strictEqual(r.success, false)
      assert.ok(r.error!.includes('DISPATCH_BLOCKED_BY_SAFETY_GUARD'))
      assert.strictEqual(fetchCalled, 0)
    } finally { globalThis.fetch = origFetch }
  })

  it('TR-04: la Sala Limpia (mockMode) de Meta sigue funcionando sin salvaguarda (no envía real)', async () => {
    const prev = process.env.ALLOW_REAL_DISPATCH
    delete process.env.ALLOW_REAL_DISPATCH
    try {
      const d = new MetaCloudDispatcher({ mockMode: true })
      const r = await d.dispatch('573001112233', 'hola')
      assert.strictEqual(r.success, true)
      assert.ok(d.dispatchedMessages.length === 1)
    } finally {
      if (prev !== undefined) process.env.ALLOW_REAL_DISPATCH = prev
    }
  })
})

describe('ENV: guard fail-fast de producción ULTRA', () => {
  const cleanEnv = () => {
    for (const k of ['ADMIN_API_KEYS', 'WEBHOOK_LEAD_SECRET', 'INTERNAL_API_SECRET', 'TRANSPORT_ENGINE', 'META_ACCESS_TOKEN', 'META_PHONE_NUMBER_ID', 'ALLOW_REAL_DISPATCH', 'NODE_ENV']) delete process.env[k]
  }

  it('ENV-01: producción sin configuración → nombra TODAS las variables y jamás valores', () => {
    cleanEnv()
    process.env.NODE_ENV = 'production'
    try {
      const problems = productionConfigProblems()
      assert.ok(problems.some((p) => p.includes('ADMIN_API_KEYS')))
      assert.ok(problems.some((p) => p.includes('WEBHOOK_LEAD_SECRET')))
      assert.ok(problems.some((p) => p.includes('INTERNAL_API_SECRET')))
      for (const p of problems) assert.ok(!/[A-Za-z0-9_/+-]{32,}/.test(p.replace(/(ADMIN_API_KEYS|WEBHOOK_LEAD_SECRET|INTERNAL_API_SECRET|META_ACCESS_TOKEN|META_PHONE_NUMBER_ID|ALLOW_REAL_DISPATCH|TRANSPORT_ENGINE)/g, '')), `posible fuga: ${p}`)
    } finally { cleanEnv() }
  })

  it('ENV-02: meta_cloud sin credenciales por organización ni ALLOW_REAL_DISPATCH → nombra las carencias', () => {
    cleanEnv()
    process.env.NODE_ENV = 'production'
    process.env.ADMIN_API_KEYS = 'x'.repeat(24)
    process.env.WEBHOOK_LEAD_SECRET = 'y'.repeat(24)
    process.env.INTERNAL_API_SECRET = 'z'.repeat(24)
    process.env.TRANSPORT_ENGINE = 'meta_cloud'
    try {
      const problems = productionConfigProblems()
      assert.ok(problems.some((p) => p.includes('META_ORG_CREDENTIALS')))
      assert.ok(problems.some((p) => p.includes('ALLOW_REAL_DISPATCH')))
    } finally { cleanEnv() }
  })

  it('ENV-02b: META_ACCESS_TOKEN global NO sustituye a las credenciales por organización (decisión #2)', () => {
    cleanEnv()
    process.env.NODE_ENV = 'production'
    process.env.ADMIN_API_KEYS = 'x'.repeat(24)
    process.env.WEBHOOK_LEAD_SECRET = 'y'.repeat(24)
    process.env.INTERNAL_API_SECRET = 'z'.repeat(24)
    process.env.TRANSPORT_ENGINE = 'meta_cloud'
    process.env.META_ACCESS_TOKEN = 'g'.repeat(32)
    process.env.META_PHONE_NUMBER_ID = '111000111'
    try {
      const problems = productionConfigProblems()
      assert.ok(problems.some((p) => p.includes('META_ORG_CREDENTIALS')), 'el guard exige credenciales POR ORGANIZACIÓN aunque exista un token global')
    } finally { cleanEnv() }
  })
})

// (reauditoría ciclo 2) Dual-formato de ADMIN_API_KEYS: la heurística de
// desambiguación (org:secreto vs secreto:org por longitud >= 16) queda
// DOCUMENTADA con pruebas — un orgId de >= 16 caracteres invierte el parseo;
// es una limitación conocida, no un defecto nuevo.
describe('parseAdminKeys — dual formato (org:secreto | secreto:org)', () => {
  it('formato org:secreto con org corto', () => {
    const keys = parseAdminKeys('org-a:0123456789abcdef01')
    assert.equal(keys.length, 1)
    assert.equal(keys[0].org, 'org-a')
    assert.equal(keys[0].key, '0123456789abcdef01')
  })
  it('formato secreto:org (secreto primero cuando el segundo tramo es corto)', () => {
    const keys = parseAdminKeys('0123456789abcdef01:org-b')
    assert.equal(keys.length, 1)
    assert.equal(keys[0].org, 'org-b')
    assert.equal(keys[0].key, '0123456789abcdef01')
  })
  it('claves de menos de 16 caracteres se rechazan (filtro de entropía)', () => {
    assert.deepEqual(parseAdminKeys('org:short'), [])
  })
  it('resolveIdentity compara en tiempo constante contra TODAS las claves', () => {
    const keys = parseAdminKeys('org-a:0123456789abcdef01,org-b:99887766554433221100')
    assert.equal(resolveIdentity('Bearer 99887766554433221100', keys)?.org, 'org-b')
    assert.equal(resolveIdentity('Bearer no-existe-000000000000', keys), null)
  })
})
