# CHANGELOG

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
