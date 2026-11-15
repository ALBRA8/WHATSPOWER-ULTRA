/**
 * store.js — capa de datos local del panel.
 *
 * Todo se guarda en el navegador (localStorage) para que el panel sea usable
 * aunque el servidor de campañas no esté levantado. Las campañas que vienen
 * del servidor NO se guardan aquí: se piden a la API.
 *
 * Las reglas de normalización y de spintax copian el comportamiento del motor
 * del proyecto (src/audiences/csv-importer.ts y src/engine/spintax.ts) para que
 * lo que ves en el panel sea lo mismo que enviará el servidor.
 */

const KEY = 'whatspower.ultra.v1'

export const CADENCES = {
  seguro: { label: 'Seguro', minDelay: 25, maxDelay: 60, batch: 40, cooldown: 10, note: 'Ritmo conservador: menos volumen por hora, menor riesgo de bloqueo.' },
  equilibrado: { label: 'Equilibrado', minDelay: 12, maxDelay: 30, batch: 80, cooldown: 8, note: 'Ritmo recomendado para la mayoría de las cuentas.' },
  agresivo: { label: 'Rápido', minDelay: 5, maxDelay: 12, batch: 150, cooldown: 5, note: 'Mayor velocidad y mayor riesgo. Úsalo solo con audiencias calientes.' }
}

const DEFAULTS = () => ({
  version: 1,
  contacts: [],
  templates: [],
  rules: [],
  conversations: [],
  links: [],
  localCampaigns: [],
  activity: [],
  suppressions: [],
  settings: {
    cadence: 'equilibrado',
    batch: 80,
    cooldownMin: 8,
    hoursFrom: '08:00',
    hoursTo: '20:00',
    onlyBusinessHours: false,
    autoReplyOffHours: true,
    offHoursMessage: 'Gracias por escribir. En este momento estamos fuera de horario: te respondemos en cuanto abramos.',
    chatbotActive: true,
    org: '',
    apiBase: ''
  },
  seeded: false
})

let state = load()

function load () {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULTS()
    const parsed = JSON.parse(raw)
    const base = DEFAULTS()
    return { ...base, ...parsed, settings: { ...base.settings, ...(parsed.settings || {}) } }
  } catch {
    return DEFAULTS()
  }
}

function persist () {
  try { localStorage.setItem(KEY, JSON.stringify(state)) } catch (e) { console.warn('No se pudo guardar el estado local', e) }
}

export function getState () { return state }
export function save () { persist() }

