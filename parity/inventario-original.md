# parity/inventario-original.md — Fase 1: Inventario del original

**Original de referencia:** `https://whatson.mybusiness-up.es` (WhatsON, Roberto & Carlos Consultores SL)
**Fecha de inventario:** 2026-11-15 · **Método:** exploración en vivo con navegador real (Chromium limpio, se superó el challenge LiteSpeed `wssplashchk` y se registró sesión), captura de árbol de accesibilidad, enlaces, formularios, localStorage y capturas de pantalla.
**Capturas:** `parity/original/orig-landing.png`, `orig-planes.png`, `orig-faq.png`, `demo2-demo-page.png`, `app-app-root.png`, `login-login.png`.

---

## 1. Hallazgo clave de alcance (honesto y verificable)

Lo que hay en `whatson.mybusiness-up.es` es el **sitio de marketing (WordPress)** del producto. El **dashboard real de WhatsON es un software de escritorio para Windows**, no una web pública:

> «El sistema, ¿es un software o es una plataforma web?» → «**Es un software para Windows** … la instalación es muy sencilla …» (FAQ, verificada en vivo).
> «Mi base de datos … ¿está en sus servidores?» → «… **es un software que se instala en su PC**, por ese motivo toda su base de datos es alojada en su PC».

Verificaciones de acceso realizadas (todas con navegador real pasando el WAF):

| Sonda | Resultado |
|---|---|
| `https://whatson.mybusiness-up.es/` | 200 — landing WordPress |
| `/nueva-demo/` | 200 — página con vídeo de YouTube embebido (no es la app) |
| `/nuevos-planes/`, `/faq`, `/contratacion/`, `/blog/`, `/legal`, `/privacidad` | 200 — WordPress |
| `app.mybusiness-up.es/` (y `/login`, `/app`, `/panel`…) | **404 nginx real** tras pasar el WAF (los 200 de curl eran la página del challenge) |
| Subdominios `panel/sistema/wa/web/dashboard/api/…` | Sin DNS (000) |
| Enlaces del landing | Ninguno apunta a una web-app de dashboard; el alta se hace por WhatsApp (`wa.me/34612497354`) y descarga de software |

**Conclusión de alcance:** no es posible recorrer «pantalla por pantalla» el dashboard privado del original desde la web. El inventario funcional del dashboard se construye con tres fuentes combinadas honestamente:

1. **El encargo del propietario** (lista autoritativa de pantallas: login, onboarding, conversaciones/chat, contactos, embudo/kanban, campañas, respuestas rápidas, etiquetas, agentes/equipo, integraciones WhatsApp/API, ajustes).
2. **Las capacidades reales documentadas por el propio original** (FAQ y planes, verificadas en vivo hoy).
3. **Las fichas clean-room del propio repo** (`FICHA_CLONAKIT_WHATSON_ULTRA.md`, `BENCHMARK_20_HERRAMIENTAS.md`), que ya describen en sala limpia qué debe hacer el producto.

El criterio de paridad es **«igual en uso»** (comportamiento y datos), no copia visual — coherente con la política de sala limpia del repo (no se copia interfaz ni código del original).

---

## 2. Rutas públicas del original (tabla)

| Ruta | Título | Qué contiene | Acciones visibles | Captura |
|---|---|---|---|---|
| `/` | «Whatsapp Marketing · Software de WhatsApp Masivo · WhatsOn» | Landing: propuesta de valor, países (>20), beneficios (QR, Excel, chatbot, envíos gratis) | «Adquirir Ahora!!», «Prueba 48 horas Gratis» (→ `wa.me/34612497354`), «Ver cómo funciona» (→ `/nueva-demo/`), FAQ, menús legales | `orig-landing.png` |
| `/nuevos-planes/` | «Nuevos Planes de Precios» | 3 licencias: Un Mes (US$139,90), Un Año (US$69,98/mes), Un Año PREMIUM (US$89,88/mes, incluye «Envío y autorespuestas de SMS») | Toggle €/$, botones «Adquirir Licencia…» | `orig-planes.png` |
| `/nueva-demo/` | «nueva demo» | Vídeo demo (YouTube `g3ybKf8edOg`) | Reproductor embebido | `demo2-demo-page.png` |
| `/faq` | «FAQ» | 20 preguntas/respuestas con capacidades reales (ver §3) | Acordeón de preguntas, botón WhatsApp soporte | `orig-faq.png` |
| `/contratacion/`, `/index.php/legal/`, `/index.php/privacidad/`, `/blog/` | Legales y blog | Condiciones (licencias por PC, garantía 7–30 días, reembolso) | Enlaces | — |

