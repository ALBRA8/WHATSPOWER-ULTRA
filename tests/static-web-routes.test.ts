import { test } from 'node:test'
import assert from 'node:assert'
import { createBroadcastServer } from '../src/server.ts'

test('RUTAS ESTÁTICAS: Panel de control (/app/) y Sitio público (/sitio/)', async (t) => {
  const { server } = createBroadcastServer({ dbPath: ':memory:' })
  const PORT = 3028
  await new Promise<void>((resolve) => server.listen(PORT, () => resolve()))

  try {
    await t.test('WEB-01: Redirecciones amigables (/app -> /app/, /sitio -> /sitio/, /panel, /inicio)', async () => {
      const rApp = await fetch(`http://localhost:${PORT}/app`, { redirect: 'manual' })
      assert.strictEqual(rApp.status, 302)
      assert.strictEqual(rApp.headers.get('location'), '/app/')

      const rSitio = await fetch(`http://localhost:${PORT}/sitio`, { redirect: 'manual' })
      assert.strictEqual(rSitio.status, 302)
      assert.strictEqual(rSitio.headers.get('location'), '/sitio/')

      const rPanel = await fetch(`http://localhost:${PORT}/panel`, { redirect: 'manual' })
      assert.strictEqual(rPanel.status, 302)
      assert.strictEqual(rPanel.headers.get('location'), '/app/')

      const rInicio = await fetch(`http://localhost:${PORT}/inicio`, { redirect: 'manual' })
      assert.strictEqual(rInicio.status, 302)
      assert.strictEqual(rInicio.headers.get('location'), '/sitio/')
    })

    await t.test('WEB-02: Servir panel (/app/) y recursos asociados sin autenticación', async () => {
      const res = await fetch(`http://localhost:${PORT}/app/`)
      assert.strictEqual(res.status, 200)
      assert.ok(res.headers.get('content-type')?.includes('text/html'))
      const html = await res.text()
      assert.ok(html.includes('WhatsPower-Ultra') || html.includes('Panel de Control') || html.includes('app.css'))

      const resCss = await fetch(`http://localhost:${PORT}/app/app.css`)
      assert.strictEqual(resCss.status, 200)
      assert.ok(resCss.headers.get('content-type')?.includes('text/css'))
    })

    await t.test('WEB-03: Servir sitio público (/sitio/) y favicon.ico', async () => {
      const res = await fetch(`http://localhost:${PORT}/sitio/`)
      assert.strictEqual(res.status, 200)
      assert.ok(res.headers.get('content-type')?.includes('text/html'))

      const resFavicon = await fetch(`http://localhost:${PORT}/favicon.ico`)
      assert.strictEqual(resFavicon.status, 200)
      assert.strictEqual(resFavicon.headers.get('content-type'), 'image/x-icon')
    })

    await t.test('WEB-04: Prevención de directory traversal hacia ficheros del sistema', async () => {
      const resBad = await fetch(`http://localhost:${PORT}/app/..%2F..%2Fpackage.json`)
      assert.strictEqual(resBad.status, 404)
    })

    await t.test('WEB-05: Campaign Studio (/studio) incluye pestaña de navegación hacia el Panel', async () => {
      const resStudio = await fetch(`http://localhost:${PORT}/studio`)
      assert.strictEqual(resStudio.status, 200)
      const html = await resStudio.text()
      assert.ok(html.includes('href="/app/"'))
      assert.ok(html.includes('▦ Panel'))
    })
  } finally {
    server.close()
  }
})
