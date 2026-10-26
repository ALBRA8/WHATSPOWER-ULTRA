import { test } from 'node:test'
import assert from 'node:assert'
import { createBroadcastDatabase } from '../src/db.ts'
import { BroadcastEngine } from '../src/queue/broadcast-worker.ts'
import { renderSpintax } from '../src/engine/spintax.ts'
import { parseAudienceCsv } from '../src/audiences/csv-importer.ts'
import { createBroadcastServer } from '../src/server.ts'

class MockDispatcher {
  dispatched: Array<{ to: string; text: string }> = []
  async dispatch(phone: string, text: string) {
    this.dispatched.push({ to: phone, text })
    return { success: true, status: 'SENT', messageId: `msg_${Math.random()}` }
  }
}

class MockLockChecker {
  busyPhones = new Set<string>()
  async checkLock(phone: string) {
    if (this.busyPhones.has(phone)) {
      return { available: false, state: 'IN_FLOW_2A' }
    }
    return { available: true }
  }
}

test('SUITE EXHAUSTIVA: WhatsPower-Ultra como Clon 100% WhatsOn & WATI', async (t) => {
  const db = createBroadcastDatabase(':memory:')
  const dispatcher = new MockDispatcher()
  const lockChecker = new MockLockChecker()
  const engine = new BroadcastEngine({ db, dispatcher: dispatcher as any, lockChecker })

  // -------------------------------------------------------------
  // WO-01: CSV Importer & Deduplicación
  // -------------------------------------------------------------
  await t.test('WO-01: Ingesta, normalización +57 y deduplicación de CSV', () => {
    const csv = `phone,name
3017543786,Johan Bravo
573017543786,Johan Duplicado
3001234567,Carlos Perez
invalido123,Descartado`

    const res = parseAudienceCsv(csv)
    assert.strictEqual(res.totalProcessed, 4)
    assert.strictEqual(res.validCount, 2)
    assert.strictEqual(res.duplicatesCount, 1)
    assert.strictEqual(res.invalidCount, 1)
    assert.strictEqual(res.contacts[0].phone, '573017543786')
    assert.strictEqual(res.contacts[1].phone, '573001234567')
  })

  // -------------------------------------------------------------
  // WO-02: Generador Spintax Recursivo
  // -------------------------------------------------------------
  await t.test('WO-02: Generación Spintax recursivo y variables dinámicas', () => {
    const template = '{¡Hola|Buen día} {{nombre}}! {Oferta {VIP|Especial}|Novedad}'
    const rendered = renderSpintax(template, {
      variables: { nombre: 'Andrés' },
      seed: 'semilla_fija_123',
    })

    assert.ok(rendered.includes('Andrés'))
    assert.ok(rendered.startsWith('¡Hola') || rendered.startsWith('Buen día'))
    assert.ok(rendered.includes('Oferta') || rendered.includes('Novedad'))
  })

  // -------------------------------------------------------------
  // WO-03: Creación de Campaña y Pre-filtrado JIT
  // -------------------------------------------------------------
  await t.test('WO-03: Creación de campaña excluye locks activos en WhatsPower Nivel 2', async () => {
    lockChecker.busyPhones.add('573017543786') // Ocupado hablando con vendedor

    const csv = `phone,name
573017543786,Ocupado en 2A
573001234567,Disponible`

    const campaign = await engine.createCampaign({
      organizationId: 'org_test',
      name: 'Campaña con Lock',
      templateSpintax: 'Hola {{nombre}}',
      csvContent: csv,
    })

    assert.strictEqual(campaign.totalTargets, 2)
    assert.strictEqual(campaign.skippedCount, 1)

    const items = engine.getItems(campaign.id)
    assert.strictEqual(items.length, 2)
    const itemLocked = items.find((i) => i.contactPhone === '573017543786')
    assert.strictEqual(itemLocked?.status, 'LOCK_EXCLUDED')

    const itemPending = items.find((i) => i.contactPhone === '573001234567')
    assert.strictEqual(itemPending?.status, 'PENDING')
  })

  // -------------------------------------------------------------
  // WO-04: Despacho paso a paso de Campaña
  // -------------------------------------------------------------
  await t.test('WO-04: Despacho secuencial del ítem PENDING', async () => {
    const campaign = engine.db.prepare("SELECT id FROM campaigns WHERE name = 'Campaña con Lock'").get() as any
    const step = await engine.processNextItem(campaign.id, new Date('2026-10-26T14:00:00')) // Horario comercial

    assert.strictEqual(step.processed, true)
    assert.strictEqual(step.status, 'SENT')
    assert.strictEqual(dispatcher.dispatched.length, 1)
    assert.strictEqual(dispatcher.dispatched[0].to, '573001234567')
  })

  // -------------------------------------------------------------
  // WO-05: Enlaces Rastreados y Redirección
  // -------------------------------------------------------------
  await t.test('WO-05: Enlace rastreado suma clics y redirige', () => {
    db.prepare(`
      INSERT INTO tracked_links (code, target_url, clicks, created_at)
      VALUES (?, ?, 0, ?)
    `).run('wpu_promo', 'https://albra.co/oferta', Date.now())

    db.prepare('UPDATE tracked_links SET clicks = clicks + 1 WHERE code = ?').run('wpu_promo')
    const row = db.prepare('SELECT clicks, target_url FROM tracked_links WHERE code = ?').get('wpu_promo') as any

    assert.strictEqual(row.clicks, 1)
    assert.strictEqual(row.target_url, 'https://albra.co/oferta')
  })

  // -------------------------------------------------------------
  // WO-06: Servidor Web Campaign Studio
  // -------------------------------------------------------------
  await t.test('WO-06: Servidor HTTP sirve Campaign Studio y endpoints de monitor', async () => {
    const { server } = createBroadcastServer({ dbPath: ':memory:', dispatcher, lockChecker })
    await new Promise<void>((resolve) => server.listen(3019, () => resolve()))

    try {
      // 1. GET /
      const resStudio = await fetch('http://localhost:3019/')
      assert.strictEqual(resStudio.status, 200)
      const html = await resStudio.text()
      assert.ok(html.includes('WhatsPower-Ultra Campaign Studio'))
      assert.ok(html.includes('Escudo Anti-Ban'))

      // 2. POST /api/spintax/preview
      const resSpintax = await fetch('http://localhost:3019/api/spintax/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: '{Hola|Saludos} {{nombre}}', name: 'Laura' }),
      })
      assert.strictEqual(resSpintax.status, 200)
      const dataSpintax = await resSpintax.json()
      assert.ok(dataSpintax.rendered.includes('Laura'))

      // 3. POST /api/audiences/preview-csv
      const resCsv = await fetch('http://localhost:3019/api/audiences/preview-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csvContent: 'phone,name\n3001234567,Test' }),
      })
      assert.strictEqual(resCsv.status, 200)
      const dataCsv = await resCsv.json()
      assert.strictEqual(dataCsv.validCount, 1)
      assert.strictEqual(dataCsv.contacts[0].phone, '573001234567')
    } finally {
      server.close()
    }
  })
})
