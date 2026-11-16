# docs/estado-panel.md — Estado del panel de WhatsPower-Ultra

> **Objetivo:** dejar el PANEL (dashboard) completamente usable. Criterio funcional, no visual: las 41 acciones del inventario (`parity/inventario-original.md`, pantallas 4.1–4.13) se ejecutan desde el panel.
> **Fecha de cierre:** 2026-11-16 · **Pruebas:** 235/235 verdes (35 DP del panel + 200 del motor) · **tsc:** sin salida · **scan-secrets:** 0 · **build-site:** 6 ficheros.
> **Fuera de alcance (por orden del dueño):** la web de ventas pública (`whatson.mybusiness-up.es`), `capture/`, `checks/`.

## Tabla de los 12 flujos

| Flujo | Estado | Prueba que lo demuestra | Fichero |
|---|---|---|---|
| **F1** Login y sesión | ✅ USABLE | DP-01, DP-02, DP-03, DP-04, DP-31 (caducidad real de la cookie) | `tests/dashboard-parity.test.ts` · `src/studio/dashboard-html.ts` · `src/dashboard/api.ts` |
| **F2** Onboarding | ✅ USABLE | DP-23 (se salta, persiste y no vuelve a salir) | `tests/dashboard-parity.test.ts` |
| **F3** Resumen con auto-refresco de 15 s que se detiene | ✅ USABLE | DP-22 (métricas reales) + DP-34 (intervalo 15 s, un solo temporizador, se para al salir) | `src/studio/dashboard-html.ts` (`viewSummary`) · `tests/dashboard-parity.test.ts` |
| **F4** Bandeja paginada (`?limit=&before=`, 50 por defecto, "cargar anteriores") | ✅ USABLE | DP-27 (60 mensajes: 50 + 10 sin repetir ni perder), DP-14, DP-15 | `src/dashboard/store.ts` (`getConversationThread`) · `src/dashboard/api.ts` · `tests/dashboard-parity.test.ts` |
| **F5** Mensaje entrante real por webhook HMAC v2 con anti-replay | ✅ USABLE | DP-14 (crea contacto+conversación+mensaje, idempotente), DP-16, DP-17 | `tests/dashboard-parity.test.ts` · `src/server.ts` |
| **F6** Contactos (paginación con "Ir a pág.", import/export CSV completo, etiquetas) | ✅ USABLE | DP-06, DP-07, DP-09, DP-28 (250 filas y filtro), DP-33 (botón "Ir a pág.") | `src/dashboard/api.ts` (`/api/contacts/export.csv`) · `src/studio/dashboard-html.ts` · `tests/dashboard-parity.test.ts` |
| **F7** Embudo (mover tarjeta idempotente con `eventId`) | ✅ USABLE | DP-12, DP-13, DP-30 (mover 2 veces = 1 efecto, sin `eventId` = 400, columnas paginadas) | `src/dashboard/api.ts` · `src/studio/dashboard-html.ts` (`viewPipeline`) · `tests/dashboard-parity.test.ts` |
| **F8** Campañas (historial real, borrar, reintentar fallidos) | ✅ USABLE | DP-20 (activa no se borra, terminal sí), DP-21 (reintento de FAILED), DP-24 (historial) | `src/dashboard/api.ts` · `src/studio/dashboard-html.ts` · `tests/dashboard-parity.test.ts` |
| **F9** Plantillas, enlaces, bajas y consentimiento | ✅ USABLE | DP-10 (respuestas rápidas), DP-25 (bajas), DP-32 (consentimiento guardado en servidor), WO-05 (enlace rastreado suma clic y redirige) | `src/studio/dashboard-html.ts` (`openConsentModal`) · `src/server.ts` · `tests/dashboard-parity.test.ts` |
| **F10** Ajustes e integraciones (credencial enmascarada, probar conexión, contrato del webhook visible) | ✅ USABLE | DP-05, DP-18 (máscara de últimos 4), DP-19 (prueba real OK y fallo), DP-35 (contrato HMAC v2 en pantalla) | `src/studio/dashboard-html.ts` (`viewIntegrations`) · `tests/dashboard-parity.test.ts` |
| **F11** Móvil 390 px y accesibilidad | ✅ USABLE | DP-33 (skip-link, `:focus-visible`, reglas a 700 px, `aria-label`, script compila) | `src/studio/dashboard-html.ts` · `tests/dashboard-parity.test.ts` |
| **F12** Cero datos inventados (vacío / cargando / error) | ✅ USABLE | DP-26 (vacío = ceros reales), DP-22, DP-29 (fallo con el motivo real del transporte), DP-30 (cajas de vacío y error del embudo) | `src/studio/dashboard-html.ts` · `tests/dashboard-parity.test.ts` |

## Qué cambió en este cierre (solo añadir; nada del motor se renombró)

