/**
 * CUARTA REPARACIÓN — B3 (Capa 2B): identidad de organización extremo a extremo.
 *
 * Problema reproducido: ULTRA enviaba el secreto GLOBAL (INTERNAL_API_SECRET)
 * como Bearer a Capa 2A y despachaba al daemon SIN nombrar su organización:
 * el secreto compartido sustituía la validación de organización y el daemon
 * no podía saber de qué org era cada envío.
 *
 * Contrato nuevo verificado (clientes reales + servidores stub que REGISTRAN
 * lo recibido):
 *  U-B3-01  Http2ALockChecker sin credencial de la org → contractError
 *           TENANT_CREDENTIAL_MISSING SIN llamar a la red (fail-closed).
 *  U-B3-02  Con credencial → Bearer = credencial de ESA organización (no el
 *           global) + X-Org-Id; el eco de la respuesta se sigue verificando.
 *  U-B3-03  Http2ASuppressionChecker: mismo contrato (credencial por org).
 *  U-B3-04  HttpCrmDaemonDispatcher sin organización → TENANT_CONTEXT_INVALID
 *           sin red; con organización → body.orgId + header X-Org-Id.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert'
import { createServer } from 'node:http'
import { Http2ALockChecker } from '../src/safety/lock-checker.ts'
import { Http2ASuppressionChecker } from '../src/safety/suppression.ts'
import { HttpCrmDaemonDispatcher } from '../src/adapters/dispatcher.ts'
import { resetOrgCredentialCache } from '../src/org-credentials.ts'

const CRED_A = 'ultra-org-alpha-service-credential-00001'
const CRED_B = 'ultra-org-beta-service-credential-000002'
const GLOBAL = 'ultra_b3_global_secret_min24chars_000' // NUNCA debe viajar como credencial de org

/** Arranca un stub 2A que exige la credencial VINCULADA a la org declarada (contrato B3). */
async function start2AStub(registered: Record<string, string>) {
  const seen: Array<{ path?: string; org?: string; auth?: string }> = []
  const stub = createServer((req, res) => {
    const org = String(req.headers['x-org-id'] || '')
    const auth = String(req.headers.authorization || '')
    seen.push({ path: req.url, org, auth })
    const expected = registered[org]
    if (!org || !expected || auth !== `Bearer ${expected}`) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Forbidden: credencial de servicio no válida para la organización declarada' }))
      return
    }
    const phone = decodeURIComponent((req.url || '').split('/').pop() || '')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (req.url?.includes('/suppression/')) {
      res.end(JSON.stringify({ phone, suppressed: false, organizationId: org }))
    } else {
      res.end(JSON.stringify({ phone, locked: false, lock: null, organizationId: org }))
    }
  })
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()))
  const port = (stub.address() as { port: number }).port
  return { stub, seen, baseUrl: `http://127.0.0.1:${port}` }
}

