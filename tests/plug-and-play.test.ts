import { describe, it } from 'node:test'
import assert from 'node:assert'
import { createBroadcastServer } from '../src/server.ts'
import { MockDispatcher } from '../src/adapters/dispatcher.ts'

describe('PLUG-AND-PLAY MODULARITY TESTS (ALBRA 3 Tiers)', () => {
  it('PNP-01: WhatsPower-Ultra operates 100% standalone with CRM (without Nivel 2 WhatsPower)', async () => {
    const mockDispatcher = new MockDispatcher()
    
    // Iniciar servidor en modo Standalone (Nivel 2 deshabilitado / no contratado)
    const { server, db, engine } = createBroadcastServer({
      dbPath: ':memory:',
      dispatcher: mockDispatcher,
      whatsPowerEnabled: false
    })

    assert.ok(server, 'El servidor se inicia limpiamente')
    assert.ok(engine, 'El motor de broadcast está listo')

    const csvContent = `phone,name
573001112233,Carlos Standalone
573009998877,Laura Directa`

    // Crear campaña en modo standalone
    const campaign = await engine.createCampaign({
      organizationId: 'org_test',
      name: 'Campaña Plug-and-Play Standalone',
      templateSpintax: '{Hola|Buen día} {{nombre}}, oferta especial',
      csvContent
    })

    assert.strictEqual(campaign.status, 'DRAFT')
    assert.strictEqual(campaign.totalTargets, 2)

    // Procesar los dos envíos secuencialmente (businessDate fija: evita flaky nocturno por guard de horario)
    const businessDate = new Date('2026-10-24T10:00:00-05:00') // 10:00 AM hora Bogotá
    const step1 = await engine.processNextItem(campaign.id, businessDate)
    assert.strictEqual(step1.processed, true)
    assert.strictEqual(step1.status, 'SENT')

    const step2 = await engine.processNextItem(campaign.id, businessDate)
    assert.strictEqual(step2.processed, true)
    assert.strictEqual(step2.status, 'SENT')

    // Verificar que el dispatcher recibió los despachos sin error de bloqueo o caída de red
    assert.strictEqual(mockDispatcher.dispatched.length, 2)
    assert.strictEqual(mockDispatcher.dispatched[0].to, '573001112233')
    assert.strictEqual(mockDispatcher.dispatched[1].to, '573009998877')

    // Paso final: campaña completada
    const stepFinal = await engine.processNextItem(campaign.id, businessDate)
    assert.strictEqual(stepFinal.processed, false)
    assert.strictEqual(stepFinal.status, 'COMPLETED')
    
    const refreshed = engine.getCampaign(campaign.id)
    assert.strictEqual(refreshed?.status, 'COMPLETED')
    assert.strictEqual(refreshed?.sentCount, 2)
  })

  it('PNP-02: Standalone local suppression prevents dispatching to opted-out contacts', async () => {
    const mockDispatcher = new MockDispatcher()
    const { engine, db } = createBroadcastServer({
      dbPath: ':memory:',
      dispatcher: mockDispatcher,
      whatsPowerEnabled: false
    })

    // Agregar número a la lista de supresión local
    db.prepare(`
      INSERT INTO suppression_list (phone, reason, created_at)
      VALUES (?, ?, ?)
    `).run('573009990000', 'opt_out_manual', Math.floor(Date.now() / 1000))

    const csvContent = `phone,name
573009990000,Usuario Desuscrito`

    const campaign = await engine.createCampaign({
      organizationId: 'org_test',
      name: 'Test Supresion Local',
      templateSpintax: 'Hola {{nombre}}',
      csvContent
    })

    // El contacto fue excluido en pre-filtrado por lista de supresión local
    assert.strictEqual(campaign.skippedCount, 1)

    const items = engine.getItems(campaign.id)
    assert.strictEqual(items.length, 1)
    assert.strictEqual(items[0].status, 'SUPPRESSED')
    assert.strictEqual(mockDispatcher.dispatched.length, 0, 'No debe disparar despacho si está suprimido')
  })
})
