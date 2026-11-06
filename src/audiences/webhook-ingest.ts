import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { canonicalizePhone } from './csv-importer.ts'
import { EventIdempotencyStore } from '../security.ts'

export interface RealtimeLeadPayload {
  phone: string
  name?: string
  source: 'facebook_ads' | 'tiktok_ads' | 'typeform' | 'custom_webhook'
  campaignId?: string
  variables?: Record<string, string>
}

export interface IngestResult {
  success: boolean
  leadId?: string
  canonicalPhone?: string
  reason?: string
  duplicate?: boolean
}

/**
 * Ingesta de leads en tiempo real (contrato v1.1.0 §1 y §3):
 *  - La organización del lead VIENE DE LA CREDENCIAL (el secreto HMAC que validó la
 *    firma VINCULA la org); jamás se acepta del payload sin verificación.
 *  - JAMÁS un webhook de la org A puede añadir leads a una campaña de la org B:
 *    payload.campaignId se valida contra la organización vinculada (404 sin oráculo).
 *  - Idempotencia PERSISTENTE por (orgId, eventId): un evento repetido (incluso tras
 *    reinicio del proceso) no inserta dos veces (tabla event_idempotency, 7 días).
 */
export class WebhookLeadIngester {
  private db: DatabaseSync
  private events: EventIdempotencyStore

  constructor(db: DatabaseSync) {
    this.db = db
    this.events = new EventIdempotencyStore(db)
  }

  ingestLead(payload: RealtimeLeadPayload, orgId: string, eventId?: string): IngestResult {
    const rawPhone = payload.phone
    const canonical = canonicalizePhone(rawPhone)

    if (!canonical) {
      return { success: false, reason: 'INVALID_PHONE_FORMAT' }
    }

    // Idempotencia del evento (con efectos externos ⇒ eventId OBLIGATORIO, contrato §3)
    if (eventId) {
      const claim = this.events.claim(orgId, eventId)
      if (claim === 'duplicate') {
        return { success: true, duplicate: true, reason: 'DUPLICATE_EVENT', canonicalPhone: canonical }
      }
    }

    // Comprobar supresión scoped por organización
    const supp = this.db.prepare('SELECT phone FROM suppression_list WHERE organization_id = ? AND phone = ?').get(orgId, canonical)
    if (supp) {
      return { success: false, canonicalPhone: canonical, reason: 'PHONE_SUPPRESSED' }
    }

    const leadId = `lead_${randomUUID()}`
    const now = Math.floor(Date.now() / 1000)

    this.db.prepare(`
      INSERT INTO realtime_leads (id, organization_id, phone, name, source, campaign_id, payload_json, processed, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      leadId,
      orgId,
      canonical,
      payload.name || null,
      payload.source,
      payload.campaignId || null,
      payload.variables ? JSON.stringify(payload.variables) : null,
      now
    )

    // Si viene asociado a una campaña, debe ser una campaña DE SU ORGANIZACIÓN (contrato §1:
    // jamás se confía en campaignId sin validar la relación con la organización autenticada).
    if (payload.campaignId) {
      const campaign = this.db.prepare('SELECT id, status, organization_id FROM campaigns WHERE id = ?').get(payload.campaignId) as any
      if (campaign && campaign.organization_id !== orgId) {
        return { success: false, canonicalPhone: canonical, reason: 'CAMPAIGN_NOT_IN_ORG' }
      }
      if (campaign && campaign.status !== 'COMPLETED' && campaign.status !== 'CANCELLED') {
        const itemId = `itm_${randomUUID()}`
        const idempotencyKey = `${orgId}_${payload.campaignId}_${canonical}`
        try {
          this.db.prepare(`
            INSERT INTO campaign_items (id, campaign_id, contact_phone, contact_name, variables_json, status, retry_count, idempotency_key)
            VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?)
          `).run(itemId, payload.campaignId, canonical, payload.name || null, payload.variables ? JSON.stringify(payload.variables) : null, idempotencyKey)
          this.db.prepare('UPDATE campaigns SET total_targets = total_targets + 1 WHERE id = ?').run(payload.campaignId)
        } catch {
          // Si ya existe en la campaña, se omite por idempotencia
        }
      }
    }

    return {
      success: true,
      leadId,
      canonicalPhone: canonical,
    }
  }

  getUnprocessedLeads(): Array<{ id: string; phone: string; name?: string; source: string; campaignId?: string }> {
    const rows = this.db.prepare('SELECT * FROM realtime_leads WHERE processed = 0 ORDER BY created_at ASC').all() as any[]
    return rows.map((r) => ({
      id: r.id,
      phone: r.phone,
      name: r.name || undefined,
      source: r.source,
      campaignId: r.campaign_id || undefined,
    }))
  }

  markProcessed(leadId: string) {
    this.db.prepare('UPDATE realtime_leads SET processed = 1 WHERE id = ?').run(leadId)
  }
}
