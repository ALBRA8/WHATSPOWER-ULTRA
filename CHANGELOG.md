# CHANGELOG

## 2026-11-17 — Reparación de producción real (FASE 1-5 del encargo maestro)

### Seguridad — Consentimiento (Ley 1581)
- **`fix(worker)` (4794444)**: `ConsentStore` OBLIGATORIO en `BroadcastEngine`
  (constructor fail-closed `CONSENT_STORE_REQUIRED`) y cableado en
  `worker-main.ts` (`LocalSuppressionStore(db, consentStore)`). El chequeo JIT
  de consentimiento es INCONDICIONAL: un engine sin store ya no puede despachar
  sin verificar (antes: `if (this.consentStore && …)` lo saltaba).
  Las bajas procesadas por la cadena del worker REVOCAN consentimiento.
  Prueba: `tests/worker-consent.test.ts` (5 casos) + siembra de consentimiento
  en pruebas existentes vía `tests/helpers/consent.ts`.

### Seguridad — Login demo y rate limiting
- **`fix(auth)` (ab524ce)**: `/studio/login-demo` responde **403 SIEMPRE en
  producción** aunque `DEMO_MODE=true`; `productionConfigProblems` lo rechaza;
  el rate limiter de login **acumula intentos** (el éxito ya NO borra el
  contador — cierra el bypass de fuerza bruta); IP del SOCKET salvo
  `TRUST_PROXY=true` (jamás `x-forwarded-for` crudo). `.env.example`
  documentado. Prueba: `tests/login-demo-hardening.test.ts` (6 casos).

### Seguridad — Pacing anti-baneo
- **`fix(worker)` (df13523)**: `WORKER_DISABLE_PACING=1|true` en producción es
  problema fatal y `worker-main.ts` aborta con exit 1 (guard explícito).
  En desarrollo sigue siendo legítimo (laboratorio). Prueba:
  `tests/pacing-guard.test.ts` (proceso hijo real con exit 1 verificado).

### Seguridad — Rastreo de clics
- **`fix(tracking)` (4ac7996)**: suite DEDICADA del comportamiento ya cableado
  en `/t/:code` (sha256(ip:salt)[:16], x-forwarded-for solo con TRUST_PROXY):
  `tests/tracking-ip-hash.test.ts` (6 casos).

### Corrección de circuito de bajas
- **`fix(suppression)` (9cbd4d0)**: normalización canónica del teléfono en
  `LocalSuppressionStore` (solo dígitos) en altas/consultas/bajas: una baja
  registrada como `+573000000000` y el contacto importado como `573000000000`
  son el MISMO teléfono (antes el JIT anti-baja comparaba formatos distintos).

### Higiene y documentación
- **`docs(hygiene)` (aa81718)**: aviso de canal NO oficial Baileys en README y
  en la UI de Integraciones → Transporte del dashboard.
- **`build/docs` (b261f5f)**: `DOCS/DECISION_SQLITE_TYPES.md` (postura
  `node:sqlite` + `--experimental-strip-types`), `scripts/backup-db.ts` y
  `scripts/restore-db.ts` (respaldo VACUUM INTO + restauración atómica,
  probados con datos ficticios), RUNBOOK §3.1 (healthchecks + unit systemd de
  referencia para el daemon) y §3.2 (respaldo/restauración).

### Verificación E2E
- **`test(e2e)` (9cbd4d0)**: `tests/e2e-cross-flow.test.ts` — flujo cruzado
  CRM→ULTRA: consentimiento por contrato → SENT → STOP entrante → baja por
  contrato → consentimiento REVOCADO → campaña siguiente SUPPRESSED → contacto
  sin consentimiento SKIPPED_NO_CONSENT → persistencia tras reinicio →
  salvaguarda física `ALLOW_REAL_DISPATCH=false` verificada (jamás envío real).

### Números de la sesión
- Suite: **269/269** en 50 suites · `tsc --noEmit`: 0 errores · `security:scan`: 0 secretos · `test:security`: 2/2.

---


## 2026-11-16 — Mejora exponencial: theme toggle + sitio público + webhook doc

### Añadido
- **Toggle de tema claro/oscuro** en el dashboard (`src/studio/dashboard-html.ts`):
  - Botón 🌙/☀️ en el topbar con un solo clic.
  - Variables CSS para modo claro (`html[data-theme="light"]`) con paleta completa
    (fondos, paneles, bordes, inputs, tablas, métricas, skeletons).
  - Persistencia en `localStorage` (`wp-theme`); se restaura al recargar.
  - Todos los colores hardcodeados del dashboard se reemplazaron por variables CSS
    para que respondan a ambos temas.
- **Sitio público de referencia** en `/sitio/` (`web/sitio/`):
  - 5 páginas HTML estáticas: `index.html` (inicio), `planes.html`, `faq.html`,
    `alianza-ia.html`, `demo.html`.
  - CSS compartido (`site.css`) con la paleta del original (#009430, #f7a820,
    cuerpo 21px, columna 1140/1024/767) y responsive en 3 breakpoints (1024, 768, 390).
  - FAQ con patrón `role="tab"` + `aria-expanded` + `aria-controls`; signo "+"
    dibujado con CSS `::after` (no texto) para evitar la trampa §9.1.
  - Ruta `/sitio/` servida por `src/server.ts` con path-traversal protection.
