/**
 * ecosystem-login.test.ts — Acceso directo al ecosistema (2026-11-17)
 *
 * El CRM (capa 1) emite enlaces de UN SOLO USO firmados con HMAC-SHA256
 * (ECOSYSTEM_SSO_SECRET compartido) a sesiones autenticadas; al abrirlos aquí
 * se concede la MISMA sesión de operador (/studio/login-ecosystem → 302 al
 * dashboard '/').
 *
 * Contrato verificado en este servidor (capa 2B):
 *  1. Fail-closed: sin ECOSYSTEM_SSO_SECRET la ruta NO existe (404).
 *  2. Token válido → 302 a '/' con Set-Cookie de sesión del Studio.
 *  3. UN SOLO USO (jti): el segundo canje → 403.
 *  4. Token expirado, manipulado o firmado con otro secreto → 403.
 *  5. Es SSO consciente del dueño (funciona en producción SOLO con el secreto
 *     configurado); el login-demo ANÓNIMO sigue 403 en producción (intacto).
 */
import test from 'node:test'
import assert from 'node:assert'
import { request } from 'node:http'
import type { Server } from 'node:http'
import { createBroadcastServer } from '../src/server.ts'
import { signEcosystemToken } from '../src/ecosystem-sso.ts'

const SSO_SECRET = 'ecosystem_sso_secret_test_min_32_chars_0001'

interface Resp {
  status: number | undefined
  headers: Record<string, string | string[] | undefined>
  body: string
}

function get(port: number, path: string): Promise<Resp> {
  return req(port, path, 'GET')
}

function req(
  port: number,
  path: string,
  method: 'GET' | 'POST',
  opts: { cookie?: string; body?: string; headers?: Record<string, string> } = {}
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers || {}) }
    if (opts.cookie) headers['Cookie'] = opts.cookie
    if (opts.body) headers['Content-Type'] = 'application/json'
    const r = request(`http://127.0.0.1:${port}${path}`, { method, headers }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    r.on('error', reject)
    if (opts.body) r.write(opts.body)
    r.end()
  })
}

function bootServer(): { server: ReturnType<typeof createBroadcastServer>['server']; restore: () => void } {
  const prevSso = process.env.ECOSYSTEM_SSO_SECRET
  const prevKeys = process.env.ADMIN_API_KEYS
  const prevDemo = process.env.DEMO_MODE
  const prevEnv = process.env.NODE_ENV
  process.env.ADMIN_API_KEYS = 'ultra_demo_admin_key_min32chars_01:org_demo'
  delete process.env.DEMO_MODE
  delete process.env.NODE_ENV // no producción por defecto
  const { server } = createBroadcastServer({ dbPath: ':memory:', whatsPowerEnabled: false })
  return {
    server,
    restore: () => {
      if (prevSso === undefined) delete process.env.ECOSYSTEM_SSO_SECRET; else process.env.ECOSYSTEM_SSO_SECRET = prevSso
      if (prevKeys === undefined) delete process.env.ADMIN_API_KEYS; else process.env.ADMIN_API_KEYS = prevKeys
      if (prevDemo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = prevDemo
      if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv
    },
  }
}

async function listenEphemeral(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve))
  return (server.address() as { port: number }).port
}

