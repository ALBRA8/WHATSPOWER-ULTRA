import { describe, it } from 'node:test'
import assert from 'node:assert'
import { createHmac } from 'node:crypto'
import { createBroadcastServer } from '../src/server.ts'
import { MetaCloudDispatcher } from '../src/adapters/meta-cloud-dispatcher.ts'
import { HttpCrmDaemonDispatcher } from '../src/adapters/dispatcher.ts'
import { productionConfigProblems } from '../src/security.ts'

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
      const list = await (await authFetch(base, '/api/campaigns', KEY_B)).json() as any[]
      assert.strictEqual(list.length, 0, 'no debe existir la campaña')
    } finally { server.close() }
  })

  it('ORG-02: clave ligada sin organizationId en body → se usa la org de la identidad', async () => {
    const server = boot()
    const base = await listenEphemeral(server)
    try {
      const { status, data } = await createCampaign(base, KEY_A, 'De org A')
      assert.strictEqual(status, 200)
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
      assert.strictEqual(ok.status, 200)
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
      const listA = await (await authFetch(base, '/api/campaigns', KEY_A)).json() as any[]
      const listB = await (await authFetch(base, '/api/campaigns', KEY_B)).json() as any[]
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

describe('WH: ingesta de leads firmada (HMAC v2)', () => {
  const lead = JSON.stringify({
    eventId: 'evt_wh_lead_001',
    campaignId: 'cmp_lead_test',
    source: 'custom_webhook',
    phone: '573000001122',
    name: 'Lead Firmado',
  })
  // Firma v2 (contrato §3): hex = HMAC-SHA256(secret, timestamp + "." + body)
  const signV2 = (secret: string, body: string, ts: string) =>
    createHmac('sha256', secret).update(`${ts}.${body}`, 'utf8').digest('hex')

  it('WH-01: webhook-lead sin firma → 401/503 (antes inyectaba leads anónimos)', async () => {
    process.env.WEBHOOK_LEAD_SECRET = 'ultra_test_lead_secret_min24chars_0'
    try {
      const server = boot()
      const base = await listenEphemeral(server)
      try {
        const res = await authFetch(base, '/api/audiences/webhook-lead', undefined, { method: 'POST', body: lead })
        assert.ok([401, 503].includes(res.status))
      } finally { server.close() }
    } finally { delete process.env.WEBHOOK_LEAD_SECRET }
  })

  it('WH-02: webhook-lead con HMAC válido → 200', async () => {
    process.env.WEBHOOK_LEAD_SECRET = 'ultra_test_lead_secret_min24chars_0'
    try {
      const server = boot()
      const base = await listenEphemeral(server)
      try {
        const res = await authFetch(base, '/api/audiences/webhook-lead', undefined, {
          method: 'POST',
          headers: {
            'X-Signature-SHA256': signV2(process.env.WEBHOOK_LEAD_SECRET!, lead, String(Date.now())),
            'X-Timestamp': String(Date.now()),
          },
          body: lead,
        })
        assert.strictEqual(res.status, 200)
      } finally { server.close() }
    } finally { delete process.env.WEBHOOK_LEAD_SECRET }
  })

  it('WH-03: replay exacto de webhook-lead → 401', async () => {
    process.env.WEBHOOK_LEAD_SECRET = 'ultra_test_lead_secret_min24chars_0'
    try {
      const server = boot()
      const base = await listenEphemeral(server)
      try {
        const ts = String(Date.now())
        const headers = {
          'X-Signature-SHA256': signV2(process.env.WEBHOOK_LEAD_SECRET!, lead, ts),
          'X-Timestamp': ts,
        }
        await authFetch(base, '/api/audiences/webhook-lead', undefined, { method: 'POST', headers, body: lead })
        const r2 = await authFetch(base, '/api/audiences/webhook-lead', undefined, { method: 'POST', headers, body: lead })
        assert.strictEqual(r2.status, 401)
      } finally { server.close() }
    } finally { delete process.env.WEBHOOK_LEAD_SECRET }
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
      const d = new MetaCloudDispatcher({ accessToken: 'EAAG_token_ficticio_para_test_000000', mockMode: false })
      const r = await d.dispatch('573001112233', 'hola')
      assert.strictEqual(r.success, false)
      assert.ok(r.error!.includes('DISPATCH_BLOCKED_BY_SAFETY_GUARD'))
      assert.strictEqual(fetchCalled, 0, 'ninguna llamada a Meta salió')
    } finally {
      globalThis.fetch = origFetch
      if (prev !== undefined) process.env.ALLOW_REAL_DISPATCH = prev
    }
  })

  it('TR-02: MetaCloudDispatcher con ALLOW_REAL_DISPATCH=true SÍ intenta el envío', async () => {
    process.env.ALLOW_REAL_DISPATCH = 'true'
    let fetchCalled = 0
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => { fetchCalled++; return new Response(JSON.stringify({ messages: [{ id: 'wamid_test' }] }), { status: 200 }) }) as any
    try {
      const d = new MetaCloudDispatcher({ accessToken: 'EAAG_token_ficticio_para_test_000000', mockMode: false })
      const r = await d.dispatch('573001112233', 'hola')
      assert.strictEqual(r.success, true)
      assert.strictEqual(fetchCalled, 1)
    } finally {
      globalThis.fetch = origFetch
      delete process.env.ALLOW_REAL_DISPATCH
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

  it('ENV-02: meta_cloud sin token ni ALLOW_REAL_DISPATCH → nombra las 3 carencias', () => {
    cleanEnv()
    process.env.NODE_ENV = 'production'
    process.env.ADMIN_API_KEYS = 'x'.repeat(24)
    process.env.WEBHOOK_LEAD_SECRET = 'y'.repeat(24)
    process.env.INTERNAL_API_SECRET = 'z'.repeat(24)
    process.env.TRANSPORT_ENGINE = 'meta_cloud'
    try {
      const problems = productionConfigProblems()
      assert.ok(problems.some((p) => p.includes('META_ACCESS_TOKEN')))
      assert.ok(problems.some((p) => p.includes('META_PHONE_NUMBER_ID')))
      assert.ok(problems.some((p) => p.includes('ALLOW_REAL_DISPATCH')))
    } finally { cleanEnv() }
  })
})
