import type { DatabaseSync } from 'node:sqlite'
import type { SuppressionChecker } from '../types.ts'

export class LocalSuppressionStore implements SuppressionChecker {
  db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  async isSuppressed(phone: string): Promise<boolean> {
    const row = this.db.prepare('SELECT phone FROM suppression_list WHERE phone = ?').get(phone)
    return Boolean(row)
  }

  addSuppression(phone: string, reason: string = 'opt_out') {
    this.db.prepare(`
      INSERT OR REPLACE INTO suppression_list (phone, reason, created_at)
      VALUES (?, ?, ?)
    `).run(phone, reason, Math.floor(Date.now() / 1000))
  }
}

export class Http2ASuppressionChecker implements SuppressionChecker {
  baseUrl: string
  timeoutMs: number

  constructor(options?: { baseUrl?: string; timeoutMs?: number }) {
    this.baseUrl = options?.baseUrl || (process.env.AGENTIC_2A_URL?.replace('/api/inbound', '') || 'http://localhost:3003')
    this.timeoutMs = options?.timeoutMs || 1500
  }

  async isSuppressed(phone: string): Promise<boolean> {
    const encodedPhone = encodeURIComponent(phone)
    const url = `${this.baseUrl}/api/internal/suppression/${encodedPhone}`

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      })

      if (!response.ok) {
        throw new Error(`SUPPRESSION_CHECK_HTTP_${response.status}`)
      }

      const data = await response.json() as { phone: string; suppressed: boolean }
      return Boolean(data.suppressed)
    } catch (err: any) {
      throw new Error(`SUPPRESSION_CHECK_UNAVAILABLE: ${err?.message || err}`)
    }
  }
}

export class CompositeSuppressionChecker implements SuppressionChecker {
  local: LocalSuppressionStore
  remote?: SuppressionChecker

  constructor(local: LocalSuppressionStore, remote?: SuppressionChecker) {
    this.local = local
    this.remote = remote
  }

  async isSuppressed(phone: string): Promise<boolean> {
    if (await this.local.isSuppressed(phone)) return true

    if (this.remote) {
      const isRemoteSuppressed = await this.remote.isSuppressed(phone)
      if (isRemoteSuppressed) {
        this.local.addSuppression(phone, 'synced_from_2a')
        return true
      }
    }

    return false
  }
}

export class FatigueManager {
  db: DatabaseSync
  daysThreshold: number

  constructor(db: DatabaseSync, daysThreshold: number = 7) {
    this.db = db
    this.daysThreshold = daysThreshold
  }

  isFatigued(phone: string): boolean {
    const row = this.db.prepare('SELECT last_broadcast_at FROM contact_fatigue WHERE phone = ?').get(phone) as { last_broadcast_at: number } | undefined
    if (!row) return false

    const now = Math.floor(Date.now() / 1000)
    const thresholdSeconds = this.daysThreshold * 24 * 60 * 60
    return (now - row.last_broadcast_at) < thresholdSeconds
  }

  recordBroadcast(phone: string, campaignId: string) {
    const now = Math.floor(Date.now() / 1000)
    this.db.prepare(`
      INSERT OR REPLACE INTO contact_fatigue (phone, last_broadcast_at, last_campaign_id)
      VALUES (?, ?, ?)
    `).run(phone, now, campaignId)
  }
}
