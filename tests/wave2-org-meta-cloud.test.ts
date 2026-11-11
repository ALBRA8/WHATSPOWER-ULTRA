/**
 * OLEADA 2 — Campañas ULTRA con credenciales Meta POR ORGANIZACIÓN
 * (decisión de negocio 2026-11-11).
 *
 * Ejercita la decisión completa en Capa 3:
 *  - cada org despacha sus campañas con SU número y SU token (puntos 6 y 7);
 *  - una org jamás usa credenciales de otra (punto 8) — incluida la
 *    verificación de identidad de la fuente CRM;
 *  - fail-closed: org sin conexión o sin credencial → su campaña NO despacha
 *    y las demás organizaciones siguen operativas (punto 9);
 *  - desconexión/revocación aislada de una org (punto 9);
 *  - salvaguarda ALLOW_REAL_DISPATCH intacta;
 *  - la fuente CRM jamás entrega tokens de una org distinta a la autenticada.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MetaCloudDispatcher } from '../src/adapters/meta-cloud-dispatcher.ts'
import {
  OrgWaCredentialRegistry,
  EnvOrgWaSource,
  CrmOrgWaSource,
  parseOrgCredentialTriples,
  parseOrgServiceCredentials,
  parseOrgNumbers,
} from '../src/org-wa-credentials.ts'
import type { OrgWaSource } from '../src/org-wa-credentials.ts'

/** Stub del Graph API que captura auth + phoneNumberId por llamada. */
function graphStub(captured: Array<{ auth: string; phoneId: string; to: string }>, status = 200) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const match = url.match(/graph\.facebook\.com\/v[\d.]+\/(\d+)\/messages/)
    if (!match) return new Response('{}', { status: 404 })
    captured.push({
      auth: (init?.headers as Record<string, string>)['Authorization'],
      phoneId: match[1],
      to: JSON.parse(String(init?.body)).to,
    })
    return new Response(JSON.stringify({ messages: [{ id: `wamid.${captured.length}` }] }), { status })
  }) as unknown as typeof fetch
}

function dualOrgRegistry(): OrgWaCredentialRegistry {
  return new OrgWaCredentialRegistry([new EnvOrgWaSource({
    metaOrgNumbers: 'org-a:111000111,org-b:222000222',
    metaOrgCredentials: 'org-a:111000111:token-ORG-A-0123456789abcdef,org-b:222000222:token-ORG-B-0123456789abcdef',
  })])
}

describe('parseo de registros por organización', () => {
  it('triples de credenciales: token débil o org __legacy__ se rechazan', () => {
    const parsed = parseOrgCredentialTriples('org-a:111000111:corto,__legacy__:999:token-largo-suficiente-123,org-b:222000222:token-ORG-B-0123456789abcdef')
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0].orgId, 'org-b')
  })

  it('credenciales de servicio hacia CRM: formato orgId:secreto', () => {
    const parsed = parseOrgServiceCredentials('org-a:secreto-servicio-a-0123456789,org-b:mal')
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0].orgId, 'org-a')
  })

  it('índice de números: identidad org→phoneId', () => {
    const parsed = parseOrgNumbers('org-a:111000111, org-a:111000112 ,basura')
    assert.equal(parsed.length, 2)
  })
})

