import { describe, it } from 'node:test'
import assert from 'node:assert'
import { createBroadcastServer } from '../src/server.ts'
import { issueStudioSession } from '../src/security.ts'

/**
 * tests/http-auth-real.test.ts
 *
 * Pruebas de autenticación y autorización directamente sobre el SERVICIO REAL
 * de WHATSPOWER-ULTRA (src/server.ts: createBroadcastServer), sin intermediación de mocks.
 *
 * Comprueba:
 *   1. Peticiones sin cabecera de autenticación reciben 401 Unauthorized en TODOS los endpoints reales.
 *   2. Peticiones con Bearer tokens inválidos o maliciosos reciben 401 Unauthorized.
 *   3. Peticiones con cookies de sesión inválidas o alteradas reciben 401 Unauthorized.
 *   4. Fail-closed: sin ADMIN_API_KEYS configurado, la API real responde 503.
 *   5. Peticiones con credenciales legítimas son autorizadas debidamente.
 *   6. Aislamiento estricto multiempresa: org_a no puede acceder, alterar ni enumerar datos de org_b.
 */

const KEY_ORG_ALPHA = 'ultra_key_alpha_real_service_00001'
const KEY_ORG_BETA = 'ultra_key_beta_real_service_000002'
const KEY_SERVICE_GLOBAL = 'ultra_key_global_service_svc_00003'

process.env.ADMIN_API_KEYS = `${KEY_ORG_ALPHA}:org_alpha,${KEY_ORG_BETA}:org_beta,${KEY_SERVICE_GLOBAL}`

async function listenEphemeralServer(server: any): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address()
  return `http://127.0.0.1:${port}`
}

