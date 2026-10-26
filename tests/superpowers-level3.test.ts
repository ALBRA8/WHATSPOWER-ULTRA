import { describe, it } from 'node:test'
import assert from 'node:assert'
import { createBroadcastServer } from '../src/server.ts'
import { MetaCloudDispatcher } from '../src/adapters/meta-cloud-dispatcher.ts'

describe('SUITE SUPERPODERES NIVEL 3: WHATSPOWER-ULTRA (WhatsOn + WATI + SleekFlow)', () => {
  it('SP3-01: Ingesta de Leads en Tiempo Real (Facebook/TikTok Ads Webhook)', async () => {
    const { leadIngester, db, engine } = createBroadcastServer({
      dbPath: ':memory:',
      whatsPowerEnabled: false,
    })

    // Crear campaña activa
    const campaign = await engine.createCampaign({
      organizationId: 'org_test',
      name: 'Campaña Captura FB Ads',
      templateSpintax: 'Hola {{nombre}}, recibimos tu solicitud',
      csvContent: 'phone,name\n573001112233,Inicial',
    })

    // 1. Ingesta de lead exitosa con normalización (+57) y vinculación a campaña
    const resValid = leadIngester.ingestLead({
      phone: '3019876543', // 10 dígitos -> 573019876543
      name: 'Juan Lead Facebook',
      source: 'facebook_ads',
      campaignId: campaign.id,
      variables: { origen: 'Campaña Black Friday' },
    })

    assert.strictEqual(resValid.success, true)
    assert.strictEqual(resValid.canonicalPhone, '573019876543')

    // Confirmar que se agregó automáticamente a campaign_items
    const items = engine.getItems(campaign.id)
    assert.strictEqual(items.length, 2)
    const dynamicItem = items.find((i) => i.contactPhone === '573019876543')
    assert.ok(dynamicItem)
    assert.strictEqual(dynamicItem?.status, 'PENDING')
    assert.strictEqual(dynamicItem?.contactName, 'Juan Lead Facebook')

    // 2. Lead con número suprimido es rechazado de inmediato
    db.prepare('INSERT INTO suppression_list (phone, reason, created_at) VALUES (?, ?, ?)').run(
      '573009990000',
      'opt_out',
      Math.floor(Date.now() / 1000)
    )

    const resSuppressed = leadIngester.ingestLead({
      phone: '573009990000',
      name: 'Usuario Dado de Baja',
      source: 'typeform',
    })

    assert.strictEqual(resSuppressed.success, false)
    assert.strictEqual(resSuppressed.reason, 'PHONE_SUPPRESSED')

    // 3. Lead con formato inválido
    const resInvalid = leadIngester.ingestLead({
      phone: '12345',
      source: 'custom_webhook',
    })

    assert.strictEqual(resInvalid.success, false)
    assert.strictEqual(resInvalid.reason, 'INVALID_PHONE_FORMAT')
  })

  it('SP3-02: Enlaces Rastreados registran clics individuales para atribución', () => {
    const { db } = createBroadcastServer({ dbPath: ':memory:', whatsPowerEnabled: false })

    // Registrar enlace rastreado
    db.prepare(`
      INSERT INTO tracked_links (code, campaign_id, target_url, clicks, created_at)
      VALUES (?, ?, ?, 0, ?)
    `).run('promo-vip', 'cmp_100', 'https://albra.co/oferta-vip', Math.floor(Date.now() / 1000))

    // Simular 2 clics con números de contacto para atribución
    db.prepare(`
      INSERT INTO tracked_link_clicks (id, code, contact_phone, user_agent, ip, clicked_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('clk_1', 'promo-vip', '573001112233', 'Mozilla/5.0', '190.25.10.1', Math.floor(Date.now() / 1000))

    db.prepare(`
      INSERT INTO tracked_link_clicks (id, code, contact_phone, user_agent, ip, clicked_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('clk_2', 'promo-vip', '573009998877', 'Mozilla/5.0', '190.25.10.2', Math.floor(Date.now() / 1000))

    db.prepare('UPDATE tracked_links SET clicks = 2 WHERE code = ?').run('promo-vip')

    const clicks = db.prepare('SELECT * FROM tracked_link_clicks WHERE code = ?').all('promo-vip') as any[]
    assert.strictEqual(clicks.length, 2)
    assert.strictEqual(clicks[0].contact_phone, '573001112233')
    assert.strictEqual(clicks[1].contact_phone, '573009998877')
  })

  it('SP3-03: Dual-Engine: MetaCloudDispatcher despacha oficialmente vía Cloud API', async () => {
    const metaDispatcher = new MetaCloudDispatcher({ mockMode: true })

    const result = await metaDispatcher.dispatch('573001234567', '¡Hola! Este mensaje viaja por Meta Cloud API Oficial')

    assert.strictEqual(result.success, true)
    assert.ok(result.messageId?.startsWith('wamid.HBgL'))
    assert.strictEqual(metaDispatcher.dispatchedMessages.length, 1)
    assert.strictEqual(metaDispatcher.dispatchedMessages[0].to, '573001234567')
    assert.strictEqual(metaDispatcher.dispatchedMessages[0].text, '¡Hola! Este mensaje viaja por Meta Cloud API Oficial')
  })
})