describe('despacho de campañas con credenciales por organización (puntos 6 y 7)', () => {
  it('cada campaña sale por el número y token de SU organización', async () => {
    const captured: Array<{ auth: string; phoneId: string; to: string }> = []
    const dispatcher = new MetaCloudDispatcher({ registry: dualOrgRegistry(), fetchImpl: graphStub(captured), allowRealDispatch: true })
    // campañas de dos organizaciones diferentes (mismo worker, misma BD)
    const rA = await dispatcher.dispatch('573001111111', 'promo A', 'org-a')
    const rB = await dispatcher.dispatch('573002222222', 'promo B', 'org-b')
    assert.equal(rA.success, true)
    assert.equal(rB.success, true)
    assert.equal(captured.length, 2)
    assert.equal(captured[0].phoneId, '111000111')
    assert.equal(captured[0].auth, 'Bearer token-ORG-A-0123456789abcdef')
    assert.equal(captured[1].phoneId, '222000222')
    assert.equal(captured[1].auth, 'Bearer token-ORG-B-0123456789abcdef')
    // trazabilidad sin secretos
    const log = JSON.stringify(dispatcher.dispatchedMessages)
    assert.ok(log.includes('org-a') && log.includes('org-b'))
    assert.equal(log.includes('token-ORG'), false)
  })

  it('una org con VARIOS números despacha por el primero conectado', async () => {
    const captured: Array<{ auth: string; phoneId: string; to: string }> = []
    const registry = new OrgWaCredentialRegistry([new EnvOrgWaSource({
      metaOrgNumbers: 'org-a:111000111,org-a:111000112',
      metaOrgCredentials: 'org-a:111000111:token-ORG-A1-0123456789abcd,org-a:111000112:token-ORG-A2-0123456789abcd',
    })])
    const dispatcher = new MetaCloudDispatcher({ registry, fetchImpl: graphStub(captured), allowRealDispatch: true })
    const r = await dispatcher.dispatch('573001111111', 'x', 'org-a')
    assert.equal(r.success, true)
    assert.equal(captured[0].phoneId, '111000111')
  })
})

describe('aislamiento y fail-closed (puntos 8 y 9)', () => {
  it('sin organizationId → ORG_REQUIRED (jamás org implícita)', async () => {
    const captured: Array<{ auth: string; phoneId: string; to: string }> = []
    const dispatcher = new MetaCloudDispatcher({ registry: dualOrgRegistry(), fetchImpl: graphStub(captured), allowRealDispatch: true })
    const r = await dispatcher.dispatch('573001111111', 'x')
    assert.equal(r.success, false)
    assert.match(r.error!, /ORG_REQUIRED/)
    assert.equal(captured.length, 0)
  })

  it('org sin conexión propia → NO_CONNECTED_NUMBER; org-b sigue operativa (punto 9)', async () => {
    const captured: Array<{ auth: string; phoneId: string; to: string }> = []
    // solo org-b tiene conexión; org-a quedó sin conexión (revocada)
    const registry = new OrgWaCredentialRegistry([new EnvOrgWaSource({
      metaOrgNumbers: 'org-b:222000222',
      metaOrgCredentials: 'org-b:222000222:token-ORG-B-0123456789abcdef',
    })])
    const dispatcher = new MetaCloudDispatcher({ registry, fetchImpl: graphStub(captured), allowRealDispatch: true })
    const rA = await dispatcher.dispatch('573001111111', 'x', 'org-a')
    assert.equal(rA.success, false)
    assert.match(rA.error!, /NO_CONNECTED_NUMBER/)
    const rB = await dispatcher.dispatch('573002222222', 'x', 'org-b')
    assert.equal(rB.success, true)
    assert.equal(captured.length, 1)
    assert.equal(captured[0].phoneId, '222000222')
  })

  it('org con conexión pero SIN credencial → CREDENTIAL_UNAVAILABLE (fail-closed)', async () => {
    const captured: Array<{ auth: string; phoneId: string; to: string }> = []
    const registry = new OrgWaCredentialRegistry([new EnvOrgWaSource({
      metaOrgNumbers: 'org-a:111000111',
      metaOrgCredentials: '', // la conexión existe, la credencial se revocó
    })])
    const dispatcher = new MetaCloudDispatcher({ registry, fetchImpl: graphStub(captured), allowRealDispatch: true })
    const r = await dispatcher.dispatch('573001111111', 'x', 'org-a')
    assert.equal(r.success, false)
    assert.match(r.error!, /CREDENTIAL_UNAVAILABLE/)
    assert.equal(captured.length, 0)
  })

  it('org desconocida jamás recibe el número ni el token de otra org (sin filtración)', async () => {
    const captured: Array<{ auth: string; phoneId: string; to: string }> = []
    const dispatcher = new MetaCloudDispatcher({ registry: dualOrgRegistry(), fetchImpl: graphStub(captured), allowRealDispatch: true })
    const r = await dispatcher.dispatch('573003333333', 'x', 'org-invitada')
    assert.equal(r.success, false)
    const text = JSON.stringify(r)
    assert.equal(text.includes('111000111'), false)
    assert.equal(text.includes('token-ORG'), false)
    assert.equal(captured.length, 0)
  })

  it('salvaguarda física: ALLOW_REAL_DISPATCH=false bloquea ANTES de cualquier resolución', async () => {
    const captured: Array<{ auth: string; phoneId: string; to: string }> = []
    const dispatcher = new MetaCloudDispatcher({ registry: dualOrgRegistry(), fetchImpl: graphStub(captured), allowRealDispatch: false })
    const r = await dispatcher.dispatch('573001111111', 'x', 'org-a')
    assert.equal(r.success, false)
    assert.match(r.error!, /DISPATCH_BLOCKED_BY_SAFETY_GUARD/)
    assert.equal(captured.length, 0)
  })
})

