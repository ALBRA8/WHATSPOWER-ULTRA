import { test } from 'node:test'
import assert from 'node:assert'
import { createBroadcastServer } from '../src/server.ts'

/**
 * (panel único, 2026-11-16) Solo hay UN panel: se sirve en `/` (y `/campaigns`).
 * Las direcciones antiguas del segundo panel (`/app/`, `/panel`) se conservan
 * como enlaces que REDIRIGEN al panel, nunca como una segunda aplicación.
 * `/sitio/*` es la referencia visual del sitio público y `/studio` el estudio
 * antiguo, que sigue vivo por compatibilidad.
 */
test('RUTAS WEB: un solo panel (/) + sitio público (/sitio/)', async (t) => {
  const { server } = createBroadcastServer({ dbPath: ':memory:' })
  const PORT = 3028
  await new Promise<void>((resolve) => server.listen(PORT, () => resolve()))

  try {
    await t.test('WEB-01: direcciones antiguas del panel redirigen al panel único', async () => {
      for (const ruta of ['/app', '/app/', '/app/app.css', '/panel']) {
        const r = await fetch(`http://localhost:${PORT}${ruta}`, { redirect: 'manual' })
        assert.strictEqual(r.status, 302, `${ruta} debe redirigir`)
        assert.strictEqual(r.headers.get('location'), '/', `${ruta} debe llevar al panel`)
      }

      const rSitio = await fetch(`http://localhost:${PORT}/sitio`, { redirect: 'manual' })
      assert.strictEqual(rSitio.status, 302)
      assert.strictEqual(rSitio.headers.get('location'), '/sitio/')

      const rInicio = await fetch(`http://localhost:${PORT}/inicio`, { redirect: 'manual' })
      assert.strictEqual(rInicio.status, 302)
      assert.strictEqual(rInicio.headers.get('location'), '/sitio/')
    })

    await t.test('WEB-02: el panel único se sirve en / y en /campaigns', async () => {
      for (const ruta of ['/', '/campaigns']) {
        const res = await fetch(`http://localhost:${PORT}${ruta}`)
        assert.strictEqual(res.status, 200, `${ruta} debe responder 200`)
        assert.ok(res.headers.get('content-type')?.includes('text/html'), `${ruta} debe ser HTML`)
        const html = await res.text()
        // Marcas del panel de paridad (src/studio/dashboard-html.ts), no del estudio antiguo.
        assert.ok(html.includes('navRoot'), `${ruta} debe ser el panel (navRoot)`)
        assert.ok(!html.includes('Campaign Studio'), `${ruta} no debe ser el estudio antiguo`)
      }

      const resLogin = await fetch(`http://localhost:${PORT}/login`)
      assert.strictEqual(resLogin.status, 200)
      assert.ok(resLogin.headers.get('content-type')?.includes('text/html'))
    })

    await t.test('WEB-03: sitio público (/sitio/) y favicon.ico', async () => {
      const res = await fetch(`http://localhost:${PORT}/sitio/`)
      assert.strictEqual(res.status, 200)
      assert.ok(res.headers.get('content-type')?.includes('text/html'))

      const resFavicon = await fetch(`http://localhost:${PORT}/favicon.ico`)
      assert.strictEqual(resFavicon.status, 200)
      assert.strictEqual(resFavicon.headers.get('content-type'), 'image/x-icon')
    })

    await t.test('WEB-04: nada del sistema se sirve por traversal', async () => {
      const resSitio = await fetch(`http://localhost:${PORT}/sitio/..%2F..%2Fpackage.json`)
      assert.strictEqual(resSitio.status, 404)
      const cuerpo = await resSitio.text()
      assert.ok(!cuerpo.includes('"whatspower-ultra"'), 'no debe filtrar package.json')

      // Bajo /app/… todo redirige al panel: nunca se lee un fichero del disco.
      const resApp = await fetch(`http://localhost:${PORT}/app/..%2F..%2Fpackage.json`, { redirect: 'manual' })
      assert.strictEqual(resApp.status, 302)
      assert.strictEqual(resApp.headers.get('location'), '/')
    })

    await t.test('WEB-05: el estudio antiguo (/studio) enlaza al panel único', async () => {
      const resStudio = await fetch(`http://localhost:${PORT}/studio`)
      assert.strictEqual(resStudio.status, 200)
      const html = await resStudio.text()
      assert.ok(html.includes('href="/"'), 'el enlace al panel debe apuntar a /')
      assert.ok(html.includes('▦ Panel'))
    })
  } finally {
    server.close()
  }
})
