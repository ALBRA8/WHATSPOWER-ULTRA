/**
 * dashboard/store.ts — Acceso a datos del DASHBOARD de paridad (Fase 3).
 *
 * Reglas del encargo (parity/matriz.md):
 *  - SOLO se añade; nada del motor de broadcast se renombra ni se re-factoriza.
 *  - Todo org-scoped: la organización SIEMPRE viene de la identidad autenticada
 *    (nunca del body). Identidad de servicio (org null) debe indicar ?orgId.
 *  - Teléfonos canónicos E.164 SIN '+' vía canonicalizePhone() del importador
 *    existente (misma convención que campaign_items.contact_phone).
 *  - created_at/updated_at en SEGUNDOS (igual que audit_log).
 *  - Nada se simula: el envío de chat pasa por los checks JIT reales
 *    (supresión + lock 2A) y por el despachador configurado (api.ts).
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { canonicalizePhone, parseAudienceCsv } from '../audiences/csv-importer.ts'
import { EventIdempotencyStore } from '../security.ts'
import { writeAudit } from '../db.ts'

export type Db = DatabaseSync

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

// ============================================================
// Contactos
// ============================================================

export interface ContactRow {
  organization_id: string
  phone: string
  name: string | null
  email: string | null
  stage_id: string | null
  source: string
  notes: string | null
  last_broadcast_at: number | null
  created_at: number
  updated_at: number
  tags?: Array<{ id: string; name: string; color: string | null }>
  stageName?: string | null
}

export interface ContactListOptions {
  q?: string
  tagId?: string
  stageId?: string
  limit?: number
  offset?: number
}

export function listContacts(db: Db, org: string, opts: ContactListOptions = {}): { contacts: ContactRow[]; total: number } {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const offset = Math.max(opts.offset ?? 0, 0)
  const where = ['c.organization_id = ?']
  const params: Array<string | number> = [org]
  if (opts.q) {
    where.push('(c.phone LIKE ? OR c.name LIKE ?)')
    const like = `%${opts.q}%`
    params.push(like, like)
  }
  if (opts.stageId) {
    where.push('c.stage_id = ?')
    params.push(opts.stageId)
  }
  if (opts.tagId) {
    where.push('EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.organization_id = c.organization_id AND ct.contact_phone = c.phone AND ct.tag_id = ?)')
    params.push(opts.tagId)
  }
  const whereSql = where.join(' AND ')
  const rows = db.prepare(
    `SELECT c.* FROM contacts c WHERE ${whereSql} ORDER BY c.created_at DESC, c.phone ASC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as unknown as ContactRow[]
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM contacts c WHERE ${whereSql}`).get(...params) as { n: number }).n
  // Etiquetas y nombre de etapa por lote (evita N+1 pesado con límite acotado)
  for (const row of rows) {
    row.tags = db.prepare(
      `SELECT t.id, t.name, t.color FROM contact_tags ct JOIN tags t ON t.organization_id = ct.organization_id AND t.id = ct.tag_id
       WHERE ct.organization_id = ? AND ct.contact_phone = ? ORDER BY t.name`
    ).all(org, row.phone) as Array<{ id: string; name: string; color: string | null }>
    const stage = row.stage_id
      ? db.prepare('SELECT name FROM pipeline_stages WHERE organization_id = ? AND id = ?').get(org, row.stage_id) as { name: string } | undefined
      : undefined
    row.stageName = stage?.name ?? null
  }
  return { contacts: rows, total }
}

export function getContact(db: Db, org: string, phone: string): ContactRow | null {
  const row = db.prepare('SELECT * FROM contacts WHERE organization_id = ? AND phone = ?').get(org, phone) as ContactRow | undefined
  if (!row) return null
  row.tags = db.prepare(
    `SELECT t.id, t.name, t.color FROM contact_tags ct JOIN tags t ON t.organization_id = ct.organization_id AND t.id = ct.tag_id
     WHERE ct.organization_id = ? AND ct.contact_phone = ? ORDER BY t.name`
  ).all(org, phone) as Array<{ id: string; name: string; color: string | null }>
  return row
}

export interface ContactInput {
  phone: string
  name?: string
  email?: string
  notes?: string
  stageId?: string
  source?: string
}

/** Crea (o actualiza nombre/email/notes si ya existía). Devuelve la fila y si fue creación. */
export function upsertContact(db: Db, org: string, input: ContactInput, opts: { auditActor?: string; updateExisting?: boolean } = {}): { contact: ContactRow; created: boolean } {
  const phone = canonicalizePhone(input.phone)
  if (!phone) throw new Error('TELEFONO_INVALID: el teléfono no es E.164 válido (ej. 573001234567)')
  if (input.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email)) throw new Error('EMAIL_INVALIDO')
  const now = nowSec()
  const existing = db.prepare('SELECT phone FROM contacts WHERE organization_id = ? AND phone = ?').get(org, phone)
  if (!existing) {
    // (verificación V-10) todo contacto nuevo nace en la PRIMERA etapa del embudo:
    // el kanban muestra de inmediato a todos los contactos sin estado explícito.
    ensureDefaultStages(db, org)
    const defaultStage = (db.prepare('SELECT id FROM pipeline_stages WHERE organization_id = ? ORDER BY position LIMIT 1').get(org) as { id: string } | undefined)?.id ?? null
    db.prepare(
      `INSERT INTO contacts (organization_id, phone, name, email, stage_id, source, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(org, phone, input.name ?? null, input.email ?? null, input.stageId ?? defaultStage, input.source ?? 'manual', input.notes ?? null, now, now)
    if (opts.auditActor) writeAudit(db, opts.auditActor, org, 'contact.create', phone)
  } else if (opts.updateExisting) {
    db.prepare(
      `UPDATE contacts SET name = COALESCE(?, name), email = COALESCE(?, email), notes = COALESCE(?, notes), updated_at = ? WHERE organization_id = ? AND phone = ?`
    ).run(input.name ?? null, input.email ?? null, input.notes ?? null, now, org, phone)
    if (opts.auditActor) writeAudit(db, opts.auditActor, org, 'contact.update', phone)
  }
  const contact = getContact(db, org, phone) as ContactRow
  return { contact, created: !existing }
}

export function updateContact(db: Db, org: string, phone: string, input: Partial<ContactInput>): ContactRow | null {
  const canonical = canonicalizePhone(phone)
  if (!canonical) throw new Error('TELEFONO_INVALID')
  const existing = getContact(db, org, canonical)
  if (!existing) return null
  if (input.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email)) throw new Error('EMAIL_INVALIDO')
  if (input.stageId !== undefined && input.stageId !== null) {
    const stage = db.prepare('SELECT id FROM pipeline_stages WHERE organization_id = ? AND id = ?').get(org, input.stageId)
    if (!stage) throw new Error('ETAPA_INVALIDA: la etapa indicada no existe')
  }
  db.prepare(
    `UPDATE contacts SET name = ?, email = ?, notes = ?, stage_id = ?, updated_at = ? WHERE organization_id = ? AND phone = ?`
  ).run(
    input.name !== undefined ? input.name : existing.name,
    input.email !== undefined ? input.email : existing.email,
    input.notes !== undefined ? input.notes : existing.notes,
    input.stageId !== undefined ? input.stageId : existing.stage_id,
    nowSec(), org, canonical,
  )
  return getContact(db, org, canonical)
}

export function deleteContact(db: Db, org: string, phone: string): boolean {
  const canonical = canonicalizePhone(phone)
  if (!canonical) return false
  const res = db.prepare('DELETE FROM contacts WHERE organization_id = ? AND phone = ?').run(org, canonical)
  if (res.changes === 0) return false
  db.prepare('DELETE FROM contact_tags WHERE organization_id = ? AND contact_phone = ?').run(org, canonical)
  db.prepare('DELETE FROM messages WHERE organization_id = ? AND conversation_phone = ?').run(org, canonical)
  db.prepare('DELETE FROM conversations WHERE organization_id = ? AND contact_phone = ?').run(org, canonical)
  return true
}

/** Importa un CSV (validador E.164 + dedupe del repo) y PERSISTE los contactos. */
export function importContactsFromCsv(db: Db, org: string, csvContent: string, opts: { auditActor?: string } = {}): {
  validCount: number; duplicatesCount: number; invalidCount: number; totalProcessed: number; inserted: number; skippedExisting: number
} {
  const parsed = parseAudienceCsv(csvContent)
  let inserted = 0
  let skippedExisting = 0
  const now = nowSec()
  for (const c of parsed.contacts) {
    const exists = db.prepare('SELECT 1 AS x FROM contacts WHERE organization_id = ? AND phone = ?').get(org, c.phone)
    if (exists) { skippedExisting++; continue }
    ensureDefaultStages(db, org)
    const defaultStage = (db.prepare('SELECT id FROM pipeline_stages WHERE organization_id = ? ORDER BY position LIMIT 1').get(org) as { id: string } | undefined)?.id ?? null
    db.prepare(
      `INSERT OR IGNORE INTO contacts (organization_id, phone, name, email, stage_id, source, notes, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, 'csv', NULL, ?, ?)`
    ).run(org, c.phone, c.name ?? null, defaultStage, now, now)
    inserted++
  }
  if (opts.auditActor) writeAudit(db, opts.auditActor, org, 'contacts.import_csv', undefined, `inserted=${inserted} skipped=${skippedExisting}`)
  return {
    validCount: parsed.validCount,
    duplicatesCount: parsed.duplicatesCount + skippedExisting,
    invalidCount: parsed.invalidCount,
    totalProcessed: parsed.totalProcessed,
    inserted,
    skippedExisting,
  }
}

// ============================================================
// Etiquetas
// ============================================================

export function listTags(db: Db, org: string): Array<{ id: string; name: string; color: string | null; createdAt: number; contactCount: number }> {
  const rows = db.prepare(
    `SELECT t.*, (SELECT COUNT(*) FROM contact_tags ct WHERE ct.organization_id = t.organization_id AND ct.tag_id = t.id) AS contactCount
     FROM tags t WHERE t.organization_id = ? ORDER BY t.name`
  ).all(org) as Array<{ id: string; name: string; color: string | null; created_at: number; contactCount: number }>
  return rows.map((r) => ({ id: r.id, name: r.name, color: r.color, createdAt: r.created_at, contactCount: r.contactCount }))
}

export function createTag(db: Db, org: string, name: string, color?: string): { id: string } {
  const trimmed = (name || '').trim()
  if (!trimmed) throw new Error('NOMBRE_REQUERIDO')
  const dup = db.prepare('SELECT 1 AS x FROM tags WHERE organization_id = ? AND lower(name) = lower(?)').get(org, trimmed)
  if (dup) throw new Error('ETIQUETA_DUPLICADA: ya existe una etiqueta con ese nombre')
  const id = `tag_${randomUUID().slice(0, 8)}`
  db.prepare('INSERT INTO tags (organization_id, id, name, color, created_at) VALUES (?, ?, ?, ?, ?)').run(org, id, trimmed, color ?? null, nowSec())
  return { id }
}

export function updateTag(db: Db, org: string, id: string, name?: string, color?: string | null): boolean {
  const existing = db.prepare('SELECT id FROM tags WHERE organization_id = ? AND id = ?').get(org, id)
  if (!existing) return false
  if (name !== undefined) {
    const trimmed = (name || '').trim()
    if (!trimmed) throw new Error('NOMBRE_REQUERIDO')
    const dup = db.prepare('SELECT 1 AS x FROM tags WHERE organization_id = ? AND lower(name) = lower(?) AND id != ?').get(org, trimmed, id)
    if (dup) throw new Error('ETIQUETA_DUPLICADA: ya existe una etiqueta con ese nombre')
  }
  db.prepare('UPDATE tags SET name = COALESCE(?, name), color = CASE WHEN ? THEN ? ELSE color END WHERE organization_id = ? AND id = ?')
    .run(name !== undefined ? name.trim() : null, color !== undefined ? 1 : 0, color ?? null, org, id)
  return true
}

export function deleteTag(db: Db, org: string, id: string): boolean {
  const res = db.prepare('DELETE FROM tags WHERE organization_id = ? AND id = ?').run(org, id)
  if (res.changes === 0) return false
  db.prepare('DELETE FROM contact_tags WHERE organization_id = ? AND tag_id = ?').run(org, id)
  return true
}

export function assignTag(db: Db, org: string, phone: string, tagId: string): boolean {
  const canonical = canonicalizePhone(phone)
  if (!canonical) throw new Error('TELEFONO_INVALID')
  const contact = db.prepare('SELECT 1 AS x FROM contacts WHERE organization_id = ? AND phone = ?').get(org, canonical)
  if (!contact) return false
  const tag = db.prepare('SELECT 1 AS x FROM tags WHERE organization_id = ? AND id = ?').get(org, tagId)
  if (!tag) throw new Error('ETIQUETA_INEXISTENTE')
  db.prepare('INSERT OR IGNORE INTO contact_tags (organization_id, contact_phone, tag_id, created_at) VALUES (?, ?, ?, ?)').run(org, canonical, tagId, nowSec())
  return true
}

export function unassignTag(db: Db, org: string, phone: string, tagId: string): boolean {
  const canonical = canonicalizePhone(phone)
  if (!canonical) return false
  const res = db.prepare('DELETE FROM contact_tags WHERE organization_id = ? AND contact_phone = ? AND tag_id = ?').run(org, canonical, tagId)
  return res.changes > 0
}

// ============================================================
// Respuestas rápidas
// ============================================================

export function listQuickReplies(db: Db, org: string): unknown[] {
  return db.prepare('SELECT id, shortcut, title, body, created_at AS createdAt, updated_at AS updatedAt FROM quick_replies WHERE organization_id = ? ORDER BY shortcut').all(org)
}

export function createQuickReply(db: Db, org: string, input: { shortcut: string; title: string; body: string }): { id: string } {
  const shortcut = (input.shortcut || '').trim()
  const title = (input.title || '').trim()
  const body = (input.body || '').trim()
  if (!shortcut || !title || !body) throw new Error('CAMPOS_REQUERIDOS: atajo, título y cuerpo son obligatorios')
  const dup = db.prepare('SELECT 1 AS x FROM quick_replies WHERE organization_id = ? AND lower(shortcut) = lower(?)').get(org, shortcut)
  if (dup) throw new Error('ATAJO_DUPLICADO: ya existe una respuesta rápida con ese atajo')
  const id = `qr_${randomUUID().slice(0, 8)}`
  const now = nowSec()
  db.prepare('INSERT INTO quick_replies (organization_id, id, shortcut, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(org, id, shortcut, title, body, now, now)
  return { id }
}

export function updateQuickReply(db: Db, org: string, id: string, input: { shortcut?: string; title?: string; body?: string }): boolean {
  const existing = db.prepare('SELECT id FROM quick_replies WHERE organization_id = ? AND id = ?').get(org, id)
  if (!existing) return false
  if (input.shortcut !== undefined) {
    if (!input.shortcut.trim()) throw new Error('CAMPOS_REQUERIDOS: atajo es obligatorio')
    const dup = db.prepare('SELECT 1 AS x FROM quick_replies WHERE organization_id = ? AND lower(shortcut) = lower(?) AND id != ?').get(org, input.shortcut.trim(), id)
    if (dup) throw new Error('ATAJO_DUPLICADO: ya existe una respuesta rápida con ese atajo')
  }
  db.prepare('UPDATE quick_replies SET shortcut = COALESCE(?, shortcut), title = COALESCE(?, title), body = COALESCE(?, body), updated_at = ? WHERE organization_id = ? AND id = ?')
    .run(input.shortcut?.trim() ?? null, input.title?.trim() ?? null, input.body?.trim() ?? null, nowSec(), org, id)
  return true
}

export function deleteQuickReply(db: Db, org: string, id: string): boolean {
  return db.prepare('DELETE FROM quick_replies WHERE organization_id = ? AND id = ?').run(org, id).changes > 0
}

// ============================================================
// Agentes
// ============================================================

export function listAgents(db: Db, org: string): unknown[] {
  return db.prepare(
    `SELECT a.*, (SELECT COUNT(*) FROM conversations c WHERE c.organization_id = a.organization_id AND c.assigned_agent_id = a.id) AS assignedConversations
     FROM agents a WHERE a.organization_id = ? ORDER BY a.created_at DESC`
  ).all(org)
}

export function createAgent(db: Db, org: string, input: { name: string; email?: string; role?: string }): { id: string } {
  const name = (input.name || '').trim()
  if (!name) throw new Error('NOMBRE_REQUERIDO')
  const role = input.role || 'agente'
  if (!['admin', 'agente'].includes(role)) throw new Error('ROL_INVALIDO: debe ser admin o agente')
  if (input.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email)) throw new Error('EMAIL_INVALIDO')
  const id = `agt_${randomUUID().slice(0, 8)}`
  db.prepare('INSERT INTO agents (organization_id, id, name, email, role, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
    .run(org, id, name, input.email ?? null, role, nowSec())
  return { id }
}

export function updateAgent(db: Db, org: string, id: string, input: { name?: string; email?: string | null; role?: string; active?: boolean }): boolean {
  const existing = db.prepare('SELECT id FROM agents WHERE organization_id = ? AND id = ?').get(org, id)
  if (!existing) return false
  if (input.role !== undefined && !['admin', 'agente'].includes(input.role)) throw new Error('ROL_INVALIDO: debe ser admin o agente')
  if (input.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email)) throw new Error('EMAIL_INVALIDO')
  db.prepare('UPDATE agents SET name = COALESCE(?, name), email = CASE WHEN ? THEN ? ELSE email END, role = COALESCE(?, role), active = COALESCE(?, active) WHERE organization_id = ? AND id = ?')
    .run(input.name?.trim() ?? null, input.email !== undefined ? 1 : 0, input.email ?? null, input.role ?? null, input.active === undefined ? null : input.active ? 1 : 0, org, id)
  return true
}

export function deleteAgent(db: Db, org: string, id: string): boolean {
  const res = db.prepare('DELETE FROM agents WHERE organization_id = ? AND id = ?').run(org, id)
  if (res.changes === 0) return false
  // Las conversaciones del agente borrado quedan SIN asignar (regla del inventario §4.10)
  db.prepare('UPDATE conversations SET assigned_agent_id = NULL WHERE organization_id = ? AND assigned_agent_id = ?').run(org, id)
  return true
}

// ============================================================
// Embudo / Pipeline
// ============================================================

export const DEFAULT_STAGES: Array<{ name: string; color: string }> = [
  { name: 'Nuevo', color: '#3b82f6' },
  { name: 'Contactado', color: '#8b5cf6' },
  { name: 'Interesado', color: '#f59e0b' },
  { name: 'Cliente', color: '#10b981' },
]

/** Crea las etapas por defecto si la org no tiene ninguna (idempotente). */
export function ensureDefaultStages(db: Db, org: string): void {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM pipeline_stages WHERE organization_id = ?').get(org) as { n: number }).n
  if (count > 0) return
  const now = nowSec()
  DEFAULT_STAGES.forEach((s, i) => {
    db.prepare('INSERT INTO pipeline_stages (organization_id, id, name, position, color, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(org, `stg_${randomUUID().slice(0, 8)}`, s.name, i + 1, s.color, now)
  })
}

export function listStages(db: Db, org: string): Array<{ id: string; name: string; position: number; color: string | null; contactCount: number }> {
  ensureDefaultStages(db, org)
  return db.prepare(
    `SELECT s.*, (SELECT COUNT(*) FROM contacts c WHERE c.organization_id = s.organization_id AND c.stage_id = s.id) AS contactCount
     FROM pipeline_stages s WHERE s.organization_id = ? ORDER BY s.position`
  ).all(org) as Array<{ id: string; name: string; position: number; color: string | null; contactCount: number }>
}

export function createStage(db: Db, org: string, name: string, color?: string): { id: string } {
  const trimmed = (name || '').trim()
  if (!trimmed) throw new Error('NOMBRE_REQUERIDO')
  const maxPos = (db.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM pipeline_stages WHERE organization_id = ?').get(org) as { m: number }).m
  const id = `stg_${randomUUID().slice(0, 8)}`
  db.prepare('INSERT INTO pipeline_stages (organization_id, id, name, position, color, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(org, id, trimmed, maxPos + 1, color ?? null, nowSec())
  return { id }
}

export function updateStage(db: Db, org: string, id: string, input: { name?: string; position?: number; color?: string | null }): boolean {
  const existing = db.prepare('SELECT id FROM pipeline_stages WHERE organization_id = ? AND id = ?').get(org, id)
  if (!existing) return false
  if (input.name !== undefined && !input.name.trim()) throw new Error('NOMBRE_REQUERIDO')
  if (input.position !== undefined && (!Number.isInteger(input.position) || input.position < 1)) throw new Error('POSICION_INVALIDA')
  db.prepare('UPDATE pipeline_stages SET name = COALESCE(?, name), position = COALESCE(?, position), color = CASE WHEN ? THEN ? ELSE color END WHERE organization_id = ? AND id = ?')
    .run(input.name?.trim() ?? null, input.position ?? null, input.color !== undefined ? 1 : 0, input.color ?? null, org, id)
  return true
}

/** Borra la etapa y MUEVE sus contactos a la primera etapa restante (regla del inventario §4.6). */
export function deleteStage(db: Db, org: string, id: string): { movedContacts: number } | null {
  const remaining = db.prepare('SELECT id FROM pipeline_stages WHERE organization_id = ? AND id != ? ORDER BY position LIMIT 1').all(org, id)
  if (remaining.length === 0) throw new Error('ULTIMA_ETAPA: no se puede borrar la única etapa del embudo')
  const fallback = (remaining[0] as { id: string }).id
  const moved = Number(db.prepare('UPDATE contacts SET stage_id = ?, updated_at = ? WHERE organization_id = ? AND stage_id = ?').run(fallback, nowSec(), org, id).changes)
  const res = db.prepare('DELETE FROM pipeline_stages WHERE organization_id = ? AND id = ?').run(org, id)
  if (res.changes === 0) return null
  return { movedContacts: moved }
}

/** Mueve un contacto de etapa con IDEMPOTENCIA por eventId (patrón Oleada 2 del CRM). */
export function moveContactStage(db: Db, org: string, phone: string, stageId: string, eventId: string, opts: { auditActor?: string } = {}): { ok: true; duplicate?: boolean } {
  const idem = new EventIdempotencyStore(db)
  const claim = idem.claim(org, eventId)
  if (claim === 'duplicate') return { ok: true, duplicate: true }
  const canonical = canonicalizePhone(phone)
  if (!canonical) throw new Error('TELEFONO_INVALID')
  const contact = db.prepare('SELECT 1 AS x FROM contacts WHERE organization_id = ? AND phone = ?').get(org, canonical)
  if (!contact) throw new Error('CONTACTO_INEXISTENTE')
  const stage = db.prepare('SELECT id FROM pipeline_stages WHERE organization_id = ? AND id = ?').get(org, stageId)
  if (!stage) throw new Error('ETAPA_INVALIDA: la etapa indicada no existe')
  db.prepare('UPDATE contacts SET stage_id = ?, updated_at = ? WHERE organization_id = ? AND phone = ?').run(stageId, nowSec(), org, canonical)
  if (opts.auditActor) writeAudit(db, opts.auditActor, org, 'pipeline.move', canonical, `to=${stageId} eventId=${eventId.slice(0, 12)}`)
  return { ok: true }
}

// ============================================================
// Conversaciones y mensajes (chat)
// ============================================================

export function ensureConversation(db: Db, org: string, phone: string, name?: string | null): void {
  const canonical = canonicalizePhone(phone)
  if (!canonical) throw new Error('TELEFONO_INVALID')
  const now = nowSec()
  // (verificación V-12) IDEMPOTENTE: responder a una conversación existente NO
  // debe chocar con la PK (organization_id, contact_phone) — bug real detectado
  // en la verificación con clics: el mensaje salía por el transporte y la
  // persistencia fallaba con UNIQUE constraint. INSERT OR IGNORE lo cierra.
  db.prepare(
    `INSERT OR IGNORE INTO conversations (organization_id, contact_phone, contact_name, last_message_at, last_message_text, last_direction, unread, created_at)
     VALUES (?, ?, ?, ?, NULL, 'outbound', 0, ?)`
  ).run(org, canonical, name ?? null, now, now)
}

export interface ConversationSummary {
  contact_phone: string
  contact_name: string | null
  last_message_at: number
  last_message_text: string | null
  last_direction: string
  unread: number
  assigned_agent_id: string | null
  assignedAgentName: string | null
}

export function listConversations(db: Db, org: string, opts: { q?: string; unreadOnly?: boolean; limit?: number; offset?: number } = {}): { conversations: ConversationSummary[]; total: number } {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const offset = Math.max(opts.offset ?? 0, 0)
  const where = ['c.organization_id = ?']
  const params: Array<string | number> = [org]
  if (opts.q) {
    where.push('(c.contact_phone LIKE ? OR c.contact_name LIKE ?)')
    const like = `%${opts.q}%`
    params.push(like, like)
  }
  if (opts.unreadOnly) where.push('c.unread > 0')
  const whereSql = where.join(' AND ')
  const rows = db.prepare(
    `SELECT c.*, a.name AS assignedAgentName FROM conversations c
     LEFT JOIN agents a ON a.organization_id = c.organization_id AND a.id = c.assigned_agent_id
     WHERE ${whereSql} ORDER BY c.last_message_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as unknown as ConversationSummary[]
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM conversations c WHERE ${whereSql}`).get(...params) as { n: number }).n
  return { conversations: rows, total }
}

export function getConversationThread(db: Db, org: string, phone: string, opts: { markRead?: boolean } = {}): {
  conversation: ConversationSummary | null; messages: Array<Record<string, unknown>>
} {
  const canonical = canonicalizePhone(phone)
  if (!canonical) throw new Error('TELEFONO_INVALID')
  const conversation = db.prepare(
    `SELECT c.*, a.name AS assignedAgentName FROM conversations c
     LEFT JOIN agents a ON a.organization_id = c.organization_id AND a.id = c.assigned_agent_id
     WHERE c.organization_id = ? AND c.contact_phone = ?`
  ).get(org, canonical) as ConversationSummary | undefined
  const messages = db.prepare(
    `SELECT id, direction, text, status, source, campaign_id AS campaignId, message_id AS messageId, error, created_at AS createdAt
     FROM messages WHERE organization_id = ? AND conversation_phone = ? ORDER BY created_at ASC, id ASC`
  ).all(org, canonical)
  if (conversation && opts.markRead) {
    db.prepare('UPDATE conversations SET unread = 0 WHERE organization_id = ? AND contact_phone = ?').run(org, canonical)
  }
  return { conversation: conversation ?? null, messages }
}

export function recordInboundMessage(db: Db, org: string, input: {
  phone: string; name?: string; text: string; messageId?: string; campaignId?: string; source?: string
}): { messageRow: Record<string, unknown>; contactCreated: boolean } {
  const canonical = canonicalizePhone(input.phone)
  if (!canonical) throw new Error('TELEFONO_INVALID')
  const text = (input.text || '').trim()
  if (!text) throw new Error('TEXTO_REQUERIDO')
  const now = nowSec()
  // Un mensaje entrante ES un contacto (origen 'lead'): se crea si es nuevo
  const exists = db.prepare('SELECT 1 AS x FROM contacts WHERE organization_id = ? AND phone = ?').get(org, canonical)
  let contactCreated = false
  if (!exists) {
    ensureDefaultStages(db, org)
    const defaultStage = (db.prepare('SELECT id FROM pipeline_stages WHERE organization_id = ? ORDER BY position LIMIT 1').get(org) as { id: string } | undefined)?.id ?? null
    db.prepare(
      `INSERT INTO contacts (organization_id, phone, name, email, stage_id, source, notes, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, 'lead', NULL, ?, ?)`
    ).run(org, canonical, input.name ?? null, defaultStage, now, now)
    contactCreated = true
  }
  ensureConversation(db, org, canonical, input.name ?? null)
  const id = `msg_${randomUUID()}`
  db.prepare(
    `INSERT INTO messages (organization_id, id, conversation_phone, direction, text, status, source, campaign_id, message_id, error, created_at)
     VALUES (?, ?, ?, 'inbound', ?, 'RECEIVED', ?, ?, ?, NULL, ?)`
  ).run(org, id, canonical, text, input.source ?? 'webhook', input.campaignId ?? null, input.messageId ?? null, now)
  db.prepare(
    `UPDATE conversations SET last_message_at = ?, last_message_text = ?, last_direction = 'inbound', unread = unread + 1,
     contact_name = COALESCE(?, contact_name) WHERE organization_id = ? AND contact_phone = ?`
  ).run(now, text, input.name ?? null, org, canonical)
  return {
    messageRow: { id, direction: 'inbound', text, status: 'RECEIVED', source: input.source ?? 'webhook', createdAt: now },
    contactCreated,
  }
}

export function recordOutboundMessage(db: Db, org: string, input: {
  phone: string; text: string; status: string; error?: string | null; messageId?: string | null; campaignId?: string | null; source?: string
}): Record<string, unknown> {
  const canonical = canonicalizePhone(input.phone)
  if (!canonical) throw new Error('TELEFONO_INVALID')
  const now = nowSec()
  ensureConversation(db, org, canonical)
  const id = `msg_${randomUUID()}`
  db.prepare(
    `INSERT INTO messages (organization_id, id, conversation_phone, direction, text, status, source, campaign_id, message_id, error, created_at)
     VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?)`
  ).run(org, id, canonical, input.text, input.status, input.source ?? 'chat', input.campaignId ?? null, input.messageId ?? null, input.error ?? null, now)
  db.prepare(
    `UPDATE conversations SET last_message_at = ?, last_message_text = ?, last_direction = 'outbound' WHERE organization_id = ? AND contact_phone = ?`
  ).run(now, input.text, org, canonical)
  db.prepare('UPDATE contacts SET last_broadcast_at = ?, updated_at = ? WHERE organization_id = ? AND phone = ? AND last_broadcast_at IS NULL AND ? = 1')
    .run(now, now, org, canonical, input.status === 'SENT' ? 1 : 0)
  return { id, direction: 'outbound', text: input.text, status: input.status, source: input.source ?? 'chat', error: input.error ?? null, createdAt: now }
}

export function assignConversation(db: Db, org: string, phone: string, agentId: string | null): boolean {
  const canonical = canonicalizePhone(phone)
  if (!canonical) return false
  if (agentId) {
    const agent = db.prepare('SELECT 1 AS x FROM agents WHERE organization_id = ? AND id = ?').get(org, agentId)
    if (!agent) throw new Error('AGENTE_INEXISTENTE')
  }
  const res = db.prepare('UPDATE conversations SET assigned_agent_id = ? WHERE organization_id = ? AND contact_phone = ?').run(agentId, org, canonical)
  return res.changes > 0
}

/** Inbound con IDEMPOTENCIA por eventId (mismo patrón que webhook-lead): un evento repetido jamás crea dos mensajes. */
export function recordInboundWithIdempotency(db: Db, org: string, input: {
  phone: string; name?: string; text: string; messageId?: string; campaignId?: string; source?: string
}, eventId: string): { duplicate?: boolean; contactCreated?: boolean; messageRow?: Record<string, unknown> } {
  const idem = new EventIdempotencyStore(db)
  const claim = idem.claim(org, eventId)
  if (claim === 'duplicate') return { duplicate: true }
  const result = recordInboundMessage(db, org, input)
  return { contactCreated: result.contactCreated, messageRow: result.messageRow }
}

// ============================================================
// Resumen (métricas reales agregadas)
// ============================================================

export function dashboardSummary(db: Db, org: string): Record<string, unknown> {
  const one = (sql: string, ...params: Array<string | number>): number => (db.prepare(sql).get(...params) as { n: number | null }).n ?? 0
  const campaignsActive = one(
    `SELECT COUNT(*) AS n FROM campaigns WHERE organization_id = ? AND status IN ('RUNNING','PAUSED','PAUSED_OFF_HOURS','PAUSED_COOLDOWN')`, org)
  const campaignsTotal = one(`SELECT COUNT(*) AS n FROM campaigns WHERE organization_id = ?`, org)
  const sentTotal = one(`SELECT COALESCE(SUM(sent_count), 0) AS n FROM campaigns WHERE organization_id = ?`, org)
  const failedTotal = one(`SELECT COALESCE(SUM(failed_count), 0) AS n FROM campaigns WHERE organization_id = ?`, org)
  const skippedTotal = one(`SELECT COALESCE(SUM(skipped_count), 0) AS n FROM campaigns WHERE organization_id = ?`, org)
  const clicks = one(
    `SELECT COALESCE(SUM(l.clicks), 0) AS n FROM tracked_links l JOIN campaigns c ON c.id = l.campaign_id WHERE c.organization_id = ?`, org)
  const contactsTotal = one(`SELECT COUNT(*) AS n FROM contacts WHERE organization_id = ?`, org)
  const suppressedTotal = one(`SELECT COUNT(*) AS n FROM suppression_list WHERE organization_id = ?`, org)
  const conversationsTotal = one(`SELECT COUNT(*) AS n FROM conversations WHERE organization_id = ?`, org)
  const unreadTotal = one(`SELECT COALESCE(SUM(unread), 0) AS n FROM conversations WHERE organization_id = ?`, org)
  const ctrPercent = sentTotal > 0 ? Math.round((clicks / sentTotal) * 1000) / 10 : 0
  return {
    campaignsActive, campaignsTotal, sentTotal, failedTotal, skippedTotal,
    clicks, ctrPercent, contactsTotal, suppressedTotal, conversationsTotal, unreadTotal,
  }
}

// ============================================================
// Ajustes y transporte por organización
// ============================================================

export interface OrgSettings {
  brandName: string | null
  country: string | null
  pacingMinSeconds: number | null
  pacingMaxSeconds: number | null
  cooldownBatchSize: number | null
  onboardingCompletedAt: number | null
}

export function getSettings(db: Db, org: string): OrgSettings {
  const row = db.prepare('SELECT * FROM org_settings WHERE organization_id = ?').get(org) as any
  if (!row) {
    return { brandName: null, country: null, pacingMinSeconds: 20, pacingMaxSeconds: 45, cooldownBatchSize: 25, onboardingCompletedAt: null }
  }
  return {
    brandName: row.brand_name ?? null,
    country: row.country ?? null,
    pacingMinSeconds: row.pacing_min_seconds ?? null,
    pacingMaxSeconds: row.pacing_max_seconds ?? null,
    cooldownBatchSize: row.cooldown_batch_size ?? null,
    onboardingCompletedAt: row.onboarding_completed_at ?? null,
  }
}

export function updateSettings(db: Db, org: string, input: Partial<OrgSettings> & { onboardingCompleted?: boolean }, opts: { auditActor?: string } = {}): OrgSettings {
  if (input.pacingMinSeconds != null && (input.pacingMinSeconds < 5 || input.pacingMinSeconds > 600)) throw new Error('RITMO_INVALIDO: pacingMinSeconds entre 5 y 600')
  if (input.pacingMaxSeconds != null && (input.pacingMaxSeconds < 5 || input.pacingMaxSeconds > 600)) throw new Error('RITMO_INVALIDO: pacingMaxSeconds entre 5 y 600')
  if (input.pacingMinSeconds != null && input.pacingMaxSeconds != null && input.pacingMinSeconds > input.pacingMaxSeconds) {
    throw new Error('RITMO_INVALIDO: el mínimo no puede superar el máximo')
  }
  if (input.cooldownBatchSize != null && (input.cooldownBatchSize < 5 || input.cooldownBatchSize > 200)) throw new Error('RITMO_INVALIDO: cooldownBatchSize entre 5 y 200')
  db.prepare(
    `INSERT INTO org_settings (organization_id, brand_name, country, pacing_min_seconds, pacing_max_seconds, cooldown_batch_size, onboarding_completed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(organization_id) DO UPDATE SET
       brand_name = COALESCE(excluded.brand_name, brand_name),
       country = COALESCE(excluded.country, country),
       pacing_min_seconds = COALESCE(excluded.pacing_min_seconds, pacing_min_seconds),
       pacing_max_seconds = COALESCE(excluded.pacing_max_seconds, pacing_max_seconds),
       cooldown_batch_size = COALESCE(excluded.cooldown_batch_size, cooldown_batch_size),
       onboarding_completed_at = COALESCE(excluded.onboarding_completed_at, onboarding_completed_at),
       updated_at = excluded.updated_at`
  ).run(
    org, input.brandName ?? null, input.country ?? null, input.pacingMinSeconds ?? null, input.pacingMaxSeconds ?? null,
    input.cooldownBatchSize ?? null, input.onboardingCompleted ? nowSec() : null, nowSec(),
  )
  if (opts.auditActor) writeAudit(db, opts.auditActor, org, 'settings.update')
  return getSettings(db, org)
}

export interface TransportConfig {
  engine: 'daemon' | 'meta_cloud'
  daemonUrl: string | null
  metaPhoneNumberId: string | null
  daemonSecretLast4: string | null
  metaTokenLast4: string | null
  updatedAt: number | null
}

export function getTransport(db: Db, org: string): TransportConfig {
  const row = db.prepare('SELECT * FROM org_transport_config WHERE organization_id = ?').get(org) as any
  if (!row) return { engine: 'daemon', daemonUrl: null, metaPhoneNumberId: null, daemonSecretLast4: null, metaTokenLast4: null, updatedAt: null }
  return {
    engine: row.engine === 'meta_cloud' ? 'meta_cloud' : 'daemon',
    daemonUrl: row.daemon_url ?? null,
    metaPhoneNumberId: row.meta_phone_number_id ?? null,
    daemonSecretLast4: row.daemon_secret_last4 ?? null,
    metaTokenLast4: row.meta_token_last4 ?? null,
    updatedAt: row.updated_at ?? null,
  }
}

export function updateTransport(db: Db, org: string, input: {
  engine?: string; daemonUrl?: string | null; metaPhoneNumberId?: string | null; daemonSecret?: string | null; metaToken?: string | null
}, opts: { auditActor?: string } = {}): TransportConfig {
  if (input.engine !== undefined && !['daemon', 'meta_cloud'].includes(input.engine)) {
    throw new Error('MOTOR_INVALIDO: engine debe ser daemon o meta_cloud')
  }
  if (input.daemonUrl && !/^https?:\/\/.+/.test(input.daemonUrl)) throw new Error('URL_INVALIDA: daemon_url debe ser http(s)')
  const current = getTransport(db, org)
  const engine = input.engine ?? current.engine
  const mask = (s: string | null | undefined) => (s && s.length >= 4 ? `…${s.slice(-4)}` : null)
  db.prepare(
    `INSERT INTO org_transport_config (organization_id, engine, daemon_url, meta_phone_number_id, daemon_secret_last4, meta_token_last4, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(organization_id) DO UPDATE SET
       engine = excluded.engine,
       daemon_url = excluded.daemon_url,
       meta_phone_number_id = excluded.meta_phone_number_id,
       daemon_secret_last4 = excluded.daemon_secret_last4,
       meta_token_last4 = excluded.meta_token_last4,
       updated_at = excluded.updated_at`
  ).run(
    org, engine,
    input.daemonUrl !== undefined ? input.daemonUrl : current.daemonUrl,
    input.metaPhoneNumberId !== undefined ? input.metaPhoneNumberId : current.metaPhoneNumberId,
    input.daemonSecret !== undefined ? mask(input.daemonSecret) : current.daemonSecretLast4,
    input.metaToken !== undefined ? mask(input.metaToken) : current.metaTokenLast4,
    nowSec(),
  )
  if (opts.auditActor) writeAudit(db, opts.auditActor, org, 'transport.update', undefined, `engine=${engine}`)
  return getTransport(db, org)
}
