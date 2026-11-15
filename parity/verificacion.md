# parity/verificacion.md — Fase 4: Verificación real con clics

**Fecha:** 2026-11-15 · **Repo:** ULTRA-live @ paridad-dashboard · **Build:** tsc limpio, **196/196 pruebas** (174 previas + 22 nuevas), `security:scan` limpio.

## Entorno de verificación (todo real, nada simulado en la lógica del producto)

- **Server ULTRA** en `127.0.0.1:3123` con `ALLOW_REAL_DISPATCH=true`, transporte **daemon CRM** y BD aislada (`/tmp/ultra-verify.db`, nunca se tocó `db/broadcast.db`).
- **Daemon stub** en `127.0.0.1:3124` con el MISMO contrato HTTP que el daemon real (`GET /health`, `POST /send` con Bearer `INTERNAL_API_SECRET` y respuesta `{success:true,messageId}`) — el despacho cruza la pila completa (UI → API → supresión → lock → dispatcher → HTTP → persistencia).
- **Navegador real** (Chromium vía Playwright) con **clics reales** en escritorio 1280×800 y móvil **390×844** táctil. Guion: `scripts/pw-ultra-verify.js`; resultados crudos: `parity/verificacion/resultados.json`.
- El mensaje entrante se inyecta por el **webhook HMAC v2 real** (`POST /api/audiences/webhook-message` firmado), no por SQL.

## Resultado: 20/20 pasos verificados

| # | Verificación (clics reales) | Resultado | Captura |
|---|---|---|---|
| V-01 | Pantalla de login dedicada, sin `window.prompt` | ✅ | `01-login-desktop.png` |
| V-02 | Onboarding 3 pasos + **prueba REAL de transporte** (✅ Conectado en N ms contra el daemon) | ✅ | `02-onboarding-paso1.png`, `03-onboarding-transporte-real-ok.png` |
| V-03 | Resumen con métricas reales + estado vacío con CTAs | ✅ | `04-resumen-metricas.png` |
| V-04 | Contactos: crear (201) y rechazo de teléfono inválido (400) | ✅ | `05-contacto-creado.png` |
| V-05 | Importar CSV PERSISTENTE con desglose insertados/duplicados/inválidos; normaliza +57 | ✅ | `06-importacion-csv-desglose.png` |
| V-06 | Contactos: editar (persistente) y borrar con confirmación (desaparece tras recargar filtro) | ✅ | — |
| V-07 | Etiquetas: crear VIP, asignar desde contactos (chip visible), filtro por etiqueta | ✅ | `07-etiquetas-vip.png` |
| V-08 | Respuestas rápidas: crear `/precio`, tabla actualizada | ✅ | `08-respuestas-rapidas.png` |
| V-09 | Agentes: crear con rol; duplicado de atajo/rol inválido rechazados | ✅ | — |
| V-10 | Embudo: 4 etapas por defecto, **arrastrar tarjeta a «Contactado»** y PERSISTE tras recargar | ✅ | `09-kanban-inicial.png`, `10-kanban-tarjeta-movida.png` |
| V-11 | Chat: inbound real firmado con HMAC v2 → conversación con badge «1» no leído | ✅ | `11-chat-bandeja-no-leido.png` |
| V-12 | Chat: abrir hilo (marca leído), insertar respuesta rápida con «/», **envío REAL** (daemon lo recibió; burbuja ✓) | ✅ | `12-chat-hilo-inbound.png`, `13-chat-enviado-real.png` |
| V-13 | Opt-out real: contacto suprimido → envío bloqueado con motivo visible (`CONTACT_SUPPRESSED…`), **cero envíos** al daemon; retirar supresión desde Ajustes | ✅ | `14-ajustes-supresion.png`, `15-chat-optout-bloqueado.png` |
| V-14 | Campañas: creador completo (spintax + «Usar contactos importados»), crear, **3 pasos de despacho real** con monitor actualizando enviados | ✅ | `16-campana-creador.png`, `17-campana-monitor-envios.png` |
| V-15 | Lista de campañas (el «Historial» muerto ya vive): contadores por estado y acciones pausar/reanudar/reintentar/borrar según estado | ✅ | `18-campana-lista-acciones.png` |
| V-16 | Integraciones: prueba de conexión REAL con latencia, guardar config; el secreto jamás vuelve por la API (solo máscara `…1234`) | ✅ | `19-integraciones-test-real.png` |
| V-17 | Ajustes: guardar ritmo por defecto (25/50, lote 25) | ✅ | `20-ajustes-ritmo.png` |
| V-18 | **Sesión caducada**: cookies borradas → cualquier fetch → redirige a `/login?expired=1` con aviso | ✅ | `21-sesion-caducada.png` |
| V-19 | Móvil 390px: sidebar colapsado (fuera de pantalla), menú hamburguesa, navegación táctil | ✅ | `22-movil-menu-abierto.png`, `23-movil-contactos.png` |
| V-20 | Móvil 390px: chat y kanban usables | ✅ | `24-movil-chat.png`, `25-movil-kanban.png` |

Recarga de página: comprobada en V-10 (kanban) y V-15 (lista) — el estado vive en la BD y el hash conserva la vista.

## Bugs reales encontrados Y CORREGIDOS durante la verificación

1. **El sondeo del chat destruía el compositor (V-12/V-13):** cada 4 s el hilo se reconstruyía entero; mientras el operador escribía, el textarea y el menú «/» desaparecían («element was detached»). **Fix:** `pollActiveThread()` refresca SOLO los mensajes nuevos y espera si hay texto en el compositor (`src/studio/dashboard-html.ts`).
2. **Responder a una conversación existente fallaba 400 (V-12):** `ensureConversation` lanzaba `UNIQUE constraint failed: conversations.organization_id, conversations.contact_phone` — el mensaje SALÍA por el transporte y NO se persistía (doble-envío al reintentar). **Fix:** `INSERT OR IGNORE` idempotente en `src/dashboard/store.ts` + prueba DP-15 ampliada (segunda respuesta en el mismo hilo).
3. **Contrato del daemon mal simulado en el entorno de prueba (V-14 falso positivo):** el stub devolvía `{ok:true}` pero el contrato real exige `{success:true,messageId}` — todos los despachos eran `DAEMON_UNKNOWN_FAILURE`. **Fix del entorno** (`scripts/ultra-daemon-stub-3124.mjs`) y del wait de V-14 (`waitForFunction` con opciones en el parámetro correcto). Tras el fix, el monitor muestra enviados reales.
4. **Contactos sin etapa = kanban vacío (V-10):** los contactos nuevos/CSV/leads nacían con `stage_id NULL` y no aparecían en ninguna columna. **Fix:** todo contacto nuevo nace en la PRIMERA etapa del embudo (`src/dashboard/store.ts`).
5. **`\n` sin escapar en el template (bloqueo total del JS):** `lines.join('\n')` dentro del template literal rompía el string JS («Invalid or unexpected token») y el dashboard no arrancaba. **Fix:** `join('\\n')`.

## Cobertura frente a la matriz (parity/matriz.md)

Todas las filas de la matriz con estado `no`/`parcial` quedaron construidas y verificadas con clics (V-01…V-20). Lo que el repo ya tenía (motor de broadcast, spintax, tracking, atribución, salvaguardas) **no se modificó** y sus 174 pruebas siguen verdes.
