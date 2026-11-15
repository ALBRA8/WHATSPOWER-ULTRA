# parity/matriz.md — Fase 2: Comparación original vs repo ULTRA-live

**Repo:** `ULTRA-live` @ `7dc7bbc` (main). **Fecha:** 2026-11-15.
**Leyenda:** `sí` = existe y funciona · `parcial` = existe incompleto o con acción muerta · `no` = no existe.
Todas las líneas citadas verificadas sobre el árbol actual.

---

## A. Pantalla por pantalla (una fila por pantalla/acción del inventario)

### A.1 Login y sesión

| # | Pantalla/acción del original | Existe | Dónde está (archivo:línea) | Qué falta exactamente |
|---|---|---|---|---|
| 1 | Pantalla de login dedicada `/login` | parcial | `src/studio/campaign-studio-html.ts:270-293` (login por `window.prompt` al primer 401) | Formulario real en `/login` con estado error/cargando; hoy es un `prompt()` del navegador |
| 2 | Canje de secreto por sesión cookie | sí | `src/server.ts:147-186` (`POST /studio/login`, cookie HttpOnly 1 h, throttle 10/min) | Nada (se reutiliza) |
| 3 | Cerrar sesión | no | — | `POST /logout` que borre la cookie y redirija |
| 4 | Redirigir a login al caducar la sesión | parcial | `src/studio/campaign-studio-html.ts:273-291` (solo al primer load) | Interceptor global de `fetch`: todo `401` → `/login?expired=1` |

### A.2 Onboarding

| # | Acción | Existe | Dónde | Qué falta |
|---|---|---|---|---|
| 5 | Onboarding guiado 1ª vez (perfil, transporte, contactos) | no | — | Modal de 3 pasos; persistencia `PUT /api/settings`; «no volver a mostrar» |
| 6 | Probar transporte desde onboarding | no | — | `POST /api/integrations/transport/test` con comprobación real |

### A.3 Resumen (home)

| # | Acción | Existe | Dónde | Qué falta |
|---|---|---|---|---|
| 7 | Métricas agregadas reales (activas/enviados/CTR/contactos/suprimidos/conversaciones) | parcial | `src/studio/campaign-studio-html.ts:203-229` (contadores SOLO de la campaña activa en memoria del navegador) | Endpoint agregado `GET /api/dashboard/summary` + pantalla Resumen con estados vacío/cargando/error |
| 8 | CTR real de enlaces rastreados | sí (API) | `src/server.ts:504-527` (`/api/attribution/report/:id`) | Exponerlo en el Resumen (agregado global) |

### A.4 Conversaciones / Chat

| # | Acción | Existe | Dónde | Qué falta |
|---|---|---|---|---|
| 9 | Bandeja de conversaciones | no | — | Tablas `conversations`/`messages`; `GET /api/conversations` (orden desc por último mensaje, búsqueda, filtro leído) |
| 10 | Hilo con mensajes y burbujas in/out | no | — | `GET /api/conversations/:phone` con mensajes persistidos |
| 11 | Responder desde la plataforma (envío REAL) | no | — | `POST /api/conversations/:phone/messages`: supresión+lock 2A → despacho real por el transporte → persistir; hoy solo hay despacho de campaña (`src/queue/broadcast-worker.ts:270 processNextItem`) |
| 12 | Marcar leído / asignar agente | no | — | `POST /api/conversations/:phone/read` y `/assign` |
| 13 | Inbound real de mensajes | no | — | `POST /api/audiences/webhook-message` con HMAC v2 (patrón de `src/server.ts:435-501` para leads) que cree contacto+conversación+mensaje |
| 14 | Insertar respuesta rápida en el compositor | no | — | Depende de fila 27 (quick replies) |

### A.5 Contactos

| # | Acción | Existe | Dónde | Qué falta |
|---|---|---|---|---|
| 15 | Listado/paginación/búsqueda/filtros | no | — | Tabla `contacts`; `GET /api/contacts` con limit/offset/búsqueda/etiqueta/etapa |
| 16 | Crear/editar/borrar contacto | no | — | `POST/PUT/DELETE /api/contacts[/:phone]` con validación E.164 y unicidad por org |
| 17 | Importar CSV PERSISTENTE | parcial | `src/audiences/csv-importer.ts` (validación y dedupe solo en memoria, consumo vía `src/server.ts:231-251` y al crear campaña) | `POST /api/contacts/import-csv` que persista y devuelva el desglose (válidos/duplicados/inválidos) |
| 18 | Exportar CSV | no | — | `GET /api/contacts/export.csv` |
| 19 | Etiquetas sobre contactos | no | — | `POST/DELETE /api/contacts/:phone/tags/:tagId` |

### A.6 Embudo / Kanban

| # | Acción | Existe | Dónde | Qué falta |
|---|---|---|---|---|
| 20 | Tablero con etapas y tarjetas | no | — | Tablas `pipeline_stages` + `contacts.stage_id`; UI kanban |
| 21 | Mover tarjeta (persistente e idempotente) | parcial | `event_idempotency` existe (`src/db.ts:100-103`, `src/security.ts:454-476`) | `POST /api/pipeline/move` con `eventId` único (patrón de la Oleada 2 del CRM) |
| 22 | CRUD de etapas | no | — | `GET/POST /api/pipeline/stages`, `PUT/DELETE /:id` con reordenación |

### A.7 Campañas

