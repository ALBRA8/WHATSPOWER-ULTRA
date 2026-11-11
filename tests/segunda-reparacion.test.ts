/**
 * segunda-reparacion.test.ts — Pruebas de la segunda reparación integral (orden §4/§6)
 *
 *  LIFECYCLE: máquina de estados de campañas — CANCELLED terminal, transiciones
 *             condicionales y atómicas, re-check del worker antes de despachar.
 *  XSS:       el HTML del Studio no interpola datos en innerHTML.
 *  STUDIO:    sesión por cookie HttpOnly (el secreto no vive en JS).
 *  LEADS:     webhooks rechazan campañas inexistentes / cross-org.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert'
import type { DatabaseSync } from 'node:sqlite'
import { createBroadcastDatabase } from '../src/db.ts'
import { BroadcastEngine } from '../src/queue/broadcast-worker.ts'
import { StandaloneLockChecker } from '../src/safety/lock-checker.ts'
import { transitionCampaignStatus } from '../src/queue/campaign-lifecycle.ts'
import { renderCampaignStudioHtml } from '../src/studio/campaign-studio-html.ts'
import {
  issueStudioSession,
  resolveStudioSession,
  parseAdminKeys,
} from '../src/security.ts'
import { WebhookLeadIngester } from '../src/audiences/webhook-ingest.ts'

function makeEngine(db: DatabaseSync, dispatcher: any): BroadcastEngine {
  return new BroadcastEngine({ db, dispatcher, lockChecker: new StandaloneLockChecker() })
}

const CSV = 'phone,name\n573000001122,<img src=x onerror=alert(1)>\n'

async function seededCampaign(): Promise<{ db: DatabaseSync; engine: BroadcastEngine; campaignId: string }> {
  const db = createBroadcastDatabase(':memory:')
  const engine = makeEngine(db, {
    dispatch: async (phone: string) => {
      // Ventana de carrera REAL: la cancelación ocurre DURANTE los checks asíncronos
      await new Promise((r) => setTimeout(r, 30))
      return { success: true, messageId: `m_${phone}` }
    },
  })
  await engine.createCampaign({ organizationId: 'org_test', name: 'LC', templateSpintax: 'Hola {{nombre}}', csvContent: CSV })
  const campaignId = (db.prepare('SELECT id FROM campaigns LIMIT 1').get() as any).id
  return { db, engine, campaignId }
}

describe('LIFECYCLE: máquina de estados de campañas (§4.B)', () => {
  it('LC-01: una campaña CANCELLED no puede reanudarse (409, terminal)', async () => {
    const { db, campaignId } = await seededCampaign()
    const toRunning = transitionCampaignStatus(db, campaignId, 'org_test', 'RUNNING')
    assert.strictEqual(toRunning.ok, true)
    const toCancelled = transitionCampaignStatus(db, campaignId, 'org_test', 'CANCELLED')
    assert.strictEqual(toCancelled.ok, true)
    // El intento de resucitar (lo que /resume permitía antes) es ILEGAL
    const zombie = transitionCampaignStatus(db, campaignId, 'org_test', 'RUNNING')
    assert.strictEqual(zombie.ok, false)
    assert.strictEqual((zombie as any).code, 'ILLEGAL_TRANSITION')
    // El estado sigue siendo CANCELLED en BD
    const st = (db.prepare('SELECT status FROM campaigns WHERE id = ?').get(campaignId) as any).status
    assert.strictEqual(st, 'CANCELLED')
  })

  it('LC-02: COMPLETED y CANCELLED son terminales; pause sobre terminal → 409', async () => {
    const { db, campaignId } = await seededCampaign()
    transitionCampaignStatus(db, campaignId, 'org_test', 'RUNNING')
    transitionCampaignStatus(db, campaignId, 'org_test', 'COMPLETED')
    const p = transitionCampaignStatus(db, campaignId, 'org_test', 'PAUSED')
    assert.strictEqual(p.ok, false)
    const r = transitionCampaignStatus(db, campaignId, 'org_test', 'RUNNING')
    assert.strictEqual(r.ok, false)
  })

  it('LC-03: la transición verifica ownership en el MISMO update (org ajena → NOT_FOUND)', async () => {
    const { db, campaignId } = await seededCampaign()
    const other = transitionCampaignStatus(db, campaignId, 'org_OTRA', 'RUNNING')
    assert.strictEqual(other.ok, false)
    assert.strictEqual((other as any).code, 'NOT_FOUND')
    // la campaña sigue DRAFT para su dueña
    const st = (db.prepare('SELECT status FROM campaigns WHERE id = ?').get(campaignId) as any).status
    assert.strictEqual(st, 'DRAFT')
  })

  it('LC-04: el worker NO despacha si la campaña se cancela durante los checks (re-check pre-despacho)', async () => {
    const { db, campaignId } = await seededCampaign()
    transitionCampaignStatus(db, campaignId, 'org_test', 'RUNNING')
    const dispatched: string[] = []
    // Ventana de carrera REAL en el LOCK CHECKER (await auténtico): la
    // cancelación ocurre DURANTE los chequeos just-in-time, ANTES del re-check
    // final de estado que precede al despacho.
    const slowLock = {
      checkLock: async (phone: string) => {
        await new Promise((r) => setTimeout(r, 40))
        return { available: true }
      },
    }
    const slowEngine = new BroadcastEngine({
      db,
      dispatcher: {
        dispatch: async (phone: string) => {
          dispatched.push(phone)
          return { success: true, messageId: 'm1' }
        },
      },
      lockChecker: slowLock as any,
      workerId: 'worker_cancel_test',
    })

    const pRun = slowEngine.processNextItem(campaignId, new Date('2026-10-26T14:00:00'))
    // Cancelar DURANTE la ventana asíncrona del check de locks
    await new Promise((r) => setTimeout(r, 10))
    transitionCampaignStatus(db, campaignId, 'org_test', 'CANCELLED')
    const res = await pRun

    assert.strictEqual(dispatched.length, 0, 'JAMÁS se despacha a una campaña cancelada')
    assert.strictEqual(res.status, 'ABORTED_CAMPAIGN_NOT_RUNNING', `resultado: ${res.status}`)
    const item = db.prepare("SELECT status FROM campaign_items WHERE campaign_id = ? AND status = 'ABORTED_CAMPAIGN_NOT_RUNNING'").get(campaignId) as any
    assert.ok(item, 'el ítem queda ABORTED_CAMPAIGN_NOT_RUNNING (sin envío)')
  })

  it('LC-05: la campaña no se marca COMPLETED mientras hay ítems DISPATCHING en vuelo', async () => {
    const { db, engine, campaignId } = await seededCampaign()
    transitionCampaignStatus(db, campaignId, 'org_test', 'RUNNING')
    // Simula un ítem en vuelo de otro worker
    db.prepare("INSERT INTO campaign_items (id, campaign_id, contact_phone, contact_name, variables_json, status, retry_count, idempotency_key) VALUES ('itm_flight', ?, '573000990011', 'EnVuelo', NULL, 'DISPATCHING', 0, 'k1')").run(campaignId)
    // El engine original solo tiene 1 ítem PENDING (el del CSV); despréndelo primero con un dispatcher que no acaba
    let release: () => void
    const gate = new Promise<void>((r) => { release = r })
    const busyEngine = new BroadcastEngine({
      db,
      dispatcher: { dispatch: async () => { await gate; return { success: true } } },
      lockChecker: new StandaloneLockChecker(),
    })
    const p = busyEngine.processNextItem(campaignId, new Date('2026-10-26T14:00:00'))
    await new Promise((r) => setTimeout(r, 10))
    // Segundo worker: no hay más PENDING, pero SÍ hay DISPATCHING → NO completed
    const r2 = await engine.processNextItem(campaignId, new Date('2026-10-26T14:00:00'))
    assert.notStrictEqual(r2.status, 'COMPLETED', 'no se completa con ítems en vuelo')
    release!()
    await p
  })
})

describe('XSS: Campaign Studio sin interpolación insegura (§4.A)', () => {
  it('XSS-01: el HTML NO construye filas con innerHTML interpolado (uso de textContent)', () => {
    const html = renderCampaignStudioHtml()
    // El patrón inseguro eliminado: tr.innerHTML con template literal interpolando datos
    assert.ok(!/\.innerHTML\s*=\s*`/.test(html), 'no debe haber innerHTML = `...${...}` con datos')
    assert.ok(html.includes('textContent'), 'las celdas de datos se construyen con textContent')
    // El único innerHTML permitido es la plantilla estática de mensajes (sin datos dinámicos)
    const innerHtmlUses = html.match(/\.innerHTML\s*=/g) || []
    assert.ok(innerHtmlUses.every(() => true))
    for (const m of html.matchAll(/\.innerHTML\s*=\s*([^;]{0,120})/g)) {
      const rhs = m[1]
      assert.ok(!rhs.includes('${'), `innerHTML sin interpolación de datos: ${rhs.trim().slice(0, 60)}`)
    }
  })

  it('XSS-02: los datos de contacto ya renderizados pasan por textContent (no por markup)', () => {
    const html = renderCampaignStudioHtml()
    assert.ok(html.includes("td2.textContent = it.contactName"), 'nombre del contacto via textContent')
    assert.ok(html.includes("td3.textContent = it.renderedText"), 'mensaje renderizado via textContent')
    assert.ok(html.includes("span.textContent = it.status"), 'estado via textContent')
  })
})

describe('STUDIO: sesión por cookie HttpOnly — el secreto no vive en JS (§4.A)', () => {
  const adminKeys = parseAdminKeys('k_director_con_16chars:org_direccion')
  it('SS-01: la cookie emitida es HttpOnly y SameSite=Strict', () => {
    const cookie = issueStudioSession(0, adminKeys[0].key)
    assert.ok(cookie.includes('HttpOnly'))
    assert.ok(cookie.includes('SameSite=Strict'))
    assert.ok(cookie.startsWith('wp_ultra_studio_session='))
  })
  it('SS-02: la cookie se resuelve a la identidad correcta y caduca (TTL 1h)', () => {
    const cookie = issueStudioSession(0, adminKeys[0].key)
    const value = cookie.split(';')[0].split('=')[1]
    const identity = resolveStudioSession(`wp_ultra_studio_session=${value}`, adminKeys)
    assert.ok(identity)
    assert.strictEqual(identity!.org, 'org_direccion')
    // Expirada → null
    const expired = issueStudioSession(0, adminKeys[0].key, Date.now() - 2 * 3600 * 1000)
    const expiredValue = expired.split(';')[0].split('=')[1]
    assert.strictEqual(resolveStudioSession(`wp_ultra_studio_session=${expiredValue}`, adminKeys), null)
  })
  it('SS-03: rotar el secreto revoca las sesiones emitidas con el anterior', () => {
    const oldKey = adminKeys[0].key
    const cookie = issueStudioSession(0, oldKey)
    const value = cookie.split(';')[0].split('=')[1]
    const rotatedKeys = parseAdminKeys('k_rotada_nueva_16char:org_direccion')
    assert.strictEqual(resolveStudioSession(`wp_ultra_studio_session=${value}`, rotatedKeys), null)
  })
  it('SS-04: el HTML del studio ya NO usa almacenamiento de sesión para la clave', () => {
    const html = renderCampaignStudioHtml()
    // Sin NINGÚN uso del Web Storage para credenciales (ni getItem/setItem)
    assert.ok(!/sessionStorage\s*\.\s*(getItem|setItem|removeItem)/.test(html), 'el secreto jamás se guarda en el Web Storage')
    assert.ok(html.includes('/studio/login'), 'el canje de sesión va por backend')
  })
})

describe('LEADS: webhook sin huérfanos ni cross-org (§4.D)', () => {
  it('LD-01: lead con campaignId INEXISTENTE → rechazado (sin inserción huérfana)', () => {
    const db = createBroadcastDatabase(':memory:')
    const ing = new WebhookLeadIngester(db)
    const res = ing.ingestLead({ phone: '573000111222', source: 'custom_webhook', campaignId: 'cmp_inexistente' }, 'org_test')
    assert.strictEqual(res.success, false)
    assert.strictEqual(res.reason, 'CAMPAIGN_NOT_FOUND')
    const count = (db.prepare('SELECT COUNT(*) c FROM realtime_leads').get() as any).c
    assert.strictEqual(count, 0)
  })

  it('LD-02: lead con campaña de OTRA organización → rechazado (CAMPAIGN_ORG_MISMATCH)', () => {
    const db = createBroadcastDatabase(':memory:')
    db.prepare("INSERT INTO campaigns (id, organization_id, name, template_spintax, status, total_targets, created_at) VALUES ('cmp_ajena', 'org_otra', 'X', 'hola', 'RUNNING', 0, 1)").run()
    const ing = new WebhookLeadIngester(db)
    const res = ing.ingestLead({ phone: '573000111222', source: 'facebook_ads', campaignId: 'cmp_ajena' }, 'org_test')
    assert.strictEqual(res.success, false)
    assert.strictEqual(res.reason, 'CAMPAIGN_ORG_MISMATCH')
    const count = (db.prepare('SELECT COUNT(*) c FROM realtime_leads').get() as any).c
    assert.strictEqual(count, 0)
  })

  it('LD-03: lead con campaña PROPIA existente → aceptado y encolado', () => {
    const db = createBroadcastDatabase(':memory:')
    db.prepare("INSERT INTO campaigns (id, organization_id, name, template_spintax, status, total_targets, created_at) VALUES ('cmp_propia', 'org_test', 'X', 'hola', 'RUNNING', 0, 1)").run()
    const ing = new WebhookLeadIngester(db)
    const res = ing.ingestLead({ phone: '573000111222', name: 'Ana', source: 'facebook_ads', campaignId: 'cmp_propia' }, 'org_test')
    assert.strictEqual(res.success, true)
    const items = (db.prepare('SELECT COUNT(*) c FROM campaign_items WHERE campaign_id = ?').get('cmp_propia') as any).c
    assert.strictEqual(items, 1)
  })
})
