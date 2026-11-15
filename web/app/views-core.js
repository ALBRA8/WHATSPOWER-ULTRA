/** views-core.js — Panel, Campañas, Monitor en vivo y el asistente de nueva campaña. */

import * as S from './store.js'
import * as API from './api.js'
import { esc, kpi, emptyRow, statusChip, toast, modal, closeModal, confirmDialog, on, download, readFileAsText, $ } from './ui.js'

const fmt = (n) => new Intl.NumberFormat('es-ES').format(Number(n || 0))

/* ================================= PANEL ================================= */

export const panel = {
  title: 'Panel',
  sub: 'Resumen de tu operación de WhatsApp',
  async data (app) {
    const st = S.getState()
    let campaigns = st.localCampaigns
    let health = null
    if (API.isServer()) {
      const [c, h] = await Promise.all([API.listCampaigns(50), API.health()])
      if (c.ok && c.data) campaigns = [...(c.data.campaigns || []).map(normalizeCampaign)]
      if (h.ok) health = h.data
    }
    return { campaigns, health, st }
  },
  html ({ campaigns, health, st }) {
    const active = campaigns.filter((c) => ['RUNNING', 'ACTIVE', 'PAUSED', 'DISPATCHING'].includes(String(c.status).toUpperCase()))
    const sentTotal = campaigns.reduce((a, c) => a + Number(c.sentCount || 0), 0)
    const failed = campaigns.reduce((a, c) => a + Number(c.failedCount || 0), 0)
    const delivery = sentTotal + failed > 0 ? Math.round((sentTotal / (sentTotal + failed)) * 100) : null

    return `
      <div class="grid g4">
        ${kpi({ label: 'Contactos', value: fmt(st.contacts.length), foot: st.contacts.length ? 'listos para difundir' : 'aún sin importar' })}
        ${kpi({ label: 'Campañas', value: fmt(campaigns.length), foot: active.length ? active.length + ' en curso ahora' : 'ninguna en curso', tone: 'azul' })}
        ${kpi({ label: 'Mensajes enviados', value: fmt(sentTotal), foot: delivery === null ? 'sin envíos todavía' : delivery + '% sin error', tone: 'verde' })}
        ${kpi({ label: 'Bajas', value: fmt(st.suppressions.length), foot: 'números que nunca se envían', tone: 'naranja' })}
      </div>

      <div class="grid g-side mt16">
        <section class="card">
          <div class="card-head">
            <div><h2>Últimas campañas</h2><p>Lo que se ha encolado y cómo va.</p></div>
            <button class="btn btn-sm btn-ghost" data-go="campanas">Ver todas</button>
          </div>
          ${campaigns.length ? `
          <div class="table-wrap">
            <table>
              <thead><tr><th>Campaña</th><th>Estado</th><th class="right">Enviados</th><th class="right">Total</th><th></th></tr></thead>
              <tbody>
                ${campaigns.slice(0, 6).map((c) => `
                  <tr>
                    <td><strong>${esc(c.name || 'Campaña sin nombre')}</strong><div class="hint">${esc(S.formatDate(c.createdAt))}</div></td>
                    <td>${statusChip(c.status)}</td>
                    <td class="right num">${fmt(c.sentCount)}</td>
                    <td class="right num">${fmt(c.totalTargets)}</td>
                    <td class="right"><button class="btn btn-sm btn-ghost" data-monitor="${esc(c.id)}">Monitor</button></td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>` : `<div class="empty">Todavía no hay campañas. Crea la primera con “+ Nueva campaña”.</div>`}
        </section>

        <div>
          <section class="card">
            <div class="card-head"><div><h3>Canal de WhatsApp</h3><p>Estado que reporta el servidor.</p></div></div>
            ${health
              ? `<dl class="kv">
                   <dt>Servidor</dt><dd><span class="chip verde">En línea</span></dd>
                   <dt>En cola</dt><dd>${fmt(health.queuePending)} pendientes · ${fmt(health.queueInFlight)} en vuelo</dd>
                   <dt>Histórico</dt><dd>${fmt(health.totalSent)} enviados · ${fmt(health.totalFailed)} con error</dd>
                 </dl>`
              : `<div class="callout warn"><strong>Sin servidor.</strong> El panel funciona con tus datos locales: puedes preparar contactos, plantillas y campañas. Para enviar de verdad, arranca el servidor del proyecto y pulsa “Conectar servidor”.</div>`}
          </section>

          <section class="card">
            <div class="card-head"><div><h3>Automatización</h3><p>Respuestas y horario activos.</p></div></div>
            <ul class="list">
              <li><span class="chip ${st.settings.chatbotActive ? 'verde' : 'gris'}">${st.settings.chatbotActive ? 'Activo' : 'Apagado'}</span> Chatbot con ${st.rules.filter((r) => r.active).length} regla(s)</li>
              <li><span class="chip ${st.settings.onlyBusinessHours ? 'verde' : 'gris'}">${st.settings.onlyBusinessHours ? 'Sí' : 'No'}</span> Enviar solo en horario ${esc(st.settings.hoursFrom)}–${esc(st.settings.hoursTo)}</li>
              <li><span class="chip ${st.settings.autoReplyOffHours ? 'verde' : 'gris'}">${st.settings.autoReplyOffHours ? 'Sí' : 'No'}</span> Mensaje fuera de horario</li>
            </ul>
            <button class="btn btn-sm btn-ghost mt16" data-go="chatbot">Abrir chatbot</button>
          </section>
        </div>
      </div>

      <section class="card mt16">
        <div class="card-head"><div><h3>Actividad reciente</h3><p>Lo último que ha pasado en el panel.</p></div></div>
        ${st.activity.length ? `<ul class="list">${st.activity.slice(0, 8).map((a) => `<li><span>${esc(a.text)}</span><span class="when">${esc(S.formatDate(a.at))}</span></li>`).join('')}</ul>` : '<div class="empty">Sin movimientos todavía.</div>'}
      </section>
    `
  },
  mount (app, root, data) {
    on(root, '[data-go]', 'click', (_e, b) => app.go(b.dataset.go))
    on(root, '[data-monitor]', 'click', (_e, b) => app.go('monitor/' + b.dataset.monitor))
    void data
  }
}

/* =============================== CAMPAÑAS ================================ */

function normalizeCampaign (c) {
  return {
    id: c.id,
    name: c.name || c.campaignName || 'Campaña',
    status: c.status || 'PENDING',
    totalTargets: c.totalTargets ?? c.total_targets ?? 0,
    sentCount: c.sentCount ?? c.sent_count ?? 0,
    skippedCount: c.skippedCount ?? c.skipped_count ?? 0,
    failedCount: c.failedCount ?? c.failed_count ?? 0,
    createdAt: c.createdAt || c.created_at || null,
    local: false
  }
}

export const campanas = {
  title: 'Campañas',
  sub: 'Difusiones creadas y su estado',
  async data () {
    let list = S.getState().localCampaigns.slice()
    let source = 'local'
    if (API.isServer()) {
      const r = await API.listCampaigns(200)
      if (r.ok && r.data) { list = (r.data.campaigns || []).map(normalizeCampaign); source = 'server' }
    }
    return { list, source }
  },
  html ({ list, source }, app) {
    const q = app.filter.campaignQuery || ''
    const statusFilter = app.filter.campaignStatus || 'todas'
    const filtered = list.filter((c) => {
      const okQ = !q || String(c.name).toLowerCase().includes(q.toLowerCase())
      const st = String(c.status).toUpperCase()
      const okS = statusFilter === 'todas' ||
        (statusFilter === 'curso' && ['RUNNING', 'ACTIVE', 'DISPATCHING', 'PAUSED'].includes(st)) ||
        (statusFilter === 'hechas' && ['COMPLETED'].includes(st)) ||
        (statusFilter === 'otras' && !['RUNNING', 'ACTIVE', 'DISPATCHING', 'PAUSED', 'COMPLETED'].includes(st))
      return okQ && okS
    })

    return `
      ${source === 'local' ? `<div class="callout warn"><strong>Modo local.</strong> Estas campañas son borradores guardados en este navegador. Para enviarlas de verdad hace falta el servidor de campañas del proyecto (pulsa “Conectar servidor”).</div>` : ''}
      <div class="toolbar">
        <div class="search"><input type="search" id="campSearch" placeholder="Buscar campaña" value="${esc(q)}" aria-label="Buscar campaña"></div>
        <div class="seg" id="campFilter" role="group" aria-label="Filtrar por estado">
          <button data-f="todas" aria-pressed="${statusFilter === 'todas'}">Todas</button>
          <button data-f="curso" aria-pressed="${statusFilter === 'curso'}">En curso</button>
          <button data-f="hechas" aria-pressed="${statusFilter === 'hechas'}">Completadas</button>
          <button data-f="otras" aria-pressed="${statusFilter === 'otras'}">Otras</button>
        </div>
        <div class="spacer"></div>
        <button class="btn btn-ghost btn-sm" id="campRefresh">Actualizar</button>
        <button class="btn btn-primary btn-sm" data-new>+ Nueva campaña</button>
      </div>

      <section class="card">
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Campaña</th><th>Estado</th><th class="right">Destinatarios</th><th class="right">Enviados</th><th class="right">Omitidos</th><th class="right">Errores</th><th></th></tr>
            </thead>
            <tbody>
              ${filtered.length ? filtered.map((c) => `
                <tr>
                  <td><strong>${esc(c.name)}</strong><div class="hint">${esc(S.formatDate(c.createdAt))}${c.local ? ' · borrador local' : ''}</div></td>
                  <td>${statusChip(c.status)}</td>
                  <td class="right num">${fmt(c.totalTargets)}</td>
                  <td class="right num">${fmt(c.sentCount)}</td>
                  <td class="right num">${fmt(c.skippedCount)}</td>
                  <td class="right num">${fmt(c.failedCount)}</td>
                  <td class="right nowrap">
                    <button class="btn btn-sm btn-ghost" data-monitor="${esc(c.id)}">Monitor</button>
                    ${c.local ? '' : `<button class="btn btn-sm btn-ghost" data-report="${esc(c.id)}">Reporte</button>`}
                  </td>
                </tr>`).join('') : emptyRow(7, list.length ? 'Ninguna campaña coincide con el filtro.' : 'Aún no hay campañas: crea la primera.')}
            </tbody>
          </table>
        </div>
      </section>
    `
  },
  mount (app, root) {
    on(root, '[data-new]', 'click', () => app.openWizard())
    on(root, '[data-monitor]', 'click', (_e, b) => app.go('monitor/' + b.dataset.monitor))
    on(root, '[data-report]', 'click', (_e, b) => app.go('reportes/' + b.dataset.report))
    const search = $('#campSearch', root)
    if (search) {
      search.addEventListener('input', () => {
        app.filter.campaignQuery = search.value
        app.render()
        const s = $('#campSearch'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length) }
      })
    }
    on(root, '#campFilter [data-f]', 'click', (_e, b) => { app.filter.campaignStatus = b.dataset.f; app.render() })
    const refresh = $('#campRefresh', root)
    if (refresh) refresh.addEventListener('click', () => app.render())
  }
}

/* ================================ MONITOR ================================ */

export const monitor = {
  title: 'Monitor en vivo',
  sub: 'Cada mensaje, contado mientras sale',
  async data (app) {
    const id = app.param
    if (!id) return { campaign: null }
    if (String(id).startsWith('lc_')) {
      const local = S.getState().localCampaigns.find((c) => c.id === id)
      return { campaign: local || null, local: true, items: [] }
    }
    const r = await API.getCampaign(id)
    if (!r.ok) return { campaign: null, error: r.error }
    const c = r.data.campaign || {}
    const items = r.data.items || []
    return { campaign: normalizeCampaign(c), items, raw: c }
  },
  html ({ campaign, items = [], local, error }, app) {
    if (!campaign) {
      return `<div class="callout bad">${esc(error || 'No se encontró la campaña.')}</div>
        <button class="btn btn-ghost" data-go="campanas">Volver a campañas</button>`
    }
    const done = Number(campaign.sentCount) + Number(campaign.skippedCount) + Number(campaign.failedCount)
    const total = Math.max(1, Number(campaign.totalTargets))
    const pct = local ? 0 : Math.min(100, Math.round((done / total) * 100))
    const st = String(campaign.status).toUpperCase()
    const canPause = !local && ['RUNNING', 'ACTIVE', 'DISPATCHING'].includes(st)
    const canResume = !local && st === 'PAUSED'
    const canCancel = !local && ['RUNNING', 'ACTIVE', 'PAUSED', 'DISPATCHING', 'DRAFT'].includes(st)

    return `
      <div class="toolbar">
        <button class="btn btn-ghost btn-sm" data-go="campanas">← Campañas</button>
        <div class="spacer"></div>
        ${canPause ? '<button class="btn btn-warm btn-sm" data-act="pause">Pausar</button>' : ''}
        ${canResume ? '<button class="btn btn-primary btn-sm" data-act="resume">Reanudar</button>' : ''}
        ${canCancel ? '<button class="btn btn-danger btn-sm" data-act="cancel">Cancelar campaña</button>' : ''}
        <button class="btn btn-ghost btn-sm" data-report="${esc(campaign.id)}">Reporte</button>
      </div>

      <section class="card">
        <div class="card-head">
          <div><h2>${esc(campaign.name)}</h2><p>${esc(S.formatDate(campaign.createdAt))} ${local ? '· borrador local (sin enviar)' : ''}</p></div>
          <div>${statusChip(campaign.status)}</div>
        </div>
        <div class="progress ${pct === 100 ? '' : 'naranja'}"><span style="width:${pct}%"></span></div>
        <div class="status-line"><span>${pct}% completado</span><span>${fmt(done)} de ${fmt(campaign.totalTargets)}</span></div>
        <div class="grid g4 mt16">
          ${kpi({ label: 'Enviados', value: fmt(campaign.sentCount), tone: 'verde' })}
          ${kpi({ label: 'Omitidos', value: fmt(campaign.skippedCount), tone: 'naranja' })}
          ${kpi({ label: 'Errores', value: fmt(campaign.failedCount), tone: 'rojo' })}
          ${kpi({ label: 'Pendientes', value: fmt(Math.max(0, campaign.totalTargets - done)), tone: 'azul' })}
        </div>
      </section>

      ${local ? `<div class="callout warn"><strong>Borrador local.</strong> Esta campaña se guardó en el navegador y no se ha enviado. Arranca el servidor del proyecto y vuelve a encolarla para ver el envío en vivo.</div>` : ''}

      <section class="card">
        <div class="card-head"><div><h3>Mensajes</h3><p>${local ? 'Primeras variaciones que se enviarían.' : 'Últimos 200 destinatarios.'}</p></div>
        ${local ? '' : '<button class="btn btn-sm btn-ghost" id="monRefresh">Actualizar</button>'}</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Teléfono</th><th>Nombre</th><th>Mensaje</th><th>Estado</th></tr></thead>
            <tbody id="monRows">
              ${renderItemRows(items, campaign, local)}
            </tbody>
          </table>
        </div>
      </section>
      ${local ? '' : `<p class="hint">Se actualiza solo cada 4 segundos. Puedes cerrar esta pestaña: el servidor sigue enviando.</p>`}
    `
  },
  mount (app, root, data) {
    on(root, '[data-go]', 'click', (_e, b) => app.go(b.dataset.go))
    on(root, '[data-report]', 'click', (_e, b) => app.go('reportes/' + b.dataset.report))
    on(root, '[data-act]', 'click', async (_e, b) => {
      const action = b.dataset.act
      const label = { pause: 'pausar', resume: 'reanudar', cancel: 'cancelar' }[action]
      if (action === 'cancel' && !(await confirmDialog('¿Cancelar la campaña? Los mensajes pendientes no se enviarán.', { okLabel: 'Cancelar campaña', danger: true }))) return
      b.disabled = true
      const r = await API.campaignAction(app.param, action)
      b.disabled = false
      if (r.ok) { toast('Campaña: ' + label + ' solicitado', 'ok'); S.logActivity('Campaña ' + app.param + ': ' + label); app.render() } else toast(r.error, 'bad')
    })
    const refresh = $('#monRefresh', root)
    if (refresh) refresh.addEventListener('click', () => app.render())

    if (data.local || !API.isServer()) return
    app.monitorTimer = setInterval(async () => {
      if (app.currentView !== 'monitor') { clearInterval(app.monitorTimer); return }
      const r = await API.getCampaign(app.param)
      if (!r.ok) return
      const c = normalizeCampaign(r.data.campaign || {})
      const tbody = document.getElementById('monRows')
      if (tbody) tbody.innerHTML = renderItemRows(r.data.items || [], c, false)
      const done = Number(c.sentCount) + Number(c.skippedCount) + Number(c.failedCount)
      const pct = Math.min(100, Math.round((done / Math.max(1, Number(c.totalTargets))) * 100))
      const bar = root.querySelector('.progress > span')
      if (bar) bar.style.width = pct + '%'
      const nums = root.querySelectorAll('.kpi-num')
      if (nums.length >= 4) {
        nums[0].textContent = fmt(c.sentCount)
        nums[1].textContent = fmt(c.skippedCount)
        nums[2].textContent = fmt(c.failedCount)
        nums[3].textContent = fmt(Math.max(0, c.totalTargets - done))
      }
      if (['COMPLETED', 'CANCELLED'].includes(String(c.status).toUpperCase())) clearInterval(app.monitorTimer)
    }, 4000)
    app.onLeave = () => clearInterval(app.monitorTimer)
  }
}

function renderItemRows (items, campaign, local) {
  if (items.length) {
    return items.slice(0, 200).map((it) => `
      <tr>
        <td class="nowrap">${esc('+' + String(it.contactPhone || ''))}</td>
        <td>${esc(it.contactName || '—')}</td>
        <td><span class="truncate" title="${esc(it.renderedText || '')}">${esc(it.renderedText || '—')}</span></td>
        <td>${statusChip(it.status)}</td>
      </tr>`).join('')
  }
  if (local && campaign && campaign.preview) {
    return campaign.preview.map((p) => `
      <tr>
        <td class="nowrap">${esc('+' + p.phone)}</td>
        <td>${esc(p.name || '—')}</td>
        <td><span class="truncate" title="${esc(p.text)}">${esc(p.text)}</span></td>
        <td>${statusChip('PENDING')}</td>
      </tr>`).join('')
  }
  return emptyRow(4, 'Todavía no hay mensajes que mostrar.')
}

/* ============================== NUEVA CAMPAÑA ============================ */

export function openWizard (app, preset = {}) {
  const st = S.getState()
  const wiz = {
    step: 1,
    name: preset.name || '',
    audience: 'contactos', // contactos | pegar | archivo
    tag: '',
    csvText: preset.csv || '',
    parsed: null,
    template: preset.template || '',
    cadence: st.settings.cadence,
    batch: st.settings.batch,
    cooldownMin: st.settings.cooldownMin,
    includeSuppressed: false
  }

  const tagOptions = [...new Set(st.contacts.flatMap((c) => c.tags || []))]

  const body = `
    <div class="seg" id="wizSteps" role="tablist" aria-label="Pasos">
      <button data-step="1" aria-pressed="true">1 · Audiencia</button>
      <button data-step="2" aria-pressed="false">2 · Mensaje</button>
      <button data-step="3" aria-pressed="false">3 · Envío</button>
    </div>

    <section class="wiz-step" data-panel="1">
      <div class="field"><label for="wizName">Nombre de la campaña</label>
        <input id="wizName" type="text" placeholder="Ej.: Promo septiembre · clientes" value="${esc(wiz.name)}"></div>

      <div class="seg" id="wizAudience" role="group" aria-label="Origen de la audiencia">
        <button data-a="contactos" aria-pressed="true">Mis contactos</button>
        <button data-a="pegar" aria-pressed="false">Pegar CSV</button>
        <button data-a="archivo" aria-pressed="false">Subir archivo</button>
      </div>

      <div data-a-panel="contactos" class="mt16">
        <div class="field-row">
          <div class="field"><label for="wizTag">Filtrar por etiqueta</label>
            <select id="wizTag"><option value="">Todos los contactos (${st.contacts.length})</option>
              ${tagOptions.map((t) => `<option value="${esc(t)}">${esc(t)} (${st.contacts.filter((c) => (c.tags || []).includes(t)).length})</option>`).join('')}
            </select></div>
          <div class="field"><label>Selección</label><div class="hint" id="wizAudCount" style="padding-top:9px">—</div></div>
        </div>
        <label class="check"><input type="checkbox" id="wizAll" checked> Usar todos los contactos de esta selección</label>
      </div>

      <div data-a-panel="pegar" hidden>
        <div class="field"><label for="wizCsv">Pega tus filas (la primera línea puede ser la cabecera)</label>
          <textarea id="wizCsv" rows="7" placeholder="phone,name,consent_origin&#10;3001112233,María López,Formulario web&#10;3004445566,Andrés Ramírez,WhatsApp"></textarea>
          <p class="hint">La columna de teléfono puede llamarse phone, telefono, celular o movil. Si no hay cabecera, la primera columna será el teléfono.</p>
        </div>
      </div>

      <div data-a-panel="archivo" hidden>
        <div class="field"><label for="wizFile">Archivo CSV exportado de Excel o Google Sheets</label>
          <input id="wizFile" type="file" accept=".csv,text/csv,text/plain">
          <p class="hint">Excel: “Guardar como → CSV UTF-8”. Nada sale de tu equipo.</p>
        </div>
      </div>

      <div id="wizAudSummary" class="mt16"></div>
    </section>

    <section class="wiz-step" data-panel="2" hidden>
      <div class="field">
        <label for="wizTemplate">Mensaje</label>
        <div class="toolbar" style="margin-bottom:8px">
          <button class="btn btn-sm btn-ghost" data-fmt="bold" title="Negrita">*N*</button>
          <button class="btn btn-sm btn-ghost" data-fmt="italic" title="Cursiva">_c_</button>
          <button class="btn btn-sm btn-ghost" data-fmt="strike" title="Tachado">~t~</button>
          <button class="btn btn-sm btn-ghost" data-var="name">+ Nombre</button>
          <button class="btn btn-sm btn-ghost" data-save-tpl>Guardar como plantilla</button>
          <div class="spacer"></div>
          <button class="btn btn-sm btn-warm" id="wizIA">Generar con IA</button>
          <button class="btn btn-sm btn-ghost" id="wizPrompt" title="Prompt 360° para pegar en cualquier IA">Prompt 360°</button>
        </div>
        <textarea id="wizTemplate" rows="7" placeholder="Hola {{name}}, {tenemos|te traemos} una promo...">${esc(wiz.template)}</textarea>
        <p class="hint">Usa <span class="mono">{{name}}</span> para el nombre y <span class="mono">{opción A|opción B}</span> para variar el texto entre contactos. <span id="wizCount"></span></p>
      </div>
      <div class="split-2">
        <div>
          <h3>Variaciones</h3>
          <div class="preview-box" id="wizPreview"></div>
          <button class="btn btn-sm btn-ghost mt16" id="wizReroll">Ver otra combinación</button>
        </div>
        <div>
          <h3>Vista previa de WhatsApp</h3>
          <div class="bubble" id="wizBubble" style="white-space:pre-wrap"></div>
        </div>
      </div>
    </section>

    <section class="wiz-step" data-panel="3" hidden>
      <div class="field">
        <label>Ritmo de envío</label>
        <div class="seg" id="wizCadence" role="group" aria-label="Ritmo">
          ${Object.entries(S.CADENCES).map(([k, v]) => `<button data-c="${k}" aria-pressed="${wiz.cadence === k}">${esc(v.label)}</button>`).join('')}
        </div>
        <p class="hint" id="wizCadenceNote"></p>
      </div>
      <div class="field-row">
        <div class="field"><label for="wizBatch">Mensajes por lote</label><input id="wizBatch" type="number" min="5" max="500" value="${wiz.batch}"></div>
        <div class="field"><label for="wizCooldown">Pausa entre lotes (min)</label><input id="wizCooldown" type="number" min="1" max="120" value="${wiz.cooldownMin}"></div>
      </div>
      <div id="wizSendSummary" class="mt16"></div>
      <div class="callout info">El servidor aplica además las reglas de seguridad del proyecto: bajas, consentimiento y fatiga (máximo una difusión cada 7 días por contacto) se filtran antes de enviar.</div>
    </section>
  `

  const foot = `
    <button class="btn btn-ghost" data-x="back" hidden>← Atrás</button>
    <button class="btn btn-ghost" data-x="cancel">Cancelar</button>
    <button class="btn btn-primary" data-x="next">Continuar →</button>
  `

  modal({ title: 'Nueva campaña', body, foot, wide: true, onMount: ({ bodyEl, footEl }) => wizardMount(app, wiz, bodyEl, footEl) })
}

function wizardMount (app, wiz, bodyEl, footEl) {
  const st = S.getState()

  const audit = () => {
    const contacts = selectedContacts(wiz, st)
    const suppressed = contacts.filter((c) => S.isSuppressed(c.phone))
    const usable = contacts.filter((c) => !S.isSuppressed(c.phone) || wiz.includeSuppressed)
    return { contacts, suppressed, usable }
  }

  const refreshAud = () => {
    const { contacts, suppressed, usable } = audit()
    const el = bodyEl.querySelector('#wizAudSummary')
    if (!el) return
    if (!contacts.length) {
      el.innerHTML = '<div class="callout warn">Todavía no hay destinatarios en esta selección.</div>'
      return
    }
    el.innerHTML = `
      <div class="callout ok"><strong>${fmt(usable.length)} destinatarios listos.</strong>
        ${suppressed.length ? ` ${fmt(suppressed.length)} están en la lista de bajas y no recibirán el mensaje.` : ' Ninguno está en la lista de bajas.'}</div>
      <div class="table-wrap"><table><thead><tr><th>Teléfono</th><th>Nombre</th><th>Origen del consentimiento</th></tr></thead><tbody>
        ${contacts.slice(0, 8).map((c) => `<tr><td class="nowrap">${esc(S.prettyPhone(c.phone))}</td><td>${esc(c.name || '—')}</td><td>${esc(c.consentOrigin || '—')}</td></tr>`).join('')}
      </tbody></table></div>
      ${contacts.length > 8 ? `<p class="hint">y ${fmt(contacts.length - 8)} más…</p>` : ''}
    `
    const count = bodyEl.querySelector('#wizAudCount')
    if (count) count.textContent = `${fmt(usable.length)} se enviarán · ${fmt(contacts.length)} en la selección`
  }

  const refreshAudienceSource = () => {
    bodyEl.querySelectorAll('[data-a-panel]').forEach((p) => { p.hidden = p.dataset.aPanel !== wiz.audience })
    bodyEl.querySelectorAll('#wizAudience button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.a === wiz.audience)))
    refreshAud()
  }

  const refreshMessage = () => {
    const template = bodyEl.querySelector('#wizTemplate')
    if (!template) return
    wiz.template = template.value
    const previewBox = bodyEl.querySelector('#wizPreview')
    const bubble = bodyEl.querySelector('#wizBubble')
    const count = bodyEl.querySelector('#wizCount')
    const sample = st.contacts[0] || { name: 'María' }
    const rows = [1, 2, 3, 4, 5].map((i) => S.renderTemplate(wiz.template, 'preview_' + i + '_' + wiz.reroll, { name: sample.name || 'María', ...(sample.variables || {}) }))
    if (previewBox) previewBox.innerHTML = rows.map((r, i) => `<div class="pv"><strong>${i + 1}.</strong> ${esc(r)}</div>`).join('')
    if (bubble) bubble.textContent = rows[0] || 'Escribe el mensaje a la izquierda.'
    if (count) count.textContent = `${wiz.template.length} caracteres · ${S.countBlocks(wiz.template)} bloque(s) de variación`
    refreshSend()
  }

  const refreshSend = () => {
    const el = bodyEl.querySelector('#wizSendSummary')
    if (!el) return
    const { usable, suppressed } = audit()
    const cad = S.CADENCES[wiz.cadence]
    const perHour = Math.round(3600 / ((cad.minDelay + cad.maxDelay) / 2))
    el.innerHTML = `<dl class="kv">
      <dt>Destinatarios</dt><dd>${fmt(usable.length)}${suppressed.length ? ` (${fmt(suppressed.length)} en bajas)` : ''}</dd>
      <dt>Ritmo</dt><dd>${esc(cad.label)} · un mensaje cada ${cad.minDelay}–${cad.maxDelay}s (≈${perHour}/hora)</dd>
      <dt>Lotes</dt><dd>${fmt(wiz.batch)} mensajes, luego ${fmt(wiz.cooldownMin)} min de pausa</dd>
      <dt>Envío</dt><dd>${API.isServer() ? 'Se encola en el servidor y sale en vivo' : 'Borrador local (sin servidor)'}</dd>
    </dl>`
    const note = bodyEl.querySelector('#wizCadenceNote')
    if (note) note.textContent = cad.note
  }

  const showStep = (n) => {
    wiz.step = n
    bodyEl.querySelectorAll('.wiz-step').forEach((s) => { s.hidden = Number(s.dataset.panel) !== n })
    bodyEl.querySelectorAll('#wizSteps button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.step) === n)))
    footEl.querySelector('[data-x="back"]').hidden = n === 1
    const next = footEl.querySelector('[data-x="next"]')
    next.textContent = n === 3 ? (API.isServer() ? 'Encolar campaña' : 'Guardar borrador local') : 'Continuar →'
    if (n === 2) refreshMessage()
    if (n === 3) refreshSend()
  }

  bodyEl.addEventListener('click', (e) => {
    const t = e.target.closest('button')
    if (!t) return
    if (t.dataset.step) return showStep(Number(t.dataset.step))
    if (t.dataset.a) { wiz.audience = t.dataset.a; refreshAudienceSource(); return }
    if (t.dataset.c) {
      wiz.cadence = t.dataset.c
      const cad = S.CADENCES[wiz.cadence]
      wiz.batch = cad.batch
      wiz.cooldownMin = cad.cooldown
      const b = bodyEl.querySelector('#wizBatch'); if (b) b.value = cad.batch
      const cd = bodyEl.querySelector('#wizCooldown'); if (cd) cd.value = cad.cooldown
      bodyEl.querySelectorAll('#wizCadence button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.c === wiz.cadence)))
      refreshSend()
      return
    }
    if (t.dataset.fmt) {
      const ta = bodyEl.querySelector('#wizTemplate')
      const wrap = { bold: ['*', '*'], italic: ['_', '_'], strike: ['~', '~'] }[t.dataset.fmt]
      surround(ta, wrap[0], wrap[1]); refreshMessage(); return
    }
    if (t.dataset.var) {
      const ta = bodyEl.querySelector('#wizTemplate')
      insertAtCursor(ta, '{{' + t.dataset.var + '}}'); refreshMessage(); return
    }
    if (t.hasAttribute('data-save-tpl')) {
      const ta = bodyEl.querySelector('#wizTemplate')
      const name = prompt('Nombre de la plantilla', wiz.name || 'Mi plantilla')
      if (name) { S.saveTemplate({ name, body: ta.value }); toast('Plantilla guardada', 'ok'); app.render() }
      return
    }
    if (t.id === 'wizReroll') { wiz.reroll = (wiz.reroll || 0) + 1; refreshMessage(); return }
    if (t.id === 'wizIA') { generateIA(app, bodyEl, refreshMessage); return }
    if (t.id === 'wizPrompt') { buildMasterPrompt(app); return }
  })

  bodyEl.addEventListener('input', (e) => {
    if (e.target.id === 'wizName') wiz.name = e.target.value
    if (e.target.id === 'wizTemplate') refreshMessage()
    if (e.target.id === 'wizCsv') { wiz.csvText = e.target.value; wiz.parsed = S.parseAudienceCsv(wiz.csvText); refreshAud() }
    if (e.target.id === 'wizTag') { wiz.tag = e.target.value; refreshAud() }
    if (e.target.id === 'wizBatch') wiz.batch = Number(e.target.value) || 5
    if (e.target.id === 'wizCooldown') wiz.cooldownMin = Number(e.target.value) || 1
    if (e.target.id === 'wizAll') refreshAud()
  })

  bodyEl.addEventListener('change', async (e) => {
    if (e.target.id === 'wizFile') {
      const f = e.target.files && e.target.files[0]
      if (!f) return
      const text = await readFileAsText(f)
      wiz.csvText = text
      wiz.parsed = S.parseAudienceCsv(text)
      refreshAud()
      toast(`${wiz.parsed.validCount} teléfonos leídos de ${f.name}`, wiz.parsed.validCount ? 'ok' : 'warn')
    }
  })

  footEl.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-x]')
    if (!b) return
    if (b.dataset.x === 'cancel') return closeModal()
    if (b.dataset.x === 'back') return showStep(Math.max(1, wiz.step - 1))
    if (b.dataset.x === 'next') {
      if (wiz.step < 3) return showStep(wiz.step + 1)
      return submit(app, wiz, st)
    }
  })

  refreshAudienceSource()
  showStep(1)
}

function selectedContacts (wiz, st) {
  if (wiz.audience === 'contactos') {
    const list = wiz.tag ? st.contacts.filter((c) => (c.tags || []).includes(wiz.tag)) : st.contacts.slice()
    return list.map((c) => ({ phone: c.phone, name: c.name, consentOrigin: c.consentOrigin }))
  }
  const parsed = wiz.parsed || S.parseAudienceCsv(wiz.csvText)
  wiz.parsed = parsed
  return parsed.contacts
}

async function buildMasterPrompt (app) {
  if (!API.isServer()) return toast('El prompt 360° necesita el servidor del proyecto.', 'warn')
  const productName = prompt('¿Qué producto o servicio anuncias?', '')
  if (!productName) return
  const painPoint = prompt('Problema que le resuelves al cliente', '')
  const mainBenefit = prompt('Beneficio principal', '')
  const r = await API.masterPrompt({
    productName,
    country: 'CO',
    mainBenefit: mainBenefit || '',
    painPoint: painPoint || ''
  })
  const text = r.ok && r.data ? (r.data.masterPrompt || '') : ''
  if (!text) return toast(r.error || 'No se pudo construir el prompt', 'bad')
  modal({
    title: 'Prompt 360° listo',
    body: `<p class="hint">Copia este texto y pégalo en la IA que uses; pide una campaña con variantes.</p>
      <textarea id="mpText" rows="14" readonly>${esc(text)}</textarea>`,
    foot: '<button class="btn btn-ghost" data-x="close">Cerrar</button><button class="btn btn-primary" data-x="copy">Copiar</button>',
    onMount: ({ bodyEl, footEl }) => {
      footEl.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-x]')
        if (!b) return
        if (b.dataset.x === 'close') return closeModal()
        const ta = bodyEl.querySelector('#mpText')
        try {
          await navigator.clipboard.writeText(ta.value)
          toast('Prompt copiado', 'ok')
        } catch {
          ta.select()
          toast('Selecciónalo y copia con Ctrl+C', 'warn')
        }
      })
    }
  })
}

async function generateIA (app, bodyEl, refreshMessage) {
  if (!API.isServer()) return toast('La generación con IA necesita el servidor del proyecto.', 'warn')
  const productName = prompt('¿Qué producto o servicio anuncias?', '')
  if (!productName) return
  const benefit = prompt('Beneficio principal para el cliente', '')
  const pain = prompt('Problema que le resuelves', '')
  const btn = bodyEl.querySelector('#wizIA')
  btn.disabled = true
  const r = await API.generateSpintax({ productName, country: 'CO', mainBenefit: benefit || '', painPoint: pain || '' })
  btn.disabled = false
  if (r.ok && r.data && r.data.spintaxTemplate) {
    const ta = bodyEl.querySelector('#wizTemplate')
    ta.value = r.data.spintaxTemplate
    refreshMessage()
    toast('Mensaje generado', 'ok')
  } else toast(r.error || 'No se pudo generar el mensaje', 'bad')
}

async function submit (app, wiz, st) {
  if (!(wiz.name || '').trim()) return toast('Ponle un nombre a la campaña.', 'warn')
  const { contacts, usable } = audit(wiz, st)
  if (!contacts.length) return toast('La audiencia está vacía.', 'warn')
  if (!(wiz.template || '').trim()) return toast('Escribe el mensaje antes de continuar.', 'warn')

  const csvContent = ['phone,name,consent_origin', ...usable.map((c) => `"${c.phone}","${(c.name || '').replace(/"/g, '""')}","${(c.consentOrigin || '').replace(/"/g, '""')}"`)].join('\n')

  if (API.isServer()) {
    const r = await API.createCampaign({ name: wiz.name.trim(), templateSpintax: wiz.template, csvContent })
    if (r.ok && r.data && r.data.id) {
      S.logActivity(`Campaña “${wiz.name}” encolada con ${usable.length} destinatarios`)
      closeModal()
      toast('Campaña encolada: ' + usable.length + ' destinatarios', 'ok')
      app.go('monitor/' + r.data.id)
      return
    }
    toast(r.error || 'No se pudo crear la campaña', 'bad')
    return
  }

  const preview = usable.slice(0, 20).map((c) => ({
    phone: c.phone,
    name: c.name,
    text: S.renderTemplate(wiz.template, c.phone, { name: c.name || '', ...(c.variables || {}) })
  }))
  const id = S.uid('lc')
  S.saveLocalCampaign({
    id,
    name: wiz.name.trim(),
    status: 'LOCAL',
    totalTargets: usable.length,
    sentCount: 0,
    skippedCount: contacts.length - usable.length,
    failedCount: 0,
    createdAt: S.nowIso(),
    local: true,
    template: wiz.template,
    cadence: wiz.cadence,
    batch: wiz.batch,
    cooldownMin: wiz.cooldownMin,
    preview
  })
  S.logActivity(`Borrador local “${wiz.name}” con ${usable.length} destinatarios`)
  closeModal()
  toast('Borrador guardado. Arranca el servidor para enviarlo.', 'ok')
  app.go('monitor/' + id)
}

function audit (wiz, st) {
  const contacts = selectedContacts(wiz, st)
  const suppressed = contacts.filter((c) => S.isSuppressed(c.phone))
  const usable = contacts.filter((c) => !S.isSuppressed(c.phone))
  return { contacts, suppressed, usable }
}

function insertAtCursor (ta, text) {
  if (!ta) return
  const start = ta.selectionStart || 0
  const end = ta.selectionEnd || 0
  ta.value = ta.value.slice(0, start) + text + ta.value.slice(end)
  ta.focus()
  ta.setSelectionRange(start + text.length, start + text.length)
}

function surround (ta, before, after) {
  if (!ta) return
  const start = ta.selectionStart || 0
  const end = ta.selectionEnd || 0
  const sel = ta.value.slice(start, end) || 'texto'
  ta.value = ta.value.slice(0, start) + before + sel + after + ta.value.slice(end)
  ta.focus()
  ta.setSelectionRange(start + before.length, start + before.length + sel.length)
}