| # | Acción | Existe | Dónde | Qué falta |
|---|---|---|---|---|
| 23 | Creador de campaña (spintax, CSV, ritmo, IA) | sí | `src/studio/campaign-studio-html.ts:104-189`; API `src/server.ts:271-302` | Nada (no se rediseña) |
| 24 | Monitor en vivo (contadores/progreso/log/pausa/reanudar/cancelar) | sí | `src/studio/campaign-studio-html.ts:192-257`; API `src/server.ts:305-401` | Nada |
| 25 | Lista/Historial de campañas | **parcial** | Botón «📊 Historial» en `src/studio/campaign-studio-html.ts:98` llama a `loadCampaignsList()` — **esa función NO existe** (botón muerto); la API sí existe: `src/server.ts:255-268` | Implementar la lista: tabla con estados y acciones; botón hoy no hace nada |
| 26 | Borrar campaña / reintentar fallidos | no | — | `DELETE /api/campaigns/:id`, `POST /api/campaigns/:id/retry-failed` (reencola FAILED → PENDING) |
| 27 | Reporte de atribución en UI | sí (API) | `src/server.ts:504-527` | Enlace desde el monitor |

### A.8 Respuestas rápidas

| # | Acción | Existe | Dónde | Qué falta |
|---|---|---|---|---|
| 27 | CRUD respuestas rápidas | no | — | Tabla `quick_replies`; `GET/POST/PUT/DELETE` con atajo único |

### A.9 Etiquetas

| # | Acción | Existe | Dónde | Qué falta |
|---|---|---|---|---|
| 28 | CRUD etiquetas + conteo real de contactos | no | — | Tablas `tags`/`contact_tags` |

### A.10 Agentes / Equipo

| # | Acción | Existe | Dónde | Qué falta |
|---|---|---|---|---|
| 29 | CRUD agentes + roles | no | — | Tabla `agents`; borrar desasigna conversaciones |
| 30 | Asignación de conversaciones | no | — | Depende de fila 12 |

### A.11 Integraciones WhatsApp / API

| # | Acción | Existe | Dónde | Qué falta |
|---|---|---|---|---|
| 31 | Estado del transporte | parcial | El transporte se construye solo por env al arrancar (`src/server.ts:64-69`) | `GET/PUT /api/integrations/transport` (config no secreta persistida por org) |
| 32 | Probar conexión REAL | no | — | `POST /api/integrations/transport/test` (health del daemon / validación de token Graph) |
| 33 | Webhook de entrada de mensajes (HMAC v2) | no | — | Fila 13 |
| 34 | Documentación del contrato de webhooks en pantalla | parcial | `.env.example` lo documenta | Mostrarlo en la pantalla |

### A.12 Ajustes

| # | Acción | Existe | Dónde | Qué falta |
|---|---|---|---|---|
| 35 | Perfil org + ritmo por defecto | parcial | Ritmo elegido solo al crear campaña (UI) | `GET/PUT /api/settings` (marca, país, delays por defecto) |
| 36 | Lista de supresión con alta/baja manual | parcial | `suppression_list` por org (`src/db.ts:181-208`); el circuito de bajas se aplica al despachar (`src/safety/suppression.ts`) | `GET/POST/DELETE /api/suppression` para gestionarla en UI |
| 37 | Estado de sesión / TTL | parcial | Cookie 1 h (`src/security.ts:409-411`) | Mostrarlo y poder cerrar sesión (fila 3) |

### A.13 Transversal

| # | Acción | Existe | Dónde | Qué falta |
|---|---|---|---|---|
| 38 | Navegación entre pantallas (sidebar/hash) | no | — | Shell con sidebar; hoy solo 2 «tabs» (uno muerto) |
| 39 | Estados vacío/cargando/error en todas las pantallas | parcial | Solo en el monitor (`logTbody` línea 249-252) | Cobertura completa |
| 40 | Toasts en acciones que mutan | parcial | `alert()` en creador (`:353, :377, :380`) | Sistema de toasts no bloqueante |
| 41 | Móvil 390 px | no | — | Sidebar colapsable, tablas scrollables |

---

## B. Lo que el repo tiene de más (NO SE TOCA)

Funcionalidad madura del repo que NO está en el alcance de paridad y **no se modifica**:

| Módulo | Evidencia |
|---|---|
| Motor de broadcast (cola atómica, claim, lease, recuperación de caídas) | `src/queue/broadcast-worker.ts`, `src/queue/persistent-worker.ts` |
| Throttler anti-ban con enfriamiento durable y reanudación automática | `src/queue/throttler.ts`, hallazgo H10 |
| Spintax recursivo | `src/engine/spintax.ts` |
| Tracking de enlaces + atribución por clic | `src/server.ts:404-429, 504-527` |
| Ingesta de leads con HMAC v2, anti-replay durable, rate limit | `src/server.ts:435-501`, `src/security.ts` |
| Copiloto neuromarketing (Hofstede/Zaltman/Rapaille) | `src/ai/*` |
| Salvaguardas de piloto, circuito de bajas, cuarentena org-less | `tests/pilot-safeguards.test.ts`, `tests/bajas-circuit.test.ts`, `tests/null-org-quarantine.test.ts` |
| Multi-org con identidad ligada y sin oráculo | `src/server.ts:101-141`, `src/security.ts:51-92` |
| Segundo transporte Meta Cloud por organización | `src/adapters/meta-cloud-dispatcher.ts`, `src/org-wa-credentials.ts` |
| Worker persistente 2B con leases renovadas (H7/H8) | `src/queue/persistent-worker.ts`, `tests/wave2-*.test.ts` |

**Regla respetada en la Fase 3:** solo se AÑADEN tablas/endpoints/pantallas; nada existente se renombra, mueve o re-factoriza. Los 174 tests vigentes deben seguir verdes.