export function uid (prefix = 'id') {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

export function nowIso () { return new Date().toISOString() }

export function formatDate (iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function formatDay (iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' })
}

/* ------------------------------- teléfonos ------------------------------- */

/** Misma canonización que el importador del servidor, con paso genérico internacional. */
export function canonicalPhone (raw) {
  if (!raw) return null
  const digits = String(raw).replace(/\D/g, '')
  if (digits.length === 10 && digits.startsWith('3')) return '57' + digits
  if (digits.length === 12 && digits.startsWith('573')) return digits
  if (digits.length >= 11 && digits.length <= 15) return digits // internacional (+34…, +52…)
  if (digits.length === 9) return '34' + digits // España sin prefijo
  return null
}

export function prettyPhone (phone) {
  const p = String(phone || '')
  if (p.startsWith('57') && p.length === 12) return '+57 ' + p.slice(2, 5) + ' ' + p.slice(5, 8) + ' ' + p.slice(8)
  if (p.startsWith('34') && p.length === 11) return '+34 ' + p.slice(2)
  return p ? '+' + p : '—'
}

/* --------------------------------- CSV ---------------------------------- */

export function parseAudienceCsv (text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (lines.length === 0) return { contacts: [], validCount: 0, invalidCount: 0, duplicatesCount: 0, error: 'Pega al menos una fila con teléfonos.' }

  const first = lines[0]
  const delimiter = first.includes(';') ? ';' : first.includes('\t') ? '\t' : ','
  const headers = first.split(delimiter).map((h) => h.trim().toLowerCase().replace(/^["']|["']$/g, ''))
  const known = ['phone', 'telefono', 'teléfono', 'celular', 'movil', 'móvil', 'numero', 'número']
  const phoneIdx = headers.findIndex((h) => known.includes(h))
  const hasHeader = phoneIdx !== -1
  const pIdx = hasHeader ? phoneIdx : 0
  const nameIdx = headers.findIndex((h) => ['name', 'nombre'].includes(h))
  const consentIdx = headers.findIndex((h) => ['consent_origin', 'origen_consentimiento', 'consentimiento', 'origen', 'fuente'].includes(h))
  const tagIdx = headers.findIndex((h) => ['tag', 'etiqueta', 'tags', 'lista'].includes(h))

  const seen = new Set()
  const contacts = []
  let invalidCount = 0
  let duplicatesCount = 0

  for (let i = hasHeader ? 1 : 0; i < lines.length; i++) {
    const row = lines[i].split(delimiter).map((c) => c.trim().replace(/^["']|["']$/g, ''))
    const phone = canonicalPhone(row[pIdx])
    if (!phone) { invalidCount++; continue }
    if (seen.has(phone)) { duplicatesCount++; continue }
    seen.add(phone)
    const variables = {}
    headers.forEach((h, idx) => {
      if (idx !== pIdx && idx !== nameIdx && idx !== consentIdx && idx !== tagIdx && row[idx]) variables[h] = row[idx]
    })
    contacts.push({
      phone,
      name: nameIdx !== -1 ? (row[nameIdx] || '') : '',
      consentOrigin: consentIdx !== -1 ? (row[consentIdx] || '') : '',
      tag: tagIdx !== -1 ? (row[tagIdx] || '') : '',
      variables
    })
  }
  return { contacts, validCount: contacts.length, invalidCount, duplicatesCount }
}

export function contactsToCsv (contacts) {
  const head = 'phone,name,consent_origin,tag'
  const rows = contacts.map((c) => [c.phone, c.name || '', c.consentOrigin || '', (c.tags || []).join('|')].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
  return [head, ...rows].join('\n')
}

/* -------------------------------- spintax -------------------------------- */

/** Resuelve {A|B|C} anidado y variables {{name}}. seed hace la elección reproducible. */
export function renderTemplate (template, seed, variables = {}) {
  let out = String(template || '')
  for (const [k, v] of Object.entries(variables)) {
    out = out.replace(new RegExp('\\{\\{\\s*' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\}\\}', 'gi'), v == null ? '' : String(v))
  }
  out = out.replace(/\{\{\s*[\w.-]+\s*\}\}/g, '')

  let s = 2166136261
  for (const ch of String(seed || 'seed')) { s ^= ch.charCodeAt(0); s = (s * 16777619) >>> 0 }
  const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296 }

  let guard = 0
  while (/\{[^{}]+\}/.test(out) && guard++ < 200) {
    out = out.replace(/\{([^{}]+)\}/, (_m, inner) => {
      const opts = inner.split('|')
      return opts[Math.floor(rnd() * opts.length)]
    })
  }
  return out.replace(/[ \t]{2,}/g, ' ').trim()
}

export function countBlocks (template) {
  const m = String(template || '').match(/\{[^{}]+\}/g)
  return m ? m.length : 0
}

/* ------------------------------- contactos ------------------------------- */

export function addContacts (list) {
  let added = 0
  let skipped = 0
  for (const c of list) {
    const exists = state.contacts.find((x) => x.phone === c.phone)
    if (exists) {
      skipped++
      if (!exists.name && c.name) exists.name = c.name
      if (c.consentOrigin && !exists.consentOrigin) exists.consentOrigin = c.consentOrigin
      if (c.tag) exists.tags = [...new Set([...(exists.tags || []), c.tag])]
      continue
    }
    state.contacts.push({
      id: uid('ct'),
      phone: c.phone,
      name: c.name || '',
      consentOrigin: c.consentOrigin || '',
      tags: c.tag ? [c.tag] : (c.tags || []),
      variables: c.variables || {},
      createdAt: nowIso()
    })
    added++
  }
  persist()
  return { added, skipped }
}

export function removeContact (id) {
  state.contacts = state.contacts.filter((c) => c.id !== id)
  persist()
}

export function updateContact (id, patch) {
  const c = state.contacts.find((x) => x.id === id)
  if (!c) return null
  Object.assign(c, patch)
  persist()
  return c
}

export function isSuppressed (phone) {
  return state.suppressions.some((s) => s.phone === phone)
}

/* ------------------------------- plantillas ------------------------------ */

export function saveTemplate (tpl) {
  if (tpl.id) {
    const t = state.templates.find((x) => x.id === tpl.id)
    if (t) Object.assign(t, tpl, { updatedAt: nowIso() })
  } else {
    state.templates.unshift({ id: uid('tpl'), name: tpl.name || 'Plantilla sin nombre', body: tpl.body || '', createdAt: nowIso() })
  }
  persist()
}

export function removeTemplate (id) {
  state.templates = state.templates.filter((t) => t.id !== id)
  persist()
}

/* --------------------------------- chatbot ------------------------------- */

export function saveRule (rule) {
  if (rule.id) {
    const r = state.rules.find((x) => x.id === rule.id)
    if (r) Object.assign(r, rule)
  } else {
    state.rules.push({
      id: uid('rule'),
      keywords: rule.keywords || '',
      match: rule.match || 'contiene',
      reply: rule.reply || '',
      image: rule.image || '',
      active: rule.active !== false,
      order: state.rules.length
    })
  }
  persist()
}

export function removeRule (id) {
  state.rules = state.rules.filter((r) => r.id !== id)
  persist()
}

export function matchRule (text) {
  const msg = String(text || '').toLowerCase().trim()
  if (!msg) return null
  const active = state.rules.filter((r) => r.active).sort((a, b) => (a.order || 0) - (b.order || 0))
  for (const r of active) {
    const keys = String(r.keywords || '').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean)
    for (const k of keys) {
      if (r.match === 'exacta' ? msg === k : msg.includes(k)) return r
    }
  }
  return null
}

/* ------------------------------- bandeja -------------------------------- */

export function saveConversation (conv) {
  if (conv.id) {
    const c = state.conversations.find((x) => x.id === conv.id)
    if (c) Object.assign(c, conv)
  } else {
    state.conversations.unshift({ id: uid('cv'), phone: conv.phone, name: conv.name || '', messages: conv.messages || [], updatedAt: nowIso() })
  }
  persist()
}

export function addMessage (convId, dir, text) {
  const c = state.conversations.find((x) => x.id === convId)
  if (!c) return null
  c.messages.push({ dir, text, at: nowIso() })
  c.updatedAt = nowIso()
  persist()
  return c
}

export function removeConversation (id) {
  state.conversations = state.conversations.filter((c) => c.id !== id)
  persist()
}

/* -------------------------------- enlaces ------------------------------- */

export function addLink (link) {
  const code = (link.code || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || uid('l').slice(-6)
  state.links.unshift({ id: uid('ln'), code, target: link.target || '', campaignId: link.campaignId || '', clicks: 0, createdAt: nowIso() })
  persist()
}

export function removeLink (id) {
  state.links = state.links.filter((l) => l.id !== id)
  persist()
}

/* -------------------------------- bajas --------------------------------- */

export function addSuppression (phone, reason) {
  const p = canonicalPhone(phone)
  if (!p) return { ok: false, error: 'Teléfono no válido.' }
  if (state.suppressions.some((s) => s.phone === p)) return { ok: false, error: 'Ese número ya está en la lista de bajas.' }
  state.suppressions.unshift({ phone: p, reason: reason || 'Baja manual', at: nowIso() })
  persist()
  return { ok: true, phone: p }
}

export function removeSuppression (phone) {
  state.suppressions = state.suppressions.filter((s) => s.phone !== phone)
  persist()
}

/* ------------------------------- actividad ------------------------------ */

export function logActivity (text, kind = 'info') {
  state.activity.unshift({ at: nowIso(), text, kind })
  state.activity = state.activity.slice(0, 200)
  persist()
}

/* -------------------------------- ajustes ------------------------------- */

export function getSettings () { return state.settings }

export function setSettings (patch) {
  Object.assign(state.settings, patch)
  persist()
  return state.settings
}

/* --------------------------- campañas locales --------------------------- */

export function saveLocalCampaign (campaign) {
  if (campaign.id) {
    const c = state.localCampaigns.find((x) => x.id === campaign.id)
    if (c) Object.assign(c, campaign)
  } else {
    state.localCampaigns.unshift(campaign)
  }
  persist()
}

export function removeLocalCampaign (id) {
  state.localCampaigns = state.localCampaigns.filter((c) => c.id !== id)
  persist()
}

/* ------------------------------ datos demo ------------------------------ */

export function seedDemo ({ force = false } = {}) {
  if (state.seeded && !force) return false
  const demoContacts = [
    ['573001112233', 'María López', 'Formulario web', 'clientes'],
    ['573004445566', 'Andrés Ramírez', 'WhatsApp', 'clientes'],
    ['573007778899', 'Carolina Díaz', 'Tienda', 'prospectos'],
    ['573001234567', 'Jorge Peña', 'Formulario web', 'prospectos'],
    ['573009876543', 'Luisa Fernanda', 'Instagram', 'clientes'],
    ['573005554433', 'Sebastián Ruiz', 'Tienda', 'mayoristas'],
    ['573002223344', 'Paola Gutiérrez', 'Referido', 'mayoristas'],
    ['573006667788', 'Diego Torres', 'Formulario web', 'prospectos']
  ]
  state.contacts = demoContacts.map(([phone, name, consentOrigin, tag]) => ({
    id: uid('ct'), phone, name, consentOrigin, tags: [tag], variables: {}, createdAt: nowIso()
  }))

  state.templates = [
    {
      id: uid('tpl'),
      name: 'Bienvenida con catálogo',
      body: 'Hola {{name}}, {te damos la bienvenida|qué alegría tenerte por aquí|gracias por escribirnos} a *Nuestra Tienda* 🎉\n\n{Te dejo|Aquí tienes|Mira} el catálogo de esta semana: https://example.com/catalogo\n\n¿Quieres que te reserve algo?',
      createdAt: nowIso()
    },
    {
      id: uid('tpl'),
      name: 'Recordatorio de pago',
      body: 'Hola {{name}}, {te recordamos|un recordatorio amable|solo un detalle} que tu pedido está reservado hasta hoy.\n\nPuedes pagar aquí: https://example.com/pagar\n\n_Cualquier duda, respondemos por este chat._',
      createdAt: nowIso()
    }
  ]

  state.rules = [
    { id: uid('rule'), keywords: 'precio, cuánto vale, cuanto vale, precio?', match: 'contiene', reply: '¡Hola! Los precios están en el catálogo: https://example.com/catalogo. ¿Buscas algo concreto?', image: '', active: true, order: 0 },
    { id: uid('rule'), keywords: 'horario, abierto', match: 'contiene', reply: 'Atendemos de lunes a sábado, de 8:00 a 20:00. Fuera de ese horario respondemos al día siguiente.', image: '', active: true, order: 1 }
  ]

  state.conversations = [
    {
      id: uid('cv'),
      phone: '573001112233',
      name: 'María López',
      updatedAt: nowIso(),
      messages: [
        { dir: 'in', text: 'Hola, ¿tienen disponible el combo de la semana?', at: nowIso() },
        { dir: 'out', text: '¡Hola María! Sí, queda disponible. ¿Te lo reservo?', at: nowIso() },
        { dir: 'in', text: 'Sí por favor 🙌', at: nowIso() }
      ]
    }
  ]

  state.suppressions = [{ phone: '573005554433', reason: 'Pidió la baja por chat', at: nowIso() }]
  state.links = [{ id: uid('ln'), code: 'catalogo', target: 'https://example.com/catalogo', campaignId: '', clicks: 0, createdAt: nowIso() }]
  state.activity = [
    { at: nowIso(), text: 'Datos de ejemplo cargados para conocer el panel', kind: 'info' }
  ]
  state.seeded = true
  persist()
  return true
}

export function resetAll () {
  state = DEFAULTS()
  persist()
}
