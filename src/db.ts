import { DatabaseSync } from 'node:sqlite'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))

export function createBroadcastDatabase(dbPath?: string): DatabaseSync {
  const targetPath = dbPath || join(__dirname, '..', 'db', 'broadcast.db')
  if (targetPath !== ':memory:') {
    mkdirSync(dirname(targetPath), { recursive: true })
  }

  const db = new DatabaseSync(targetPath)

  // Esquema SQLite privado de Capa 2B
  db.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      template_spintax TEXT NOT NULL,
      status TEXT NOT NULL,
      scheduled_at INTEGER,
      started_at INTEGER,
      finished_at INTEGER,
      total_targets INTEGER NOT NULL DEFAULT 0,
      sent_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS campaign_items (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      contact_phone TEXT NOT NULL,
      contact_name TEXT,
      variables_json TEXT,
      rendered_text TEXT,
      status TEXT NOT NULL,
      lock_checked_at INTEGER,
      dispatched_at INTEGER,
      error_reason TEXT,
      message_id TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      idempotency_key TEXT UNIQUE NOT NULL,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
    );

    CREATE TABLE IF NOT EXISTS suppression_list (
      phone TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contact_fatigue (
      phone TEXT PRIMARY KEY,
      last_broadcast_at INTEGER NOT NULL,
      last_campaign_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tracked_links (
      code TEXT PRIMARY KEY,
      campaign_id TEXT,
      target_url TEXT NOT NULL,
      clicks INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tracked_link_clicks (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      contact_phone TEXT,
      user_agent TEXT,
      ip TEXT,
      clicked_at INTEGER NOT NULL,
      FOREIGN KEY (code) REFERENCES tracked_links(code)
    );

    CREATE TABLE IF NOT EXISTS realtime_leads (
      id TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      name TEXT,
      source TEXT NOT NULL, -- 'facebook_ads' | 'tiktok_ads' | 'typeform' | 'custom_webhook'
      campaign_id TEXT,
      payload_json TEXT,
      processed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_items_campaign ON campaign_items(campaign_id, status);
  `)

  return db
}
