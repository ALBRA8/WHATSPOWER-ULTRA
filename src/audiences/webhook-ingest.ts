import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { canonicalizePhone } from './csv-importer.ts'

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
}

export class WebhookLeadIngester {
  private db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  ingestLead(payload: RealtimeLeadPayload): IngestResult {
    const rawPhone = payload.phone
    const canonical = canonicalizePhone(rawPhone)

    if (!canonical) {
      return { success: false, reason: 'INVALID_PHONE_FORMAT' }
    }

    // Comprobar supresión
    const supp = this.db.prepare('SELECT phone FROM suppression_list WHERE phone = ?').get(canonical)
    if (supp) {
      return { success: false, canonicalPhone: canonical, reason: 'PHONE_SUPPRESSED' }
    }

    const leadId = `lead_${randomUUID()}`
    const now = Math.floor(Date.now() / 1000)

    this.db.prepare(`
      INSERT INTO realtime_leads (id, phone, name, source, campaign_id, payload_json, processed, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      leadId,
      canonical,
      payload.name || null,
      payload.source,
      payload.campaignId || null,
      payload.variables ? JSON.stringify(payload.variables) : null,
      now
    )

    // Si viene asociado a una campaña activa, agregarlo a campaign_items como PENDING
    if (payload.campaignId) {
      const campaign = this.db.prepare('SELECT id, status FROM campaigns WHERE id = ?').get(payload.campaignId) as any
      if (campaign && campaign.status !== 'COMPLETED' && campaign.status !== 'CANCELLED') {
        const itemId = `itm_${randomUUID()}`
        const idempotencyKey = `${payload.campaignId}_${canonical}`
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
