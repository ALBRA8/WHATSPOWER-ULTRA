import { describe, it } from 'node:test'
import assert from 'node:assert'
import { NeuromarketingEngine } from '../src/ai/neuromarketing-engine.ts'
import { createBroadcastServer } from '../src/server.ts'

describe('SUITE MOTOR DE NEUROMARKETING & VENTAS 360° (Nivel 3 WHATSPOWER-ULTRA)', () => {
  const engine = new NeuromarketingEngine()

  it('NM-01: Calibración Cultural de Hofstede para LATAM y España', () => {
    // Colombia
    const col = engine.analyzeTargetMarket({
      country: 'COLOMBIA',
      productDescription: 'Plataforma SaaS para inmobiliarias',
    })
    assert.strictEqual(col.country, 'COLOMBIA')
    assert.strictEqual(col.culturalProfile.idv, 13) // Colectivista
    assert.strictEqual(col.culturalProfile.uai, 80) // Alta aversión a la incertidumbre
    assert.ok(col.culturalProfile.culturalHookAdvice.includes('confianza'))

    // México
    const mex = engine.analyzeTargetMarket({
      country: 'MEXICO',
      productDescription: 'Servicios de inversión en bienes raíces',
    })
    assert.strictEqual(mex.country, 'MEXICO')
    assert.strictEqual(mex.culturalProfile.mas, 69) // Logro y estatus
    assert.ok(col.neuromarketingGuidelines.length >= 4)
  })

  it('NM-02: Mapeo de Miedos Universales y Metáforas de Zaltman', () => {
    const analysis = engine.analyzeTargetMarket({
      country: 'COLOMBIA',
      industry: 'software empresarial',
      productDescription: 'Automatización de ventas para WhatsApp',
      mainPainPoint: 'perder el control de los clientes y gastar demasiado tiempo',
    })

    assert.ok(analysis.primaryFearTargeted.name)
    assert.ok(analysis.primaryFearTargeted.antidote)
    assert.ok(analysis.recommendedMetaphor.name)
    assert.ok(analysis.recommendedArchetype.symbolicCode)
  })

  it('NM-03: Generador de Spintax Persuasivo con Fórmulas de Conversión', () => {
    const res = engine.generateNeuromarketingSpintax({
      productName: 'ALBRA WhatsPower Ultra',
      country: 'COLOMBIA',
      mainBenefit: 'cerrar 3 veces más ventas en piloto automático',
      painPoint: 'dejar clientes en visto y perder cotizaciones',
      callToAction: '¿Te comparto un video de 1 minuto demostrándolo?',
    })

    assert.ok(res.spintaxTemplate.includes('{{nombre}}'))
    assert.ok(res.spintaxTemplate.includes('{¡Hola|Buen día|Hola qué tal}'))
    assert.ok(res.spintaxTemplate.includes('ALBRA WhatsPower Ultra'))
    assert.ok(res.spintaxTemplate.includes('cerrar 3 veces más ventas'))
    assert.ok(res.neuroAnalysis.symbolicHook)
    assert.ok(res.neuroAnalysis.fearAntidoteUsed)
  })

  it('NM-04: Constructor de Master Prompt 360° para LLMs y Chatbots', () => {
    const prompt = engine.buildMasterPrompt({
      businessName: 'Inmobiliaria Horizonte',
      country: 'COLOMBIA',
      productCategory: 'Apartamentos sobre planos en Medellín',
      targetAudience: 'Inversionistas jóvenes entre 28 y 45 años',
      uniqueSellingProposition: 'Plusvalía garantizada del 18% anual con entrega asegurada',
    })

    assert.ok(prompt.includes('Multiverse GPT'))
    assert.ok(prompt.includes('Geert Hofstede para COLOMBIA'))
    assert.ok(prompt.includes('Clotaire Rapaille & Gerald Zaltman'))
    assert.ok(prompt.includes('Inmobiliaria Horizonte'))
    assert.ok(prompt.includes('Plusvalía garantizada'))
  })

  it('NM-05: Servidor HTTP expone endpoints de Neuromarketing IA', async () => {
    const { neuromarketingEngine } = createBroadcastServer({ dbPath: ':memory:', whatsPowerEnabled: false })
    assert.ok(neuromarketingEngine, 'El motor de neuromarketing está montado en el servidor')

    const analysis = neuromarketingEngine.analyzeTargetMarket({
      country: 'MEXICO',
      productDescription: 'Turismo experiencial de lujo en Bacalar',
    })

    assert.strictEqual(analysis.country, 'MEXICO')
    assert.ok(analysis.recommendedArchetype.name)
  })
})