describe('AUTENTICACIÓN REAL EN SERVICIO HTTP (src/server.ts)', () => {
  const protectedEndpoints: Array<{ method: string; path: string; body?: object }> = [
    { method: 'GET', path: '/api/campaigns' },
    { method: 'POST', path: '/api/campaigns', body: { name: 'Camp_Real' } },
    { method: 'GET', path: '/api/campaigns/cmp_test_123' },
    { method: 'POST', path: '/api/campaigns/cmp_test_123/step' },
    { method: 'POST', path: '/api/campaigns/cmp_test_123/pause' },
    { method: 'POST', path: '/api/campaigns/cmp_test_123/resume' },
    { method: 'POST', path: '/api/campaigns/cmp_test_123/cancel' },
    { method: 'GET', path: '/api/attribution/report/cmp_test_123' },
    { method: 'POST', path: '/api/spintax/preview', body: { template: 'Hola {A|B}' } },
    { method: 'POST', path: '/api/audiences/preview-csv', body: { csvContent: 'phone\n573001234567' } },
    { method: 'POST', path: '/api/ai/neuromarketing/analyze', body: { market: 'Test' } },
    { method: 'POST', path: '/api/ai/neuromarketing/generate-spintax', body: { objective: 'Test' } },
    { method: 'POST', path: '/api/ai/neuromarketing/master-prompt', body: { product: 'Test' } },
  ]

  for (const ep of protectedEndpoints) {
    it(`REAL-AUTH-401-ANON: ${ep.method} ${ep.path} sin cabecera Authorization responde estrictamente 401`, async () => {
      const { server } = createBroadcastServer({ dbPath: ':memory:', whatsPowerEnabled: false })
      const baseUrl = await listenEphemeralServer(server)
      try {
        const res = await fetch(`${baseUrl}${ep.path}`, {
          method: ep.method,
          headers: { 'Content-Type': 'application/json' },
          body: ep.body ? JSON.stringify(ep.body) : undefined,
        })
        assert.strictEqual(res.status, 401, `Se esperaba 401 Unauthorized en ${ep.method} ${ep.path}`)
        const data = await res.json() as any
        assert.ok(data.error?.includes('Unauthorized'), 'El payload debe confirmar error de autorización')
      } finally {
        server.close()
      }
    })

    it(`REAL-AUTH-401-BAD-TOKEN: ${ep.method} ${ep.path} con Bearer token falso responde estrictamente 401`, async () => {
      const { server } = createBroadcastServer({ dbPath: ':memory:', whatsPowerEnabled: false })
      const baseUrl = await listenEphemeralServer(server)
      try {
        const res = await fetch(`${baseUrl}${ep.path}`, {
          method: ep.method,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer token_malicioso_invalido_99999999',
          },
          body: ep.body ? JSON.stringify(ep.body) : undefined,
        })
        assert.strictEqual(res.status, 401, `Se esperaba 401 con credencial inválida en ${ep.method} ${ep.path}`)
      } finally {
        server.close()
      }
    })

    it(`REAL-AUTH-401-BAD-COOKIE: ${ep.method} ${ep.path} con cookie falsificada responde estrictamente 401`, async () => {
      const { server } = createBroadcastServer({ dbPath: ':memory:', whatsPowerEnabled: false })
      const baseUrl = await listenEphemeralServer(server)
      try {
        const res = await fetch(`${baseUrl}${ep.path}`, {
          method: ep.method,
          headers: {
            'Content-Type': 'application/json',
            'Cookie': 'ultra_studio_session=cookie_falsa_manipulada_00000000',
          },
          body: ep.body ? JSON.stringify(ep.body) : undefined,
        })
        assert.strictEqual(res.status, 401, `Se esperaba 401 con cookie manipulada en ${ep.method} ${ep.path}`)
      } finally {
        server.close()
      }
    })
  }

  it('REAL-AUTH-FAIL-CLOSED: cuando ADMIN_API_KEYS está ausente en el servidor real responde 503 fail-closed', async () => {
    const prev = process.env.ADMIN_API_KEYS
    delete process.env.ADMIN_API_KEYS
    try {
      const { server } = createBroadcastServer({ dbPath: ':memory:', whatsPowerEnabled: false })
      const baseUrl = await listenEphemeralServer(server)
      try {
        const res = await fetch(`${baseUrl}/api/campaigns`, {
          headers: { 'Authorization': `Bearer ${KEY_ORG_ALPHA}` },
        })
        assert.strictEqual(res.status, 503, 'Sin claves admin configuradas debe responder 503 fail-closed')
        const data = await res.json() as any
        assert.ok(data.error?.includes('fail-closed'))
      } finally {
        server.close()
      }
    } finally {
      process.env.ADMIN_API_KEYS = prev
    }
  })

  it('REAL-AUTH-OK-COOKIE: sesión legítima de Studio emite cookie HttpOnly que autoriza peticiones GET subsecuentes', async () => {
    const { server } = createBroadcastServer({ dbPath: ':memory:', whatsPowerEnabled: false })
    const baseUrl = await listenEphemeralServer(server)
    try {
      // 1. Login exitoso en /studio/login con clave válida
      const loginRes = await fetch(`${baseUrl}/studio/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: KEY_ORG_ALPHA }),
      })
      assert.strictEqual(loginRes.status, 200)
      const setCookie = loginRes.headers.get('set-cookie')
      assert.ok(setCookie && setCookie.includes('ultra_studio_session='), 'Debe emitir cookie ultra_studio_session')

      // 2. Usar esa cookie para consultar /api/campaigns sin Authorization header
      const cookieVal = setCookie.split(';')[0]
      const campaignsRes = await fetch(`${baseUrl}/api/campaigns`, {
        headers: { 'Cookie': cookieVal },
      })
      assert.strictEqual(campaignsRes.status, 200, 'La cookie legítima debe autorizar la petición GET')
    } finally {
      server.close()
    }
  })

  it('REAL-AUTH-MULTI-TENANT: org_alpha no puede consultar ni operar campañas de org_beta (aislamiento en servidor real)', async () => {
    const { server } = createBroadcastServer({ dbPath: ':memory:', whatsPowerEnabled: false })
    const baseUrl = await listenEphemeralServer(server)
    try {
      // 1. Crear campaña autenticado como org_alpha
      const createRes = await fetch(`${baseUrl}/api/campaigns`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${KEY_ORG_ALPHA}`,
        },
        body: JSON.stringify({
          name: 'Campaña Secreta Alpha',
          templateSpintax: 'Hola',
          csvContent: 'phone,name\n573009990001,Contacto Alpha',
        }),
      })
      assert.strictEqual(createRes.status, 201)
      const campaignAlpha = await createRes.json() as any
      const alphaId = campaignAlpha.id

      // 2. org_beta intenta consultar el detalle de la campaña de org_alpha -> 404 (sin oráculo)
      const getFromBeta = await fetch(`${baseUrl}/api/campaigns/${alphaId}`, {
        headers: { 'Authorization': `Bearer ${KEY_ORG_BETA}` },
      })
      assert.strictEqual(getFromBeta.status, 404, 'org_beta debe recibir 404 al consultar recurso ajeno')

      // 3. org_beta intenta pausar la campaña de org_alpha -> 404
      const pauseFromBeta = await fetch(`${baseUrl}/api/campaigns/${alphaId}/pause`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${KEY_ORG_BETA}` },
      })
      assert.strictEqual(pauseFromBeta.status, 404, 'org_beta no puede pausar la campaña de org_alpha')

      // 4. org_beta lista campañas -> solo recibe las suyas (0 de alpha)
      const listFromBeta = await fetch(`${baseUrl}/api/campaigns`, {
        headers: { 'Authorization': `Bearer ${KEY_ORG_BETA}` },
      })
      assert.strictEqual(listFromBeta.status, 200)
      const betaData = await listFromBeta.json() as any
      assert.strictEqual(betaData.campaigns.length, 0, 'org_beta no debe ver campañas de org_alpha en listados')

      // 5. Inyección de organizationId cruzada rechazada: org_alpha intentando adjudicar a org_beta en body -> 400
      const injectRes = await fetch(`${baseUrl}/api/campaigns`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${KEY_ORG_ALPHA}`,
        },
        body: JSON.stringify({
          name: 'Intento de Inyeccion',
          organizationId: 'org_beta',
          templateSpintax: 'Hola',
          csvContent: 'phone,name\n573009990002,Inyectado',
        }),
      })
      assert.strictEqual(injectRes.status, 400, 'Inyección cruzada de organizationId en body debe ser 400')
    } finally {
      server.close()
    }
  })
})