| Fichero | Cambio | Flujo |
|---|---|---|
| `src/dashboard/store.ts` | `getConversationThread` acepta `limit` (50 por defecto, 1–200) y cursor `before`; devuelve `hasMore` y `oldestMessageId` | F4 |
| `src/dashboard/api.ts` | `GET /api/session` (caducidad `iat`+TTL de 60 min); `export.csv` recorre TODAS las páginas (antes cortaba en 200) y respeta `q`/`tagId`/`stageId`; el hilo lee `limit`/`before` | F1, F4, F6 |
| `src/studio/dashboard-html.ts` | Hilo: "Cargar mensajes anteriores" con cursor (`olderBar`/`threadOlder`). Mensaje fallido: clase `failed` + motivo real del transporte. Contactos: botón "Ir a pág." (`ctJump`) y 🛡️ consentimiento por fila contra `/api/compliance/consent`. Ajustes: tarjeta "Sesión" (`/api/session`, refrescar, salir). Embudo: buscador, columnas paginadas de 50, arrastrar idempotente (`eventId`) y cajas de vacío/error. CSS: skip-link, `:focus-visible`, objetivos de 44 px y tablas con scroll a ≤700 px | F1, F4, F6, F7, F9, F11, F12 |

## Detalles por flujo

### F1 — Login y sesión ✅
- `/login` dedicado con clave; cookie HttpOnly de 1 h; `/logout` la revoca (DP-01, DP-04).
- Sin sesión, toda `/api/*` responde 401 (DP-03, cerrado por defecto).
- Un 401 cualquiera lleva a `/login?expired=1` (interceptor del panel).
- `GET /api/session` dice cuándo caduca, que es lo que pinta la tarjeta "Sesión" de Ajustes (DP-31).

### F2 — Onboarding ✅
- Tres pasos; el de transporte prueba la conexión de verdad; se puede saltar.
- Persiste en `org_settings.onboarding_completed_at` y no vuelve a salir (DP-23).

### F3 — Resumen ✅
- Ocho métricas reales de `/api/dashboard/summary` (DP-22).
- Auto-refresco cada 15 s; antes de crear uno nuevo se limpia el anterior y, si ya no estamos en `#/summary`, el propio temporizador se detiene y se olvida (DP-34).
- **Límite honesto:** DP-34 es una prueba **estructural** (lee el script servido y comprueba las cuatro condiciones). No hay prueba en navegador real del repintado a los 15 s; ejecutarlo requeriría un navegador, que no se usó.

### F4 — Bandeja ✅
- Lista ordenada por `last_message_at`, abrir hilo, responder con despacho real (DP-15).
- Hilo paginado de 50 en 50 con cursor `before`, sin solapes ni huecos (DP-27); el botón solo aparece si hay más.

### F5 — Mensaje entrante ✅
- Webhook HMAC v2 (`X-Signature-SHA256`) crea contacto, conversación y mensaje, y repetir el mismo `eventId` no duplica (DP-14); anti-replay y rate limit son los del ingesta de leads.
- Suprimido → 409 con motivo (DP-16); lock activo → 409 (DP-17).

### F6 — Contactos ✅
- CRUD con unicidad por org y E.164 (DP-06); import CSV con desglose (DP-07); etiquetas con cascada al borrar (DP-09).
- Export CSV completo: 250 contactos → 251 líneas, y con `?q=` devuelve exactamente el filtro de la pantalla (DP-28).
- Paginación previo/siguiente + "Ir a pág." (DP-33 comprueba el control; el salto usa `offset = (p-1)*limit`).

### F7 — Embudo ✅
- Etapas con CRUD y reubicación al borrar (DP-12).
- Arrastrar envía `eventId`; repetirlo devuelve `duplicate` sin segundo efecto; sin `eventId` es 400 (DP-13, DP-30).
- Cada columna pagina de 50 en 50 con su propio buscador (DP-30).

### F8 — Campañas ✅
- Crear con spintax + CSV + IA (el creador que ya funcionaba).
- Monitor: pausar/reanudar/cancelar; una campaña activa no se puede borrar (DP-20).
- Historial real con contadores (DP-24); reintentar fallidos reencola los `FAILED` (DP-21).

### F9 — Plantillas, enlaces, bajas y consentimiento ✅
- Respuestas rápidas con atajo único (DP-10); etiquetas (DP-09).
- Bajas: alta y listado contra el endpoint real (DP-25).
- Consentimiento: el botón 🛡️ de cada contacto manda `POST /api/compliance/consent`; DP-32 comprueba la fila en `consent_records` (`status='ACTIVE'`, canal `whatsapp`) y que un payload vacío da 400. Si el servidor falla, el panel dice en pantalla que el consentimiento **solo** quedó en el navegador y no cuenta para la difusión.
- Enlaces rastreados: `/r/<code>` suma el clic y redirige (WO-05 del motor); el panel los muestra en el reporte de atribución de la campaña.
- **Chatbot:** el original **no tiene pantalla de chatbot** (inventario §4.1–4.13); solo lo anuncia en el texto de ventas (§«auto-respuestas con Chatbot integrado»), que está fuera de alcance. No hay acción que ejecutar en el panel, así que no se inventó ninguna.

