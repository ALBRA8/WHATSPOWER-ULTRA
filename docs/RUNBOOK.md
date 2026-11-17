# RUNBOOK DE OPERACIONES E INCIDENTES — WHATSPOWER-ULTRA (Nivel 3)

## 1. NIVELES DE SEVERIDAD
- **P1 — Crítico:** Cola de despacho detenida, deadlock en SQLite (`SQLITE_BUSY`), caída total del dispatcher Meta Cloud.
- **P2 — Alto:** Tasa de fallos `UNCERTAIN_DISPATCH` > 2% del lote, degradación de calidad de número (Meta error 131049).
- **P3 — Medio:** Desconexión temporal de worker, expiración de lease de claims, alertas de fatiga de audiencia.

---

## 2. PROCEDIMIENTOS DE OPERACIÓN

### 2.1 Recuperación de Cola tras Caída (Crash Recovery)
1. El arranque del worker o del servidor ejecuta automáticamente `engine.recoverFromCrash()`.
2. Los ítems que quedaron a mitad de despacho (`DISPATCHING`) pasan a `UNCERTAIN_DISPATCH`.
3. Para reanudar campañas que estaban en `PAUSED_COOLDOWN`, el worker reanuda automáticamente una vez transcurridos los segundos de enfriamiento.

### 2.2 Reconciliación de Claims Inciertos
- Los envíos inciertos NUNCA se reintentan automáticamente.
- El operador debe auditar la tabla `campaign_items` (`status = 'UNCERTAIN_DISPATCH'`).
- Si se verifica la no entrega con Meta Business Manager o receptor, se autoriza el reenvío manual.

### 2.3 Circuito de Bajas y Habeas Data (Ley 1581)
- Cada baja (`addSuppression`) revoca inmediatamente el consentimiento en `consent_records`.
- Peticiones de supresión de datos:
  `DELETE /api/compliance/contact-data?phone=<TEL>`
- Peticiones de exportación de datos:
  `GET /api/compliance/contact-data?phone=<TEL>`

---

## 3. RENDIMIENTO Y MONITOREO
- Endpoint de salud y métricas de cola: `GET /api/health` (PÚBLICO, sin autenticación por diseño: expone métricas agregadas de cola, jamás datos de contacto).
  - Responde `200` con contadores: `queuePending`, `queueInFlight`, `sent`, `uncertain`, `failed`.
  - Si la BD no responde a `SELECT 1`, el endpoint falla → alarma y reinicio del proceso (ver §3.1).
- Rendimiento medido de SQLite (WAL Mode en servidor local):
  - Inserciones individuales: ~4,300 TPS
  - Inserciones en lote (BEGIN/COMMIT): ~70,000 TPS
  - Claims atómicos de cola: ~2,500 claims/segundo
- Capacidad suficiente para superar por más de 10x la tasa máxima de despacho de Meta Cloud API (~80-250 msgs/seg).

### 3.1 Healthcheck y reinicio automático
- **Servidor ULTRA:** `GET /api/health` cada 30-60 s desde systemd/supervisor del host. Si 3 comprobaciones consecutivas fallan (exit ≠ 200 o timeout), el supervisor reinicia el proceso (`npm start`).
- **Worker ULTRA (`npm run worker`):** el proceso mantiene el bucle vivo (timer referenciado) y registra `uncaughtException`/`unhandledRejection` sin morir por fallos de un tick. El supervisor debe reiniciar si el proceso TERMINA (exit ≠ 0) o si `/api/health` deja de reflejar actividad de la cola con campañas RUNNING.
- **Daemon WhatsApp del CRM (Capa 1, puerto 3002):**
  - Salud: `GET /status` con `Authorization: Bearer <INTERNAL_API_SECRET>` → `200` con sesiones por organización.
  - Arranque supervisado: `node scripts/start-daemon-detached.mjs` (doble fork + unref, log en `daemon.log`).
  - Reinicio automático recomendado en el host: unidad systemd con `Restart=always` y `RestartSec=10` que ejecuta `npm run wa:daemon`; el daemon re-vincula las sesiones desde `.wa-auth/<orgId>/` al arrancar (sin re-escanear QR salvo que la sesión haya sido revocada en el teléfono).
- **Unit systemd de referencia (host Linux, editar rutas antes de instalar):**

```ini
# /etc/systemd/system/albra-daemon.service
[Unit]
Description=CRM ALBRA WhatsApp Daemon (Baileys)
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/crm-albra
ExecStart=/usr/bin/node src/whatsapp-daemon/daemon.mjs
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

### 3.2 Respaldo y restauración de la BD (nuevo en reparación 2026-11-17)
- Respaldo consistente EN CALIENTE (seguro con el worker vivo):
  `node --experimental-strip-types scripts/backup-db.ts [ruta_bd] [destino]`
  → usa `VACUUM INTO` + `PRAGMA integrity_check` sobre la copia.
- Restauración (DETÉN el worker antes; el script conserva la BD previa):
  `node --experimental-strip-types scripts/restore-db.ts <respaldo.db> [destino]`
  → verifica integridad del respaldo, restaura por intercambio atómico y deja la BD anterior como `<destino>.pre-restore-<ts>`.
- Frecuencia recomendada: respaldo diario + antes de cualquier migración de esquema (regla 3 del repositorio: respaldo físico previo).
