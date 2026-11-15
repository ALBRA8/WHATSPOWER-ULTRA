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
- Endpoint de salud y métricas de cola: `GET /api/health`
- Rendimiento medido de SQLite (WAL Mode en servidor local):
  - Inserciones individuales: ~4,300 TPS
  - Inserciones en lote (BEGIN/COMMIT): ~70,000 TPS
  - Claims atómicos de cola: ~2,500 claims/segundo
- Capacidad suficiente para superar por más de 10x la tasa máxima de despacho de Meta Cloud API (~80-250 msgs/seg).