describe('fuente CRM — el administrador de conexiones (contrato OLEADA 2)', () => {
  it('cada org se consulta autenticada CON SU credencial y el CRM confirma la identidad', async () => {
    const calls: Array<{ auth: string; url: string }> = []
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)['Authorization']
      calls.push({ auth, url: String(input) })
      if (auth === 'Bearer secreto-servicio-a-0123456789') {
        return new Response(JSON.stringify({
          organizationId: 'org-a',
          connections: [{ id: 'conn-1', phoneNumberId: '111000111', phoneNumber: '+52 55 100 1000', wabaId: 'waba-a' }],
        }), { status: 200 })
      }
      // CRM devuelve 404 para credenciales desconocidas (no revela otras orgs)
      return new Response(JSON.stringify({ error: 'No encontrada' }), { status: 404 })
    }) as unknown as typeof fetch

    const originalFetch = globalThis.fetch
    globalThis.fetch = fakeFetch
    try {
      const source = new CrmOrgWaSource([
        { orgId: 'org-a', secret: 'secreto-servicio-a-0123456789' },
        { orgId: 'org-b', secret: 'secreto-otro-0123456789aaaa' },
      ])
      const listA = await source.listForOrg('org-a')
      assert.equal(listA.length, 1)
      assert.equal(listA[0].phoneNumberId, '111000111')
      // la llamada de org-a se autenticó con SU secreto
      assert.equal(calls[0].auth, 'Bearer secreto-servicio-a-0123456789')
      // org-b: su credencial no matchea nada → lista vacía (fail-closed)
      const listB = await source.listForOrg('org-b')
      assert.equal(listB.length, 0)
      // org sin credencial declarada → ni siquiera se consulta
      const listC = await source.listForOrg('org-fantasma')
      assert.equal(listC.length, 0)
      assert.equal(calls.length, 2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('el CRM responde una org distinta a la solicitada → fail-closed (sin token)', async () => {
    const fakeFetch = (async () => {
      // CRM malicioso/desconfigurado: entrega contenido de org-b a org-a
      return new Response(JSON.stringify({
        organizationId: 'org-b',
        connections: [{ id: 'c', phoneNumberId: '222000222', phoneNumber: '', wabaId: null }],
      }), { status: 200 })
    }) as unknown as typeof fetch
    const originalFetch = globalThis.fetch
    globalThis.fetch = fakeFetch
    try {
      const source = new CrmOrgWaSource([{ orgId: 'org-a', secret: 'secreto-servicio-a-0123456789' }])
      const list = await source.listForOrg('org-a')
      assert.equal(list.length, 0) // identidad no confirmada → NADA
      const cred = await source.resolveCredential('org-a', '222000222')
      assert.equal(cred, null)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('CrmOrgWaSource sin credenciales declaradas → error al construir (fail-fast)', () => {
    delete process.env.CRM_INTERNAL_CREDENTIALS
    assert.throws(() => new CrmOrgWaSource(), /CRM_INTERNAL_CREDENTIALS/)
  })
})

describe('compatibilidad sala limpia (mockMode explícito)', () => {
  it('mockMode:true sigue disponible para pruebas — sin org y sin salvaguarda', async () => {
    const prev = process.env.ALLOW_REAL_DISPATCH
    delete process.env.ALLOW_REAL_DISPATCH
    try {
      const d = new MetaCloudDispatcher({ mockMode: true })
      const r = await d.dispatch('573001112233', 'hola')
      assert.equal(r.success, true)
      assert.equal(d.dispatchedMessages.length, 1)
    } finally {
      if (prev !== undefined) process.env.ALLOW_REAL_DISPATCH = prev
    }
  })
})

describe('fuente compuesta (env + CRM) con verificación cruzada', () => {
  it('una fuente caída no autoriza usar credenciales de otra org', async () => {
    const brokenSource: OrgWaSource = {
      async listForOrg() { throw new Error('CRM caído') },
      async resolveCredential() { throw new Error('CRM caído') },
    }
    const registry = new OrgWaCredentialRegistry([brokenSource, new EnvOrgWaSource({
      metaOrgNumbers: 'org-a:111000111',
      metaOrgCredentials: 'org-a:111000111:token-ORG-A-0123456789abcdef',
    })])
    const cred = await registry.resolveCredential('org-a', '111000111')
    assert.ok(cred)
    assert.equal(cred!.accessToken, 'token-ORG-A-0123456789abcdef')
    const cross = await registry.resolveCredential('org-b', '111000111')
    assert.equal(cross, null)
  })
})


// ============================================================
// (Auditoría A1-01, 2026-11-11) Clasificación B2 en ULTRA:
// timeout/5xx → RESULTADO INCIERTO (jamás reenvío a ciegas);
// solo rechazables (400/401/403/...) son fallo confirmado.
// Espejo del contrato §7 que WHATSPOWER ya cumplía.
// ============================================================
describe('A1-01: clasificación de incertidumbre en MetaCloudDispatcher', () => {
  it('HTTP 500 de Graph → uncertain:true (el mensaje pudo haberse aceptado)', async () => {
    const captured: Array<{ auth: string; phoneId: string; to: string }> = []
    const dispatcher = new MetaCloudDispatcher({ registry: dualOrgRegistry(), fetchImpl: graphStub(captured, 500), allowRealDispatch: true })
    const r = await dispatcher.dispatch('573001111111', 'x', 'org-a')
    assert.equal(r.success, false)
    assert.equal(r.uncertain, true, '5xx DEBE clasificarse como resultado incierto')
    assert.match(r.error!, /ambiguo/)
  })

  it('HTTP 400 de Graph → fallo CONFIRMADO sin uncertain (rechazo real)', async () => {
    const captured: Array<{ auth: string; phoneId: string; to: string }> = []
    const dispatcher = new MetaCloudDispatcher({ registry: dualOrgRegistry(), fetchImpl: graphStub(captured, 400), allowRealDispatch: true })
    const r = await dispatcher.dispatch('573001111111', 'x', 'org-a')
    assert.equal(r.success, false)
    assert.notEqual(r.uncertain, true)
    assert.match(r.error!, /META_CLOUD_API_HTTP_400/)
  })

  it('timeout / conexión cortada → uncertain:true (B2)', async () => {
    const throwing: typeof fetch = (async () => { throw new Error('The operation was aborted due to timeout') }) as unknown as typeof fetch
    const dispatcher = new MetaCloudDispatcher({ registry: dualOrgRegistry(), fetchImpl: throwing, allowRealDispatch: true })
    const r = await dispatcher.dispatch('573001111111', 'x', 'org-a')
    assert.equal(r.success, false)
    assert.equal(r.uncertain, true)
    assert.match(r.error!, /META_CLOUD_NETWORK_ERROR/)
  })
})
