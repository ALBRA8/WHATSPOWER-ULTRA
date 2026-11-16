/**
 * dashboard/api.ts — Endpoints REST del dashboard de paridad (Fase 3).
 *
 * Se REGISTRA al final del enrutado de src/server.ts (antes del 404). Toda ruta
 * /api/* ya pasó la puerta de autenticación del server (Bearer ADMIN_API_KEYS o
 * sesión de studio por cookie) — aquí la identidad viene dada y la organización
 * SIEMPRE se deriva de ella:
 *   - identidad ligada (org !== null) → esa org, sin excepción;
 *   - identidad de servicio (org === null) → exige ?orgId (o 'default').
 * Nada se simula: el envío de chat ejecuta los checks JIT reales (supresión
 * local+2A, lock 2A) y despacha por el transporte configurado del engine.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { canonicalizePhone } from '../audiences/csv-importer.ts'
import {
  STUDIO_SESSION_COOKIE,
  STUDIO_SESSION_TTL_SECONDS,
  readBody,
  checkWebhookSecurity,
  resolveLeadSecrets,
  LEGACY_LEAD_ORG,
  type AdminIdentity,
  type LeadSecretSpec,
  type RateLimiter,
  type ReplayCache,
  type DurableReplayCache,
} from '../security.ts'
import { writeAudit } from '../db.ts'
import {
  listContacts, getContact, upsertContact, updateContact, deleteContact, importContactsFromCsv,
  listTags, createTag, updateTag, deleteTag, assignTag, unassignTag,
  listQuickReplies, createQuickReply, updateQuickReply, deleteQuickReply,
  listAgents, createAgent, updateAgent, deleteAgent,
  listStages, createStage, updateStage, deleteStage, moveContactStage,
  listConversations, getConversationThread, recordInboundMessage, recordOutboundMessage, assignConversation, recordInboundWithIdempotency,
  dashboardSummary, getSettings, updateSettings, getTransport, updateTransport,
} from './store.ts'
import type { DatabaseSync } from 'node:sqlite'

export interface DashboardCtx {
  db: DatabaseSync
  identity: AdminIdentity
  dispatcher: any
  lockChecker: any
  suppressionStore: any
  leadReplay: ReplayCache | DurableReplayCache
  leadRate: RateLimiter
  leadSecretSpec: LeadSecretSpec
}

function json(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(obj))
}

function readJson(raw: string): Record<string, any> {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Resolución de organización (jamás del body para identidades ligadas). */
function orgOf(ctx: DashboardCtx, url: URL): string {
  if (ctx.identity.org !== null) return ctx.identity.org
  const explicit = (url.searchParams.get('orgId') || '').trim()
  return explicit || 'default'
}

async function readJsonObject(req: IncomingMessage): Promise<{ ok: true; body: Record<string, any> } | { ok: false; status: number; error: string }> {
  const rb = await readBody(req)
  if (!rb.ok) return { ok: false, status: 413, error: 'Payload demasiado grande' }
  return { ok: true, body: readJson(rb.body) }
}

/** handling de errores de negocio (400/404/409) del store. */
function errorStatus(e: any): number {
  const msg = String(e?.message || '')
  if (msg.startsWith('CONTACTO_INEXISTENTE')) return 404
  if (/DUPLICAD|INVALIDO|REQUERIDOS?|INVALIDA|ROL_INVALIDO|ULTIMA_ETAPA|RITMO_INVALIDO|MOTOR_INVALIDO|URL_INVALIDA|TELEFONO_INVALID|TEXTO_REQUERIDO|POSICION_INVALIDA/.test(msg)) return 400
  return 400
}

const TERMINAL_CAMPAIGN_STATUSES = ['COMPLETED', 'CANCELLED', 'FAILED']