test('ECOSISTEMA — /studio/login-ecosystem (canje SSO de un solo uso)', async (t) => {
  await t.test('1. Fail-closed: sin ECOSYSTEM_SSO_SECRET la ruta NO existe (404)', async () => {
    const { server, restore } = bootServer()
    delete process.env.ECOSYSTEM_SSO_SECRET
    const port = await listenEphemeral(server)
    try {
      const res = await get(port, '/studio/login-ecosystem?token=lo-que-sea')
      assert.equal(res.status, 404, 'sin secreto configurado el canje NO se ofrece')
      assert.equal(res.headers['set-cookie'], undefined, 'sin secreto jamás se emite sesión')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      restore()
    }
  })

  await t.test('2. Token válido → 302 al dashboard con cookie de sesión del Studio', async () => {
    const { server, restore } = bootServer()
    process.env.ECOSYSTEM_SSO_SECRET = SSO_SECRET
    const port = await listenEphemeral(server)
    try {
      const token = signEcosystemToken(SSO_SECRET)
      const res = await get(port, `/studio/login-ecosystem?token=${encodeURIComponent(token)}`)
      assert.equal(res.status, 302, 'el canje válido redirige al dashboard')
      assert.equal(res.headers['location'], '/')
      const cookie = res.headers['set-cookie']
      assert.ok(cookie, 'se emite la cookie de sesión')
      assert.ok(String(cookie).includes('wp_ultra_studio_session='), 'cookie del Studio de la capa 2B')
      assert.ok(String(cookie).includes('HttpOnly'), 'la cookie es HttpOnly')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      restore()
    }
  })

  await t.test('3. UN SOLO USO: reutilizar el mismo enlace → 403 sin nueva sesión', async () => {
    const { server, restore } = bootServer()
    process.env.ECOSYSTEM_SSO_SECRET = SSO_SECRET
    const port = await listenEphemeral(server)
    try {
      const token = signEcosystemToken(SSO_SECRET)
      const first = await get(port, `/studio/login-ecosystem?token=${encodeURIComponent(token)}`)
      assert.equal(first.status, 302)
      const second = await get(port, `/studio/login-ecosystem?token=${encodeURIComponent(token)}`)
      assert.equal(second.status, 403, 'el jti ya fue canjeado')
      assert.equal(second.headers['set-cookie'], undefined, 'no se emite sesión en el reintento')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      restore()
    }
  })

  await t.test('4. Token expirado → 403', async () => {
    const { server, restore } = bootServer()
    process.env.ECOSYSTEM_SSO_SECRET = SSO_SECRET
    const port = await listenEphemeral(server)
    try {
      const expired = signEcosystemToken(SSO_SECRET, Date.now() - 10 * 60_000)
      const res = await get(port, `/studio/login-ecosystem?token=${encodeURIComponent(expired)}`)
      assert.equal(res.status, 403, 'el TTL de 90 s se respeta')
      assert.equal(res.headers['set-cookie'], undefined)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      restore()
    }
  })

  await t.test('5. Token manipulado (firma alterada) → 403', async () => {
    const { server, restore } = bootServer()
    process.env.ECOSYSTEM_SSO_SECRET = SSO_SECRET
    const port = await listenEphemeral(server)
    try {
      const token = signEcosystemToken(SSO_SECRET)
      const tampered = token.slice(0, -4) + (token.endsWith('AAAA') ? 'BBBB' : 'AAAA')
      const res = await get(port, `/studio/login-ecosystem?token=${encodeURIComponent(tampered)}`)
      assert.equal(res.status, 403, 'la firma HMAC no cuadra')
      assert.equal(res.headers['set-cookie'], undefined)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      restore()
    }
  })

  await t.test('6. Token firmado con OTRO secreto → 403', async () => {
    const { server, restore } = bootServer()
    process.env.ECOSYSTEM_SSO_SECRET = SSO_SECRET
    const port = await listenEphemeral(server)
    try {
      const foreign = signEcosystemToken('otro_secreto_totalmente_distinto_0002')
      const res = await get(port, `/studio/login-ecosystem?token=${encodeURIComponent(foreign)}`)
      assert.equal(res.status, 403, 'solo el secreto compartido del ecosistema valida')
      assert.equal(res.headers['set-cookie'], undefined)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      restore()
    }
  })

  await t.test('7. SSO consciente: en producción SÍ canjea con el secreto configurado (a diferencia del login-demo anónimo)', async () => {
    const { server, restore } = bootServer()
    process.env.ECOSYSTEM_SSO_SECRET = SSO_SECRET
    process.env.NODE_ENV = 'production'
    const port = await listenEphemeral(server)
    try {
      const token = signEcosystemToken(SSO_SECRET)
      const sso = await get(port, `/studio/login-ecosystem?token=${encodeURIComponent(token)}`)
      assert.equal(sso.status, 302, 'el SSO firmado y de un solo uso es el mecanismo consciente del dueño')
      const demo = await get(port, '/studio/login-demo')
      // login-demo anónimo es POST; con GET el fallback responde 404 — lo que
      // importa aquí es que NO emita cookie en NINGÚN caso sin POST válido.
      assert.equal(demo.headers['set-cookie'], undefined, 'el demo anónimo no emite sesión')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      restore()
    }
  })

  await t.test('8. En producción SIN secreto → 404 (fail-closed idéntico)', async () => {
    const { server, restore } = bootServer()
    delete process.env.ECOSYSTEM_SSO_SECRET
    process.env.NODE_ENV = 'production'
    const port = await listenEphemeral(server)
    try {
      const res = await get(port, '/studio/login-ecosystem?token=x')
      assert.equal(res.status, 404)
      assert.equal(res.headers['set-cookie'], undefined)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      restore()
    }
  })

  await t.test('9. CADENA DE ACEPTACIÓN: canje → cookie → GET /api/campaigns responde 200 (no 401)', async () => {
    const { server, restore } = bootServer()
    process.env.ECOSYSTEM_SSO_SECRET = SSO_SECRET
    const port = await listenEphemeral(server)
    try {
      const token = signEcosystemToken(SSO_SECRET)
      const redemption = await get(port, `/studio/login-ecosystem?token=${encodeURIComponent(token)}`)
      assert.equal(redemption.status, 302)
      const cookiePair = String(redemption.headers['set-cookie']).split(';')[0]
      assert.ok(cookiePair.startsWith('wp_ultra_studio_session='), 'cookie de sesión emitida por el canje')
      // Con la cookie del canje, el listado de campañas responde 200 — paso 6
      // del guion de aceptación del dueño (dashboard con datos, sin prompt).
      const campaigns = await req(port, '/api/campaigns', 'GET', { cookie: cookiePair })
      assert.equal(campaigns.status, 200, 'la sesión del canje autoriza /api/campaigns')
      const parsed = JSON.parse(campaigns.body)
      assert.ok(Array.isArray(parsed.campaigns), 'el body es el listado JSON de campañas')
      // Y sin cookie sigue 401: la sesión es la única llave.
      const anon = await get(port, '/api/campaigns')
      assert.equal(anon.status, 401)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      restore()
    }
  })

  await t.test('10. Fallo del canje responde PÁGINA HTML con motivo y “Volver al CRM”', async () => {
    const { server, restore } = bootServer()
    process.env.ECOSYSTEM_SSO_SECRET = SSO_SECRET
    const port = await listenEphemeral(server)
    try {
      // Reutilizado → 403 HTML: motivo “ya fue utilizado” + botón volver.
      const token = signEcosystemToken(SSO_SECRET)
      await get(port, `/studio/login-ecosystem?token=${encodeURIComponent(token)}`)
      const replay = await get(port, `/studio/login-ecosystem?token=${encodeURIComponent(token)}`)
      assert.equal(replay.status, 403)
      assert.ok(String(replay.headers['content-type']).includes('text/html'), 'la respuesta de fallo es HTML, no JSON crudo')
      assert.ok(replay.body.includes('ya fue utilizado'), 'el motivo (enlace ya usado) es visible para el dueño')
      assert.ok(replay.body.includes('Volver al CRM'), 'hay camino de salida hacia el CRM')
      // Caducado → 403 HTML: motivo “caducado”.
      const expired = signEcosystemToken(SSO_SECRET, Date.now() - 10 * 60_000)
      const exp = await get(port, `/studio/login-ecosystem?token=${encodeURIComponent(expired)}`)
      assert.equal(exp.status, 403)
      assert.ok(exp.body.includes('caducado'), 'el motivo (TTL de 90 s) es visible')
      // Sin secreto → 404 HTML: fail-closed explicado (también en producción).
      delete process.env.ECOSYSTEM_SSO_SECRET
      const unconfigured = await get(port, '/studio/login-ecosystem?token=x')
      assert.equal(unconfigured.status, 404)
      assert.ok(String(unconfigured.headers['content-type']).includes('text/html'))
      assert.ok(unconfigured.body.includes('no configurado'), 'el fail-closed se explica, no se oculta')
      assert.equal(unconfigured.headers['set-cookie'], undefined, 'sin secreto jamás se emite sesión')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      restore()
    }
  })
})
