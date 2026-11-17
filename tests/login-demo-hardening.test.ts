/**
 * login-demo-hardening.test.ts — (reparación 2026-11-17) FASE 1.B
 *
 * Endurecimiento del login demo (/studio/login-demo) y del rate limiter de login:
 *  1. Con NODE_ENV=production el endpoint responde 403 SIEMPRE, aunque
 *     DEMO_MODE=true hubiese quedado activo en el entorno.
 *  2. productionConfigProblems RECHAZA DEMO_MODE=true en producción (fail-closed
 *     al arrancar servidor y worker).
 *  3. El rate limiter de login ACUMULA intentos dentro de la ventana: el éxito
 *     NO borra el contador (cierra el bypass de fuerza bruta con aciertos
 *     intercalados) → la petición 11 dentro de 60 s recibe 429 aunque las
 *     anteriores fueran exitosas.
 *  4. La IP del throttle es la del SOCKET salvo TRUST_PROXY=true|1: un
 *     x-forwarded-for crudo (controlado por el cliente) jamás decide el bucket.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { createBroadcastServer } from '../src/server.ts'
import { productionConfigProblems, resolveClientIp, trustProxyEnabled } from '../src/security.ts'

function post(port: number, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number | undefined; headers: any; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

test('FASE 1.B — endurecimiento de login-demo y rate limiter', async (t) => {
  await t.test('1.B.1 productionConfigProblems rechaza DEMO_MODE=true en producción', () => {
    const problems = productionConfigProblems({ NODE_ENV: 'production', DEMO_MODE: 'true' } as NodeJS.ProcessEnv)
    assert.ok(problems.some((p) => p.includes('DEMO_MODE')), 'DEMO_MODE activo en producción debe ser un problema fatal')
    // en desarrollo NO es problema
    const devProblems = productionConfigProblems({ NODE_ENV: 'development', DEMO_MODE: 'true' } as NodeJS.ProcessEnv)
    assert.ok(!devProblems.some((p) => p.includes('DEMO_MODE')), 'en desarrollo DEMO_MODE=true es legítimo')
  })

  await t.test('1.B.2 /studio/login-demo responde 403 en producción aunque DEMO_MODE=true', async () => {
    const prevEnv = process.env.NODE_ENV
    const prevDemo = process.env.DEMO_MODE
    process.env.NODE_ENV = 'production'
    process.env.DEMO_MODE = 'true'
    try {
      const { server } = createBroadcastServer({ dbPath: ':memory:', whatsPowerEnabled: false })
      await new Promise<void>((resolve) => server.listen(0, resolve))
      const port = (server.address() as any).port
      try {
        const res = await post(port, '/studio/login-demo')
        assert.equal(res.status, 403, 'producción bloquea el login demo SIEMPRE')
        assert.ok(!res.headers['set-cookie'], 'no se emite sesión en producción')
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    } finally {
      if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv
      if (prevDemo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = prevDemo
    }
  })

  await t.test('1.B.3 rate limiter ACUMULA: 11ª petición en la ventana → 429 (el éxito no borra)', async () => {
    process.env.ADMIN_API_KEYS = 'ultra_demo_admin_key_min32chars_01:org_demo'
    delete process.env.DEMO_MODE
    process.env.DEMO_MODE = 'true'
    const prevEnv = process.env.NODE_ENV
    delete process.env.NODE_ENV // no producción para que el demo opere
    try {
      const { server } = createBroadcastServer({ dbPath: ':memory:', whatsPowerEnabled: false })
      await new Promise<void>((resolve) => server.listen(0, resolve))
      const port = (server.address() as any).port
      try {
        const statuses: (number | undefined)[] = []
        for (let i = 0; i < 11; i++) {
          const res = await post(port, '/studio/login-demo')
          statuses.push(res.status)
        }
        assert.ok(statuses.slice(0, 10).every((s) => s === 200), `las 10 primeras conceden sesión demo (${statuses.slice(0, 10)})`)
        assert.equal(statuses[10], 429, 'la 11ª petición dentro de la ventana recibe 429 (los éxitos NO limpian el contador)')
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    } finally {
      if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv
    }
  })

  await t.test('1.B.4 IP del SOCKET salvo TRUST_PROXY (x-forwarded-for crudo jamás decide)', () => {
    const fakeReq = {
      socket: { remoteAddress: '9.9.9.9' },
      headers: { 'x-forwarded-for': '6.6.6.6, 10.0.0.1' },
    }
    // Sin TRUST_PROXY: la IP es la del socket (header ignorado)
    assert.equal(resolveClientIp(fakeReq as any, false), '9.9.9.9')
    assert.equal(trustProxyEnabled({ TRUST_PROXY: undefined } as any), false)
    // Con TRUST_PROXY=true: primera entrada del header
    assert.equal(resolveClientIp(fakeReq as any, true), '6.6.6.6')
    assert.equal(trustProxyEnabled({ TRUST_PROXY: 'true' } as any), true)
    assert.equal(trustProxyEnabled({ TRUST_PROXY: '1' } as any), true)
    // Sin socket → 'local' (no rompe el throttle)
    assert.equal(resolveClientIp({ headers: {} } as any, false), 'local')
  })

  await t.test('1.B.5 dos clientes con x-forwarded-for DISTINTO comparten bucket sin TRUST_PROXY (anti suplantación)', async () => {
    process.env.ADMIN_API_KEYS = 'ultra_demo_admin_key_min32chars_01:org_demo'
    process.env.DEMO_MODE = 'true'
    delete process.env.TRUST_PROXY
    const prevEnv = process.env.NODE_ENV
    delete process.env.NODE_ENV
    try {
      const { server } = createBroadcastServer({ dbPath: ':memory:', whatsPowerEnabled: false })
      await new Promise<void>((resolve) => server.listen(0, resolve))
      const port = (server.address() as any).port
      try {
        // 10 peticiones desde "IPs falsificadas" distintas
        for (let i = 0; i < 10; i++) {
          const res = await post(port, '/studio/login-demo', { 'x-forwarded-for': `10.1.${i}.7` })
          assert.equal(res.status, 200, `petición ${i + 1} OK (la IP falsificada no crea buckets propios)`)
        }
        // la 11ª (otra IP falsificada más) recibe 429: el bucket ES el del socket
        const res11 = await post(port, '/studio/login-demo', { 'x-forwarded-for': '10.1.99.7' })
        assert.equal(res11.status, 429, 'el atacante no evade el throttle rotando x-forwarded-for')
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    } finally {
      if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv
    }
  })
})
