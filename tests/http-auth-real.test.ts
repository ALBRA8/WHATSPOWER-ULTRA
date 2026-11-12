import { describe, it } from 'node:test'
import assert from 'node:assert'
import { createBroadcastServer } from '../src/server.ts'
import { issueStudioSession, signWebhookPayload } from '../src/security.ts'

/**
 * tests/http-auth-real.test.ts
 *
 * Pruebas exhaustivas de autenticación, autorización y aislamiento multiempresa
 * ejecutadas DIRECTAMENTE contra el servidor HTTP real (src/server.ts: createBroadcastServer).
 *
 * Cobertura auditada:
 *   1. Rechazo 401 Unauthorized sin credenciales en todos los endpoints protegidos.
 *   2. Rechazo 401 con tokens Bearer manipulados o maliciosos.
 *   3. Rechazo 401 con cookies de sesión manipuladas o alteradas.
 *   4. Fail-closed: 503 Service Unavailable cuando ADMIN_API_KEYS está ausente.
 *   5. Acceso autorizado 200/201 con credenciales legítimas en cada método y ruta.
 *   6. Aislamiento multi-tenant estricto: org_alpha jamás puede consultar, operar o enumerar datos de org_beta.
 *   7. Detección y rechazo 400 de inyección de organizationId cruzado en cuerpo.
 *   8. Canje de sesión en /studio/login y autorización subsecuente con cookie HttpOnly.
 *   9. Verificación de endpoints públicos (/api/health, /) y rutas no reconocidas.
 *  10. Ingesta de leads webhook con verificación criptográfica HMAC v2 y protección anti-replay.
 */

const KEY_ORG_ALPHA = 'ultra_key_alpha_real_service_00001'
const KEY_ORG_BETA = 'ultra_key_beta_real_service_000002'
const KEY_SERVICE_GLOBAL = 'ultra_key_global_service_svc_00003'
const WEBHOOK_SECRET_ALPHA = 'webhook_sec_alpha_real_service_min24chars'

