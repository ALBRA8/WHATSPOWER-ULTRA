import { test, describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import { createBroadcastDatabase } from '../src/db.ts'
import { createMockMetaServer } from './helpers/mock-meta-server.ts'
import { MessagingWindowStore } from '../src/safety/messaging-window.ts'
import { TemplateRegistry, type MetaTemplate } from '../src/safety/template-registry.ts'
import { classifyMetaError } from '../src/adapters/meta-error-classifier.ts'
import {
  resolveOrganizationTransportPlan,
  type OrganizationPlanConfig,
} from '../src/adapters/transport-selector.ts'

describe('FASE 1 — CANAL OFICIAL DE WHATSAPP (WHATSPOWER-ULTRA Nivel 3)', () => {
  describe('1.1 Transporte por defecto y aviso de riesgo Baileys en difusión', () => {
    it('Organización de pago (plan: paid) usa Meta Cloud API por defecto', () => {
      const config: OrganizationPlanConfig = {
        organizationId: 'ultra_org_paid_1',
        plan: 'paid',
      }
      const resolution = resolveOrganizationTransportPlan(config)
      assert.strictEqual(resolution.selectedTransport, 'meta-cloud')
      assert.strictEqual(resolution.allowed, true)
    })

    it('Baileys en plan básico viene DESACTIVADO por defecto sin confirmación de riesgo', () => {
      const config: OrganizationPlanConfig = {
        organizationId: 'ultra_org_basic_1',
        plan: 'basic',
        preferredTransport: 'baileys',
        baileysRiskAcknowledged: false,
      }
      const resolution = resolveOrganizationTransportPlan(config)
      assert.strictEqual(resolution.allowed, false)
      assert.ok(resolution.error?.includes('BAILEYS_RISK_NOT_ACKNOWLEDGED'))
    })

    it('Baileys se autoriza ÚNICAMENTE cuando la organización acepta explícitamente el riesgo', () => {
      const config: OrganizationPlanConfig = {
        organizationId: 'ultra_org_basic_2',
        plan: 'basic',
        preferredTransport: 'baileys',
        baileysRiskAcknowledged: true,
      }
      const resolution = resolveOrganizationTransportPlan(config)
      assert.strictEqual(resolution.allowed, true)
      assert.strictEqual(resolution.selectedTransport, 'baileys')
      assert.ok(resolution.warning?.includes('ALTO RIESGO'))
    })
  })

  describe('1.2 Ventana de 24 horas y plantillas aprobadas en campañas', () => {
    const db = createBroadcastDatabase(':memory:')
    const windowStore = new MessagingWindowStore(db)
    const templateRegistry = new TemplateRegistry(db)

    const orgId = 'ultra_org_window'
    const contactPhone = '573001234567'

    it('Sin interacción entrante previa, está FUERA de la ventana de 24h', () => {
      const isInside = windowStore.isInside24hWindow(orgId, contactPhone)
      assert.strictEqual(isInside, false)
    })

    it('Un mensaje entrante abre la ventana de 24 horas', () => {
      windowStore.recordCustomerInbound(orgId, contactPhone, Date.now())
      assert.strictEqual(windowStore.isInside24hWindow(orgId, contactPhone), true)
    })

    it('Una interacción de hace 25 horas está FUERA de la ventana de 24h', () => {
      const twentyFiveHoursAgo = Date.now() - 25 * 60 * 60 * 1000
      windowStore.recordCustomerInbound(orgId, '573009999999', twentyFiveHoursAgo)
      assert.strictEqual(windowStore.isInside24hWindow(orgId, '573009999999'), false)
    })

    it('Fuera de la ventana, una plantilla APROBADA es permitida', () => {
      const tpl: MetaTemplate = {
        id: 'ultra_tpl_01',
        organizationId: orgId,
        name: 'aviso_promocional',
        language: 'es',
        category: 'MARKETING',
        status: 'APPROVED',
        body: 'Hola {{1}}, tenemos una oferta especial para ti.',
      }
      templateRegistry.registerTemplate(tpl)
      const check = templateRegistry.isTemplateApproved(orgId, 'aviso_promocional')
      assert.strictEqual(check.approved, true)
      assert.strictEqual(check.status, 'APPROVED')
    })

    it('Fuera de la ventana, una plantilla RECHAZADA o PENDIENTE queda bloqueada', () => {
      templateRegistry.registerTemplate({
        id: 'ultra_tpl_02',
        organizationId: orgId,
        name: 'spam_rechazado',
        language: 'es',
        category: 'MARKETING',
        status: 'REJECTED',
        body: 'Gana dinero ya sin esfuerzo.',
      })
      const checkRejected = templateRegistry.isTemplateApproved(orgId, 'spam_rechazado')
      assert.strictEqual(checkRejected.approved, false)
      assert.strictEqual(checkRejected.status, 'REJECTED')
    })
  })

  describe('1.3 Clasificación explícita de errores de Meta (sin reintentos ciegos)', () => {
    it('Error de límites (131048) mapea a META_RATE_LIMIT_EXCEEDED sin reintento', () => {
      const classified = classifyMetaError(400, {
        error: { code: 131048, message: 'Throughput limit reached' },
      })
      assert.strictEqual(classified.state, 'META_RATE_LIMIT_EXCEEDED')
      assert.strictEqual(classified.retryable, false)
      assert.strictEqual(classified.uncertain, false)
    })

    it('Error de calidad (131049) mapea a META_NUMBER_QUALITY_DEGRADED sin reintento', () => {
      const classified = classifyMetaError(400, {
        error: { code: 131049, message: 'Number rating degraded' },
      })
      assert.strictEqual(classified.state, 'META_NUMBER_QUALITY_DEGRADED')
      assert.strictEqual(classified.retryable, false)
    })

    it('Error de plantilla rechazada (132000) mapea a META_TEMPLATE_REJECTED sin reintento', () => {
      const classified = classifyMetaError(400, {
        error: { code: 132000, message: 'Template rejected' },
      })
      assert.strictEqual(classified.state, 'META_TEMPLATE_REJECTED')
      assert.strictEqual(classified.retryable, false)
    })

    it('Error de ventana (131047) mapea a META_WINDOW_EXPIRED sin reintento', () => {
      const classified = classifyMetaError(400, {
        error: { code: 131047, message: 'Window expired' },
      })
      assert.strictEqual(classified.state, 'META_WINDOW_EXPIRED')
      assert.strictEqual(classified.retryable, false)
    })
  })

  describe('1.4 Servidor Meta simulado local en ULTRA', () => {
    let mockServer: ReturnType<typeof createMockMetaServer>
    let baseUrl: string

    before(async () => {
      mockServer = createMockMetaServer()
      const port = await mockServer.start()
      baseUrl = `http://localhost:${port}`
    })

    after(async () => {
      await mockServer.stop()
    })

    it('Mock Meta Server responde exitosamente ante despacho válido de ULTRA', async () => {
      const res = await fetch(`${baseUrl}/v21.0/987654321/messages`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ultra_token_valid',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: '573001234567',
          type: 'text',
          text: { body: 'Campaña ULTRA' },
        }),
      })
      assert.strictEqual(res.status, 200)
      const data = await res.json()
      assert.ok(data.messages?.[0]?.id.startsWith('wamid.'))
    })
  })
})

