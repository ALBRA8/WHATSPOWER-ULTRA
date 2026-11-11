# POLÍTICA DE SUPRESIÓN (5.B — TERCERA REPARACIÓN)

Rama: `fix/tercera-reparacion-integral` · Estado: **documentada, implementada y probada** (tests `U3-02`, `U3-03`, `U3-09`).

## Decisión de política

**La supresión es POR ORGANIZACIÓN por defecto.**

Causa raíz corregida: la lista de supresión de Capa 2B era GLOBAL por teléfono
(`phone` PK). Consecuencias: (1) la baja de un contacto en una organización lo
silenciaba en TODAS — correcto solo si las relaciones comerciales son de un
mismo grupo, falso en multiempresa real; (2) la sincronización desde Capa 2A
escribía en esa lista global, contaminando otras organizaciones; (3) un
listado/administración global exponía la existencia de contactos de una org a
otra.

## Modelo v4

1. **`suppression_list` POR ORGANIZACIÓN** — PK `(organization_id, phone)`.
   Cada organización gestiona sus propias bajas; la consulta exige
   `organizationId` (fail-closed sin org: `TENANT_CONTEXT_INVALID`).
2. **`global_suppression_list` — complemento restringido y auditable** — SOLO
   para requisitos legales/regulatorios documentados (p. ej. bloqueos
   regulatorios). Reglas de protección:
   - No se alimenta nunca de bajas de una organización concreta.
   - Toda fila exige un **motivo documentado** (≥ 8 caracteres; la API rechaza
     `GLOBAL_SUPPRESSION_REQUIRES_DOCUMENTED_REASON` en caso contrario).
   - La re-activación por organización NO elimina filas globales legales.
3. **Sincronización con Capa 2A por organización** — `CompositeSuppressionChecker`
   guarda la baja sincronizada en el espacio de ESA organización
   (`synced_from_2a`); jamás contamina otras orgs.
4. **Fatiga comercial POR ORGANIZACIÓN** — `contact_fatigue` PK
   `(organization_id, phone)`: el descanso de 7 días pertenece a la relación
   comercial con ESA organización.

## Migración conservadora de datos legacy (no se inventa atribución)

Los opt-outs previos a la v4 eran globales sin organización conocida:
- **No** se reasignan a organizaciones inventadas.
- **No** se borran (rompería una solicitud legal de no-contacto).
- Se copian a `global_suppression_list` con motivo
  `migrado_v4: opt-out previo al aislamiento (política conservadora)` — el
  contacto NO vuelve a recibir mensajes de nadie; cada organización puede
  además gestionar sus bajas propias por organización.
- La fatiga legacy queda en el espacio reservado `__legacy__` (invisible para
  organizaciones reales).

## Consulta y gestión

- Consulta: `LocalSuppressionStore.isSuppressed(phone, organizationId)` →
  suprimido si está en la lista DE ESA org **o** en la global legal.
- Baja por org: `addSuppression(organizationId, phone, reason)`.
- Alta global legal (operación restringida, auditable):
  `addGlobalSuppression(phone, reason_documentado)`.
- Re-activación: `removeSuppression(organizationId, phone)` (jamás toca la global).

## Rollback

Revertir el commit v4 restaura el modelo global anterior. Ver
`docs/MIGRACIONES.md` §v4 para el rollback exacto de esquema.