Estados observados en el sitio público: vacío (n/a), carga (spinner del WAF), error (404 real de `app.*`), con datos (todos los listados). Sin paginación (WordPress). Avisos: sin toasts; navegación clásica.

---

## 3. Capacidades funcionales reales del producto original (fuente: FAQ en vivo, citas literales)

Estas son las verdades funcionales que el dashboard debe reproducir «en uso»:

1. **Vincular cuenta por QR:** «solo necesita vincular su cuenta de Whatsapp … escaneando el código QR, del mismo modo que hace para utilizar Whatsapp Web. Una vez enlazada su cuenta … aparecerá su logotipo, nombre, estado».
2. **Carga de contactos desde Excel/CSV:** «el software puede cargar contactos ilimitados directamente desde un archivo en EXCEL. También podrás cambiar la lista de contactos, tantas veces como necesites».
3. **Envíos masivos con anti-ban (las «6 grandes diferencias», literales del FAQ):**
   1. retardo entre envío y envío programable;
   2. pausa cada ciertos envíos;
   3. saludos distintos por envío (spintax);
   4. emoticonos aleatorios;
   5. múltiples canales de WhatsApp rotando cada N mensajes;
   6. auto-respuestas con Chatbot integrado.
4. **Chatbot/auto-respuesta:** «Puede definir auto-respuestas con el Chatbot integrado» (y en PREMIUM: «Envío y autorespuestas de SMS»).
5. **Responder desde la plataforma y ver mensajes:** «¿Puedo responder desde la plataforma?» / «¿Puedo ver los mensajes y respuestas de mis clientes?» — chat con bandeja de conversaciones.
6. **Mensajes con formato:** negrita, cursiva y tachado.
7. **Reportes:** «¿El software me genera reportes?» — sí (métricas de envío).
8. **Mensajería por defecto cuando el PC está apagado** (auto-respuesta de ausencia).

---

## 4. Inventario funcional del dashboard objetivo (pantalla por pantalla)

> Fuente autoritativa: encargo del propietario + capacidades §3 + fichas clean-room. Para cada pantalla: ruta, título, acciones (qué petición real lanzan y qué cambian), estados, modales/validaciones, filtros, orden, paginación y avisos. Este inventario es el CONTRATO que la Fase 2 contrasta con el repo y la Fase 3 construye.

### 4.1 Login
- **Ruta:** `/login`. **Título:** «WhatsPower-Ultra · Acceso».
- **Acciones:** formulario con campo secreto administrativo → `POST /studio/login` (canje por cookie HttpOnly de sesión, 1 h); al éxito redirige a `/`; «Cerrar sesión» → `POST /logout` (borra cookie).
- **Validaciones:** campo obligatorio; error genérico «Credencial administrativa inválida» (401, sin oráculo); throttle 10/min por IP → 429 con mensaje «Demasiados intentos».
- **Estados:** error (401/429), cargando (botón deshabilitado), éxito (redirección).
- **Sesión caducada:** cualquier `401` en la app redirige a `/login` con aviso «Sesión caducada».

### 4.2 Onboarding
- **Ruta:** modal guiado sobre `/` (3 pasos) la primera vez (hasta `PUT /api/settings` con `onboardingCompleted=true`).
- **Pasos:** 1) perfil del negocio (nombre de la marca, país); 2) transporte (elegir daemon CRM/Meta Cloud, URL y probar conexión real); 3) primer contacto/CSV de ejemplo.
- **Acciones:** `GET/PUT /api/settings`, `POST /api/integrations/transport/test` (comprobación REAL del transporte), «Saltar».
- **Estados:** sin completar (modal), completado (no vuelve a aparecer), guardando, error de validación (marca el campo).

