import test from 'node:test'
import assert from 'node:assert/strict'
import { createBroadcastDatabase } from '../src/db.ts'
import { ConsentStore } from '../src/safety/consent-store.ts'
import { BroadcastEngine } from '../src/queue/broadcast-worker.ts'
import { parseAudienceCsv } from '../src/audiences/csv-importer.ts'
import { LocalSuppressionStore } from '../src/safety/suppression.ts'
import { createBroadcastServer } from '../src/server.ts'
import { request } from 'node:http'
import { createHash } from 'node:crypto'

test('FASE 2 — Consentimiento y Cumplimiento Normativo (ULTRA Nivel 3)', async (t) => {
  await t.test('2.1 CSV Import exige columna de origen de consentimiento', () => {
    // CSV sin columna de consentimiento debe lanzar error de validación
    const csvWithoutConsent = `phone,name\n573001112233,Juan`
    assert.throws(() => {
      parseAudienceCsv(csvWithoutConsent, { requireConsentOrigin: true })
    }, /CSV_CONSENT_REQUIRED/)

    // CSV con columna de consentimiento válida debe procesar correctamente
    const csvWithConsent = `phone,name,consent_origin\n573001112233,Juan,web_formulario_registro`
    const parsed = parseAudienceCsv(csvWithConsent, { requireConsentOrigin: true })
    assert.equal(parsed.contacts.length, 1)
    assert.equal(parsed.contacts[0].consentOrigin, 'web_formulario_registro')
  })

  await t.test('2.2 Ninguna campaña envía sin consentimiento vigente (Ley 1581)', async () => {
    const db = createBroadcastDatabase(':memory:')
    const consentStore = new ConsentStore(db)
    const suppressionStore = new LocalSuppressionStore(db, consentStore)
    const dispatcher = {
      dispatch: async () => ({ status: 'SENT', externalMessageId: 'meta_mock_123' })
    }
    const lockChecker = {
      checkLock: async () => ({ available: true })
    }

    const engine = new BroadcastEngine({
      db,
      dispatcher: dispatcher as any,
      lockChecker: lockChecker as any,
      suppressionStore,
      consentStore,
    })

    // Campaña para org_alpha con un contacto sin consentimiento
    const orgId = 'org_alpha'
    const phoneNoConsent = '573009998877'
    const csv = `phone,name,consent_origin\n${phoneNoConsent},Pedro,tienda_fisica`
    const campaign = await engine.createCampaign({
      organizationId: orgId,
      name: 'Campaña Estricta Consentimiento',
      templateSpintax: 'Hola {amigo|cliente}',
      csvContent: csv,
    })

    // Intentar despachar el ítem sin haber registrado consentimiento activo -> SKIPPED_NO_CONSENT
    // Pasamos hora dentro de horario comercial (ej. 10:00 AM)
    const inBusinessHours = new Date('2026-11-16T15:00:00Z')
    const stepRes = await engine.processNextItem(campaign.id, inBusinessHours)
    assert.equal(stepRes.status, 'SKIPPED_NO_CONSENT')

    // Ahora registrar consentimiento explícito para ese contacto
    consentStore.recordConsent({
      organizationId: orgId,
      contactPhone: phoneNoConsent,
      whoAuthorized: 'Pedro',
      channel: 'WHATSAPP_OPTIN',
      textShown: 'Acepto recibir notificaciones comerciales de org_alpha según política de datos',
      source: 'tienda_fisica',
    })

    // Verificar que hasActiveConsent es true
    assert.equal(consentStore.hasActiveConsent(orgId, phoneNoConsent), true)
  })

  await t.test('2.3 Bajas / Opt-out revocan consentimiento y quedan auditadas', async () => {
    const db = createBroadcastDatabase(':memory:')
    const consentStore = new ConsentStore(db)
    const suppressionStore = new LocalSuppressionStore(db, consentStore)
    const orgId = 'org_beta'
    const phone = '573005554433'

    // Otorgar consentimiento
    consentStore.recordConsent({
      organizationId: orgId,
      contactPhone: phone,
      whoAuthorized: 'Cliente Beta',
      channel: 'WEB_FORM',
      textShown: 'Autorizo tratamiento',
      source: 'web_lp',
    })
    assert.equal(consentStore.hasActiveConsent(orgId, phone), true)

    // Contacto solicita baja (addSuppression)
    await suppressionStore.addSuppression(orgId, phone, 'STOP')

    // El consentimiento debe haber quedado revocado
    assert.equal(consentStore.hasActiveConsent(orgId, phone), false)

    // La auditoría debe registrar REVOKE
    const audit = consentStore.getAuditLog(orgId, phone)
    const revokeEntry = audit.find((a) => a.action === 'REVOKE')
    assert.ok(revokeEntry, 'Debe existir registro de auditoría de revocación')
  })

  await t.test('2.4 Exportación y borrado de datos personales (Habeas Data Ley 1581)', async () => {
    const db = createBroadcastDatabase(':memory:')
    const consentStore = new ConsentStore(db)
    const orgId = 'org_gamma'
    const phone = '573007776655'

    consentStore.recordConsent({
      organizationId: orgId,
      contactPhone: phone,
      whoAuthorized: 'Usuario Gamma',
      channel: 'SMS',
      textShown: 'Acepto términos y política de privacidad',
      source: 'puntos_colombia',
    })

    // Exportación
    const exported = consentStore.exportContactData(orgId, phone)
    assert.equal(exported.contactPhone, phone)
    assert.equal(exported.legalBasis, 'Ley 1581 de 2012 — Habeas Data')
    assert.ok(exported.consentRecord)
    assert.ok(exported.auditTrail.length > 0)

    // Borrado / Supresión
    const delRes = consentStore.deleteContactData(orgId, phone, 'oficial_privacidad')
    assert.equal(delRes.success, true)
    assert.equal(consentStore.hasActiveConsent(orgId, phone), false)
    assert.equal(consentStore.getConsentRecord(orgId, phone), null)
  })

  await t.test('2.5 Rastreo de clics: IP anonimizada con hash y control estricto TRUST_PROXY', async () => {
    const { server, db } = createBroadcastServer({
      dbPath: ':memory:',
      whatsPowerEnabled: false,
    })

    // Insertar un enlace rastreado en la BD activa del servidor
    db.prepare(`
      INSERT INTO tracked_links (code, campaign_id, target_url, clicks, created_at)
      VALUES ('promo123', 'camp_test', 'https://example.com/oferta', 0, 1700000000)
    `).run()

    // Iniciar servidor en puerto libre
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as any).port

    try {
      // 1. Petición SIN TRUST_PROXY: x-forwarded-for debe ser ignorado
      const originalTrust = process.env.TRUST_PROXY
      delete process.env.TRUST_PROXY

      await new Promise<void>((resolve, reject) => {
        const req = request(
          `http://127.0.0.1:${port}/t/promo123`,
          {
            headers: {
              'x-forwarded-for': '198.51.100.99', // IP externa no confiable
              'user-agent': 'TestBot/1.0',
            },
          },
          (res) => {
            assert.equal(res.statusCode, 302)
            assert.equal(res.headers.location, 'https://example.com/oferta')
            resolve()
          }
        )
        req.on('error', reject)
        req.end()
      })

      // Verificar en la BD del servidor cómo se guardó el click
      const click1 = db.prepare('SELECT * FROM tracked_link_clicks WHERE code = ?').get('promo123') as any
      assert.ok(click1, 'Debe registrarse el click')
      assert.equal(click1.ip.length, 16, 'La IP debe ser un hash de 16 caracteres')
      assert.notEqual(click1.ip, '198.51.100.99', 'Nunca debe guardar la IP de x-forwarded-for sin TRUST_PROXY')
      assert.notEqual(click1.ip, '127.0.0.1', 'Nunca debe guardar la IP cruda')

      // 2. Petición CON TRUST_PROXY habilitado
      process.env.TRUST_PROXY = 'true'
      await new Promise<void>((resolve, reject) => {
        const req = request(
          `http://127.0.0.1:${port}/t/promo123`,
          {
            headers: {
              'x-forwarded-for': '203.0.113.50, 10.0.0.1',
              'user-agent': 'TestBot/2.0',
            },
          },
          (res) => {
            assert.equal(res.statusCode, 302)
            resolve()
          }
        )
        req.on('error', reject)
        req.end()
      })

      const clicks = db.prepare('SELECT * FROM tracked_link_clicks WHERE code = ? ORDER BY clicked_at ASC').all('promo123') as any[]
      assert.equal(clicks.length, 2)
      const salt = process.env.IP_HASH_SALT || 'crm_albra_privacy_salt'
      const expectedHash = createHash('sha256').update(`203.0.113.50:${salt}`).digest('hex').slice(0, 16)
      assert.equal(clicks[1].ip, expectedHash, 'Con TRUST_PROXY debe hashear la primera IP del X-Forwarded-For')

      // Restaurar env
      if (originalTrust !== undefined) process.env.TRUST_PROXY = originalTrust
      else delete process.env.TRUST_PROXY
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  await t.test('2.6 Endpoints de Cumplimiento (Exportar, Borrar, Registrar Consentimiento)', async () => {
    process.env.ADMIN_API_KEYS = 'ultra_secret_admin_key_12345:default'
    const { server } = createBroadcastServer({
      dbPath: ':memory:',
      whatsPowerEnabled: false,
    })

    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as any).port

    try {
      // 1. Registrar consentimiento vía API
      const recordRes = await new Promise<any>((resolve, reject) => {
        const req = request(
          `http://127.0.0.1:${port}/api/compliance/consent`,
          {
            method: 'POST',
            headers: {
              authorization: 'Bearer ultra_secret_admin_key_12345',
              'content-type': 'application/json',
            },
          },
          (res) => {
            let data = ''
            res.on('data', (c) => (data += c))
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }))
          }
        )
        req.on('error', reject)
        req.end(
          JSON.stringify({
            contactPhone: '573112223344',
            whoAuthorized: 'Cliente API',
            channel: 'WEB_CHECKOUT',
            textShown: 'Autorizo comunicaciones según Ley 1581',
            source: 'checkout_colombia',
          })
        )
      })
      assert.equal(recordRes.status, 201)
      assert.equal(recordRes.body.ok, true)

      // 2. Exportar datos (Habeas Data)
      const exportRes = await new Promise<any>((resolve, reject) => {
        const req = request(
          `http://127.0.0.1:${port}/api/compliance/contact-data?phone=573112223344`,
          {
            method: 'GET',
            headers: { authorization: 'Bearer ultra_secret_admin_key_12345' },
          },
          (res) => {
            let data = ''
            res.on('data', (c) => (data += c))
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }))
          }
        )
        req.on('error', reject)
        req.end()
      })
      assert.equal(exportRes.status, 200)
      assert.equal(exportRes.body.legalBasis, 'Ley 1581 de 2012 — Habeas Data')
      assert.equal(exportRes.body.consentRecord.whoAuthorized, 'Cliente API')

      // 3. Borrar datos personales (Derecho de supresión)
      const deleteRes = await new Promise<any>((resolve, reject) => {
        const req = request(
          `http://127.0.0.1:${port}/api/compliance/contact-data?phone=573112223344`,
          {
            method: 'DELETE',
            headers: { authorization: 'Bearer ultra_secret_admin_key_12345' },
          },
          (res) => {
            let data = ''
            res.on('data', (c) => (data += c))
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }))
          }
        )
        req.on('error', reject)
        req.end()
      })
      assert.equal(deleteRes.status, 200)
      assert.equal(deleteRes.body.success, true)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