### F10 — Ajustes e integraciones ✅
- Perfil de org y ritmo por defecto (DP-05).
- Transporte con la credencial enmascarada: solo se guarda el final (DP-18).
- "Probar conexión (real)" devuelve OK con latencia y el fallo con su motivo (DP-19).
- El contrato del webhook está en pantalla: URL, cabeceras, fórmula de la firma, cuerpo, variable del secreto, rate limit y anti-replay (DP-35).

### F11 — Móvil y accesibilidad ✅
- Skip-link "Saltar al contenido", `:focus-visible` y `#viewRoot` como `role="main"` (DP-33).
- A ≤700 px: menú colapsable, botones y filas de al menos 44 px, tablas con scroll táctil y etiquetas `aria-label` en los controles con icono (DP-33).
- **Límite honesto:** no se ha abierto un navegador a 390 px; se comprueba que las reglas y los atributos están en la página servida.

### F12 — Cero datos inventados ✅
- Cada pantalla lee de su endpoint; sin datos, ceros reales y CTA de importar (DP-26).
- Cargando: skeletons. Error: tarjeta con el mensaje y botón reintentar; el embudo añade "Sin tarjetas en esta etapa." y "Error cargando el embudo." (DP-30).
- Los fallos de envío muestran el motivo del transporte, no un icono mudo (DP-29).

## Bandeja con filtro leído / no leído (entrega 2)

- La barra de la bandeja tiene dos botones reales, «Todas» y «No leídas», con `aria-pressed` y un contador de sin leer en el segundo.
- El filtro lo aplica el servidor (`GET /api/conversations?unreadOnly=1`): la paginación y el `total` son los de verdad, no se filtra en el navegador.
- Cada fila con mensajes sin leer trae un botón «✓ Marcar como leída» que llama a `POST /api/conversations/<telefono>/read` y recarga la lista sin abrir el hilo.
- Si el filtro deja la lista vacía se dice por qué: «No hay conversaciones sin leer: al abrir un hilo sus mensajes quedan leídos.»

## Pruebas de pantalla (sin navegador)

- DP-36 a DP-39 montan el panel en un DOM de mentira dentro de la prueba, con el servidor real detrás: pulsan los botones y miran lo que se dibuja.
- DP-36: bandeja — el filtro viaja al servidor y marcar leída deja la fila fuera de «No leídas».
- DP-37 / DP-38 / DP-39: etiquetas, respuestas rápidas y agentes — cabeceras de la tabla, filas traídas del endpoint real y botón de crear.
- **Límite honesto:** sigue sin abrirse un navegador real ni 390 px; el DOM de mentira no mide estilos ni tamaños.

## Puertas de calidad (las cuatro a la vez)

| Puerta | Resultado |
|---|---|
| `node scripts/run-tests.mjs` | ✅ 239 pruebas verdes (39 DP del panel + 200 del motor), 0 fallos. *Nota:* en una pasada con la máquina cargada saltaron por tiempo de espera U-B3-02 y U-B3-03 (son del motor, no del panel); aislados pasan en 0,2 s y la suite completa repitió 239/239. |
| `npx tsc --noEmit -p tsconfig.json` | ✅ sin salida |
| `node scripts/scan-secrets.mjs` | ✅ 0 secretos expuestos |
| `node scripts/build-site.mjs` | ✅ 6 ficheros (3 rutas + 5 páginas), sin error |

## Lo que SOLO el dueño puede hacer

Ver `OWNER_TODO.md` (resumen):
- **D1:** número real y token de Meta Cloud, más `ALLOW_REAL_DISPATCH=true`, para que los envíos salgan a teléfonos reales.
- **D2:** `INTERNAL_API_SECRET` y secretos de webhook (`WEBHOOK_LEAD_SECRETS`) reales, fuera del repo.
- **D3:** revisar a ojo el aspecto frente al original (capturas), que es criterio visual y quedó fuera de encargo.

## Conclusión

**No queda nada por implementar en el panel.** Los 12 flujos están USABLES y probados de punta a punta con 39 pruebas DP que comprueban el efecto observable (filas en la base de datos, respuestas HTTP, CSV completo, idempotencia, y lo que se dibuja en pantalla) y 200 pruebas del motor. Cuatro cosas siguen fuera de mi alcance y son del dueño: verlo en un navegador real (incluido 390 px), un número de WhatsApp con sus credenciales, los secretos de webhook reales y el visto bueno visual. Dos pruebas (F3 y F11) son estructurales y así se dice arriba: no se ejecutó un navegador real.