### 4.3 Resumen (dashboard home)
- **Ruta:** `/` tras login. **Acciones visibles:** tarjetas de métricas reales (campañas activas, enviados totales, tasa de clics, contactos, suprimidos, conversaciones abiertas); accesos a «Nueva campaña» e «Importar contactos».
- **Datos:** `GET /api/dashboard/summary` (agregados reales de `campaigns`, `campaign_items`, `tracked_links`, `contacts`, `suppression_list`, `conversations`).
- **Estados:** vacío (cero en todo + guía), cargando (skeleton), error (tarjeta de reintento).

### 4.4 Conversaciones / Chat
- **Ruta:** `/conversations`. **Estructura:** lista izquierda (orden `last_message_at` desc, filtro leído/no leído, búsqueda por teléfono/nombre), hilo derecha (mensajes orden asc, burbujas in/out), compositor abajo.
- **Acciones reales:** abrir conversación (`GET /api/conversations`, `GET /api/conversations/:phone` — marca leído `POST /api/conversations/:phone/read`); enviar mensaje (`POST /api/conversations/:phone/messages`) que **despacha de verdad**: normaliza E.164 → check supresión (local+2A) → check lock 2A → despacho por el transporte configurado → persiste `messages` y actualiza `conversations.last_message_at`; insertar respuesta rápida (lee `GET /api/quick-replies`); asignar agente (`POST /api/conversations/:phone/assign`); etiquetar contacto.
- **Validaciones:** teléfono E.164 válido; texto no vacío; contacto suprimido → error visible «Contacto suprimido (opt-out)»; lock activo → «Contacto en flujo activo (lock 2A)».
- **Inbound real:** `POST /api/audiences/webhook-message` (HMAC v2 igual que `webhook-lead`, rate 30/min, anti-replay) crea/actualiza conversación, crea contacto si es nuevo y persiste el mensaje entrante. Estados: vacío (sin conversaciones), cargando, error.

### 4.5 Contactos
- **Ruta:** `/contacts`. **Columnas:** teléfono, nombre, etapa, etiquetas, origen (csv/manual/lead), último broadcast, creado. Orden por creado desc. **Paginación** server-side (`?limit&offset`). **Búsqueda** por teléfono/nombre; **filtro** por etiqueta y etapa.
- **Acciones reales:** crear/editar/borrar (`POST /api/contacts`, `PUT/DELETE /api/contacts/:phone`); importar CSV (`POST /api/contacts/import-csv` — reutiliza el validador E.164 del repo, devuelve válidos/duplicados/inválidos y PERSISTE); exportar (`GET /api/contacts/export.csv`); asignar/quitar etiqueta (`POST/DELETE /api/contacts/:phone/tags/:tagId`).
- **Modales:** crear/editar (teléfono requerido y único por org, nombre opcional), confirmación de borrado, resultado de importación con desglose.
- **Estados:** vacío (CTA importar), cargando, error; toast de éxito/error en cada acción.

### 4.6 Embudo / Kanban
- **Ruta:** `/pipeline`. **Tablero:** columnas = etapas (`pipeline_stages` con posición), tarjetas = contactos por etapa; arrastrar tarjeta → `POST /api/pipeline/move` con `eventId` único por ocurrencia (idempotente vía `event_idempotency`) que persiste `contacts.stage_id` y registra auditoría.
- **Gestión de etapas:** crear/renombrar/reordenar/borrar (`GET/POST /api/pipeline/stages`, `PUT/DELETE /api/pipeline/stages/:id`).
- **Validaciones:** no borrar etapa con contactos sin destino (o mover a la primera); `eventId` repetido → 200 sin efecto.
- **Estados:** vacío (etapas por defecto + CTA), arrastrando, error de guardado (tarjeta vuelve a su columna).

