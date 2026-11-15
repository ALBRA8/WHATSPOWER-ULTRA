/* site.js — comportamiento del sitio público.
   Nada se envía a ningún servidor: los formularios solo validan y avisan. */

const $ = (sel, ctx = document) => ctx.querySelector(sel)
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel))

/* ---------- menú en móvil ---------- */
for (const boton of $$('[data-menu]')) {
  const menu = document.getElementById(boton.getAttribute('aria-controls'))
  if (!menu) continue
  boton.addEventListener('click', () => {
    const abierto = menu.classList.toggle('abierto')
    boton.setAttribute('aria-expanded', String(abierto))
  })
}

/* ---------- acordeón de preguntas ---------- */
/* Cada pregunta es un <details>: abre al pulsar aunque el JavaScript no cargue. */
for (const caja of $$('[data-acordeon]')) {
  for (const item of $$('details.item', caja)) {
    const resumen = $('.pregunta', item)
    if (!resumen) continue
    const sincronizar = () => resumen.setAttribute('aria-expanded', String(item.open))
    sincronizar()
    item.addEventListener('toggle', sincronizar)
  }
  for (const boton of $$('button.pregunta', caja)) {
    boton.addEventListener('click', () => {
      const item = boton.closest('.item')
      const abierto = item.classList.toggle('abierto')
      boton.setAttribute('aria-expanded', String(abierto))
    })
  }
}

/* ---------- pestañas de tema: resaltan y abren, nunca esconden ---------- */
/* Esconder preguntas dejaba el acordeón vacío en móvil: ahora cada pestaña
   abre la primera pregunta de su tema y deja todas las demás a la vista. */
const temas = $('[role="tablist"]')
if (temas) {
  const items = $$('[data-acordeon] .item')
  for (const tab of $$('[role="tab"]', temas)) {
    tab.addEventListener('click', () => {
      for (const otro of $$('[role="tab"]', temas)) otro.setAttribute('aria-selected', String(otro === tab))
      const tema = tab.dataset.tema
      for (const item of items) item.hidden = false
      for (const item of items) {
        const suyo = tema === 'todas' || (item.dataset.grupo || '') === tema
        item.classList.toggle('apagado', !suyo)
      }
      const primero = items.find((item) => !item.classList.contains('apagado'))
      if (!primero) return
      if (primero.tagName === 'DETAILS') primero.open = true
      else {
        const boton = $('.pregunta', primero)
        if (boton && boton.getAttribute('aria-expanded') !== 'true') boton.click()
      }
      primero.scrollIntoView({ block: 'start', behavior: 'smooth' })
    })
  }
}

/* ---------- validación de formularios ---------- */
const correoOk = (v) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v.trim())
const telOk = (v) => v.replace(/[^\d]/g, '').length >= 9

function marcar (campo, mensaje) {
  const caja = campo.closest('.campo') || campo.parentElement
  const err = $('[data-err]', caja)
  if (err) err.textContent = mensaje
  campo.setAttribute('aria-invalid', mensaje ? 'true' : 'false')
  return !mensaje
}

function validarFormulario (form) {
  let bien = true
  for (const campo of $$('input, textarea, select', form)) {
    if (campo.type === 'checkbox') continue
    if (!campo.required && !campo.value.trim()) continue
    let error = ''
    if (campo.required && !campo.value.trim()) error = 'Este dato hace falta.'
    else if (campo.type === 'email' && !correoOk(campo.value)) error = 'Revisa el correo: falta la arroba o el dominio.'
    else if (campo.type === 'tel' && !telOk(campo.value)) error = 'El teléfono necesita al menos 9 cifras.'
    if (!marcar(campo, error)) bien = false
  }
  const consent = $('input[type="checkbox"][required]', form)
  if (consent && !consent.checked) {
    let aviso = consent.parentElement.querySelector('[data-err]')
    if (!aviso) aviso = $('[data-err]', form)
    if (aviso) aviso.textContent = 'Marca la casilla para continuar.'
    bien = false
  }
  return bien
}

for (const form of $$('[data-demo-form], [data-contacto]')) {
  form.addEventListener('submit', (ev) => {
    ev.preventDefault()
    const ok = $('[data-demo-ok]', form)
    const boton = $('button[type="submit"]', form)
    if (!validarFormulario(form)) {
      ok?.classList.remove('visible')
      ok?.setAttribute('hidden', '')
      if (boton?.dataset.textoOriginal) boton.textContent = boton.dataset.textoOriginal
      return
    }
    if (ok) {
      ok.removeAttribute('hidden')
      ok.classList.add('visible')
    } else if (boton) {
      boton.dataset.textoOriginal = boton.dataset.textoOriginal || boton.textContent
      boton.textContent = 'Recibido (demo, no se envía)'
    }
  })
}

for (const form of $$('[data-buscar]')) {
  form.addEventListener('submit', (ev) => {
    ev.preventDefault()
    const campo = $('input', form)
    const aviso = $('[data-buscar-ok]', form)
    const bien = campo.value.trim().length >= 3
    marcar(campo, bien ? '' : 'Escribe al menos tres letras.')
    if (aviso) aviso.hidden = !bien
  })
}

/* ---------- año del pie ---------- */
for (const nodo of $$('[data-anio]')) nodo.textContent = String(new Date().getFullYear())