process.env.ADMIN_API_KEYS = `${KEY_ORG_ALPHA}:org_alpha,${KEY_ORG_BETA}:org_beta,${KEY_SERVICE_GLOBAL}`
process.env.WEBHOOK_LEAD_SECRETS = `org_alpha:${WEBHOOK_SECRET_ALPHA}`

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
        const data = (await res.json()) as any
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
            Authorization: 'Bearer token_malicioso_invalido_99999999',
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
            Cookie: 'wp_ultra_studio_session=cookie_falsa_manipulada_00000000',
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
          headers: { Authorization: `Bearer ${KEY_ORG_ALPHA}` },
        })
        assert.strictEqual(res.status, 503, 'Sin claves admin configuradas debe responder 503 fail-closed')
        const data = (await res.json()) as any
        assert.ok(data.error?.includes('fail-closed'))
      } finally {
        server.close()
      }
    } finally {
      process.env.ADMIN_API_KEYS = prev
    }
  })

  it('REAL-AUTH-STUDIO-SESSION: ciclo completo de login, emisión de cookie HttpOnly y rechazo de cookies alteradas', async () => {
    const { server } = createBroadcastServer({ dbPath: ':memory:', whatsPowerEnabled: false })
    const baseUrl = await listenEphemeralServer(server)
    try {
      // 1. Login exitoso
      const loginRes = await fetch(`${baseUrl}/studio/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: KEY_ORG_ALPHA }),
      })
      assert.strictEqual(loginRes.status, 200)
      const setCookie = loginRes.headers.get('set-cookie')
      assert.ok(setCookie && setCookie.includes('wp_ultra_studio_session='), 'Debe emitir cookie wp_ultra_studio_session')
      assert.ok(setCookie.includes('HttpOnly'), 'La cookie debe ser HttpOnly')
      assert.ok(setCookie.includes('SameSite=Strict'), 'La cookie debe ser SameSite=Strict')

      const cookieVal = setCookie.split(';')[0]

      // 2. GET con cookie legítima
      const campaignsRes = await fetch(`${baseUrl}/api/campaigns`, {
        headers: { Cookie: cookieVal },
      })
      assert.strictEqual(campaignsRes.status, 200, 'La cookie legítima debe autorizar la petición GET')

      // 3. Login fallido con secreto inválido -> 401
      const badLogin = await fetch(`${baseUrl}/studio/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: 'dummy_bad_login_secret_fail' }),
      })
      assert.strictEqual(badLogin.status, 401)

      // 4. Cookie con firma HMAC manipulada -> 401
      const tamperedCookie = cookieVal.slice(0, -5) + 'XXXXX'
      const tamperedRes = await fetch(`${baseUrl}/api/campaigns`, {
        headers: { Cookie: tamperedCookie },
      })
      assert.strictEqual(tamperedRes.status, 401, 'Cookie con firma manipulada debe ser rechazada con 401')
    } finally {
      server.close()
    }
  })

  it('REAL-AUTH-OPERATIONS-ALLOWED: acceso autorizado 200/201 con credenciales legítimas en endpoints clave', async () => {
    const { server } = createBroadcastServer({ dbPath: ':memory:', whatsPowerEnabled: false })
    const baseUrl = await listenEphemeralServer(server)
    try {
      // 1. Spintax preview
      const spintaxRes = await fetch(`${baseUrl}/api/spintax/preview`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${KEY_ORG_ALPHA}`,
        },
        body: JSON.stringify({ template: 'Hola {amigo|cliente}' }),
      })
      assert.strictEqual(spintaxRes.status, 200)
      const spintaxData = (await spintaxRes.json()) as any
      assert.ok(spintaxData.rendered)

      // 2. Audience CSV preview
      const csvRes = await fetch(`${baseUrl}/api/audiences/preview-csv`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${KEY_ORG_ALPHA}`,
        },
        body: JSON.stringify({ csvContent: 'phone,name\n573001234567,Juan' }),
      })
      assert.strictEqual(csvRes.status, 200)
      const csvData = (await csvRes.json()) as any
      assert.strictEqual(csvData.validCount, 1)

      // 3. Neuromarketing Analyze
      const neuroRes = await fetch(`${baseUrl}/api/ai/neuromarketing/analyze`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${KEY_ORG_ALPHA}`,
        },
        body: JSON.stringify({ product: 'CRM', audience: 'PyMEs' }),
      })
      assert.strictEqual(neuroRes.status, 200)

      // 4. Neuromarketing Generate Spintax
      const neuroSpintaxRes = await fetch(`${baseUrl}/api/ai/neuromarketing/generate-spintax`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${KEY_ORG_ALPHA}`,
        },
        body: JSON.stringify({ product: 'CRM', trigger: 'urgency' }),
      })
      assert.strictEqual(neuroSpintaxRes.status, 200)

      // 5. Neuromarketing Master Prompt
      const neuroPromptRes = await fetch(`${baseUrl}/api/ai/neuromarketing/master-prompt`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${KEY_ORG_ALPHA}`,
        },
        body: JSON.stringify({ product: 'CRM', objective: 'Ventas' }),
      })
      assert.strictEqual(neuroPromptRes.status, 200)
    } finally {
      server.close()
    }
  })

  it('REAL-AUTH-MULTI-TENANT: aislamiento estricto entre organizaciones y rechazo de inyección de organizationId', async () => {
    const { server } = createBroadcastServer({ dbPath: ':memory:', whatsPowerEnabled: false })
    const baseUrl = await listenEphemeralServer(server)
    try {
      // 1. Crear campaña autenticado como org_alpha
      const createRes = await fetch(`${baseUrl}/api/campaigns`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${KEY_ORG_ALPHA}`,
        },
        body: JSON.stringify({
          name: 'Campaña Secreta Alpha',
          templateSpintax: 'Hola',
          csvContent: 'phone,name\n573009990001,Contacto Alpha',
        }),
      })
      assert.strictEqual(createRes.status, 201)
      const campaignAlpha = (await createRes.json()) as any
      const alphaId = campaignAlpha.id

      // 2. org_beta intenta consultar el detalle de la campaña de org_alpha -> 404 (sin oráculo)
      const getFromBeta = await fetch(`${baseUrl}/api/campaigns/${alphaId}`, {
        headers: { Authorization: `Bearer ${KEY_ORG_BETA}` },
      })
      assert.strictEqual(getFromBeta.status, 404, 'org_beta debe recibir 404 al consultar recurso ajeno')

      // 3. org_beta intenta pausar la campaña de org_alpha -> 404
      const pauseFromBeta = await fetch(`${baseUrl}/api/campaigns/${alphaId}/pause`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY_ORG_BETA}` },
      })
      assert.strictEqual(pauseFromBeta.status, 404, 'org_beta no puede pausar la campaña de org_alpha')

      // 4. org_beta intenta cancelar la campaña de org_alpha -> 404
      const cancelFromBeta = await fetch(`${baseUrl}/api/campaigns/${alphaId}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY_ORG_BETA}` },
      })
      assert.strictEqual(cancelFromBeta.status, 404)

      // 5. org_beta intenta consultar reporte de atribución de org_alpha -> 404
      const attribFromBeta = await fetch(`${baseUrl}/api/attribution/report/${alphaId}`, {
        headers: { Authorization: `Bearer ${KEY_ORG_BETA}` },
      })
      assert.strictEqual(attribFromBeta.status, 404)

      // 6. org_beta lista campañas -> solo recibe 0 campañas de alpha
      const listFromBeta = await fetch(`${baseUrl}/api/campaigns`, {
        headers: { Authorization: `Bearer ${KEY_ORG_BETA}` },
      })
      assert.strictEqual(listFromBeta.status, 200)
      const betaData = (await listFromBeta.json()) as any
      assert.strictEqual(betaData.campaigns.length, 0, 'org_beta no debe ver campañas de org_alpha en listados')

      // 7. Inyección cruzada de organizationId en body rechazada con 400
      const injectRes = await fetch(`${baseUrl}/api/campaigns`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${KEY_ORG_ALPHA}`,
        },
        body: JSON.stringify({
          name: 'Intento de Inyeccion',
          organizationId: 'org_beta',
          templateSpintax: 'Hola',
          csvContent: 'phone,name\n573009990002,Inyectado',
        }),
      })
      assert.strictEqual(injectRes.status, 400, 'Inyección cruzada de organizationId en body debe ser 400')

      // 8. org_alpha sí puede consultar y operar su propia campaña
      const getFromAlpha = await fetch(`${baseUrl}/api/campaigns/${alphaId}`, {
        headers: { Authorization: `Bearer ${KEY_ORG_ALPHA}` },
      })
      assert.strictEqual(getFromAlpha.status, 200)

      const pauseFromAlpha = await fetch(`${baseUrl}/api/campaigns/${alphaId}/pause`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY_ORG_ALPHA}` },
      })
      assert.strictEqual(pauseFromAlpha.status, 200)

      const resumeFromAlpha = await fetch(`${baseUrl}/api/campaigns/${alphaId}/resume`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY_ORG_ALPHA}` },
      })
      assert.strictEqual(resumeFromAlpha.status, 200)

      const cancelFromAlpha = await fetch(`${baseUrl}/api/campaigns/${alphaId}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY_ORG_ALPHA}` },
      })
      assert.strictEqual(cancelFromAlpha.status, 200)

      // 9. Reanudar una campaña cancelada (terminal) es rechazado con 409 Conflict
      const resumeCanceled = await fetch(`${baseUrl}/api/campaigns/${alphaId}/resume`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY_ORG_ALPHA}` },
      })
      assert.strictEqual(resumeCanceled.status, 409, 'Reanudar campaña CANCELLED debe ser 409 Conflict')
    } finally {
      server.close()
    }
  })

  it('REAL-AUTH-PUBLIC-AND-METHODS: endpoints públicos, métodos no soportados y rutas no encontradas', async () => {
    const { server } = createBroadcastServer({ dbPath: ':memory:', whatsPowerEnabled: false })
    const baseUrl = await listenEphemeralServer(server)
    try {
      // 1. Healthcheck público -> 200
      const healthRes = await fetch(`${baseUrl}/api/health`)
      assert.strictEqual(healthRes.status, 200)
      const healthData = (await healthRes.json()) as any
      assert.strictEqual(healthData.status, 'ok')

      // 2. UI pública -> 200 HTML
      const uiRes = await fetch(`${baseUrl}/`)
      assert.strictEqual(uiRes.status, 200)
      assert.ok(uiRes.headers.get('content-type')?.includes('text/html'))

      // 3. Ruta desconocida en /api/* sin credenciales -> 401
      const unknownAnon = await fetch(`${baseUrl}/api/ruta-inexistente-123`)
      assert.strictEqual(unknownAnon.status, 401)

      // 4. Ruta desconocida en /api/* con credenciales legítimas -> 404
      const unknownAuth = await fetch(`${baseUrl}/api/ruta-inexistente-123`, {
        headers: { Authorization: `Bearer ${KEY_ORG_ALPHA}` },
      })
      assert.strictEqual(unknownAuth.status, 404)

      // 5. Método HTTP PUT en /api/campaigns con credenciales -> 404 (método no enrutado)
      const putAuth = await fetch(`${baseUrl}/api/campaigns`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${KEY_ORG_ALPHA}` },
      })
      assert.strictEqual(putAuth.status, 404)

      // 6. Enlace rastreado inexistente -> 404
      const linkRes = await fetch(`${baseUrl}/t/codigo_inexistente_999`)
      assert.strictEqual(linkRes.status, 404)
    } finally {
      server.close()
    }
  })

  it('REAL-AUTH-WEBHOOK-HMAC: ingesta de leads con verificación criptográfica real y anti-replay', async () => {
    const { server } = createBroadcastServer({ dbPath: ':memory:', whatsPowerEnabled: false })
    const baseUrl = await listenEphemeralServer(server)
    try {
      const now = Date.now()
      const rawPayload = JSON.stringify({ phone: '573001234567', name: 'Lead Real', source: 'custom_webhook' })
      const validSig = signWebhookPayload(now, rawPayload, WEBHOOK_SECRET_ALPHA, 'org_alpha')

      // 1. Ingesta legítima con firma HMAC v2 válida
      const validLeadRes = await fetch(`${baseUrl}/api/audiences/webhook-lead`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Org-Id': 'org_alpha',
          'X-Timestamp': String(now),
          'X-Signature-Sha256': validSig,
        },
        body: rawPayload,
      })
      assert.strictEqual(validLeadRes.status, 200, 'Webhook con firma válida debe ser 200')

      // 2. Replay attack: enviar la misma petición con misma firma y timestamp -> 401
      const replayRes = await fetch(`${baseUrl}/api/audiences/webhook-lead`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Org-Id': 'org_alpha',
          'X-Timestamp': String(now),
          'X-Signature-Sha256': validSig,
        },
        body: rawPayload,
      })
      assert.strictEqual(replayRes.status, 401, 'Petición duplicada debe ser rechazada por anti-replay')
      const replayData = (await replayRes.json()) as any
      assert.ok(replayData.error?.includes('replay'))

      // 3. Firma adulterada -> 401
      const badSigRes = await fetch(`${baseUrl}/api/audiences/webhook-lead`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Org-Id': 'org_alpha',
          'X-Timestamp': String(Date.now()),
          'X-Signature-Sha256': 'firma_totalmente_falsa_9999999999',
        },
        body: rawPayload,
      })
      assert.strictEqual(badSigRes.status, 401, 'Firma HMAC inválida debe ser 401')

      // 4. Timestamp expirado (> 5 minutos) -> 401
      const expiredTime = Date.now() - 600_000
      const expiredSig = signWebhookPayload(expiredTime, rawPayload, WEBHOOK_SECRET_ALPHA, 'org_alpha')
      const expiredRes = await fetch(`${baseUrl}/api/audiences/webhook-lead`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Org-Id': 'org_alpha',
          'X-Timestamp': String(expiredTime),
          'X-Signature-Sha256': expiredSig,
        },
        body: rawPayload,
      })
      assert.strictEqual(expiredRes.status, 401, 'Timestamp expirado debe ser 401')

      // 5. Organización desconocida en X-Org-Id -> 401
      const unknownOrgRes = await fetch(`${baseUrl}/api/audiences/webhook-lead`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Org-Id': 'org_fantasma_desconocida',
          'X-Timestamp': String(Date.now()),
          'X-Signature-Sha256': 'firma',
        },
        body: rawPayload,
      })
      assert.strictEqual(unknownOrgRes.status, 401, 'Organización desconocida debe ser 401')
    } finally {
      server.close()
    }
  })
})