- **`docs/WEBHOOK-MENSAJES.md`**: contrato completo del webhook de entrada
  (B10 del prompt). Cabeceras, firma HMAC v2 (ts + cuerpo + org), ventana de
  tolerancia 5 min, ejemplos curl de alta y de error (401/503), idempotencia
  de eventos duplicados, modelo de datos, reglas de seguridad.
- **README** actualizado: documentación de las rutas `/sitio/`, el toggle de tema,
  `npm run security:scan` y `npm run tsc`.

### Cambiado
- `src/studio/dashboard-html.ts`: colores hardcodeados (#1f2937, #374151, #1e293b,
  #334155, #1a2436) reemplazados por variables CSS (--input-bg, --input-border,
  --table-head, --table-row-border, --metric-bg, --hover-bg, etc.) para que
  respondan al tema activo. Añadido botón `theme-toggle` en el topbar y
  funciones `toggleTheme()` / `actualizarIconoTheme()`.
- `src/server.ts`: import de `readFile`, `join`, `dirname`, `extname`, `normalize`,
  `fileURLToPath`. Añadida ruta `/sitio/` para servir las páginas públicas.

### Verificación
- `npm run tsc`: limpio (0 errores).
- `npm test`: 195/196 verdes (1 fail preexistente en `contracts-integration.test.ts:215`,
  confirmado que falla igual sin estos cambios — es un test de red que requiere
  el servicio 2A vivo en `:3003`).
- `npm run security:scan`: limpio (0 secretos).
- Rutas verificadas: `/` (200), `/login` (200), `/studio` (200), `/sitio/` (200),
  `/sitio/index.html` (200), `/sitio/planes.html` (200), `/sitio/faq.html` (200),
  `/sitio/site.css` (200), `/api/health` (200).

---

## 2026-11-15 — Paridad de dashboard (encargo «PROMPT PARA EL CONSTRUCTOR», 5 fases)

### Añadido (todo ADITIVO sobre el motor de broadcast existente)
- Dashboard completo en `/` (y `/campaigns`) con 10 pantallas: Resumen, Conversaciones/Chat,
  Contactos, Embudo (kanban), Campañas (lista + creador/monitor existentes reutilizados),
  Respuestas rápidas, Etiquetas, Agentes, Integraciones y Ajustes. Login dedicado `/login`
  (canje `/studio/login` por cookie HttpOnly), `/logout`, interceptor 401 → `/login?expired=1`.
  El studio legado queda intacto en `/studio`.
- Tablas nuevas (aditivas, `IF NOT EXISTS`): contacts, tags, contact_tags, quick_replies,
  agents, conversations, messages, pipeline_stages, org_transport_config, org_settings.
- Endpoints nuevos bajo la puerta de autenticación existente: dashboard/summary, settings,
  contacts (CRUD + import-csv persistente + export.csv), tags, quick-replies, agents,
  pipeline/stages + move idempotente (eventId), conversations + messages (envío REAL con
  supresión + lock 2A + transporte), webhook de mensajes entrantes HMAC v2
  (`/api/audiences/webhook-message`), integrations/transport (+ test de conexión real),
  suppression (alta/baja), campaigns DELETE (solo terminal) y retry-failed.
- Carpeta `parity/`: inventario del original, matriz archivo:línea, verificación con clics
  (20/20, 25 capturas) y remate (handoff). Pruebas nuevas: `tests/dashboard-parity.test.ts`
  (22 pruebas DP-01…DP-22).

### Corregido durante la verificación real
- Sondeo del chat reconstruía el hilo y destruía el compositor mientras se escribía →
  `pollActiveThread()` refresca solo mensajes y espera si hay texto.
- `ensureConversation` no idempotente → responder a una conversación existente daba 400
  (UNIQUE) después de despachar; ahora `INSERT OR IGNORE` + prueba DP-15 ampliada.
- Contactos nuevos/CSV/leads sin etapa → kanban vacío; nacen en la primera etapa.

### Verificación
- 196/196 pruebas (174 previas intactas), `tsc --noEmit` limpio, `security:scan` limpio.
- Verificación con navegador real en escritorio y 390 px: 20/20 pasos (parity/verificacion.md).

---

## 2026-11-15 — Producción real: verificación total, escáner de historial y throttler ajustable (rama repair/produccion-real)

## 2026-11-11/12 — Auditoría integral: ciclos 1 y 2 (rama impl/audit-20261111)

### Corregido
- Seguridad: rate limiting durable en BD; fail-closed de secretos; HMAC timing-safe;
  secretos Telegram cifrados con lookup por hash; JWT jamás en URLs de export; errores
  genéricos (sin filtrar e.message); P2002→409 / P2025→404.
- Fiabilidad: idempotencia extremo a extremo con eventId determinista; dedup de webhooks
  (waMessageId/mid) incl. statuses; liberación de dedup on-throw; transacciones atómicas
  (registro, conexiones con límite de plan, cliente+timeline); WAL + busy_timeout.
- Frontend (CRM): deep-links reales, reset de formulario corregido, TabsList wrap,
  JSON.parse blindado, vista /chat muerta eliminada.
- Pruebas: suites en verde al cierre de cada ciclo; pruebas nuevas para cada corrección
  (rate limit durable, dedup, dual-formato, release-on-throw, etc.).

### Rerequisito de despliegue
- Ejecutar `npx prisma migrate deploy` (incluye migración 4_audit_indexes con respaldo
  reversible) y `node scripts/migrate-telegram-secrets.mjs` (backfill idempotente).
- NO desplegar sin autorización expresa del propietario.