describe('B3: identidad de organización en la integración 2B → 2A', () => {
  test('U-B3-01: lock-checker sin credencial de la org → fail-closed SIN red', async () => {
    delete process.env.WHATSPOWER_ORG_CREDENTIALS
    resetOrgCredentialCache()
    let requests = 0
    const stub = createServer(() => { requests++ })
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()))
    const port = (stub.address() as { port: number }).port
    try {
      const checker = new Http2ALockChecker({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 500 })
      const res = await checker.checkLock('573001112233', 'org_sin_credencial')
      assert.equal(res.available, false)
      assert.equal(res.contractError, true)
      assert.match(res.error || '', /TENANT_CREDENTIAL_MISSING/)
      assert.equal(requests, 0, 'NO debe salir ninguna petición (el global no sustituye la credencial)')
    } finally {
      stub.close()
    }
  })

  test('U-B3-02: con credencial, el Bearer es el de LA ORGANIZACIÓN y el eco se verifica', async () => {
    process.env.WHATSPOWER_ORG_CREDENTIALS = `org_alpha:${CRED_A},org_beta:${CRED_B}`
    delete process.env.INTERNAL_API_SECRET
    resetOrgCredentialCache()
    const { stub, seen, baseUrl } = await start2AStub({ org_alpha: CRED_A, org_beta: CRED_B })
    try {
      const checker = new Http2ALockChecker({ baseUrl, timeoutMs: 800 })
      const res = await checker.checkLock('573001112233', 'org_alpha')
      assert.equal(res.available, true, 'credencial vinculada → consulta aceptada')
      assert.equal(seen[0]?.org, 'org_alpha')
      assert.equal(seen[0]?.auth, `Bearer ${CRED_A}`, 'el Bearer es la credencial de la org, NO el secreto global')

      // Otra org con SU credencial
      await checker.checkLock('573001112233', 'org_beta')
      assert.equal(seen[1]?.org, 'org_beta')
      assert.equal(seen[1]?.auth, `Bearer ${CRED_B}`)
    } finally {
      stub.close()
      delete process.env.WHATSPOWER_ORG_CREDENTIALS
      resetOrgCredentialCache()
    }
  })

  test('U-B3-03: supresión con credencial por organización; acceso cruzado → 403 → fail-closed', async () => {
    process.env.WHATSPOWER_ORG_CREDENTIALS = `org_alpha:${CRED_A}`
    delete process.env.INTERNAL_API_SECRET
    resetOrgCredentialCache()
    const { stub, baseUrl } = await start2AStub({ org_alpha: CRED_A })
    try {
      const checker = new Http2ASuppressionChecker({ baseUrl, timeoutMs: 800 })
      const suppressed = await checker.isSuppressed('573001112233', 'org_alpha')
      assert.equal(suppressed, false)

      // El stub 2A exige credencial vinculada: ULTRA presentando la credencial de
      // alpha para operar como beta → 403 → el cliente lanza (fail-closed).
      // (Simulación del acceso cruzado: la credencial de A no vale para B.)
      process.env.WHATSPOWER_ORG_CREDENTIALS = `org_beta:${CRED_A}` // credencial de A registrada "para" B: 2A la rechaza
      resetOrgCredentialCache()
      await assert.rejects(
        () => checker.isSuppressed('573001112233', 'org_beta'),
        /TENANT_CONTEXT_REJECTED_403/,
        'la credencial no vinculada a la org → 403 de 2A → error de contrato'
      )
    } finally {
      stub.close()
      delete process.env.WHATSPOWER_ORG_CREDENTIALS
      resetOrgCredentialCache()
    }
  })

  test('U-B3-04: el despacho nombra su organización (body.orgId + X-Org-Id) o no sale', async () => {
    delete process.env.ALLOW_REAL_DISPATCH
    let fetchCalled = 0
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => { fetchCalled++; throw new Error('no debe llamarse') }) as typeof fetch
    try {
      const d = new HttpCrmDaemonDispatcher({ endpointUrl: 'http://daemon.test/send', secret: 'daemon_secret_test', allowRealDispatch: true })
      const r = await d.dispatch('573001112233', 'hola')
      assert.equal(r.success, false)
      assert.match(r.error || '', /TENANT_CONTEXT_INVALID/)
      assert.equal(fetchCalled, 0, 'sin organización no hay despacho ni red')
    } finally {
      globalThis.fetch = origFetch
    }

    // Con organización: body.orgId + X-Org-Id viajan al daemon
    let captured: { headers: Record<string, string>; body: Record<string, unknown> } | null = null
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      }
      return new Response(JSON.stringify({ success: true, messageId: 'wa_1' }), { status: 200 })
    }) as typeof fetch
    process.env.ALLOW_REAL_DISPATCH = 'true'
    try {
      const d2 = new HttpCrmDaemonDispatcher({ endpointUrl: 'http://daemon.test/send', secret: 'daemon_secret_test', allowRealDispatch: true })
      const r2 = await d2.dispatch('573001112233', 'hola', 'org_alpha')
      assert.equal(r2.success, true)
      assert.ok(captured)
      const c = captured as unknown as { headers: Record<string, string>; body: Record<string, unknown> }
      assert.equal(c.body.orgId, 'org_alpha', 'el despacho NOMBRA su organización')
      assert.equal(c.headers['X-Org-Id'], 'org_alpha')
    } finally {
      globalThis.fetch = origFetch
      delete process.env.ALLOW_REAL_DISPATCH
    }
  })
})
