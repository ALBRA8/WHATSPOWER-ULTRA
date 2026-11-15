/**
 * api.js — puente entre el panel y el servidor de campañas del proyecto.
 *
 * Tres estados posibles:
 *  · 'server'  → el servidor responde y la sesión está abierta (cookie del Studio)
 *  · 'locked'  → el servidor responde pero pide el secreto de administración
 *  · 'offline' → no hay servidor (sitio servido como archivos estáticos, o caído)
 *
 * En 'offline' el panel sigue siendo usable con los datos locales (store.js)
 * y lo dice claramente en pantalla; nunca simula haber enviado nada.
 */

const base = () => {
  try { return (JSON.parse(localStorage.getItem('whatspower.ultra.v1') || '{}').settings || {}).apiBase || '' } catch { return '' }
}

export const session = { mode: 'checking', health: null, lastError: '', checkedAt: 0 }

async function call (path, options = {}) {
  const url = base().replace(/\/$/, '') + path
  try {
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      ...options
    })
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
    if (res.status === 401) return { ok: false, status: 401, data, error: (data && data.error) || 'Se requiere el secreto de administración.' }
    if (res.status === 503) return { ok: false, status: 503, data, error: (data && data.error) || 'Servicio no disponible: falta ADMIN_API_KEYS en el servidor.' }
    if (!res.ok) return { ok: false, status: res.status, data, error: (data && data.error) || `Error ${res.status}` }
    return { ok: true, status: res.status, data }
  } catch (e) {
    return { ok: false, status: 0, data: null, error: 'No se pudo contactar con el servidor.' }
  }
}

/** Comprueba servidor + sesión. No lanza nunca. */
export async function probe () {
  session.mode = 'checking'
  const health = await call('/api/health')
  if (!health.ok && health.status === 0) {
    session.mode = 'offline'
    session.health = null
    session.lastError = health.error
    session.checkedAt = Date.now()
    return session
  }
  session.health = health.ok ? health.data : null
  const list = await call('/api/campaigns?limit=1')
  if (list.ok) session.mode = 'server'
  else if (list.status === 401 || list.status === 503) { session.mode = 'locked'; session.lastError = list.error }
  else { session.mode = 'offline'; session.lastError = list.error }
  session.checkedAt = Date.now()
  return session
}

export async function login (secret) {
  const res = await call('/studio/login', { method: 'POST', body: JSON.stringify({ secret }) })
  if (res.ok) { session.mode = 'server'; session.lastError = '' } else { session.lastError = res.error }
  return res
}

export const health = () => call('/api/health')
export const listCampaigns = (limit = 100, offset = 0) => call(`/api/campaigns?limit=${limit}&offset=${offset}`)
export const getCampaign = (id) => call(`/api/campaigns/${encodeURIComponent(id)}?itemsLimit=200`)
export const createCampaign = (payload) => call('/api/campaigns', { method: 'POST', body: JSON.stringify(payload) })
export const campaignAction = (id, action) => call(`/api/campaigns/${encodeURIComponent(id)}/${action}`, { method: 'POST' })
export const spintaxPreview = (payload) => call('/api/spintax/preview', { method: 'POST', body: JSON.stringify(payload) })
export const csvPreview = (csvContent) => call('/api/audiences/preview-csv', { method: 'POST', body: JSON.stringify({ csvContent }) })
export const attribution = (id) => call(`/api/attribution/report/${encodeURIComponent(id)}`)
export const optOut = (contactPhone, reason) => call('/api/compliance/opt-out', { method: 'POST', body: JSON.stringify({ contactPhone, reason }) })
export const recordConsent = (payload) => call('/api/compliance/consent', { method: 'POST', body: JSON.stringify(payload) })
export const masterPrompt = (payload) => call('/api/ai/neuromarketing/master-prompt', { method: 'POST', body: JSON.stringify(payload) })
export const contactData = (phone) => call(`/api/compliance/contact-data?phone=${encodeURIComponent(phone)}`)
export const generateSpintax = (payload) => call('/api/ai/neuromarketing/generate-spintax', { method: 'POST', body: JSON.stringify(payload) })
export const neuroAnalyze = (payload) => call('/api/ai/neuromarketing/analyze', { method: 'POST', body: JSON.stringify(payload) })

export function isServer () { return session.mode === 'server' }
export function isOffline () { return session.mode === 'offline' }
