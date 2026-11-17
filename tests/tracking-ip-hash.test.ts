/**
 * tracking-ip-hash.test.ts — (reparación 2026-11-17) FASE 1.F
 *
 * Rastreo de clics (/t/:code) anónimo y seguro:
 *  1. JAMÁS se guarda la IP cruda del cliente: solo sha256(ip:salt) truncado (16 hex).
 *  2. La IP se toma del x-forwarded-for SOLO con TRUST_PROXY=true|1; de lo
 *     contrario se usa la IP del socket (el header es controlado por el cliente).
 *  3. El salt se respeta: IP_HASH_SALT cambia el hash (hash no reversible).
 *  4. La atribución de clics sigue funcionando (302 + contador + fila de evento).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { createHash } from 'node:crypto'
import { createBroadcastServer } from '../src/server.ts'

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number | undefined; location?: string }> {
  return new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, { method: 'GET', headers }, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location as string }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('FASE 1.F — clics rastreados: IP anonimizada y TRUST_PROXY estricto', async (t) => {
  // Aisla el .env del repo: el salt de estas pruebas es controlado aquí.
  const prevSalt = process.env.IP_HASH_SALT
  process.env.IP_HASH_SALT = 'tracking_ip_hash_test_salt'
  const prevTrust = process.env.TRUST_PROXY
  delete process.env.TRUST_PROXY

  t.after(() => {
    if (prevSalt === undefined) delete process.env.IP_HASH_SALT; else process.env.IP_HASH_SALT = prevSalt
    if (prevTrust === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = prevTrust
  })

  const { server, db } = createBroadcastServer({ dbPath: ':memory:', whatsPowerEnabled: false })
  db.prepare(`
    INSERT INTO tracked_links (code, campaign_id, target_url, clicks, created_at)
    VALUES ('trackip01', 'camp_ip_test', 'https://example.com/promo', 0, 1700000000)
  `).run()

  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as any).port

  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))

  await t.test('1.F.1 sin TRUST_PROXY: x-forwarded-for se ignora y la IP NUNCA queda cruda', async () => {
    const res = await get(port, '/t/trackip01', {
      'x-forwarded-for': '198.51.100.77',
      'user-agent': 'TrackingTestBot/1.0',
    })
    assert.equal(res.status, 302)
    assert.equal(res.location, 'https://example.com/promo')

    const click = db.prepare('SELECT * FROM tracked_link_clicks WHERE code = ?').get('trackip01') as any
    assert.ok(click, 'el clic queda registrado')
    assert.equal(click.ip.length, 16, 'la IP almacenada es un hash truncado de 16 hex')
    assert.match(click.ip, /^[0-9a-f]{16}$/)
    assert.notEqual(click.ip, '198.51.100.77', 'jamás la IP del header falsificado')
    assert.ok(!click.ip.includes('.'), 'no es una IP en claro')
  })

  await t.test('1.F.2 el hash corresponde a sha256(ip_socket:salt) truncado', () => {
    const click = db.prepare('SELECT * FROM tracked_link_clicks WHERE code = ?').get('trackip01') as any
    // El socket de localhost puede representarse como 127.0.0.1, ::1 o ::ffff:127.0.0.1
    const locals = ['127.0.0.1', '::1', '::ffff:127.0.0.1']
    const expected = locals.map((ip) => createHash('sha256').update(`${ip}:tracking_ip_hash_test_salt`).digest('hex').slice(0, 16))
    assert.ok(expected.includes(click.ip), `hash determinista de la IP del socket (obtenido ${click.ip})`)
  })

  await t.test('1.F.3 con TRUST_PROXY=true se hashea la PRIMERA IP del x-forwarded-for', async () => {
    process.env.TRUST_PROXY = 'true'
    try {
      const res = await get(port, '/t/trackip01', { 'x-forwarded-for': '203.0.113.50, 10.0.0.1' })
      assert.equal(res.status, 302)
      const clicks = db.prepare('SELECT * FROM tracked_link_clicks WHERE code = ? ORDER BY clicked_at, rowid').all('trackip01') as any[]
      const last = clicks[clicks.length - 1]
      const expected = createHash('sha256').update('203.0.113.50:tracking_ip_hash_test_salt').digest('hex').slice(0, 16)
      assert.equal(last.ip, expected, 'con proxy de confianza, la IP real del cliente se hashea')
      assert.notEqual(last.ip, '203.0.113.50')
    } finally {
      delete process.env.TRUST_PROXY
    }
  })

  await t.test('1.F.4 salt distinto produce hash distinto (sin hash reversible ni global)', () => {
    const h1 = createHash('sha256').update('198.51.100.77:salt_a').digest('hex').slice(0, 16)
    const h2 = createHash('sha256').update('198.51.100.77:salt_b').digest('hex').slice(0, 16)
    assert.notEqual(h1, h2, 'cambiar IP_HASH_SALT anonimiza de nuevo el histórico')
  })

  await t.test('1.F.5 el contador de clicks sigue creciendo (atribución intacta)', () => {
    const row = db.prepare('SELECT clicks FROM tracked_links WHERE code = ?').get('trackip01') as any
    assert.ok(row.clicks >= 2, `contador de clics incrementado (${row.clicks})`)
  })
})
