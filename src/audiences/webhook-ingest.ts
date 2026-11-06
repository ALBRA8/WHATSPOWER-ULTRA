import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { canonicalizePhone } from './csv-importer.ts'
import { createHash } from 'node:crypto'
import { LEGACY_LEAD_ORG } from '../security.ts'

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

  /**
   * Ingesta de lead con binding de organización (reparación integral 2026-11-06):
   * - organizationId viene de la VERIFICACIÓN HMAC (X-Org-Id autenticado), nunca del body.
   * - Si el payload referencia una campaña, esa campaña DEBE pertenecer a la organización
   *   autenticada; en caso contrario se rechaza SIN almacenar (anti inyección cross-org).
   * - El secreto v1 (org reservada "_legacy") no puede ligar leads a campañas.
   */
  ingestLead(payload: RealtimeLeadPayload, organizationId?: string): IngestResult {
    const org = organizationId ?? LEGACY_LEAD_ORG
    const rawPhone = payload.phone
    const canonical = canonicalizePhone(rawPhone)

    if (!canonical) {
      return { success: false, reason: 'INVALID_PHONE_FORMAT' }
    }

    // Binding cross-org: la campaña referenciada debe pertenecer a la org autenticada.
    if (payload.campaignId) {
      const campaign = this.db.prepare('SELECT id, organization_id, status FROM campaigns WHERE id = ?').get(payload.campaignId) as any
      if (campaign) {
        if (!org || org === LEGACY_LEAD_ORG || campaign.organization_id !== org) {
          return { success: false, canonicalPhone: canonical, reason: 'CAMPAIGN_ORG_MISMATCH' }
        }
      }
    }

    // Comprobar supresión
    const supp = this.db.prepare('SELECT phone FROM suppression_list WHERE phone = ?').get(canonical)
    if (supp) {
      return { success: false, canonicalPhone: canonical, reason: 'PHONE_SUPPRESSED' }
    }

    const leadId = `lead_${randomUUID()}`
    const now = Math.floor(Date.now() / 1000)

    this.db.prepare(`
      INSERT INTO realtime_leads (id, phone, name, source, campaign_id, payload_json, processed, created_at, organization_id)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      leadId,
      canonical,
      payload.name || null,
      payload.source,
      payload.campaignId || null,
      payload.variables ? JSON.stringify(payload.variables) : null,
      now,
      org === LEGACY_LEAD_ORG ? null : org
    )

    // Si viene asociado a una campaña activa, agregarlo a campaign_items como PENDING
    if (payload.campaignId) {
      const campaign = this.db.prepare('SELECT id, status FROM campaigns WHERE id = ?').get(payload.campaignId) as any
      if (campaign && campaign.status !== 'COMPLETED' && campaign.status !== 'CANCELLED') {
        const itemId = `itm_${randomUUID()}`
        // (reparación integral) MISMA función de clave que el importador CSV:
        // formatos distintos sobre una columna UNIQUE creaban ítems duplicados.
        const idempotencyKey = createHash('sha256').update(`${payload.campaignId}_${canonical}`).digest('hex')
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
