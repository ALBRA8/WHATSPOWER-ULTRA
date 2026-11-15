/**
 * app.js — arranque del panel: navegación, estado de conexión y router.
 *
 * Cada vista vive en views-core.js o views-more.js y expone:
 *   { title, sub, data(app), html(data, app), mount(app, root, data) }
 */

import * as S from './store.js'
import * as API from './api.js'
import { esc, toast, modal, closeModal } from './ui.js'
import { panel, campanas, monitor, openWizard } from './views-core.js'
import { contactos, plantillas, chatbot, bandeja, reportes, enlaces, bajas, ajustes } from './views-more.js'

const views = { panel, campanas, monitor, contactos, plantillas, chatbot, bandeja, reportes, enlaces, bajas, ajustes }

const app = {
  currentView: 'panel',
  param: null,
  filter: { campaignQuery: '', campaignStatus: 'todas', contactQuery: '', contactTag: '' },
  monitorTimer: null,
  onLeave: null,
  go (hash) {
    const target = String(hash || 'panel').replace(/^#\/?/, '')
    if (location.hash === '#/' + target) route()
    else location.hash = '#/' + target
  },
  render () { route({ keepScroll: true }) },
  openWizard (preset) { openWizard(app, preset || {}) },
  async reconnect () { await API.probe(); paintConnection() },
  leave () {
    if (typeof app.onLeave === 'function') { try { app.onLeave() } catch {} ; app.onLeave = null }
    if (app.monitorTimer) { clearInterval(app.monitorTimer); app.monitorTimer = null }
  }
}

/* -------------------------------- conexión ------------------------------- */

function paintConnection () {
  const chip = document.getElementById('connChip')
  const text = document.getElementById('connText')
  const btn = document.getElementById('connBtn')
  if (!chip || !text || !btn) return
  const mode = API.session.mode
  if (mode === 'server') {
    chip.className = 'conn ok'
    text.textContent = 'Servidor conectado'
    btn.textContent = 'Sesión activa'
  } else if (mode === 'locked') {
    chip.className = 'conn warn'
    text.textContent = 'Pide secreto'
    btn.textContent = 'Conectar servidor'
  } else if (mode === 'checking') {
    chip.className = 'conn'
    text.textContent = 'Comprobando…'
    btn.textContent = 'Conectar servidor'
  } else {
    chip.className = 'conn off'
    text.textContent = 'Sin servidor · datos locales'
    btn.textContent = 'Conectar servidor'
  }
}

function openLogin () {
  if (API.session.mode === 'server') {
    toast('La sesión del servidor ya está abierta.', 'ok')
    return
  }
  modal({
    title: 'Conectar con el servidor',
    body: `
      <p class="hint">El panel se conecta al servidor de campañas del proyecto. Escribe el secreto de administración (el valor de <span class="mono">ADMIN_API_KEYS</span>). Se guarda como cookie de sesión en este navegador; nunca se escribe en el código.</p>
      <div class="field"><label for="lgSecret">Secreto de administración</label>
        <input id="lgSecret" type="password" autocomplete="current-password" placeholder="••••••••••••"></div>
      <div id="lgOut"></div>
      ${API.session.mode === 'offline' ? '<div class="callout warn">El servidor no responde en esta dirección. Si abriste el panel como archivo o desde otro servidor estático, arranca primero el servidor del proyecto.</div>' : ''}
    `,
    foot: '<button class="btn btn-ghost" data-x="cancel">Cancelar</button><button class="btn btn-primary" data-x="ok">Entrar</button>',
    onMount: ({ bodyEl, footEl }) => {
      const input = bodyEl.querySelector('#lgSecret')
      const out = bodyEl.querySelector('#lgOut')
      const btn = footEl.querySelector('[data-x="ok"]')
      input.focus()
      const submit = async () => {
        const secret = input.value.trim()
        if (!secret) return
        btn.disabled = true
        btn.textContent = 'Comprobando…'
        const r = await API.login(secret)
        btn.disabled = false
        btn.textContent = 'Entrar'
        if (r.ok) {
          closeModal()
          toast('Conectado al servidor', 'ok')
          paintConnection()
          app.render()
        } else {
          out.innerHTML = `<div class="callout bad">${esc(r.error)}</div>`
        }
      }
      footEl.addEventListener('click', (e) => {
        const b = e.target.closest('[data-x]')
        if (!b) return
        if (b.dataset.x === 'cancel') return closeModal()
        submit()
      })
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit() })
    }
  })
}

/* --------------------------------- cajón --------------------------------- */

function setDrawer (open) {
  const sidebar = document.getElementById('sidebar')
  const scrim = document.getElementById('scrim')
  const menuBtn = document.getElementById('menuBtn')
  if (!sidebar) return
  sidebar.classList.toggle('open', open)
  if (menuBtn) menuBtn.setAttribute('aria-expanded', String(open))
  if (scrim && !open && document.getElementById('modalRoot').hidden) scrim.hidden = true
  if (scrim && open) scrim.hidden = false
}

/* --------------------------------- router -------------------------------- */

async function route ({ keepScroll = false } = {}) {
  const raw = location.hash.replace(/^#\/?/, '') || 'panel'
  const [name, ...rest] = raw.split('/')
  const view = views[name] ? name : 'panel'
  const param = rest.length ? decodeURIComponent(rest.join('/')) : null

  if (view !== app.currentView) app.leave()
  app.currentView = view
  app.param = param

  document.querySelectorAll('.nav-item').forEach((a) => {
    const target = (a.getAttribute('href') || '').replace(/^#\/?/, '')
    if (target === view) a.setAttribute('aria-current', 'page')
    else a.removeAttribute('aria-current')
  })

  const def = views[view]
  const titleEl = document.getElementById('viewTitle')
  const subEl = document.getElementById('viewSub')
  if (titleEl) titleEl.textContent = def.title
  if (subEl) subEl.textContent = def.sub || ''
  document.title = def.title + ' · WhatsPower Ultra'

  const main = document.getElementById('vista')
  const scroll = main.scrollTop
  if (!keepScroll) main.innerHTML = '<div class="loading">Cargando…</div>'

  let data = {}
  try {
    data = def.data ? await def.data(app, param) : {}
  } catch (e) {
    data = { error: e && e.message }
  }
  if (app.currentView !== view) return

  main.innerHTML = def.html(data, app)
  if (def.mount) def.mount(app, main, data)
  main.scrollTop = keepScroll ? scroll : 0
  setDrawer(false)
}

/* -------------------------------- arranque ------------------------------- */

function boot () {
  const st = S.getState()
  if (!st.seeded && st.contacts.length === 0) S.seedDemo()

  document.getElementById('connBtn').addEventListener('click', openLogin)
  document.getElementById('newBtn').addEventListener('click', () => app.openWizard())
  document.getElementById('menuBtn').addEventListener('click', () => {
    const open = !document.getElementById('sidebar').classList.contains('open')
    setDrawer(open)
  })
  document.getElementById('scrim').addEventListener('click', () => { closeModal(); setDrawer(false) })
  document.getElementById('modalClose').addEventListener('click', closeModal)

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (!document.getElementById('modalRoot').hidden) closeModal()
    else setDrawer(false)
  })

  window.addEventListener('hashchange', () => route())
  window.addEventListener('online', paintConnection)
  window.addEventListener('offline', paintConnection)

  paintConnection()
  route()

  API.probe().then(() => {
    paintConnection()
    if (app.currentView === 'panel' || app.currentView === 'campanas' || app.currentView === 'ajustes') app.render()
  })
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
else boot()

export { app }
