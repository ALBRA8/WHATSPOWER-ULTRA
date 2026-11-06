import { DatabaseSync } from 'node:sqlite'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, copyFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const SCHEMA_VERSION = 3
export const DEFAULT_ORG_ID = 'default'

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name) as { name: string } | undefined
  return Boolean(row)
}

/**
 * Migración v3 (reparación integral 2026-11-06, contrato §9): supresiones, fatiga y
 * leads en tiempo real pasan a ser propiedad de la ORGANIZACIÓN. Los datos heredados
 * se asignan a la organización 'default'. Reversible: copia <db>.pre-v3-*.bak antes
 * de migrar; transacción única con ROLLBACK ante cualquier fallo.
 */
function migrateToV3(db: DatabaseSync, targetPath: string): void {
  if (targetPath !== ':memory:') {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      copyFileSync(targetPath, `${targetPath}.pre-v3-${stamp}.bak`)
    } catch { /* BD nueva sin archivo aún */ }
  }

  db.exec('BEGIN')
  try {
    if (tableExists(db, 'suppression_list') && !tableExists(db, 'suppression_list_v3')) {
      db.exec('ALTER TABLE suppression_list RENAME TO suppression_list_legacy')
      db.exec(`CREATE TABLE suppression_list_v3 (
        organization_id TEXT NOT NULL,
        phone TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (organization_id, phone)
      );`)
      db.exec(`INSERT OR IGNORE INTO suppression_list_v3 (organization_id, phone, reason, created_at)
        SELECT '${DEFAULT_ORG_ID}', phone, reason, created_at FROM suppression_list_legacy;`)
      db.exec('DROP TABLE suppression_list_legacy;')
      db.exec('ALTER TABLE suppression_list_v3 RENAME TO suppression_list;')
    }

    if (tableExists(db, 'contact_fatigue') && !tableExists(db, 'contact_fatigue_v3')) {
      db.exec('ALTER TABLE contact_fatigue RENAME TO contact_fatigue_legacy')
      db.exec(`CREATE TABLE contact_fatigue_v3 (
        organization_id TEXT NOT NULL,
        phone TEXT NOT NULL,
        last_broadcast_at INTEGER NOT NULL,
        last_campaign_id TEXT NOT NULL,
        PRIMARY KEY (organization_id, phone)
      );`)
      db.exec(`INSERT OR IGNORE INTO contact_fatigue_v3 (organization_id, phone, last_broadcast_at, last_campaign_id)
        SELECT '${DEFAULT_ORG_ID}', phone, last_broadcast_at, last_campaign_id FROM contact_fatigue_legacy;`)
      db.exec('DROP TABLE contact_fatigue_legacy;')
      db.exec('ALTER TABLE contact_fatigue_v3 RENAME TO contact_fatigue;')
    }

    if (tableExists(db, 'realtime_leads') && !tableExists(db, 'realtime_leads_v3')) {
      db.exec('ALTER TABLE realtime_leads RENAME TO realtime_leads_legacy')
      db.exec(`CREATE TABLE realtime_leads_v3 (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        phone TEXT NOT NULL,
        name TEXT,
        source TEXT NOT NULL,
        campaign_id TEXT,
        payload_json TEXT,
        processed INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );`)
      db.exec(`INSERT OR IGNORE INTO realtime_leads_v3 (id, organization_id, phone, name, source, campaign_id, payload_json, processed, created_at)
        SELECT id, '${DEFAULT_ORG_ID}', phone, name, source, campaign_id, payload_json, processed, created_at FROM realtime_leads_legacy;`)
      db.exec('DROP TABLE realtime_leads_legacy;')
      db.exec('ALTER TABLE realtime_leads_v3 RENAME TO realtime_leads;')
    }

    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* nada que revertir */ }
    throw err
  }
}

export function createBroadcastDatabase(dbPath?: string): DatabaseSync {
  const targetPath = dbPath || join(__dirname, '..', 'db', 'broadcast.db')
  if (targetPath !== ':memory:') {
    mkdirSync(dirname(targetPath), { recursive: true })
  }

  const db = new DatabaseSync(targetPath)

  // Detección de esquema pre-v3 (las BD heredadas nunca tienen webhook_replay).
  if (tableExists(db, 'suppression_list') && !tableExists(db, 'webhook_replay')) {
    migrateToV3(db, targetPath)
  }

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
      organization_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (organization_id, phone)
    );

    CREATE TABLE IF NOT EXISTS contact_fatigue (
      organization_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      last_broadcast_at INTEGER NOT NULL,
      last_campaign_id TEXT NOT NULL,
      PRIMARY KEY (organization_id, phone)
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
      organization_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      name TEXT,
      source TEXT NOT NULL, -- 'facebook_ads' | 'tiktok_ads' | 'typeform' | 'custom_webhook'
      campaign_id TEXT,
      payload_json TEXT,
      processed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    -- Anti-replay PERSISTENTE de webhooks (contrato §3; purga >600s, sobrevive reinicios)
    CREATE TABLE IF NOT EXISTS webhook_replay (
      fingerprint TEXT PRIMARY KEY,
      seen_at INTEGER NOT NULL
    );

    -- Idempotencia PERSISTENTE de eventos (contrato §3): clave orgId::eventId, purga 7 días
    CREATE TABLE IF NOT EXISTS event_idempotency (
      key TEXT PRIMARY KEY,
      claimed_at INTEGER NOT NULL
    );

    -- Registro de auditoría (contrato §1): identidades de servicio y acciones administrativas
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      actor TEXT NOT NULL,
      organization_id TEXT,
      action TEXT NOT NULL,
      resource TEXT,
      detail TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_items_campaign ON campaign_items(campaign_id, status);
    CREATE INDEX IF NOT EXISTS idx_webhook_replay_seen_at ON webhook_replay (seen_at);
    CREATE INDEX IF NOT EXISTS idx_event_idempotency_claimed_at ON event_idempotency (claimed_at);
  `)

  const v = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if ((v?.user_version ?? 0) < SCHEMA_VERSION) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
  }

  return db
}

/** Purga de antigüedad (contrato §3): replay >600s, idempotencia de eventos >7 días. */
export function purgeExpiredSecurityRows(db: DatabaseSync): void {
  const now = Date.now()
  try {
    db.prepare('DELETE FROM webhook_replay WHERE seen_at < ?').run(now - 600_000)
    db.prepare('DELETE FROM event_idempotency WHERE claimed_at < ?').run(now - 7 * 24 * 60 * 60 * 1000)
  } catch { /* la purga jamás rompe el tráfico */ }
}

/** Registra una acción en audit_log (sin datos sensibles: jamás teléfonos completos ni cuerpos). */
export function writeAudit(db: DatabaseSync, actor: string, orgId: string | null, action: string, resource?: string, detail?: string): void {
  try {
    db.prepare('INSERT INTO audit_log (id, actor, organization_id, action, resource, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      `aud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      actor.slice(0, 8) + '…', // jamás la clave completa
      orgId,
      action,
      resource || null,
      detail || null,
      Math.floor(Date.now() / 1000),
    )
  } catch { /* la auditoría jamás rompe el tráfico */ }
}