export async function handleDashboardApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: DashboardCtx,
): Promise<boolean> {
  const method = req.method || 'GET'
  const path = url.pathname
  const org = orgOf(ctx, url)
  const actor = ctx.identity.key

  // ---------- Resumen ----------
  if (method === 'GET' && path === '/api/dashboard/summary') {
    json(res, 200, dashboardSummary(ctx.db, org))
    return true
  }

  // ---------- Ajustes ----------
  if (method === 'GET' && path === '/api/settings') {
    json(res, 200, getSettings(ctx.db, org))
    return true
  }

  // ---------- Sesión ----------
  // La cookie de studio es stateless (orgIndex.iat.firma, TTL 1 h): la caducidad
  // se puede mostrar en pantalla sin guardar nada más.
  if (method === 'GET' && path === '/api/session') {
    const raw = String(req.headers.cookie || '')
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${STUDIO_SESSION_COOKIE}=`))
    let issuedAt: number | null = null
    if (raw) {
      const iat = Number.parseInt(raw.slice(STUDIO_SESSION_COOKIE.length + 1).split('.')[1] || '', 10)
      if (Number.isFinite(iat)) issuedAt = iat
    }
    json(res, 200, {
      authenticated: true,
      issuedAt,
      expiresAt: issuedAt === null ? null : issuedAt + STUDIO_SESSION_TTL_SECONDS * 1000,
      ttlSeconds: STUDIO_SESSION_TTL_SECONDS,
      now: Date.now(),
    })
    return true
  }
  if (method === 'PUT' && path === '/api/settings') {
    const rb = await readJsonObject(req)
    if (!rb.ok) return json(res, rb.status, { error: rb.error }), true
    try {
      json(res, 200, updateSettings(ctx.db, org, rb.body, { auditActor: actor }))
    } catch (e: any) {
      json(res, errorStatus(e), { error: e.message })
    }
    return true
  }

  // ---------- Contactos ----------
  if (method === 'GET' && path === '/api/contacts') {
    const q = url.searchParams.get('q') || undefined
    const tagId = url.searchParams.get('tagId') || undefined
    const stageId = url.searchParams.get('stageId') || undefined
    const limit = parseInt(url.searchParams.get('limit') || '50', 10)
    const offset = parseInt(url.searchParams.get('offset') || '0', 10)
    json(res, 200, listContacts(ctx.db, org, { q, tagId, stageId, limit, offset }))
    return true
  }
  if (method === 'POST' && path === '/api/contacts') {
    const rb = await readJsonObject(req)
    if (!rb.ok) return json(res, rb.status, { error: rb.error }), true
    try {
      const phone = canonicalizePhone(String(rb.body.phone || ''))
      if (phone && getContact(ctx.db, org, phone)) {
        return json(res, 409, { error: 'CONTACTO_DUPLICADO: ya existe un contacto con ese teléfono' }), true
      }
      const { contact, created } = upsertContact(ctx.db, org, {
        phone: String(rb.body.phone || ''),
        name: rb.body.name ? String(rb.body.name) : undefined,
        email: rb.body.email ? String(rb.body.email) : undefined,
        notes: rb.body.notes ? String(rb.body.notes) : undefined,
        source: 'manual',
      }, { auditActor: actor })
      json(res, created ? 201 : 200, { contact, created })
    } catch (e: any) {
      json(res, errorStatus(e), { error: e.message })
    }
    return true
  }
  if (method === 'POST' && path === '/api/contacts/import-csv') {
    const rb = await readJsonObject(req)
    if (!rb.ok) return json(res, rb.status, { error: rb.error }), true
    try {
      const result = importContactsFromCsv(ctx.db, org, String(rb.body.csvContent || ''), { auditActor: actor })
      json(res, 200, result)
    } catch (e: any) {
      json(res, 400, { error: e.message })
    }
    return true
  }
  if (method === 'GET' && path === '/api/contacts/export.csv') {
    // Exportación COMPLETA (antes se cortaba en 200 filas): recorre todas las
    // páginas del mismo filtro que muestra la pantalla y escapa comas/comillas.
    const stages = listStages(ctx.db, org)
    const stageById = new Map(stages.map((s) => [s.id, s.name]))
    const csvCell = (v: unknown): string => {
      const s = v === null || v === undefined ? '' : String(v)
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const lines = ['phone,name,email,stage,source,created_at']
    const q = url.searchParams.get('q') || undefined
    const tagId = url.searchParams.get('tagId') || undefined
    const stageId = url.searchParams.get('stageId') || undefined
    const pageSize = 200
    const maxRows = 100000
    let offset = 0
    let total = Number.POSITIVE_INFINITY
    while (offset < total && lines.length - 1 < maxRows) {
      const page = listContacts(ctx.db, org, { q, tagId, stageId, limit: pageSize, offset })
      total = page.total
      if (page.contacts.length === 0) break
      for (const c of page.contacts) {
        const stageName = c.stage_id ? stageById.get(c.stage_id) || '' : ''
        lines.push([c.phone, c.name || '', c.email || '', stageName, c.source, new Date(c.created_at * 1000).toISOString()].map(csvCell).join(','))
      }
      offset += page.contacts.length
    }
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="contacts.csv"' })
    res.end(lines.join('\n'))
    return true
  }
  {
    const m = path.match(/^\/api\/contacts\/([^/]+)$/)
    if (m && ['GET', 'PUT', 'DELETE'].includes(method)) {
      const phone = decodeURIComponent(m[1])
      try {
        if (method === 'GET') {
          const contact = getContact(ctx.db, org, phone)
          if (!contact) return json(res, 404, { error: 'Contacto no encontrado' }), true
          return json(res, 200, { contact }), true
        }
        if (method === 'PUT') {
          const rb = await readJsonObject(req)
          if (!rb.ok) return json(res, rb.status, { error: rb.error }), true
          const contact = updateContact(ctx.db, org, phone, {
            name: rb.body.name !== undefined ? String(rb.body.name) : undefined,
            email: rb.body.email !== undefined ? String(rb.body.email) : undefined,
            notes: rb.body.notes !== undefined ? String(rb.body.notes) : undefined,
            stageId: rb.body.stageId !== undefined ? String(rb.body.stageId) : undefined,
          })
          if (!contact) return json(res, 404, { error: 'Contacto no encontrado' }), true
          writeAudit(ctx.db, actor, org, 'contact.update', phone)
          return json(res, 200, { contact }), true
        }
        const ok = deleteContact(ctx.db, org, phone)
        if (!ok) return json(res, 404, { error: 'Contacto no encontrado' }), true
        writeAudit(ctx.db, actor, org, 'contact.delete', phone)
        return json(res, 200, { ok: true }), true
      } catch (e: any) {
        return json(res, errorStatus(e), { error: e.message }), true
      }
    }
  }
  {
    const m = path.match(/^\/api\/contacts\/([^/]+)\/tags\/([^/]+)$/)
    if (m && (method === 'POST' || method === 'DELETE')) {
      const phone = decodeURIComponent(m[1])
      const tagId = decodeURIComponent(m[2])
      try {
        if (method === 'POST') {
          const ok = assignTag(ctx.db, org, phone, tagId)
          if (!ok) return json(res, 404, { error: 'Contacto no encontrado' }), true
          return json(res, 200, { ok: true }), true
        }
        const ok = unassignTag(ctx.db, org, phone, tagId)
        return json(res, 200, { ok }), true
      } catch (e: any) {
        return json(res, errorStatus(e), { error: e.message }), true
      }
    }
  }

  // ---------- Etiquetas ----------
  if (method === 'GET' && path === '/api/tags') {
    json(res, 200, { tags: listTags(ctx.db, org) })
    return true
  }
  if (method === 'POST' && path === '/api/tags') {
    const rb = await readJsonObject(req)
    if (!rb.ok) return json(res, rb.status, { error: rb.error }), true
    try {
      json(res, 201, createTag(ctx.db, org, String(rb.body.name || ''), rb.body.color ? String(rb.body.color) : undefined))
    } catch (e: any) {
      json(res, String(e.message).includes('DUPLICADA') ? 409 : errorStatus(e), { error: e.message })
    }
    return true
  }
  {
    const m = path.match(/^\/api\/tags\/([^/]+)$/)
    if (m && ['PUT', 'DELETE'].includes(method)) {
      const id = decodeURIComponent(m[1])
      try {
        if (method === 'PUT') {
          const rb = await readJsonObject(req)
          if (!rb.ok) return json(res, rb.status, { error: rb.error }), true
          const ok = updateTag(ctx.db, org, id, rb.body.name !== undefined ? String(rb.body.name) : undefined, rb.body.color !== undefined ? String(rb.body.color) : undefined)
          return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Etiqueta no encontrada' }), true
        }
        const ok = deleteTag(ctx.db, org, id)
        return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Etiqueta no encontrada' }), true
      } catch (e: any) {
        return json(res, String(e.message).includes('DUPLICADA') ? 409 : errorStatus(e), { error: e.message }), true
      }
    }
  }

  // ---------- Respuestas rápidas ----------
  if (method === 'GET' && path === '/api/quick-replies') {
    json(res, 200, { quickReplies: listQuickReplies(ctx.db, org) })
    return true
  }
  if (method === 'POST' && path === '/api/quick-replies') {
    const rb = await readJsonObject(req)
    if (!rb.ok) return json(res, rb.status, { error: rb.error }), true
    try {
      json(res, 201, createQuickReply(ctx.db, org, {
        shortcut: String(rb.body.shortcut || ''),
        title: String(rb.body.title || ''),
        body: String(rb.body.body || ''),
      }))
    } catch (e: any) {
      json(res, String(e.message).includes('DUPLICADO') ? 409 : errorStatus(e), { error: e.message })
    }
    return true
  }
  {
    const m = path.match(/^\/api\/quick-replies\/([^/]+)$/)
    if (m && ['PUT', 'DELETE'].includes(method)) {
      const id = decodeURIComponent(m[1])
      try {
        if (method === 'PUT') {
          const rb = await readJsonObject(req)
          if (!rb.ok) return json(res, rb.status, { error: rb.error }), true
          const ok = updateQuickReply(ctx.db, org, id, {
            shortcut: rb.body.shortcut !== undefined ? String(rb.body.shortcut) : undefined,
            title: rb.body.title !== undefined ? String(rb.body.title) : undefined,
            body: rb.body.body !== undefined ? String(rb.body.body) : undefined,
          })
          return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Respuesta rápida no encontrada' }), true
        }
        const ok = deleteQuickReply(ctx.db, org, id)
        return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Respuesta rápida no encontrada' }), true
      } catch (e: any) {
        return json(res, String(e.message).includes('DUPLICADO') ? 409 : errorStatus(e), { error: e.message }), true
      }
    }
  }

  // ---------- Agentes ----------
  if (method === 'GET' && path === '/api/agents') {
    json(res, 200, { agents: listAgents(ctx.db, org) })
    return true
  }
  if (method === 'POST' && path === '/api/agents') {
    const rb = await readJsonObject(req)
    if (!rb.ok) return json(res, rb.status, { error: rb.error }), true
    try {
      json(res, 201, createAgent(ctx.db, org, {
        name: String(rb.body.name || ''),
        email: rb.body.email ? String(rb.body.email) : undefined,
        role: rb.body.role ? String(rb.body.role) : undefined,
      }))
    } catch (e: any) {
      json(res, errorStatus(e), { error: e.message })
    }
    return true
  }
  {
    const m = path.match(/^\/api\/agents\/([^/]+)$/)
    if (m && ['PUT', 'DELETE'].includes(method)) {
      const id = decodeURIComponent(m[1])
      try {
        if (method === 'PUT') {
          const rb = await readJsonObject(req)
          if (!rb.ok) return json(res, rb.status, { error: rb.error }), true
          const ok = updateAgent(ctx.db, org, id, {
            name: rb.body.name !== undefined ? String(rb.body.name) : undefined,
            email: rb.body.email !== undefined ? String(rb.body.email) : undefined,
            role: rb.body.role !== undefined ? String(rb.body.role) : undefined,
            active: rb.body.active !== undefined ? Boolean(rb.body.active) : undefined,
          })
          return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Agente no encontrado' }), true
        }
        const ok = deleteAgent(ctx.db, org, id)
        if (ok) writeAudit(ctx.db, actor, org, 'agent.delete', id)
        return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Agente no encontrado' }), true
      } catch (e: any) {
        return json(res, errorStatus(e), { error: e.message }), true
      }
    }
  }

  // ---------- Embudo ----------
  if (method === 'GET' && path === '/api/pipeline/stages') {
    json(res, 200, { stages: listStages(ctx.db, org) })
    return true
  }
  if (method === 'POST' && path === '/api/pipeline/stages') {
    const rb = await readJsonObject(req)
    if (!rb.ok) return json(res, rb.status, { error: rb.error }), true
    try {
      json(res, 201, createStage(ctx.db, org, String(rb.body.name || ''), rb.body.color ? String(rb.body.color) : undefined))
    } catch (e: any) {
      json(res, errorStatus(e), { error: e.message })
    }
    return true
  }
  {
    const m = path.match(/^\/api\/pipeline\/stages\/([^/]+)$/)
    if (m && ['PUT', 'DELETE'].includes(method)) {
      const id = decodeURIComponent(m[1])
      try {
        if (method === 'PUT') {
          const rb = await readJsonObject(req)
          if (!rb.ok) return json(res, rb.status, { error: rb.error }), true
          const ok = updateStage(ctx.db, org, id, {
            name: rb.body.name !== undefined ? String(rb.body.name) : undefined,
            position: rb.body.position !== undefined ? Number(rb.body.position) : undefined,
            color: rb.body.color !== undefined ? String(rb.body.color) : undefined,
          })
          return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Etapa no encontrada' }), true
        }
        const result = deleteStage(ctx.db, org, id)
        return json(res, result ? 200 : 404, result ? { ok: true, movedContacts: result.movedContacts } : { error: 'Etapa no encontrada' }), true
      } catch (e: any) {
        return json(res, errorStatus(e), { error: e.message }), true
      }
    }
  }
  if (method === 'POST' && path === '/api/pipeline/move') {
    const rb = await readJsonObject(req)
    if (!rb.ok) return json(res, rb.status, { error: rb.error }), true
    try {
      const eventId = String(rb.body.eventId || '').trim()
      if (!eventId) return json(res, 400, { error: 'eventId es obligatorio (idempotencia extremo a extremo)' }), true
      const result = moveContactStage(ctx.db, org, String(rb.body.phone || ''), String(rb.body.stageId || ''), eventId, { auditActor: actor })
      json(res, 200, result)
    } catch (e: any) {
      json(res, errorStatus(e), { error: e.message })
    }
    return true
  }

  // ---------- Conversaciones ----------
  if (method === 'GET' && path === '/api/conversations') {
    const q = url.searchParams.get('q') || undefined
    const unreadOnly = url.searchParams.get('unreadOnly') === '1'
    const limit = parseInt(url.searchParams.get('limit') || '50', 10)
    const offset = parseInt(url.searchParams.get('offset') || '0', 10)
    json(res, 200, listConversations(ctx.db, org, { q, unreadOnly, limit, offset }))
    return true
  }
  {
    const m = path.match(/^\/api\/conversations\/([^/]+)$/)
    if (m && method === 'GET') {
      const phone = decodeURIComponent(m[1])
      try {
        const limit = parseInt(url.searchParams.get('limit') || '50', 10)
        const before = url.searchParams.get('before') || undefined
        const thread = getConversationThread(ctx.db, org, phone, { markRead: true, limit, before })
        if (!thread.conversation) return json(res, 404, { error: 'Conversación no encontrada' }), true
        json(res, 200, thread)
      } catch (e: any) {
        json(res, errorStatus(e), { error: e.message })
      }
      return true
    }
  }
  {
    const m = path.match(/^\/api\/conversations\/([^/]+)\/(read|assign|messages)$/)
    if (m && method === 'POST') {
      const phone = decodeURIComponent(m[1])
      const action = m[2]
      try {
        if (action === 'read') {
          const thread = getConversationThread(ctx.db, org, phone, { markRead: true })
          if (!thread.conversation) return json(res, 404, { error: 'Conversación no encontrada' }), true
          return json(res, 200, { ok: true, unread: 0 }), true
        }
        if (action === 'assign') {
          const rb = await readJsonObject(req)
          if (!rb.ok) return json(res, rb.status, { error: rb.error }), true
          const agentId = rb.body.agentId ? String(rb.body.agentId) : null
          const ok = assignConversation(ctx.db, org, phone, agentId)
          if (!ok) return json(res, 404, { error: 'Conversación no encontrada' }), true
          writeAudit(ctx.db, actor, org, 'conversation.assign', phone, `agent=${agentId || 'none'}`)
          return json(res, 200, { ok: true, assignedAgentId: agentId }), true
        }
        // action === 'messages': ENVÍO REAL por el transporte con checks JIT
        const rb = await readJsonObject(req)
        if (!rb.ok) return json(res, rb.status, { error: rb.error }), true
        const text = String(rb.body.text || '').trim()
        if (!text) return json(res, 400, { error: 'TEXTO_REQUERIDO: el mensaje no puede estar vacío' }), true
        const canonical = canonicalizePhone(phone)
        if (!canonical) return json(res, 400, { error: 'TELEFONO_INVALID: el teléfono no es E.164 válido' }), true
        // JIT 1 — supresión (local + 2A si está habilitado): opt-out JAMÁS recibe chat
        let suppressed = false
        try {
          suppressed = await ctx.suppressionStore.isSuppressed(canonical, org)
        } catch (e: any) {
          return json(res, 503, { error: `SUPPRESSION_CHECK_FAILED: ${e.message}` }), true
        }
        if (suppressed) {
          return json(res, 409, { error: 'CONTACT_SUPPRESSED: el contacto está en la lista de supresión (opt-out) — no se envía' }), true
        }
        // JIT 2 — lock 2A (diálogo activo): fail-closed si no disponible
        let lock: any
        try {
          lock = await ctx.lockChecker.checkLock(canonical, org)
        } catch (e: any) {
          return json(res, 503, { error: `LOCK_CHECK_FAILED: ${e.message}` }), true
        }
        if (lock && lock.available === false) {
          return json(res, 409, { error: `CONTACT_LOCKED: contacto en flujo activo (${lock.state || 'IN_FLOW_2A'}) — no se envía`, state: lock.state ?? null }), true
        }
        // Despacho REAL por el transporte configurado
        let dispatchResult: any
        try {
          dispatchResult = await ctx.dispatcher.dispatch(canonical, text, org)
        } catch (e: any) {
          const messageRow = recordOutboundMessage(ctx.db, org, { phone: canonical, text, status: 'FAILED', error: e.message })
          return json(res, 502, { ok: false, message: messageRow, dispatch: { error: e.message } }), true
        }
        const ok = Boolean(dispatchResult?.success)
        const messageRow = recordOutboundMessage(ctx.db, org, {
          phone: canonical, text,
          status: ok ? 'SENT' : 'FAILED',
          error: ok ? null : String(dispatchResult?.error || dispatchResult?.status || 'dispatch_failed'),
          messageId: dispatchResult?.messageId ?? null,
        })
        json(res, ok ? 200 : 502, { ok, message: messageRow, dispatch: { status: dispatchResult?.status ?? null, messageId: dispatchResult?.messageId ?? null, error: dispatchResult?.error ?? null } })
      } catch (e: any) {
        json(res, errorStatus(e), { error: e.message })
      }
      return true
    }
  }

  // ---------- Inbound real de mensajes (HMAC v2, paridad con webhook-lead) ----------
  if (method === 'POST' && path === '/api/audiences/webhook-message') {
    const rl = ctx.leadRate.check(
      `wmsg:${(typeof req.headers['x-forwarded-for'] === 'string' ? (req.headers['x-forwarded-for'] as string).split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown'}`, 30)
    if (!rl.allowed) {
      json(res, 429, { error: 'Demasiadas peticiones (rate limit)' })
      return true
    }
    const rb = await readBody(req)
    if (!rb.ok) return json(res, 413, { error: 'Payload demasiado grande' }), true
    const rawOrg = typeof req.headers['x-org-id'] === 'string' ? (req.headers['x-org-id'] as string).trim() : ''
    const orgForBinding = rawOrg || LEGACY_LEAD_ORG
    if (ctx.leadSecretSpec.byOrg.size === 0) {
      json(res, 503, { error: 'Service Unavailable: secretos de webhook no configurados (fail-closed)' })
      return true
    }
    const orgSecrets = resolveLeadSecrets(ctx.leadSecretSpec, orgForBinding)
    if (!orgSecrets) {
      json(res, 401, { error: 'Unauthorized: organización de webhook desconocida (X-Org-Id)' })
      return true
    }
    const sec = checkWebhookSecurity(
      rb.body,
      req.headers['x-signature-sha256'] as string | undefined,
      req.headers['x-timestamp'] as string | undefined,
      orgSecrets,
      ctx.leadReplay,
      Date.now(),
      orgForBinding,
    )
    if (!sec.ok) {
      json(res, sec.status, { error: sec.error })
      return true
    }
    try {
      const payload = readJson(rb.body)
      const eventId = String(payload.eventId || '')
      if (!eventId) return json(res, 400, { error: 'eventId es obligatorio (idempotencia de ingesta)' }), true
      const result = recordInboundWithIdempotency(ctx.db, orgForBinding, {
        phone: String(payload.phone || ''),
        name: payload.name ? String(payload.name) : undefined,
        text: String(payload.text || ''),
        messageId: payload.messageId ? String(payload.messageId) : undefined,
        campaignId: payload.campaignId ? String(payload.campaignId) : undefined,
      }, eventId)
      if (result.duplicate) {
        return json(res, 200, { ok: true, duplicate: true }), true
      }
      json(res, 200, { ok: true, duplicate: false, contactCreated: result.contactCreated, message: result.messageRow })
    } catch (e: any) {
      json(res, errorStatus(e), { error: e.message })
    }
    return true
  }

  // ---------- Integraciones (transporte) ----------
  if (method === 'GET' && path === '/api/integrations/transport') {
    json(res, 200, getTransport(ctx.db, org))
    return true
  }
  if (method === 'PUT' && path === '/api/integrations/transport') {
    const rb = await readJsonObject(req)
    if (!rb.ok) return json(res, rb.status, { error: rb.error }), true
    try {
      json(res, 200, updateTransport(ctx.db, org, {
        engine: rb.body.engine !== undefined ? String(rb.body.engine) : undefined,
        daemonUrl: rb.body.daemonUrl !== undefined ? String(rb.body.daemonUrl) : undefined,
        metaPhoneNumberId: rb.body.metaPhoneNumberId !== undefined ? String(rb.body.metaPhoneNumberId) : undefined,
        daemonSecret: rb.body.daemonSecret !== undefined ? String(rb.body.daemonSecret) : undefined,
        metaToken: rb.body.metaToken !== undefined ? String(rb.body.metaToken) : undefined,
      }, { auditActor: actor }))
    } catch (e: any) {
      json(res, errorStatus(e), { error: e.message })
    }
    return true
  }
  if (method === 'POST' && path === '/api/integrations/transport/test') {
    const rb = await readJsonObject(req)
    if (!rb.ok) return json(res, rb.status, { error: rb.error }), true
    const saved = getTransport(ctx.db, org)
    const engine = rb.body.engine ? String(rb.body.engine) : saved.engine
    const started = Date.now()
    try {
      if (engine === 'daemon') {
        const daemonUrl = (rb.body.daemonUrl ? String(rb.body.daemonUrl) : saved.daemonUrl || '').replace(/\/$/, '')
        if (!daemonUrl) return json(res, 400, { error: 'SIN_CONFIGURAR: falta daemon_url (guárdalo o pásalo en el cuerpo)' }), true
        const target = daemonUrl.endsWith('/health') ? daemonUrl : `${daemonUrl}/health`
        const resp = await fetch(target, { signal: AbortSignal.timeout(3000) })
        json(res, 200, { ok: resp.ok, status: resp.status, latencyMs: Date.now() - started, target })
        return true
      }
      // meta_cloud: validación REAL del token contra Graph (el token SOLO vive en esta petición)
      const phoneId = rb.body.metaPhoneNumberId ? String(rb.body.metaPhoneNumberId) : saved.metaPhoneNumberId
      const token = rb.body.token ? String(rb.body.token) : ''
      if (!phoneId) return json(res, 400, { error: 'SIN_CONFIGURAR: falta metaPhoneNumberId' }), true
      if (!token) return json(res, 400, { error: 'SIN_TOKEN: para probar Meta Cloud indica el token en el cuerpo (jamás se persiste)' }), true
      const resp = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(phoneId)}?access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(5000) })
      json(res, 200, { ok: resp.ok, status: resp.status, latencyMs: Date.now() - started, target: 'graph.facebook.com' })
      return true
    } catch (e: any) {
      json(res, 200, { ok: false, status: null, latencyMs: Date.now() - started, error: e.message })
      return true
    }
  }

  // ---------- Supresión (bajas) ----------
  if (method === 'GET' && path === '/api/suppression') {
    const rows = ctx.db.prepare('SELECT phone, reason, created_at AS createdAt FROM suppression_list WHERE organization_id = ? ORDER BY created_at DESC').all(org)
    json(res, 200, { suppression: rows })
    return true
  }
  if (method === 'POST' && path === '/api/suppression') {
    const rb = await readJsonObject(req)
    if (!rb.ok) return json(res, rb.status, { error: rb.error }), true
    const phone = canonicalizePhone(String(rb.body.phone || ''))
    if (!phone) return json(res, 400, { error: 'TELEFONO_INVALID: el teléfono no es E.164 válido' }), true
    const reason = String(rb.body.reason || 'opt_out')
    // El alta de supresión es SIEMPRE local y org-scoped (política 5.B): con el
    // Composite (2A habilitado) se resuelve el store local; con standalone es directo.
    const localStore = (ctx.suppressionStore && typeof (ctx.suppressionStore as any).addSuppression === 'function')
      ? ctx.suppressionStore
      : (ctx.suppressionStore as any).local
    if (!localStore || typeof localStore.addSuppression !== 'function') {
      return json(res, 503, { error: 'SUPPRESSION_STORE_UNAVAILABLE' }), true
    }
    await localStore.addSuppression(org, phone, reason)
    writeAudit(ctx.db, actor, org, 'suppression.add', phone, reason)
    json(res, 201, { ok: true, phone, reason })
    return true
  }
  {
    const m = path.match(/^\/api\/suppression\/([^/]+)$/)
    if (m && method === 'DELETE') {
      const phone = canonicalizePhone(decodeURIComponent(m[1]))
      if (!phone) return json(res, 400, { error: 'TELEFONO_INVALID' }), true
      const localStore = (ctx.suppressionStore && typeof (ctx.suppressionStore as any).removeSuppression === 'function')
        ? ctx.suppressionStore
        : (ctx.suppressionStore as any).local
      if (!localStore || typeof localStore.removeSuppression !== 'function') {
        return json(res, 503, { error: 'SUPPRESSION_STORE_UNAVAILABLE' }), true
      }
      await localStore.removeSuppression(org, phone)
      writeAudit(ctx.db, actor, org, 'suppression.remove', phone)
      json(res, 200, { ok: true })
      return true
    }
  }

  // ---------- Campañas: borrar y reintentar fallidos (aditivas) ----------
  {
    const m = path.match(/^\/api\/campaigns\/([^/]+)$/)
    if (m && method === 'DELETE') {
      const campaignId = decodeURIComponent(m[1])
      const campaign = ctx.db.prepare('SELECT id, status FROM campaigns WHERE id = ? AND (? IS NULL OR organization_id = ?)').get(campaignId, ctx.identity.org, ctx.identity.org) as { id: string; status: string } | undefined
      if (!campaign) return json(res, 404, { error: 'Campaña no encontrada' }), true
      if (!TERMINAL_CAMPAIGN_STATUSES.includes(campaign.status)) {
        return json(res, 409, { error: `CAMPAÑA_ACTIVA: solo se pueden borrar campañas terminales (COMPLETED/CANCELLED/FAILED); estado actual ${campaign.status}`, currentStatus: campaign.status }), true
      }
      ctx.db.prepare('DELETE FROM campaign_items WHERE campaign_id = ?').run(campaignId)
      ctx.db.prepare('DELETE FROM campaigns WHERE id = ?').run(campaignId)
      writeAudit(ctx.db, actor, ctx.identity.org, 'campaign.delete', campaignId)
      json(res, 200, { ok: true })
      return true
    }
  }
  {
    const m = path.match(/^\/api\/campaigns\/([^/]+)\/retry-failed$/)
    if (m && method === 'POST') {
      const campaignId = decodeURIComponent(m[1])
      const campaign = ctx.db.prepare('SELECT id, status FROM campaigns WHERE id = ? AND (? IS NULL OR organization_id = ?)').get(campaignId, ctx.identity.org, ctx.identity.org) as { id: string; status: string } | undefined
      if (!campaign) return json(res, 404, { error: 'Campaña no encontrada' }), true
      const res2 = ctx.db.prepare(
        `UPDATE campaign_items SET status = 'PENDING', error_reason = NULL, claimed_by = NULL, claimed_at = NULL
         WHERE campaign_id = ? AND status = 'FAILED'`
      ).run(campaignId)
      writeAudit(ctx.db, actor, ctx.identity.org, 'campaign.retry_failed', campaignId, `requeued=${res2.changes}`)
      json(res, 200, { ok: true, requeued: Number(res2.changes), campaignStatus: campaign.status })
      return true
    }
  }

  return false
}
