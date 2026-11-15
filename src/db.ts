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

  // (tercera reparación) WAL para concurrencia REAL multi-worker/réplica sobre el
  // mismo archivo (workers concurrentes + recuperación sin bloqueos de escritura).
  // (reauditoría ciclo 2) busy_timeout: WAL alone no evita SQLITE_BUSY en la
  // primera colisión de escrituras entre server y worker que comparten db/.
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;`)

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

    -- (fusión integral) Idempotencia PERSISTENTE de eventos con efectos externos:
-- clave orgId::eventId, purga a 7 días. Un evento repetido JAMÁS ejecuta dos veces.
    CREATE TABLE IF NOT EXISTS event_idempotency (
      key TEXT PRIMARY KEY,
      claimed_at INTEGER NOT NULL
    );

    -- (fusión integral) Auditoría de identidades de servicio y acciones administrativas.
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
  // B4 — ORGANIZACIÓN EN CADA ÍTEM (identidad verificable en claim y despacho):
  //  - campaign_items.organization_id: la org del ítem, escrita SIEMPRE al crear.
  //  - Migración histórica: los ítems existentes heredan la organización de SU
  //    campaña (la única fuente de verdad previa). Los ítems huérfanos (sin
  //    campaña existente) quedan organization_id NULL y son CUARENTENADOS por
  //    quarantineOrglessItems() al arrancar: jamás se reclaman ni despachan.
  //  (rollback: ALTER TABLE campaign_items DROP COLUMN organization_id;)
  if (!itemCols.includes('organization_id')) {
    db.exec(`ALTER TABLE campaign_items ADD COLUMN organization_id TEXT`)
  }
  db.exec(`
    UPDATE campaign_items
    SET organization_id = (SELECT c.organization_id FROM campaigns c WHERE c.id = campaign_items.campaign_id)
    WHERE organization_id IS NULL
      AND EXISTS (SELECT 1 FROM campaigns c2 WHERE c2.id = campaign_items.campaign_id AND c2.organization_id IS NOT NULL)
  `)
  const leadCols = (db.prepare('PRAGMA table_info(realtime_leads)').all() as Array<{ name: string }>).map((c) => c.name)
  if (!leadCols.includes('organization_id')) {
    db.exec(`ALTER TABLE realtime_leads ADD COLUMN organization_id TEXT`)
  }

  // ============================================================
  // (hallazgo 10, auditoría funcional 2026-11-12) campaigns.cooldown_started_at
  // Timestamp DURABLE de la pausa por enfriamiento: permite la REANUDACIÓN
  // AUTOMÁTICA de campañas PAUSED_COOLDOWN cuando el cooldown REALMENTE venció,
  // incluso tras reiniciar el proceso (el estado in-memory del Throttler se
  // pierde al reiniciar; este timestamp sobrevive).
  //  (rollback: ALTER TABLE campaigns DROP COLUMN cooldown_started_at;)
  // ============================================================
  const campaignCols = (db.prepare('PRAGMA table_info(campaigns)').all() as Array<{ name: string }>).map((c) => c.name)
  if (!campaignCols.includes('cooldown_started_at')) {
    db.exec(`ALTER TABLE campaigns ADD COLUMN cooldown_started_at INTEGER`)
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

  // ============================================================
  // PARIDAD DASHBOARD (parity/matriz.md — Fase 3, 2026-11-15): tablas para las
  // pantallas que el dashboard añade (contactos, conversaciones/chat, embudo,
  // respuestas rápidas, etiquetas, agentes, ajustes y transporte por org).
  // TODAS aditivas (IF NOT EXISTS), sin tocar el esquema vigente del motor de
  // broadcast. Convenciones: created_at/updated_at en SEGUNDOS (igual que
  // audit_log); teléfonos canónicos E.164 SIN '+' (igual que csv-importer);
  // TODO org-scoped (organization_id) como el resto del esquema v4/v5.
  // ============================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      organization_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      name TEXT,
      email TEXT,
      stage_id TEXT,
      source TEXT NOT NULL DEFAULT 'manual', -- manual | csv | lead
      notes TEXT,
      last_broadcast_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (organization_id, phone)
    );

    CREATE TABLE IF NOT EXISTS tags (
      organization_id TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (organization_id, id)
    );

    CREATE TABLE IF NOT EXISTS contact_tags (
      organization_id TEXT NOT NULL,
      contact_phone TEXT NOT NULL,
      tag_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (organization_id, contact_phone, tag_id)
    );

    CREATE TABLE IF NOT EXISTS quick_replies (
      organization_id TEXT NOT NULL,
      id TEXT NOT NULL,
      shortcut TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (organization_id, id)
    );

    CREATE TABLE IF NOT EXISTS agents (
      organization_id TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT,
      role TEXT NOT NULL DEFAULT 'agente', -- admin | agente
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (organization_id, id)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      organization_id TEXT NOT NULL,
      contact_phone TEXT NOT NULL,
      contact_name TEXT,
      last_message_at INTEGER NOT NULL,
      last_message_text TEXT,
      last_direction TEXT NOT NULL DEFAULT 'outbound', -- inbound | outbound
      unread INTEGER NOT NULL DEFAULT 0,
      assigned_agent_id TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (organization_id, contact_phone)
    );

    CREATE TABLE IF NOT EXISTS messages (
      organization_id TEXT NOT NULL,
      id TEXT NOT NULL,
      conversation_phone TEXT NOT NULL,
      direction TEXT NOT NULL, -- inbound | outbound
      text TEXT NOT NULL,
      status TEXT NOT NULL, -- SENT | FAILED | RECEIVED
      source TEXT NOT NULL DEFAULT 'chat', -- chat | campaign | webhook
      campaign_id TEXT,
      message_id TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (organization_id, id)
    );

    CREATE TABLE IF NOT EXISTS pipeline_stages (
      organization_id TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      position INTEGER NOT NULL,
      color TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (organization_id, id)
    );

    -- Configuración de transporte NO SECRETA por organización (paridad:
    -- pantalla Integraciones). Los SECRETOS jamás se persisten: solo máscara
    -- de últimos 4 caracteres para pintar el estado; las credenciales reales
    -- viven en el entorno (ADMIN/META_ORG_CREDENTIALS/INTERNAL_API_SECRET).
    CREATE TABLE IF NOT EXISTS org_transport_config (
      organization_id TEXT PRIMARY KEY,
      engine TEXT NOT NULL DEFAULT 'daemon', -- daemon | meta_cloud
      daemon_url TEXT,
      meta_phone_number_id TEXT,
      daemon_secret_last4 TEXT,
      meta_token_last4 TEXT,
      updated_at INTEGER NOT NULL
    );

    -- Ajustes del dashboard por organización (perfil, ritmo por defecto,
    -- onboarding). Valores por defecto en dashboard/store.ts.
    CREATE TABLE IF NOT EXISTS org_settings (
      organization_id TEXT PRIMARY KEY,
      brand_name TEXT,
      country TEXT,
      pacing_min_seconds INTEGER,
      pacing_max_seconds INTEGER,
      cooldown_batch_size INTEGER,
      onboarding_completed_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_contacts_org_created ON contacts(organization_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_contact_tags_tag ON contact_tags(organization_id, tag_id);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(organization_id, conversation_phone, created_at);
    CREATE INDEX IF NOT EXISTS idx_conversations_org_last ON conversations(organization_id, last_message_at DESC);
  `)

  return db
}

// (fusión integral) Registro de auditoría: la acción queda registrada con actor
// TRUNCADO (jamás la clave completa) y organización (null = identidad de servicio).
export function writeAudit(db: DatabaseSync, actor: string, orgId: string | null, action: string, resource?: string, detail?: string): void {
  try {
    db.prepare('INSERT INTO audit_log (id, actor, organization_id, action, resource, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      `aud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      actor.slice(0, 8) + '…',
      orgId,
      action,
      resource || null,
      detail || null,
      Math.floor(Date.now() / 1000),
    )
  } catch { /* la auditoría jamás rompe el tráfico */ }
}
