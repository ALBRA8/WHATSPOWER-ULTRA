# MIGRACIONES — Reparación Integral 2026-11-06 (WHATSPOWER-ULTRA)

Rama: `fix/tercera-reparacion-integral` · Base: `fix/segunda-reparacion-integral` @ `65635c0`

Todas las migraciones de esta rama son **aditivas y reversibles**. No se
modifica ni se borra ninguna columna/tabla existente.

## M-v4 (TERCERA REPARACIÓN) — Supresión y fatiga POR ORGANIZACIÓN (5.B)

**Propósito:** la lista de bajas y la fatiga comercial eran GLOBALES por
teléfono (una organización silenciaba/fatigaba contactos de otra). Política
decidida y documentada en `docs/POLITICA-SUPRESION.md`:

```sql
-- suppression_list: PK (phone) → (organization_id, phone)
CREATE TABLE global_suppression_list (
  phone TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
INSERT OR IGNORE INTO global_suppression_list (phone, reason, created_at)
  SELECT phone, 'migrado_v4: opt-out previo al aislamiento (política conservadora)', created_at
  FROM suppression_list;   -- copia CONSERVADORA de opt-outs legacy (no se inventa org)
ALTER TABLE suppression_list RENAME TO suppression_list_v3old;
CREATE TABLE suppression_list (
  organization_id TEXT NOT NULL, phone TEXT NOT NULL, reason TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY (organization_id, phone));
DROP TABLE suppression_list_v3old;

-- contact_fatigue: PK (phone) → (organization_id, phone); legacy → '__legacy__'
ALTER TABLE contact_fatigue RENAME TO contact_fatigue_v3old;
CREATE TABLE contact_fatigue (
  organization_id TEXT NOT NULL, phone TEXT NOT NULL, last_broadcast_at INTEGER NOT NULL,
  last_campaign_id TEXT NOT NULL, PRIMARY KEY (organization_id, phone));
INSERT INTO contact_fatigue SELECT '__legacy__', phone, last_broadcast_at, last_campaign_id FROM contact_fatigue_v3old;
DROP TABLE contact_fatigue_v3old;
```

**Rollback exacto (reversible; los opt-outs legacy se conservan en
`global_suppression_list` hasta que se decida lo contrario):**

```bash
sqlite3 db/broadcast.db "DROP TABLE IF EXISTS suppression_list;
CREATE TABLE suppression_list (phone TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
-- (opcional) recuperar bajas por-org como globales:
-- INSERT OR IGNORE INTO suppression_list SELECT phone, reason, created_at FROM suppression_list_v3old;
DROP TABLE IF EXISTS contact_fatigue;
CREATE TABLE contact_fatigue (phone TEXT PRIMARY KEY, last_broadcast_at INTEGER NOT NULL, last_campaign_id TEXT NOT NULL);
DROP TABLE IF EXISTS global_suppression_list;"
```

## M1 — `campaign_items.claimed_by` / `campaign_items.claimed_at`

**Propósito:** claim atómico del worker de despacho (un ítem solo puede ser
reclamado por un worker; el UPDATE condicional `WHERE status='PENDING'` es la
primitiva de exclusión). Con esto desaparece la carrera SELECT→await→UPDATE que
permitía doble despacho con workers concurrentes.

```sql
ALTER TABLE campaign_items ADD COLUMN claimed_by TEXT;
ALTER TABLE campaign_items ADD COLUMN claimed_at INTEGER;
```

**Rollback exacto (reversible):**

```bash
sqlite3 db/broadcast.db "ALTER TABLE campaign_items DROP COLUMN claimed_by; ALTER TABLE campaign_items DROP COLUMN claimed_at;"
```

(Requiere SQLite ≥ 3.35, incluido en Node ≥ 22.) Aplicar con la ventana de
despacho detenida; el código nuevo no arranca sin las columnas.

## M2 — `realtime_leads.organization_id`

**Propósito:** binding de organización de los leads ingeridos por webhook. La
organización viene de la verificación HMAC (X-Org-Id autenticado), nunca del
body. `NULL` = lead del secreto v1 ("_legacy").

```sql
ALTER TABLE realtime_leads ADD COLUMN organization_id TEXT;
```

**Rollback exacto:**

```bash
sqlite3 db/broadcast.db "ALTER TABLE realtime_leads DROP COLUMN organization_id;"
```

## M3 — Anti-replay durable: `db/replay-cache.db` (nueva base)

**Propósito:** el anti-replay de webhooks sobrevive reinicios del proceso y
sirve varias réplicas que compartan el archivo. Tabla:
`replay_seen(fingerprint TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)`.

**Rollback exacto:** borrar el archivo y volver a `ReplayCache` en memoria
(`git revert` del commit). Ruta configurable con `REPLAY_DB_PATH`.

## Cambio de contrato (no-DB): HMAC v2

- Antes (v1): `X-Signature-Sha256 = HMAC(secret, rawBody)` — el timestamp NO
  estaba ligado a la firma (replay con timestamp fresco era posible).
- Ahora (v2): `X-Signature-Sha256 = HMAC(secretoDeLaOrg, "${orgId}.${timestamp}.${rawBody}")`.
- Emisores afectados: integraciones de ingesta de leads. Actualiza el firmante
  y envía `X-Org-Id`. El secreto único v1 sigue aceptado (org `_legacy`), pero
  no puede ligar leads a campañas.
- Rollback: `git revert` del commit de contrato + revert del firmante emisor.

## Cambios de comportamiento que NO requieren migración

- `/api/audiences/webhook-lead` responde **403** cuando la campaña referenciada
  pertenece a otra organización (antes inyectaba el lead).
- La cola marca `CLAIMED_BY_OTHER_WORKER` en carreras perdidas (antes podía
  despachar duplicado).
- Nueva operación controlada `reconcileStaleClaims(maxAgeSeconds=900)`:
  claims de workers muertos → `UNCERTAIN_DISPATCH` (nunca vuelve a `PENDING`).
