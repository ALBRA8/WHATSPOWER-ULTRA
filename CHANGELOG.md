# CHANGELOG

## 2026-11-15 — Preparación para Producción Real (rama repair/produccion-real)

### Fase 1 — Canal Oficial de WhatsApp
- **Meta Cloud API por defecto:** Integración de Meta Cloud API para difusión oficial por organización con resolución de números y tokens dedicados.
- **Ventana de 24 horas y Plantillas:** Almacén de ventana y registro de plantillas, bloqueando difusiones no transaccionales fuera de ventana.
- **Clasificación de Errores Meta:** Manejo riguroso de límites de velocidad, plantillas rechazadas y estados `UNCERTAIN` sin reintentos ciegos.

### Fase 2 — Consentimiento y Cumplimiento Normativo (Ley 1581)
- **ConsentStore:** Registro de autorización previa y trazabilidad auditable (`consent_records` y `consent_audit_log`).
- **JIT Guard en Despacho:** Validación pre-despacho (<50ms): ítems sin consentimiento transitan a `SKIPPED_NO_CONSENT`.
- **Importador CSV:** Parámetro `consent_origin` obligatorio en cada registro importado.
- **Bajas y Habeas Data:** Revocación automática de consentimiento ante bajas; endpoints de exportación y borrado de datos.
- **Rastreo de Clics Anónimo:** Validación de `TRUST_PROXY === 'true'` y almacenamiento de IP hasheada con SHA-256 de 16 caracteres.

### Fase 3 — Estabilidad, Capacidad y Operaciones
- **Alineación de Entorno:** Node `>=22.12.0` (engines), `.nvmrc` (`22.14.0`), Dockerfile (`node:22-alpine`) y CI (`node-version: 22`).
- **Runner de Pruebas Multiplataforma:** `scripts/run-tests.mjs` ejecutando los 20 archivos de prueba limpiamente en Windows y Linux.
- **Benchmark SQLite:** Verificada capacidad de 70,914 inserts/s en batch y 2,541 claims de cola/s en SQLite WAL, cubriendo con creces la demanda sin requerir Postgres.
- **Healthcheck Operativo:** `/api/health` con métricas de colas, sent/failed/uncertain y memoria.
- **Runbook:** Guía operativa de producción en `docs/RUNBOOK.md`.

### Fase 4 y 5 — Higiene y Verificación
- Sanitización de datos personales en scripts, contratos y tests.
- Eliminadas afirmaciones engañosas de paridad WhatsOn/WATI en `README.md` y `FICHA.md`.
- 36 suites de prueba pasando (194/194 pruebas superadas al 100%). TypeScript 0 errores.

---

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
