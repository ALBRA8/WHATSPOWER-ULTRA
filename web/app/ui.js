/** ui.js — utilidades de interfaz compartidas por las vistas. */

export function esc (value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

export function on (root, selector, event, handler) {
  root.addEventListener(event, (e) => {
    const target = e.target.closest(selector)
    if (target && root.contains(target)) handler(e, target)
  })
}

export function toast (message, kind = 'info', ms = 3800) {
  const host = document.getElementById('toasts')
  const div = document.createElement('div')
  div.className = 'toast ' + kind
  div.textContent = message
  host.appendChild(div)
  setTimeout(() => { div.style.opacity = '0'; div.style.transition = 'opacity .25s'; setTimeout(() => div.remove(), 260) }, ms)
}

let onCloseCurrent = null

export function modal ({ title, body, foot, wide = false, onMount }) {
  const root = document.getElementById('modalRoot')
  const scrim = document.getElementById('scrim')
  document.getElementById('modalTitle').textContent = title
  const bodyEl = document.getElementById('modalBody')
  bodyEl.innerHTML = body
  const footEl = document.getElementById('modalFoot')
  footEl.innerHTML = foot || ''
  root.hidden = false
  scrim.hidden = false
  root.querySelector('.modal').classList.toggle('wide', wide)
  onCloseCurrent = onMount ? onMount({ bodyEl, footEl, close: closeModal }) || null : null
  return { bodyEl, footEl, close: closeModal }
}

export function closeModal () {
  const root = document.getElementById('modalRoot')
  if (root.hidden) return
  root.hidden = true
  document.getElementById('scrim').hidden = true
  document.getElementById('modalBody').innerHTML = ''
  document.getElementById('modalFoot').innerHTML = ''
  if (typeof onCloseCurrent === 'function') { try { onCloseCurrent() } catch {} ; onCloseCurrent = null }
}

export function confirmDialog (message, { okLabel = 'Confirmar', danger = false } = {}) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; closeModal(); resolve(v) } }
    const m = modal({
      title: 'Confirmar',
      body: `<p>${esc(message)}</p>`,
      foot: `<button class="btn btn-ghost" data-x="no">Cancelar</button>
             <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-x="yes">${esc(okLabel)}</button>`,
      onMount: ({ footEl }) => {
        footEl.addEventListener('click', (e) => {
          const b = e.target.closest('[data-x]')
          if (!b) return
          done(b.dataset.x === 'yes')
        })
        return () => done(false)
      }
    })
    void m
  })
}

export function kpi ({ label, value, foot = '', tone = '' }) {
  return `<div class="kpi ${tone}">
    <div class="kpi-label">${esc(label)}</div>
    <div class="kpi-num">${esc(value)}</div>
    ${foot ? `<div class="kpi-foot">${esc(foot)}</div>` : ''}
  </div>`
}

export function emptyRow (cols, text) {
  return `<tr><td colspan="${cols}"><div class="empty">${esc(text)}</div></td></tr>`
}

export function statusChip (status) {
  const s = String(status || '').toUpperCase()
  const map = {
    SENT: ['verde', 'Enviado'],
    PENDING: ['gris', 'Pendiente'],
    DISPATCHING: ['azul', 'Enviando'],
    CLAIMED: ['azul', 'Enviando'],
    SUPPRESSED: ['naranja', 'En baja'],
    FATIGUE_EXCLUDED: ['naranja', 'Fatiga'],
    LOCKED_EXCLUDED: ['naranja', 'Bloqueado'],
    NO_CONSENT_EXCLUDED: ['naranja', 'Sin consentimiento'],
    EXCLUDED: ['naranja', 'Excluido'],
    FAILED_FATAL: ['rojo', 'Fallido'],
    FAILED_RETRYABLE: ['rojo', 'Reintento'],
    UNCERTAIN_DISPATCH: ['naranja', 'Incierto'],
    DRAFT: ['gris', 'Borrador'],
    RUNNING: ['azul', 'En curso'],
    ACTIVE: ['azul', 'En curso'],
    PAUSED: ['naranja', 'En pausa'],
    COMPLETED: ['verde', 'Completada'],
    CANCELLED: ['gris', 'Cancelada'],
    LOCAL: ['gris', 'Local']
  }
  const [tone, label] = map[s] || ['gris', status || '—']
  return `<span class="chip ${tone}">${esc(label)}</span>`
}

export function download (filename, content, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1500)
}

export function readFileAsText (file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result || ''))
    fr.onerror = () => reject(fr.error)
    fr.readAsText(file)
  })
}

export function debounce (fn, ms = 200) {
  let t
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms) }
}
