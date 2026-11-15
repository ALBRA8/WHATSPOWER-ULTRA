/** views-more.js — Contactos, Plantillas, Chatbot, Bandeja, Reportes, Enlaces, Bajas y Ajustes. */

import * as S from './store.js'
import * as API from './api.js'
import { esc, kpi, emptyRow, statusChip, toast, modal, closeModal, confirmDialog, on, download, readFileAsText, $, debounce } from './ui.js'

const fmt = (n) => new Intl.NumberFormat('es-ES').format(Number(n || 0))

/* =============================== CONTACTOS =============================== */

export const contactos = {
  title: 'Contactos',
  sub: 'Tu audiencia: quién recibe y con qué consentimiento',
  data () { return { st: S.getState() } },
  html ({ st }, app) {
    const q = (app.filter.contactQuery || '').toLowerCase()
    const tag = app.filter.contactTag || ''
    const tags = [...new Set(st.contacts.flatMap((c) => c.tags || []))]
    const list = st.contacts.filter((c) => {
      const okQ = !q || c.name.toLowerCase().includes(q) || c.phone.includes(q)
      const okT = !tag || (c.tags || []).includes(tag)
      return okQ && okT
    })
    const suppressed = st.contacts.filter((c) => S.isSuppressed(c.phone)).length

    return `
      <div class="grid g4">
        ${kpi({ label: 'Contactos', value: fmt(st.contacts.length), tone: 'verde' })}
        ${kpi({ label: 'Etiquetas', value: fmt(tags.length) })}
        ${kpi({ label: 'En lista de bajas', value: fmt(suppressed), tone: 'naranja', foot: 'no reciben nada' })}
        ${kpi({ label: 'Sin origen de consentimiento', value: fmt(st.contacts.filter((c) => !c.consentOrigin).length), tone: 'rojo' })}
      </div>

      <div class="toolbar mt16">
        <div class="search"><input type="search" id="ctSearch" placeholder="Buscar por nombre o número" value="${esc(app.filter.contactQuery || '')}" aria-label="Buscar contactos"></div>
        <select id="ctTag" aria-label="Filtrar por etiqueta" style="max-width:200px">
          <option value="">Todas las etiquetas</option>
          ${tags.map((t) => `<option value="${esc(t)}" ${tag === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
        </select>
        <div class="spacer"></div>
        <button class="btn btn-ghost btn-sm" id="ctExport">Exportar CSV</button>
        <button class="btn btn-ghost btn-sm" id="ctImport">Importar</button>
        <button class="btn btn-primary btn-sm" id="ctAdd">+ Añadir contacto</button>
      </div>

      <section class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Nombre</th><th>Teléfono</th><th>Etiquetas</th><th>Consentimiento</th><th>Alta</th><th></th></tr></thead>
            <tbody>
              ${list.length ? list.slice(0, 400).map((c) => `
                <tr>
                  <td>${esc(c.name || '—')}</td>
                  <td class="nowrap">${esc(S.prettyPhone(c.phone))}</td>
                  <td>${(c.tags || []).map((t) => `<span class="chip gris">${esc(t)}</span>`).join(' ') || '—'}</td>
                  <td>${c.consentOrigin ? esc(c.consentOrigin) : '<span class="chip rojo">falta</span>'}</td>
                  <td class="nowrap">${esc(S.formatDay(c.createdAt))}</td>
                  <td class="right nowrap">
                    <button class="btn btn-sm btn-ghost" data-edit="${esc(c.id)}">Editar</button>
                    <button class="btn btn-sm btn-ghost" data-optout="${esc(c.phone)}">Dar de baja</button>
                  </td>
                </tr>`).join('') : emptyRow(6, st.contacts.length ? 'Ningún contacto coincide con la búsqueda.' : 'Aún no hay contactos: importa tu lista o añade uno a mano.')}
            </tbody>
          </table>
        </div>
        ${list.length > 400 ? `<p class="hint">Mostrando 400 de ${fmt(list.length)}. Usa la búsqueda para acotar.</p>` : ''}
      </section>
    `
  },
  mount (app, root) {
    const search = $('#ctSearch', root)
    if (search) {
      const run = debounce(() => { app.filter.contactQuery = search.value; app.render() }, 220)
      search.addEventListener('input', () => { run() })
      search.focus()
    }
    const tag = $('#ctTag', root)
    if (tag) tag.addEventListener('change', () => { app.filter.contactTag = tag.value; app.render() })

    const exp = $('#ctExport', root)
    if (exp) exp.addEventListener('click', () => {
      const st = S.getState()
      download('contactos.csv', S.contactsToCsv(st.contacts))
      toast('CSV exportado', 'ok')
    })

    const imp = $('#ctImport', root)
    if (imp) imp.addEventListener('click', () => openImport(app))

    const add = $('#ctAdd', root)
    if (add) add.addEventListener('click', () => openContactForm(app, null))

    on(root, '[data-edit]', 'click', (_e, b) => {
      const c = S.getState().contacts.find((x) => x.id === b.dataset.edit)
      openContactForm(app, c)
    })
    on(root, '[data-optout]', 'click', async (_e, b) => {
      const phone = b.dataset.optout
      if (!(await confirmDialog('Este número dejará de recibir difusiones. ¿Continuar?', { okLabel: 'Dar de baja', danger: true }))) return
      const r = S.addSuppression(phone, 'Baja desde el panel')
      if (API.isServer()) await API.optOut(phone, 'Baja desde el panel')
      S.logActivity('Baja añadida: ' + S.prettyPhone(phone))
      toast(r.ok ? 'Número añadido a la lista de bajas' : r.error, r.ok ? 'ok' : 'warn')
      app.render()
    })
  }
}

function openContactForm (app, contact) {
  const isNew = !contact
  modal({
    title: isNew ? 'Añadir contacto' : 'Editar contacto',
    body: `
      <div class="field-row">
        <div class="field"><label for="cfName">Nombre</label><input id="cfName" type="text" value="${esc(contact?.name || '')}"></div>
        <div class="field"><label for="cfPhone">Teléfono</label><input id="cfPhone" type="text" value="${esc(contact?.phone || '')}" placeholder="300 111 2233"></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="cfConsent">Origen del consentimiento</label><input id="cfConsent" type="text" value="${esc(contact?.consentOrigin || '')}" placeholder="Formulario web, tienda, WhatsApp…"></div>
        <div class="field"><label for="cfTags">Etiquetas (separadas por coma)</label><input id="cfTags" type="text" value="${esc((contact?.tags || []).join(', '))}"></div>
      </div>
      <p class="hint">El origen del consentimiento es obligatorio para difundir según la política del proyecto (Ley 1581).</p>
    `,
    foot: `<button class="btn btn-ghost" data-x="cancel">Cancelar</button><button class="btn btn-primary" data-x="save">Guardar</button>`,
    onMount: ({ footEl }) => {
      footEl.addEventListener('click', (e) => {
        const b = e.target.closest('[data-x]')
        if (!b) return
        if (b.dataset.x === 'cancel') return closeModal()
        const phone = S.canonicalPhone(document.getElementById('cfPhone').value)
        if (!phone) return toast('Ese teléfono no parece válido.', 'warn')
        const patch = {
          phone,
          name: document.getElementById('cfName').value.trim(),
          consentOrigin: document.getElementById('cfConsent').value.trim(),
          tags: document.getElementById('cfTags').value.split(',').map((t) => t.trim()).filter(Boolean)
        }
        if (isNew) {
          const r = S.addContacts([{ ...patch, tag: '' }])
          if (!r.added) {
            S.updateContact(S.getState().contacts.find((c) => c.phone === phone).id, patch)
          }
        } else {
          S.updateContact(contact.id, patch)
        }
        S.logActivity((isNew ? 'Contacto añadido: ' : 'Contacto actualizado: ') + patch.name)
        closeModal(); toast('Contacto guardado', 'ok'); app.render()
      })
    }
  })
}

function openImport (app) {
  modal({
    title: 'Importar contactos',
    body: `
      <div class="seg" id="impMode" role="group">
        <button data-m="pegar" aria-pressed="true">Pegar</button>
        <button data-m="archivo" aria-pressed="false">Archivo CSV</button>
      </div>
      <div class="field mt16" data-m-panel="pegar">
        <label for="impCsv">Filas CSV (la cabecera es opcional)</label>
        <textarea id="impCsv" rows="8" placeholder="phone,name,consent_origin,tag&#10;3001112233,María López,Formulario web,clientes"></textarea>
      </div>
      <div class="field mt16" data-m-panel="archivo" hidden>
        <label for="impFile">Archivo CSV</label>
        <input id="impFile" type="file" accept=".csv,text/csv,text/plain">
      </div>
      <div id="impSummary" class="mt16"></div>
    `,
    foot: `<button class="btn btn-ghost" data-x="cancel">Cancelar</button><button class="btn btn-primary" data-x="save">Importar</button>`,
    onMount: ({ bodyEl, footEl }) => {
      let text = ''
      const refresh = () => {
        const parsed = S.parseAudienceCsv(text)
        const box = bodyEl.querySelector('#impSummary')
        if (!text) { box.innerHTML = ''; return }
        box.innerHTML = `<div class="callout ${parsed.validCount ? 'ok' : 'warn'}">
          <strong>${fmt(parsed.validCount)}</strong> válidos · <strong>${fmt(parsed.duplicatesCount)}</strong> duplicados · <strong>${fmt(parsed.invalidCount)}</strong> descartados
        </div>
        ${parsed.contacts.length ? `<div class="table-wrap"><table><thead><tr><th>Teléfono</th><th>Nombre</th><th>Origen</th></tr></thead><tbody>
          ${parsed.contacts.slice(0, 6).map((c) => `<tr><td class="nowrap">${esc(S.prettyPhone(c.phone))}</td><td>${esc(c.name || '—')}</td><td>${esc(c.consentOrigin || '—')}</td></tr>`).join('')}
        </tbody></table></div>` : ''}`
      }
      bodyEl.addEventListener('click', (e) => {
        const b = e.target.closest('#impMode button')
        if (!b) return
        bodyEl.querySelectorAll('[data-m-panel]').forEach((p) => { p.hidden = p.dataset.mPanel !== b.dataset.m })
        bodyEl.querySelectorAll('#impMode button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)))
      })
      bodyEl.addEventListener('input', (e) => { if (e.target.id === 'impCsv') { text = e.target.value; refresh() } })
      bodyEl.addEventListener('change', async (e) => {
        if (e.target.id === 'impFile' && e.target.files[0]) {
          text = await readFileAsText(e.target.files[0])
          refresh()
        }
      })
      footEl.addEventListener('click', (e) => {
        const b = e.target.closest('[data-x]')
        if (!b) return
        if (b.dataset.x === 'cancel') return closeModal()
        const parsed = S.parseAudienceCsv(text)
        if (!parsed.contacts.length) return toast('No se encontró ningún teléfono válido.', 'warn')
        const r = S.addContacts(parsed.contacts)
        S.logActivity(`Importación: ${r.added} contacto(s) nuevos`)
        closeModal()
        toast(`${r.added} añadidos, ${r.skipped} ya estaban`, 'ok')
        app.render()
      })
    }
  })
}

/* =============================== PLANTILLAS ============================== */

export const plantillas = {
  title: 'Plantillas',
  sub: 'Mensajes que reutilizas, con variables y variaciones',
  data () { return { st: S.getState() } },
  html ({ st }) {
    return `
      <div class="toolbar">
        <p class="hint" style="margin:0">${fmt(st.templates.length)} plantilla(s). Usa {{name}} para el nombre y {A|B} para variar.</p>
        <div class="spacer"></div>
        <button class="btn btn-primary btn-sm" id="tplNew">+ Nueva plantilla</button>
      </div>
      ${st.templates.length ? `<div class="grid g2">
        ${st.templates.map((t) => `
          <section class="card">
            <div class="card-head"><div><h3>${esc(t.name)}</h3><p>${esc(S.formatDay(t.createdAt))} · ${S.countBlocks(t.body)} bloque(s)</p></div></div>
            <div class="preview-box"><div class="pv">${esc(S.renderTemplate(t.body, 'sample', { name: 'María' }))}</div></div>
            <div class="toolbar mt16" style="margin-bottom:0">
              <button class="btn btn-sm btn-primary" data-use="${esc(t.id)}">Usar en campaña</button>
              <button class="btn btn-sm btn-ghost" data-edit="${esc(t.id)}">Editar</button>
              <button class="btn btn-sm btn-ghost" data-dup="${esc(t.id)}">Duplicar</button>
              <button class="btn btn-sm btn-danger" data-del="${esc(t.id)}">Borrar</button>
            </div>
          </section>`).join('')}
      </div>` : `<div class="card"><div class="empty">Aún no tienes plantillas. Crea la primera para reutilizarla en tus campañas.</div></div>`}
    `
  },
  mount (app, root) {
    const st = S.getState()
    $('#tplNew', root)?.addEventListener('click', () => openTemplateForm(app, null))
    on(root, '[data-edit]', 'click', (_e, b) => openTemplateForm(app, st.templates.find((t) => t.id === b.dataset.edit)))
    on(root, '[data-dup]', 'click', (_e, b) => {
      const t = st.templates.find((x) => x.id === b.dataset.dup)
      S.saveTemplate({ name: t.name + ' (copia)', body: t.body })
      toast('Plantilla duplicada', 'ok'); app.render()
    })
    on(root, '[data-del]', 'click', async (_e, b) => {
      if (!(await confirmDialog('¿Borrar esta plantilla?', { okLabel: 'Borrar', danger: true }))) return
      S.removeTemplate(b.dataset.del); toast('Plantilla borrada', 'ok'); app.render()
    })
    on(root, '[data-use]', 'click', (_e, b) => {
      const t = st.templates.find((x) => x.id === b.dataset.use)
      app.openWizard({ name: t.name, template: t.body })
    })
  }
}

function openTemplateForm (app, tpl) {
  const isNew = !tpl
  modal({
    title: isNew ? 'Nueva plantilla' : 'Editar plantilla',
    wide: true,
    body: `
      <div class="field"><label for="tfName">Nombre</label><input id="tfName" type="text" value="${esc(tpl?.name || '')}"></div>
      <div class="field">
        <label for="tfBody">Mensaje</label>
        <textarea id="tfBody" rows="8">${esc(tpl?.body || '')}</textarea>
        <p class="hint"><span class="mono">{{name}}</span> = nombre del contacto · <span class="mono">{Hola|Qué tal}</span> = variaciones</p>
      </div>
      <h3>Vista previa</h3>
      <div class="preview-box" id="tfPreview"></div>
    `,
    foot: `<button class="btn btn-ghost" data-x="cancel">Cancelar</button><button class="btn btn-primary" data-x="save">Guardar</button>`,
    onMount: ({ bodyEl, footEl }) => {
      const body = bodyEl.querySelector('#tfBody')
      const prev = bodyEl.querySelector('#tfPreview')
      const refresh = () => {
        prev.innerHTML = [1, 2, 3].map((i) => `<div class="pv">${esc(S.renderTemplate(body.value, 'tpl_' + i, { name: i === 1 ? 'María' : i === 2 ? 'Andrés' : 'Carolina' }))}</div>`).join('')
      }
      body.addEventListener('input', refresh)
      refresh()
      footEl.addEventListener('click', (e) => {
        const b = e.target.closest('[data-x]')
        if (!b) return
        if (b.dataset.x === 'cancel') return closeModal()
        const name = bodyEl.querySelector('#tfName').value.trim()
        if (!name) return toast('Ponle un nombre a la plantilla.', 'warn')
        if (!body.value.trim()) return toast('La plantilla está vacía.', 'warn')
        S.saveTemplate({ id: tpl?.id, name, body: body.value })
        closeModal(); toast('Plantilla guardada', 'ok'); app.render()
      })
    }
  })
}

/* ================================ CHATBOT ================================ */

export const chatbot = {
  title: 'Chatbot',
  sub: 'Respuestas automáticas mientras no estás',
  data () { return { st: S.getState() } },
  html ({ st }) {
    return `
      <div class="grid g-side">
        <section class="card">
          <div class="card-head">
            <div><h2>Reglas de respuesta</h2><p>Si el mensaje del cliente contiene la palabra, se responde solo.</p></div>
            <div>${st.settings.chatbotActive ? '<span class="chip verde">Activo</span>' : '<span class="chip gris">Apagado</span>'}</div>
          </div>
          ${st.rules.length ? `<div class="table-wrap"><table>
            <thead><tr><th>Palabras</th><th>Respuesta</th><th>Estado</th><th></th></tr></thead>
            <tbody>
              ${st.rules.map((r) => `
                <tr>
                  <td>${esc(r.keywords)}<div class="hint">coincidencia ${esc(r.match)}</div></td>
                  <td><span class="truncate" title="${esc(r.reply)}">${esc(r.reply)}</span></td>
                  <td>${r.active ? '<span class="chip verde">Activa</span>' : '<span class="chip gris">Pausada</span>'}</td>
                  <td class="right nowrap">
                    <button class="btn btn-sm btn-ghost" data-rule-edit="${esc(r.id)}">Editar</button>
                    <button class="btn btn-sm btn-ghost" data-rule-toggle="${esc(r.id)}">${r.active ? 'Pausar' : 'Activar'}</button>
                    <button class="btn btn-sm btn-danger" data-rule-del="${esc(r.id)}">Borrar</button>
                  </td>
                </tr>`).join('')}
            </tbody></table></div>` : '<div class="empty">Sin reglas todavía. Añade una para responder precios, horarios o enlaces.</div>'}
          <button class="btn btn-primary btn-sm mt16" id="ruleNew">+ Añadir regla</button>
        </section>

        <div>
          <section class="card">
            <div class="card-head"><div><h3>Probar el chatbot</h3><p>Escribe como si fueras un cliente.</p></div></div>
            <div id="simLog" class="preview-box" style="min-height:110px; display:flex; flex-direction:column; gap:8px"></div>
            <div class="field mt16" style="margin-bottom:0">
              <label for="simInput">Mensaje del cliente</label>
              <div style="display:flex; gap:8px">
                <input id="simInput" type="text" placeholder="¿Cuánto vale el combo?">
                <button class="btn btn-primary" id="simSend">Enviar</button>
              </div>
            </div>
          </section>

          <section class="card">
            <div class="card-head"><div><h3>Fuera de horario</h3><p>Qué contesta el sistema cuando está cerrado.</p></div></div>
            <label class="check"><input type="checkbox" id="offToggle" ${st.settings.autoReplyOffHours ? 'checked' : ''}> Responder automáticamente fuera de horario</label>
            <div class="field"><label for="offMsg">Mensaje</label><textarea id="offMsg" rows="3">${esc(st.settings.offHoursMessage)}</textarea></div>
            <label class="check"><input type="checkbox" id="chatToggle" ${st.settings.chatbotActive ? 'checked' : ''}> Chatbot activo</label>
            <button class="btn btn-primary btn-sm" id="chatSave">Guardar</button>
          </section>
        </div>
      </div>
    `
  },
  mount (app, root) {
    const st = S.getState()
    const log = $('#simLog', root)
    const addBubble = (text, mine) => {
      const d = document.createElement('div')
      d.className = 'bubble' + (mine ? ' them' : '')
      d.textContent = text
      log.appendChild(d)
      log.scrollTop = log.scrollHeight
    }
    const send = () => {
      const input = $('#simInput', root)
      const text = input.value.trim()
      if (!text) return
      input.value = ''
      addBubble(text, true)
      if (!st.settings.chatbotActive) { addBubble('(El chatbot está apagado: este mensaje quedaría pendiente de respuesta manual.)', false); return }
      const rule = S.matchRule(text)
      addBubble(rule ? rule.reply : 'No hay ninguna regla que coincida. Puedes añadir una con esas palabras.', false)
    }
    $('#simSend', root)?.addEventListener('click', send)
    $('#simInput', root)?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send() } })

    $('#ruleNew', root)?.addEventListener('click', () => openRuleForm(app, null))
    on(root, '[data-rule-edit]', 'click', (_e, b) => openRuleForm(app, st.rules.find((r) => r.id === b.dataset.ruleEdit)))
    on(root, '[data-rule-toggle]', 'click', (_e, b) => {
      const r = st.rules.find((x) => x.id === b.dataset.ruleToggle)
      S.saveRule({ ...r, active: !r.active })
      app.render()
    })
    on(root, '[data-rule-del]', 'click', async (_e, b) => {
      if (!(await confirmDialog('¿Borrar esta regla?', { okLabel: 'Borrar', danger: true }))) return
      S.removeRule(b.dataset.ruleDel); app.render()
    })

    $('#chatSave', root)?.addEventListener('click', () => {
      S.setSettings({
        autoReplyOffHours: $('#offToggle', root).checked,
        offHoursMessage: $('#offMsg', root).value,
        chatbotActive: $('#chatToggle', root).checked
      })
      toast('Chatbot actualizado', 'ok')
      app.render()
    })
  }
}

function openRuleForm (app, rule) {
  const isNew = !rule
  modal({
    title: isNew ? 'Nueva regla' : 'Editar regla',
    body: `
      <div class="field"><label for="rfKeys">Palabras o frases (separadas por coma)</label>
        <input id="rfKeys" type="text" value="${esc(rule?.keywords || '')}" placeholder="precio, cuánto vale, tarifa"></div>
      <div class="field"><label for="rfMatch">Coincidencia</label>
        <select id="rfMatch">
          <option value="contiene" ${rule?.match === 'contiene' ? 'selected' : ''}>El mensaje contiene la palabra</option>
          <option value="exacta" ${rule?.match === 'exacta' ? 'selected' : ''}>El mensaje es exactamente igual</option>
        </select></div>
      <div class="field"><label for="rfReply">Respuesta</label><textarea id="rfReply" rows="4">${esc(rule?.reply || '')}</textarea></div>
      <div class="field"><label for="rfImage">Imagen (enlace opcional)</label><input id="rfImage" type="url" value="${esc(rule?.image || '')}" placeholder="https://…/catalogo.jpg"></div>
    `,
    foot: `<button class="btn btn-ghost" data-x="cancel">Cancelar</button><button class="btn btn-primary" data-x="save">Guardar regla</button>`,
    onMount: ({ bodyEl, footEl }) => {
      footEl.addEventListener('click', (e) => {
        const b = e.target.closest('[data-x]')
        if (!b) return
        if (b.dataset.x === 'cancel') return closeModal()
        const keywords = bodyEl.querySelector('#rfKeys').value.trim()
        const reply = bodyEl.querySelector('#rfReply').value.trim()
        if (!keywords || !reply) return toast('Faltan las palabras o la respuesta.', 'warn')
        S.saveRule({
          id: rule?.id,
          keywords,
          match: bodyEl.querySelector('#rfMatch').value,
          reply,
          image: bodyEl.querySelector('#rfImage').value.trim(),
          active: rule?.active !== false
        })
        closeModal(); toast('Regla guardada', 'ok'); app.render()
      })
    }
  })
}

/* ================================ BANDEJA ================================ */

export const bandeja = {
  title: 'Bandeja',
  sub: 'Conversaciones y respuestas',
  data (app) {
    const st = S.getState()
    const selected = st.conversations.find((c) => c.id === app.param) || st.conversations[0] || null
    return { st, selected }
  },
  html ({ st, selected }) {
    return `
      <div class="callout info"><strong>Bandeja local.</strong> Aquí guardas las conversaciones que quieras atender desde el panel. La entrada automática de respuestas necesita el conector de mensajes del servidor; mientras tanto puedes registrar y responder manualmente.</div>
      <div class="grid g-side">
        <section class="card">
          <div class="card-head"><div><h2>Conversaciones</h2><p>${fmt(st.conversations.length)} hilo(s).</p></div>
            <button class="btn btn-sm btn-ghost" id="cvNew">+ Nuevo hilo</button></div>
          ${st.conversations.length ? `<ul class="list">
            ${st.conversations.map((c) => `
              <li>
                <div><strong>${esc(c.name || S.prettyPhone(c.phone))}</strong>
                  <div class="hint truncate">${esc((c.messages[c.messages.length - 1] || {}).text || '')}</div></div>
                <span class="when">${esc(S.formatDate(c.updatedAt))}</span>
                <button class="btn btn-sm btn-ghost" data-open="${esc(c.id)}">Abrir</button>
              </li>`).join('')}
          </ul>` : '<div class="empty">Sin conversaciones.</div>'}
        </section>
        <section class="card">
          ${selected ? `
            <div class="card-head"><div><h3>${esc(selected.name || S.prettyPhone(selected.phone))}</h3><p>${esc(S.prettyPhone(selected.phone))}</p></div>
              <button class="btn btn-sm btn-danger" data-cv-del="${esc(selected.id)}">Borrar hilo</button></div>
            <div class="preview-box" style="display:flex;flex-direction:column;gap:8px;min-height:180px;max-height:320px;overflow:auto">
              ${selected.messages.map((m) => `<div class="bubble ${m.dir === 'in' ? 'them' : ''}">${esc(m.text)}<div class="hint">${esc(S.formatDate(m.at))}</div></div>`).join('')}
            </div>
            <div class="field mt16" style="margin-bottom:0">
              <label for="cvReply">Responder</label>
              <div style="display:flex;gap:8px"><input id="cvReply" type="text" placeholder="Escribe tu respuesta"><button class="btn btn-primary" id="cvSend">Enviar</button></div>
            </div>` : '<div class="empty">Elige una conversación.</div>'}
        </section>
      </div>
    `
  },
  mount (app, root, data) {
    const st = S.getState()
    on(root, '[data-open]', 'click', (_e, b) => app.go('bandeja/' + b.dataset.open))
    const sel = data.selected
    if (sel) {
      const send = () => {
        const input = $('#cvReply', root)
        const text = input.value.trim()
        if (!text) return
        S.addMessage(sel.id, 'out', text)
        const rule = S.matchRule(text)
        void rule
        toast('Respuesta guardada en el hilo', 'ok')
        app.render()
      }
      $('#cvSend', root)?.addEventListener('click', send)
      $('#cvReply', root)?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send() } })
      on(root, '[data-cv-del]', 'click', async () => {
        if (!(await confirmDialog('¿Borrar esta conversación?', { okLabel: 'Borrar', danger: true }))) return
        S.removeConversation(sel.id); app.go('bandeja')
      })
    }
    $('#cvNew', root)?.addEventListener('click', () => {
      const phone = prompt('Teléfono del contacto')
      if (!phone) return
      const canon = S.canonicalPhone(phone)
      if (!canon) return toast('Teléfono no válido.', 'warn')
      const name = prompt('Nombre (opcional)') || ''
      const c = { phone: canon, name, messages: [] }
      S.saveConversation(c)
      const conv = S.getState().conversations[0]
      app.go('bandeja/' + conv.id)
    })
    void st
  }
}

/* ================================ REPORTES =============================== */

export const reportes = {
  title: 'Reportes',
  sub: 'Qué pasó con cada envío',
  async data (app) {
    const st = S.getState()
    let campaigns = st.localCampaigns.slice()
    if (API.isServer()) {
      const r = await API.listCampaigns(100)
      if (r.ok && r.data) campaigns = (r.data.campaigns || []).map((c) => ({
        id: c.id, name: c.name || 'Campaña', status: c.status,
        totalTargets: c.totalTargets ?? c.total_targets ?? 0,
        sentCount: c.sentCount ?? c.sent_count ?? 0,
        skippedCount: c.skippedCount ?? c.skipped_count ?? 0,
        failedCount: c.failedCount ?? c.failed_count ?? 0,
        createdAt: c.createdAt || c.created_at || null
      }))
    }
    const id = app.param || (campaigns[0] && campaigns[0].id) || null
    let attribution = null
    let detail = null
    if (id && API.isServer() && !String(id).startsWith('lc_')) {
      const [a, d] = await Promise.all([API.attribution(id), API.getCampaign(id)])
      if (a.ok) attribution = a.data
      if (d.ok) detail = d.data
    }
    return { campaigns, id, attribution, detail, st }
  },
  html ({ campaigns, id, attribution, detail }) {
    const c = campaigns.find((x) => x.id === id)
    if (!campaigns.length) return '<div class="card"><div class="empty">Aún no hay campañas que reportar.</div></div>'
    const total = Number(c?.totalTargets || 0)
    const sent = Number(c?.sentCount || 0)
    const skipped = Number(c?.skippedCount || 0)
    const failed = Number(c?.failedCount || 0)
    const clicks = attribution ? Number(attribution.totalClicks || 0) : null
    const ctr = attribution ? String(attribution.ctr || '0.0') : null
    const pct = (n) => total ? Math.round((n / total) * 100) : 0

    const itemStatuses = detail && detail.items
      ? detail.items.reduce((acc, it) => { const k = it.status || 'PENDING'; acc[k] = (acc[k] || 0) + 1; return acc }, {})
      : null

    return `
      <div class="toolbar">
        <label for="repPick" style="margin:0">Campaña</label>
        <select id="repPick" style="max-width:340px">
          ${campaigns.map((x) => `<option value="${esc(x.id)}" ${x.id === id ? 'selected' : ''}>${esc(x.name)} · ${esc(S.formatDay(x.createdAt))}</option>`).join('')}
        </select>
        <div class="spacer"></div>
        <button class="btn btn-ghost btn-sm" id="repExport">Exportar CSV</button>
      </div>

      <div class="grid g4">
        ${kpi({ label: 'Enviados', value: fmt(sent), foot: pct(sent) + '% del total', tone: 'verde' })}
        ${kpi({ label: 'Omitidos', value: fmt(skipped), foot: 'bajas, fatiga o bloqueo', tone: 'naranja' })}
        ${kpi({ label: 'Errores', value: fmt(failed), tone: 'rojo' })}
        ${kpi({ label: 'Clics', value: clicks === null ? '—' : fmt(clicks), foot: clicks === null ? 'requiere servidor' : 'CTR ' + ctr + '%', tone: 'azul' })}
      </div>

      <section class="card mt16">
        <div class="card-head"><div><h3>Reparto de los envíos</h3><p>${esc(c?.name || '')}</p></div>${statusChip(c?.status)}</div>
        <div class="bars">
          ${[['Enviados', sent, 'var(--verde)'], ['Omitidos', skipped, 'var(--naranja)'], ['Errores', failed, 'var(--rojo)']].map(([label, value, color]) => `
            <div class="bar-row">
              <span>${label}</span>
              <div class="bar-track"><span style="width:${total ? Math.max(2, pct(value)) : 0}%; background:${color}"></span></div>
              <span class="num right">${fmt(value)}</span>
            </div>`).join('')}
        </div>
        ${itemStatuses ? `<h3 class="mt16">Detalle por estado de mensaje</h3>
          <div class="table-wrap"><table><thead><tr><th>Estado</th><th class="right">Mensajes</th></tr></thead><tbody>
            ${Object.entries(itemStatuses).map(([k, v]) => `<tr><td>${statusChip(k)}</td><td class="right num">${fmt(v)}</td></tr>`).join('')}
          </tbody></table></div>` : ''}
      </section>

      ${attribution && attribution.links && attribution.links.length ? `<section class="card">
        <div class="card-head"><div><h3>Enlaces de esta campaña</h3><p>Clics registrados por el servidor.</p></div></div>
        <div class="table-wrap"><table><thead><tr><th>Código</th><th>Destino</th><th class="right">Clics</th></tr></thead><tbody>
          ${attribution.links.map((l) => `<tr><td class="mono">${esc(l.code)}</td><td><span class="truncate">${esc(l.targetUrl || l.target_url || '')}</span></td><td class="right num">${fmt(l.clicks)}</td></tr>`).join('')}
        </tbody></table></div>
      </section>` : ''}

      ${detail && detail.items ? `<section class="card">
        <div class="card-head"><div><h3>Mensajes</h3><p>Primeros 200.</p></div></div>
        <div class="table-wrap"><table><thead><tr><th>Teléfono</th><th>Nombre</th><th>Estado</th></tr></thead><tbody>
          ${detail.items.slice(0, 200).map((it) => `<tr><td class="nowrap">${esc('+' + String(it.contactPhone || ''))}</td><td>${esc(it.contactName || '—')}</td><td>${statusChip(it.status)}</td></tr>`).join('')}
        </tbody></table></div>
      </section>` : ''}
    `
  },
  mount (app, root, data) {
    const pick = $('#repPick', root)
    if (pick) pick.addEventListener('change', () => app.go('reportes/' + pick.value))
    const exp = $('#repExport', root)
    if (exp) exp.addEventListener('click', () => {
      const c = data.campaigns.find((x) => x.id === data.id)
      if (!c) return
      const rows = [
        ['campaña', 'estado', 'destinatarios', 'enviados', 'omitidos', 'errores', 'creada'],
        [c.name, c.status, c.totalTargets, c.sentCount, c.skippedCount, c.failedCount, c.createdAt || '']
      ]
      if (data.detail && data.detail.items) {
        rows[0] = ['campaña', 'estado', 'destinatarios', 'enviados', 'omitidos', 'errores', 'creada', 'telefono', 'nombre', 'estado_mensaje']
        data.detail.items.forEach((it, i) => {
          rows[i + 1] = [c.name, c.status, c.totalTargets, c.sentCount, c.skippedCount, c.failedCount, c.createdAt || '', it.contactPhone || '', it.contactName || '', it.status || '']
        })
      }
      download(`reporte_${String(c.name).replace(/\W+/g, '_')}.csv`, rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n'))
      toast('Reporte exportado', 'ok')
    })
  }
}

/* ================================ ENLACES ================================ */

export const enlaces = {
  title: 'Enlaces',
  sub: 'Direcciones que puedes repartir y medir',
  data () { return { st: S.getState() } },
  html ({ st }) {
    return `
      <div class="callout info">Los enlaces creados aquí son tus enlaces de referencia. Los clics de las campañas los cuenta el servidor en <span class="mono">/t/&lt;código&gt;</span> y aparecen en el reporte de cada campaña.</div>
      <section class="card">
        <div class="card-head"><div><h2>Nuevo enlace</h2><p>Un código corto y el destino real.</p></div></div>
        <div class="field-row">
          <div class="field"><label for="lkCode">Código</label><input id="lkCode" type="text" placeholder="catalogo-septiembre"></div>
          <div class="field"><label for="lkTarget">Destino</label><input id="lkTarget" type="url" placeholder="https://tu-tienda.com/catalogo"></div>
          <div class="field" style="max-width:180px"><label>&nbsp;</label><button class="btn btn-primary" id="lkAdd" style="width:100%">Crear</button></div>
        </div>
      </section>
      <section class="card">
        <div class="card-head"><div><h3>Enlaces</h3><p>${fmt(st.links.length)} guardado(s).</p></div></div>
        ${st.links.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Código</th><th>Destino</th><th class="right">Clics</th><th>Creado</th><th></th></tr></thead>
          <tbody>${st.links.map((l) => `<tr>
            <td class="mono">${esc(l.code)}</td>
            <td><span class="truncate">${esc(l.target)}</span></td>
            <td class="right num">${fmt(l.clicks)}</td>
            <td class="nowrap">${esc(S.formatDay(l.createdAt))}</td>
            <td class="right nowrap">
              <button class="btn btn-sm btn-ghost" data-copy="${esc(l.target)}">Copiar destino</button>
              <button class="btn btn-sm btn-danger" data-lk-del="${esc(l.id)}">Borrar</button>
            </td>
          </tr>`).join('')}</tbody></table></div>` : '<div class="empty">Todavía no hay enlaces.</div>'}
      </section>
    `
  },
  mount (app, root) {
    $('#lkAdd', root)?.addEventListener('click', () => {
      const code = $('#lkCode', root).value.trim()
      const target = $('#lkTarget', root).value.trim()
      if (!target) return toast('Escribe el destino del enlace.', 'warn')
      S.addLink({ code, target })
      toast('Enlace guardado', 'ok'); app.render()
    })
    on(root, '[data-copy]', 'click', async (_e, b) => {
      try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copiado', 'ok') } catch { toast('No se pudo copiar', 'warn') }
    })
    on(root, '[data-lk-del]', 'click', async (_e, b) => {
      if (!(await confirmDialog('¿Borrar este enlace?', { okLabel: 'Borrar', danger: true }))) return
      S.removeLink(b.dataset.lkDel); app.render()
    })
  }
}

/* ================================= BAJAS ================================= */

export const bajas = {
  title: 'Bajas',
  sub: 'Números que nunca deben recibir difusiones',
  data () { return { st: S.getState() } },
  html ({ st }) {
    return `
      <div class="grid g-side">
        <section class="card">
          <div class="card-head"><div><h2>Lista de bajas</h2><p>${fmt(st.suppressions.length)} número(s). El servidor los filtra antes de enviar.</p></div></div>
          ${st.suppressions.length ? `<div class="table-wrap"><table>
            <thead><tr><th>Teléfono</th><th>Motivo</th><th>Fecha</th><th></th></tr></thead>
            <tbody>${st.suppressions.map((s) => `<tr>
              <td class="nowrap">${esc(S.prettyPhone(s.phone))}</td>
              <td>${esc(s.reason)}</td>
              <td class="nowrap">${esc(S.formatDay(s.at))}</td>
              <td class="right"><button class="btn btn-sm btn-ghost" data-un="${esc(s.phone)}">Quitar</button></td>
            </tr>`).join('')}</tbody></table></div>` : '<div class="empty">Sin bajas registradas.</div>'}
          <button class="btn btn-ghost btn-sm mt16" id="spExport">Exportar CSV</button>
        </section>

        <div>
          <section class="card">
            <div class="card-head"><div><h3>Añadir una baja</h3><p>Si alguien pide no recibir más mensajes.</p></div></div>
            <div class="field"><label for="spPhone">Teléfono</label><input id="spPhone" type="text" placeholder="300 111 2233"></div>
            <div class="field"><label for="spReason">Motivo</label><input id="spReason" type="text" placeholder="Pidió la baja por chat"></div>
            <button class="btn btn-primary btn-sm" id="spAdd">Añadir a bajas</button>
          </section>
          <section class="card">
            <div class="card-head"><div><h3>Consultar un número</h3><p>Bajas y consentimiento de ese contacto.</p></div></div>
            <div class="field"><label for="spLook">Teléfono</label><div style="display:flex;gap:8px"><input id="spLook" type="text" placeholder="300 111 2233"><button class="btn btn-ghost" id="spLookBtn">Consultar</button></div></div>
            <div id="spLookOut"></div>
          </section>
          <section class="card">
            <div class="card-head"><div><h3>Registrar consentimiento</h3><p>Deja constancia de que la persona autorizó recibir mensajes.</p></div></div>
            <div class="field"><label for="csPhone">Teléfono</label><input id="csPhone" type="text" placeholder="300 111 2233"></div>
            <div class="field"><label for="csWho">Quién autorizó</label><input id="csWho" type="text" placeholder="María López"></div>
            <div class="field"><label for="csChannel">Canal</label><input id="csChannel" type="text" placeholder="Formulario web"></div>
            <div class="field"><label for="csText">Texto que aceptó</label><input id="csText" type="text" placeholder="Acepto recibir mensajes de WhatsOn"></div>
            <button class="btn btn-primary btn-sm" id="csAdd">Registrar consentimiento</button>
            <p class="hint">Sin servidor se guarda en este navegador y se avisa; con el servidor conectado queda en el registro del servidor.</p>
          </section>
        </div>
      </div>
    `
  },
  mount (app, root) {
    $('#spAdd', root)?.addEventListener('click', async () => {
      const phone = $('#spPhone', root).value
      const reason = $('#spReason', root).value || 'Baja manual'
      const r = S.addSuppression(phone, reason)
      if (!r.ok) return toast(r.error, 'warn')
      if (API.isServer()) await API.optOut(r.phone, reason)
      S.logActivity('Baja añadida: ' + S.prettyPhone(r.phone))
      toast('Número añadido a bajas', 'ok'); app.render()
    })
    on(root, '[data-un]', 'click', async (_e, b) => {
      if (!(await confirmDialog('¿Sacar este número de la lista de bajas?', { okLabel: 'Quitar', danger: true }))) return
      S.removeSuppression(b.dataset.un); app.render()
    })
    $('#spExport', root)?.addEventListener('click', () => {
      const st = S.getState()
      download('bajas.csv', 'phone,reason,fecha\n' + st.suppressions.map((s) => `"${s.phone}","${s.reason}","${s.at}"`).join('\n'))
      toast('CSV exportado', 'ok')
    })
    $('#csAdd', root)?.addEventListener('click', async () => {
      const phone = S.canonicalPhone($('#csPhone', root).value)
      const out = $('#csAdd', root)
      if (!phone) return toast('Teléfono no válido', 'warn')
      const payload = {
        contactPhone: phone,
        whoAuthorized: ($('#csWho', root).value || '').trim(),
        channel: ($('#csChannel', root).value || '').trim() || 'Panel',
        textShown: ($('#csText', root).value || '').trim(),
        source: 'Panel de control'
      }
      // Se guarda siempre en local; si hay servidor, además en su registro.
      const local = S.getState().contacts.find((c) => c.phone === phone)
      if (local) S.updateContact(local.id, { consentOrigin: payload.channel, consentAt: S.nowIso() })
      S.logActivity('Consentimiento registrado: ' + S.prettyPhone(phone))
      if (!API.isServer()) {
        toast('Guardado en este navegador (sin servidor conectado)', 'warn')
        app.render()
        return
      }
      out.disabled = true
      const r = await API.recordConsent(payload)
      out.disabled = false
      toast(r.ok ? 'Consentimiento registrado en el servidor' : 'Servidor: ' + r.error, r.ok ? 'ok' : 'warn')
      app.render()
    })
    $('#spLookBtn', root)?.addEventListener('click', async () => {
      const raw = $('#spLook', root).value
      const phone = S.canonicalPhone(raw)
      const out = $('#spLookOut', root)
      if (!phone) { out.innerHTML = '<div class="callout warn">Teléfono no válido.</div>'; return }
      const local = S.getState()
      const isDown = S.isSuppressed(phone)
      const contact = local.contacts.find((c) => c.phone === phone)
      let server = null
      if (API.isServer()) {
        const r = await API.contactData(phone)
        if (r.ok) server = r.data
      }
      out.innerHTML = `<dl class="kv">
        <dt>Bajas (panel)</dt><dd>${isDown ? '<span class="chip naranja">En lista de bajas</span>' : '<span class="chip verde">No está de baja</span>'}</dd>
        <dt>Contacto</dt><dd>${contact ? esc(contact.name || 'sin nombre') + ' · ' + esc(contact.consentOrigin || 'sin origen') : 'no está en tus contactos'}</dd>
        <dt>Servidor</dt><dd>${server ? esc(JSON.stringify(server).slice(0, 180)) : (API.isServer() ? 'sin datos' : 'requiere servidor')}</dd>
      </dl>`
    })
  }
}

/* ================================ AJUSTES ================================ */

export const ajustes = {
  title: 'Ajustes',
  sub: 'Ritmo, horario y conexión con el servidor',
  data () { return { st: S.getState(), session: API.session } },
  html ({ st, session }) {
    return `
      <div class="grid g-side">
        <section class="card">
          <div class="card-head"><div><h2>Envío</h2><p>Valores por defecto al crear campañas.</p></div></div>
          <div class="field">
            <label>Ritmo recomendado</label>
            <div class="seg" id="stCadence">
              ${Object.entries(S.CADENCES).map(([k, v]) => `<button data-c="${k}" aria-pressed="${st.settings.cadence === k}">${esc(v.label)}</button>`).join('')}
            </div>
          </div>
          <div class="field-row">
            <div class="field"><label for="stBatch">Mensajes por lote</label><input id="stBatch" type="number" min="5" max="500" value="${st.settings.batch}"></div>
            <div class="field"><label for="stCool">Pausa entre lotes (min)</label><input id="stCool" type="number" min="1" max="120" value="${st.settings.cooldownMin}"></div>
          </div>
          <label class="check"><input type="checkbox" id="stHours" ${st.settings.onlyBusinessHours ? 'checked' : ''}> Enviar solo en horario comercial</label>
          <div class="field-row">
            <div class="field"><label for="stFrom">Desde</label><input id="stFrom" type="time" value="${esc(st.settings.hoursFrom)}"></div>
            <div class="field"><label for="stTo">Hasta</label><input id="stTo" type="time" value="${esc(st.settings.hoursTo)}"></div>
          </div>
          <button class="btn btn-primary btn-sm" id="stSave">Guardar ajustes</button>
        </section>

        <div>
          <section class="card">
            <div class="card-head"><div><h3>Conexión</h3><p>El panel puede trabajar con o sin servidor.</p></div></div>
            <dl class="kv">
              <dt>Estado</dt><dd>${session.mode === 'server' ? '<span class="chip verde">Conectado</span>' : session.mode === 'locked' ? '<span class="chip naranja">Pide secreto</span>' : '<span class="chip gris">Sin servidor</span>'}</dd>
              <dt>Servidor</dt><dd class="mono">${esc(location.origin)}</dd>
              <dt>Comprobado</dt><dd>${session.checkedAt ? esc(S.formatDate(new Date(session.checkedAt).toISOString())) : '—'}</dd>
            </dl>
            ${session.lastError ? `<div class="callout warn">${esc(session.lastError)}</div>` : ''}
            <div class="field"><label for="stApi">Servidor alternativo (opcional)</label><input id="stApi" type="url" value="${esc(st.settings.apiBase || '')}" placeholder="http://localhost:3004"></div>
            <button class="btn btn-ghost btn-sm" id="stApiSave">Guardar y reconectar</button>
          </section>

          <section class="card">
            <div class="card-head"><div><h3>Datos del panel</h3><p>Todo lo local vive en este navegador.</p></div></div>
            <p class="hint">${st.contacts.length} contactos · ${st.templates.length} plantillas · ${st.rules.length} reglas · ${st.conversations.length} conversaciones · ${st.localCampaigns.length} borradores</p>
            <div class="toolbar" style="margin-bottom:0">
              <button class="btn btn-ghost btn-sm" id="stExport">Copia de seguridad (JSON)</button>
              <button class="btn btn-ghost btn-sm" id="stSeed">Cargar datos de ejemplo</button>
              <button class="btn btn-danger btn-sm" id="stReset">Borrar todo lo local</button>
            </div>
          </section>
        </div>
      </div>
    `
  },
  mount (app, root, data) {
    let cadence = data.st.settings.cadence
    root.querySelectorAll('#stCadence button').forEach((b) => b.addEventListener('click', () => {
      cadence = b.dataset.c
      root.querySelectorAll('#stCadence button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)))
    }))
    $('#stSave', root)?.addEventListener('click', () => {
      S.setSettings({
        cadence,
        batch: Number($('#stBatch', root).value) || 80,
        cooldownMin: Number($('#stCool', root).value) || 8,
        onlyBusinessHours: $('#stHours', root).checked,
        hoursFrom: $('#stFrom', root).value,
        hoursTo: $('#stTo', root).value
      })
      toast('Ajustes guardados', 'ok')
    })
    $('#stApiSave', root)?.addEventListener('click', async () => {
      S.setSettings({ apiBase: $('#stApi', root).value.trim() })
      await app.reconnect()
      toast('Reconectado', 'ok')
      app.render()
    })
    $('#stExport', root)?.addEventListener('click', () => {
      download('whatspower-panel.json', JSON.stringify(S.getState(), null, 2), 'application/json')
      toast('Copia descargada', 'ok')
    })
    $('#stSeed', root)?.addEventListener('click', () => {
      S.seedDemo({ force: true }); toast('Datos de ejemplo cargados', 'ok'); app.render()
    })
    $('#stReset', root)?.addEventListener('click', async () => {
      if (!(await confirmDialog('Se borrarán contactos, plantillas, reglas y borradores de este navegador. ¿Continuar?', { okLabel: 'Borrar todo', danger: true }))) return
      S.resetAll(); toast('Panel vacío', 'ok'); app.go('panel')
    })
  }
}
