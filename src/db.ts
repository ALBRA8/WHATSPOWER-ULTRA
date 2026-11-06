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

  // ============================================================
  // Migraciones aditivas y REVERSIBLES (reparación integral 2026-11-06)
  // Documentación y rollback exacto en docs/MIGRACIONES.md.
  //  - campaign_items.claimed_by / claimed_at → claim atómico del worker
  //    (rollback: ALTER TABLE campaign_items DROP COLUMN claimed_by;
  //               ALTER TABLE campaign_items DROP COLUMN claimed_at;)
  //  - realtime_leads.organization_id → binding org de leads
  //    (rollback: ALTER TABLE realtime_leads DROP COLUMN organization_id;)
  // ============================================================
  const itemCols = (db.prepare('PRAGMA table_info(campaign_items)').all() as Array<{ name: string }>).map((c) => c.name)
  if (!itemCols.includes('claimed_by')) {
    db.exec(`ALTER TABLE campaign_items ADD COLUMN claimed_by TEXT`)
  }
  if (!itemCols.includes('claimed_at')) {
    db.exec(`ALTER TABLE campaign_items ADD COLUMN claimed_at INTEGER`)
  }
  const leadCols = (db.prepare('PRAGMA table_info(realtime_leads)').all() as Array<{ name: string }>).map((c) => c.name)
  if (!leadCols.includes('organization_id')) {
    db.exec(`ALTER TABLE realtime_leads ADD COLUMN organization_id TEXT`)
  }

  // ============================================================
  // v4 — TERCERA REPARACIÓN (5.B): SUPRESIÓN Y FATIGA POR ORGANIZACIÓN
  //  - suppression_list: PK pasa de (phone) a (organization_id, phone).
  //    Las filas globales legacy se copian CONSERVADORAMENTE a la nueva lista
  //    GLOBAL restringida y auditable `global_suppression_list` (un opt-out
  //    previo jamás deja de aplicarse; no se inventa atribución por org).
  //    (rollback: ver docs/MIGRACIONES.md §v4)
  //  - contact_fatigue: PK (organization_id, phone) — el descanso comercial es
  //    de la relación con ESA organización. Filas legacy → '__legacy__'.
  // ============================================================
  const GLOBAL_LEGACY_REASON = 'migrado_v4: opt-out previo al aislamiento (política conservadora)'

  db.exec(`
    CREATE TABLE IF NOT EXISTS global_suppression_list (
      phone TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `)

  const suppCols = (db.prepare('PRAGMA table_info(suppression_list)').all() as Array<{ name: string }>).map((c) => c.name)
  if (!suppCols.includes('organization_id')) {
    // Copia conservadora de los opt-outs legacy a la lista global documentada
    db.exec(`
      INSERT OR IGNORE INTO global_suppression_list (phone, reason, created_at)
        SELECT phone, '${GLOBAL_LEGACY_REASON}', created_at FROM suppression_list;
    `)
    db.exec(`
      ALTER TABLE suppression_list RENAME TO suppression_list_v3old;
      CREATE TABLE suppression_list (
        organization_id TEXT NOT NULL,
        phone TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (organization_id, phone)
      );
      DROP TABLE suppression_list_v3old;
      CREATE INDEX IF NOT EXISTS idx_suppression_org ON suppression_list(organization_id, phone);
    `)
  }

  const fatigueCols = (db.prepare('PRAGMA table_info(contact_fatigue)').all() as Array<{ name: string }>).map((c) => c.name)
  if (!fatigueCols.includes('organization_id')) {
    db.exec(`
      ALTER TABLE contact_fatigue RENAME TO contact_fatigue_v3old;
      CREATE TABLE contact_fatigue (
        organization_id TEXT NOT NULL,
        phone TEXT NOT NULL,
        last_broadcast_at INTEGER NOT NULL,
        last_campaign_id TEXT NOT NULL,
        PRIMARY KEY (organization_id, phone)
      );
      INSERT INTO contact_fatigue (organization_id, phone, last_broadcast_at, last_campaign_id)
        SELECT '__legacy__', phone, last_broadcast_at, last_campaign_id FROM contact_fatigue_v3old;
      DROP TABLE contact_fatigue_v3old;
    `)
  }

  return db
}
