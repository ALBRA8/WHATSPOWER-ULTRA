# INFORME DE TERCERA REPARACIÓN INTEGRAL — WHATSPOWER-ULTRA

**Repositorio:** `ALBRA8/WHATSPOWER-ULTRA` · **Rama:** `fix/tercera-reparacion-integral`
**Base commit:** `65635c0` (fix/segunda-reparacion-integral) · **Commit final:** `216b684`
**Fecha:** 2026-11-06/07 · **Ejecutado en sala limpia (sandbox), sin despachos reales.**

---

## 1. Alcance ejecutado (orden §5.A–§5.D)

### 5.A — COMPATIBILIDAD CON WHATSPOWER (BLOQUEO PRINCIPAL — RESUELTO)
**Causa raíz confirmada:** `Http2ALockChecker.checkLock(phone)` y
`Http2ASuppressionChecker.isSuppressed(phone)` NO enviaban `x-org-id`; la
Capa 2A endurecida en fase 2 respondía 400 → ULTRA lo trataba como fallo
genérico: la incompatibilidad de contrato era indistinguible de una denegación
de seguridad legítima (todas las campañas con 2A activada quedaban bloqueadas
o, peor, un "libre" malinterpretado habría permitido despachar).

Corregido de extremo a extremo:
- **Interfaces:** `LockChecker.checkLock(phone, organizationId)` y
  `SuppressionChecker.isSuppressed(phone, organizationId)` — la organización de
  la CAMPAÑA se propaga al pre-filtrado (creación) y a los chequeos
  Just-In-Time (<50 ms) del worker.
- **Cliente HTTP:** `X-Org-Id` SIEMPRE presente + Bearer; **verificación del
  eco** `organizationId` de la respuesta (2A lo añadió en su lado): sin eco →
  `TENANT_UNVERIFIED`; desajustado → `TENANT_MISMATCH`; 400/403 de contexto →
  `TENANT_CONTEXT_REJECTED` — marcados `contractError: true` (auditable como
  fallo de contrato, jamás confundido con un lock o una supresión legítima).
- **Fail-closed de contexto:** sin organización no se consulta ni se despacha;
  la ejecución piloto supervisada exige `PILOT_ORG_ID`.
- **Lado 2A (repo hermano):** los endpoints internos hacen eco de
  `organizationId` (contrato v2) — verificable en la integración real I-05/I-07.
- **Evidencia REAL (mock insuficiente como prueba):** integración de 3
  servicios con HTTP real (sección 5) + tests de contrato contra servidor 2A
  simulado con el contrato vigente (contracts TEST 2, incluido el caso
  "servidor 2A legado sin eco" → rechazado).

### 5.B — POLÍTICA DE SUPRESIÓN (rediseñada, documentada y probada)
`docs/POLITICA-SUPRESION.md`:
- **POR ORGANIZACIÓN por defecto:** `suppression_list` PK `(organization_id,
  phone)`; fatiga comercial `contact_fatigue` PK `(organization_id, phone)`.
- **`global_suppression_list` restringida y auditable:** SOLO requisitos
  legales/regulatorios documentados; motivo obligatorio (≥8 caracteres,
  `GLOBAL_SUPPRESSION_REQUIRES_DOCUMENTED_REASON`); jamás alimentada por bajas
  de una organización; la re-activación por org no la toca.
- **Migración conservadora:** los opt-outs legacy (globales, sin org conocida)
  se COPIAN a la lista global documentada con motivo
  `migrado_v4: ... (política conservadora)` — un opt-out jamás deja de
  aplicarse y NO se inventa atribución por organización. Fatiga legacy →
  `'__legacy__'` (invisible para orgs reales). Rollback exacto en
  `docs/MIGRACIONES.md` §M-v4.
- **Sincronización 2A:** la baja remota se guarda EN SU organización
  (`synced_from_2a`), sin contaminación cruzada (U3-09).

### 5.C — CAMPAIGN STUDIO Y XSS (verificación de fase 2 + regresiones)
- Confirmado: sin `sessionStorage` de secretos; cookies `HttpOnly`,
  `SameSite=Strict`, `Secure` en producción, HMAC stateless ligado al secreto
  (rotación ⇒ revocación) — U3-05.
- `innerHTML` solo estático/vaciado; los datos de campañas se pintan con
  `textContent` — verificado con U3-04 (payload hostil viaja como DATO en el
  preview JSON; la plantilla no interpola filas de datos).
- Sesión: expiración (1 h), firma verificada timing-safe, revocación por
  rotación.

### 5.D — CAMPAÑAS Y WORKER (máquina de estados reforzada)
Mantenido lo de fase 2 (claim atómico, re-check F0, UNCERTAIN_DISPATCH,
`recoverFromCrash`, reconciliación de claims vencidos) y ampliado con pruebas
forzosas: **cancelación DURANTE los chequeos JIT** → `ABORTED_CAMPAIGN_NOT_
RUNNING` con CERO envíos (U3-06); PAUSED no despacha; CANCELLED terminal
(resume rechazado) (U3-07); **dos organizaciones en paralelo con el mismo
teléfono** (lock/fatiga por org) (U3-08); sincronización de baja remota en su
org (U3-09). Además: **WAL** en `broadcast.db` para concurrencia real
multi-proceso (habilitado y verificado por la integración I-14).

## 2. Hallazgos PENDIENTES / decisiones de producto
- `ADMIN_API_KEYS` con identidad por organización es la base del ownership;
  la identidad de servicio (clave sin org) conserva poder total por diseño —
  si se quiere eliminar ese poder, es decisión de producto (rompería la
  creación de campañas multi-org del servicio).
- `campaign_items` no replica `organization_id` (se hereda de la campaña por
  JOIN; el worker siempre opera vía campaña). Añadible si se quiere defensa en
  profundidad a nivel de fila.
- El proveedor real de despacho (Meta Cloud / daemon) exige
  `ALLOW_REAL_DISPATCH=true` explícito; no se ejecutó ningún despacho real.

## 3. Pruebas REALES ejecutadas
| Comando | Resultado |
|---|---|
| suite completa (10 archivos, `node --test`) | **99/99 pass** (90 previos actualizados al contrato v2 + 9 nuevas U3-01..U3-09) |
| `npx tsc --noEmit` | OK (CI: success) |
| CI GitHub Actions (`CI WHATSPOWER-ULTRA`) | **success** en `216b684` |

## 4. Migraciones y resultados
§M-v4 (`POLITICA-SUPRESION.md` + `MIGRACIONES.md`): rebuild de
`suppression_list`/`contact_fatigue` con org, copia conservadora a la lista
global documentada, índice por org. Probadas sobre BD legacy real creada
ad-hoc en U3-03 (schema v3 + filas) → migración automática al arrancar v4.

## 5. Integración real (sección 7)
15/15 escenarios OK con los tres servicios por HTTP real (detalle en el
informe de WHATSPOWER y en `/home/z/my-project/integration/results.json`).
Los escenarios I-02..I-09, I-12..I-14 ejercitan EL LADO ULTRA del contrato
contra la 2A REAL.

## 6. Enlaces
- Rama: https://github.com/ALBRA8/WHATSPOWER-ULTRA/tree/fix/tercera-reparacion-integral
- Commits: `ed8bf6a` (reparación), `3e5ecfb` (WAL), `216b684` (fix tipos CI)
- CI: https://github.com/ALBRA8/WHATSPOWER-ULTRA/actions (run success en `216b684`)
