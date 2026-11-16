import { test } from 'node:test'
import assert from 'node:assert'
import { createBroadcastServer } from '../src/server.ts'

/**
 * (panel único, 2026-11-16) Solo hay UN panel: se sirve en `/` (y `/campaigns`).
 * Las direcciones antiguas del panel (`/app/`, `/panel`) y las páginas de venta
 * (`/sitio`, `/sitio/`, `/inicio`) redirigen directamente al panel en `/`.
 * No se exponen páginas de venta: solo el dashboard de control.
 */
test('RUTAS WEB: un solo panel (/) - páginas de venta retiradas', async (t) => {
  const { server } = createBroadcastServer({ dbPath: ':memory:' })
  const PORT = 3028
  await new Promise<void>((resolve) => server.listen(PORT, () => resolve()))

  try {
    await t.test('WEB-01: direcciones antiguas del panel y del sitio redirigen al panel único', async () => {
      for (const ruta of ['/app', '/app/', '/app/app.css', '/panel', '/sitio', '/sitio/', '/inicio', '/sitio/planes.html', '/sitio/faq.html']) {
        const r = await fetch(`http://localhost:${PORT}${ruta}`, { redirect: 'manual' })
        assert.strictEqual(r.status, 302, `${ruta} debe redirigir`)
        assert.strictEqual(r.headers.get('location'), '/', `${ruta} debe llevar al panel`)
      }
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

    await t.test('WEB-03: favicon.ico se sirve correctamente', async () => {
      const resFavicon = await fetch(`http://localhost:${PORT}/favicon.ico`)
      assert.strictEqual(resFavicon.status, 200)
      assert.strictEqual(resFavicon.headers.get('content-type'), 'image/x-icon')
    })

    await t.test('WEB-04: nada del sistema se sirve por traversal', async () => {
      // Intentos bajo /sitio/ y /app/ redirigen al panel (302) o dan 404: nunca leen del disco
      const resSitio = await fetch(`http://localhost:${PORT}/sitio/..%2F..%2Fpackage.json`, { redirect: 'manual' })
      assert.ok([302, 404].includes(resSitio.status))
      if (resSitio.status === 302) {
        assert.strictEqual(resSitio.headers.get('location'), '/')
      } else {
        const cuerpo = await resSitio.text()
        assert.ok(!cuerpo.includes('"whatspower-ultra"'), 'no debe filtrar package.json')
      }

      const resApp = await fetch(`http://localhost:${PORT}/app/..%2F..%2Fpackage.json`, { redirect: 'manual' })
      assert.strictEqual(resApp.status, 302)
      assert.strictEqual(resApp.headers.get('location'), '/')
    })

    await t.test('WEB-05: el estudio antiguo (/studio) enlaza al panel único', async () => {
      const resStudio = await fetch(`http://localhost:${PORT}/studio`)
      assert.strictEqual(resStudio.status, 200)
      const html = await resStudio.text()
      assert.ok(html.includes('href="/"'), 'el enlace al panel debe apuntar a /')
      assert.ok(html.includes('Panel'))
    })
  } finally {
    server.close()
  }
})