### 4.7 Campañas
- **Ruta:** `/campaigns` (lista) y `/campaigns/:id` (monitor en vivo).
- **Lista:** tabla real con nombre, estado, destinatarios, enviados, omitidos, errores, creada; orden creado desc; paginación; acciones: ver, pausar/reanudar/cancelar (según estado), **borrar** (`DELETE /api/campaigns/:id` — nueva), reintentar fallidos (`POST /api/campaigns/:id/retry-failed` — nueva). Botón «Nueva campaña» → creador.
- **Creador:** EXACTAMENTE el que ya funciona en el repo (nombre, plantilla spintax con preview 5 variaciones, CSV con validación, ritmo anti-ban, copiloto neuromarketing) — no se rediseña.
- **Monitor:** el existente (contadores, progreso, log en caliente, pausar/reanudar/cancelar) + enlace a reporte de atribución real (`GET /api/attribution/report/:id`).
- **Estados:** vacío, cargando, error; toast por acción; los botones de estado incompatible devuelven el 409 del backend y muestran su mensaje.

### 4.8 Respuestas rápidas
- **Ruta:** `/quick-replies`. **Acciones reales:** listar/crear/editar/borrar (`GET/POST /api/quick-replies`, `PUT/DELETE /api/quick-replies/:id`) con atajo (único), título y cuerpo; validación de campos requeridos y unicidad de atajo; uso desde el compositor del chat (menú «/»).
- **Estados:** vacío (CTA), cargando, error; toast por acción.

### 4.9 Etiquetas
- **Ruta:** `/tags`. **Acciones reales:** CRUD (`GET/POST /api/tags`, `PUT/DELETE /api/tags/:id`) con nombre único y color; borrar etiqueta la desasigna de los contactos; contador de contactos por etiqueta (real).
- **Estados:** vacío, cargando, error; toast.

### 4.10 Agentes / Equipo
- **Ruta:** `/agents`. **Acciones reales:** CRUD (`GET/POST /api/agents`, `PUT/DELETE /api/agents/:id`) con nombre, email, rol (`admin|agente`), activo; borrar agente desasigna sus conversaciones; asignación de conversaciones desde el chat (`assigned_agent`).
- **Estados:** vacío, cargando, error; toast.

### 4.11 Integraciones WhatsApp / API
- **Ruta:** `/integrations`. **Contenido real:** estado del transporte (`GET /api/integrations/transport`): motor (daemon CRM / Meta Cloud), URL del daemon (si aplica), phone_number_id (si aplica), estado de credenciales (solo máscara, jamás el secreto); editar config no secreta (`PUT /api/integrations/transport`); **Probar conexión** (`POST /api/integrations/transport/test`) que hace una llamada REAL (health del daemon / validación de token contra Graph API con el token provisto solo en memoria); webhooks de entrada: la URL `/api/audiences/webhook-message` con el contrato HMAC v2 documentado.
- **Validaciones:** URL http(s) válida; prueba de conexión con resultado real (OK/latencia/error).
- **Estados:** sin configurar (aviso), probando (spinner), error visible con el mensaje real del backend.

### 4.12 Ajustes
- **Ruta:** `/settings`. **Acciones reales:** perfil org (nombre de marca, país) y ritmo por defecto (delays min/max, lote de enfriamiento) → `GET/PUT /api/settings`; lista de supresión real con alta manual (`GET/POST /api/suppression`, `DELETE /api/suppression/:phone`); cierre de sesión (`POST /logout`); estado de la sesión (TTL restante).
- **Estados:** cargando, guardado (toast), error.

### 4.13 Navegación global y comportamiento transversal
- **Sidebar** con las 12 pantallas + logo + estado del transporte; colapsa a iconos en móvil (390 px), menú hamburguesa.
- **Sesión caducada:** interceptor global de `fetch`: ante `401` → redirigir a `/login?expired=1`.
- **Toasts** de éxito/error en TODAS las acciones que mutan; **estados vacío/cargando/error** en TODAS las pantallas.
- **Recarga conserva estado:** la ruta activa vive en `location.hash` (`#/contacts` etc.) y sobrevive F5.
- **Formato WhatsApp:** el compositor y las plantillas admiten `*negrita*`, `_cursiva_`, `~tachado~` (envío de texto plano con esos marcadores, igual que el original).
