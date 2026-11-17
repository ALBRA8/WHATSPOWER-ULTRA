# AUDIT_REPORT — WHATSPOWER-ULTRA

## Actualización 2026-11-17 — Reparación técnica y auditoría de producción (FASE 1-5)

**Rama:** `repair/produccion-real` · **Método:** TDD (prueba que falla antes y pasa después) + verificación real (no solo compilación).

### Puertas de calidad (ejecutadas al cierre de la sesión)
| Verificación | Resultado |
|---|---|
| `tsc --noEmit` | 0 errores |
| `npm test` (node:test, 50 suites) | **269/269 PASS** |
| `npm run test:security` | 2/2 PASS |
| `npm run security:scan` | 0 secretos en el árbol |
| Simulación E2E flujo cruzado | **7/7 PASS** (`tests/e2e-cross-flow.test.ts`) |

### Hallazgos resueltos con evidencia

| ID | Severidad | Hallazgo | Reparación (commit) | Prueba |
|---|---|---|---|---|
| H-1 | **CRÍTICO** | `npm run worker` construía `BroadcastEngine` SIN `ConsentStore`: el chequeo JIT de consentimiento (Ley 1581) se saltaba por completo y las bajas no revocaban consentimiento | Constructor fail-closed (`CONSENT_STORE_REQUIRED`) + cableado en `worker-main.ts` + chequeo JIT incondicional (4794444) | `tests/worker-consent.test.ts` (5) |
| H-2 | **ALTO** | `/studio/login-demo` concedía sesión admin en producción si `DEMO_MODE=true` quedaba activo; el rate limiter borraba el contador tras cada éxito (bypass de fuerza bruta) y usaba `x-forwarded-for` crudo | 403 incondicional en producción; validación en `productionConfigProblems`; intentos acumulativos; `resolveClientIp` con TRUST_PROXY (ab524ce) | `tests/login-demo-hardening.test.ts` (6) |
| H-3 | ALTO | `WORKER_DISABLE_PACING=1` desactivaba el throttling anti-baneo sin restricción | Problema fatal en `productionConfigProblems` + guard explícito con exit 1 en `worker-main.ts`; legítimo solo en desarrollo (df13523) | `tests/pacing-guard.test.ts` (4, proceso hijo real) |
| H-4 | MEDIO | El rastreo de clics `/t/:code` tenía el hash de IP cableado pero sin suite dedicada verificable como hallazgo | Suite dedicada: IP jamás cruda, hash determinista, TRUST_PROXY estricto (4ac7996) | `tests/tracking-ip-hash.test.ts` (6) |
| H-5 | MEDIO | Normalización del teléfono en la lista de supresión: baja `+57…` no coincidía con contacto `573…` (el JIT anti-baja comparaba formatos) | Normalización canónica en `LocalSuppressionStore` (altas, consultas, bajas) (9cbd4d0) | `tests/e2e-cross-flow.test.ts` (7) |
| H-6 | INFO | Aviso de canal no oficial Baileys ausente en README y UI | Aviso destacado en README + caja de aviso en Integraciones → Transporte (aa81718) | Inspección + suite en verde |
| H-7 | INFO | Falta decisión documentada de runtime y procedimiento de respaldo | `DOCS/DECISION_SQLITE_TYPES.md`; `backup-db.ts`/`restore-db.ts` probados; RUNBOOK §3.1-§3.2 (b261f5f) | Scripts ejecutados con datos ficticios |

### Qué queda pendiente y por qué
- **Docker compose build**: sin docker en el entorno de trabajo; Dockerfile/compose presentes y revisados estáticamente → tarea del PC (`OWNER_TODO.md` §4).
- **Canal Meta Cloud oficial**: requiere cuenta Meta Business verificada, número oficial y plantillas aprobadas por el dueño (`OWNER_TODO.md` §2). El adaptador por organización ya existe; NO se migró Baileys (regla del encargo).
- **Rotación multi-cuenta automática**: NO implementada (sin código); declarada como pendiente en la matriz de paridad sincerada (`CONTEXTO CRM/PARIDAD_WHATSON_WHATSPOWER_ULTRA.md` en el repo CRM).

---


## Actualización 2026-11-15 — Producción real (rama `repair/produccion-real`)

**Método:** línea base completa ejecutada sobre la rama (FASE 1-4 de la sesión anterior re-verificadas en verde), mejora operativa con suite completa, E2E con los 3 servicios reales en simulación y prueba de studio en navegador real.

### Línea base (ejecutada en esta sesión)
| Verificación | Resultado |
|---|---|
| `tsc --noEmit` | 0 errores |
| Suite (node:test) | **194/194** en 36 suites (incluye fase1 Meta Cloud, fase2 consentimiento/CSV/bajas, H7-H10, cuarentena NULL-org) |
| `npm audit` | 0 vulnerabilidades |
| `security:scan` (árbol) | LIMPIO |
| `security:scan:history` (NUEVO) | **0 hallazgos** — historial git completo limpio desde la creación |

### Hallazgos / cambios de esta sesión

| ID | Severidad | Descripción | Estado | Evidencia |
|---|---|---|---|---|
| F6-U1 | BAJA | Ventanas horarias y pacing hard-coded (impedía E2E fuera de horario y ajustes por despliegue) | ✅ MEJORADO | `throttler.ts` configurable por env con defaults idénticos al histórico; suite 194/194 |
| F6-U2 | BAJA | Afirmación de paridad "WhatsOn + WATI + SleekFlow" en el Campaign Studio | ✅ CORREGIDO | Subtítulo neutral; suite en verde |
| F6-U3 | INFO | ULTRA carecía de escáner de historial git | ✅ CORREGIDO | `security:scan:history` → 0 hallazgos |
| F6-U4 | INFO | Activación de campaña: `/resume` es el camino DRAFT→RUNNING (documentado en E2E) | ✅ DOCUMENTADO | `scripts` del E2E + RUNBOOK heredan la nota |

### E2E 3 servicios reales (18/18 PASS, simulación, cero envíos reales)
- Campaña creada con 3 contactos → activada (`/resume` DRAFT→RUNNING) → despacho por pasos con pacing real:
  - Contacto con lock en WP → `LOCK_EXCLUDED` (Http2ALockChecker real contra WP).
  - Contacto sin consentimiento → `SKIPPED_NO_CONSENT` (JIT guard FASE 2).
  - Contacto válido con consentimiento → intento de despacho → `FAILED_FATAL` por salvaguarda `ALLOW_REAL_DISPATCH=false`.
  - `SENT=0` en toda la campaña; worker persistente con parada graciosa verificada (SIGTERM).

### Campaign Studio en navegador (Playwright/Chromium)
Carga 200, Historial (`logTbody`) presente, métricas sent/failed/skipped/total presentes, vista móvil 390px sin desbordamiento. Prueba conjunta 11/11 con el Flow Studio de WP.

### Pendientes (no bloqueados por código)
- Docker compose en el PC del dueño (sin docker aquí) → `OWNER_TODO.md` §4.
- Cuenta Meta Business + número oficial + plantillas → `OWNER_TODO.md` §2.

---

## Segunda reparación integral — 2026-11-06 (rama `fix/segunda-reparacion-integral`)

Nueva orden de trabajo (fase 2). Causas raíz corregidas y evidencia por bloque:

### §4.A XSS en Campaign Studio + secreto en el navegador
- **Causa raíz 1:** el monitor del Studio construía las filas del registro con `tr.innerHTML = \`...${it.contactName}...\`` — nombres, teléfonos, textos y estados procedentes de CSV o leads externos se interpolaban como HTML (XSS en el navegador del operador, que hasta ahora sostenía el secreto admin).
- **Corrección:** filas construidas con `createElement` + `textContent` para TODOS los datos dinámicos (XSS-01 verifica que no queda ningún `innerHTML = \`...${}` con datos; XSS-02 verifica el uso de textContent por campo).
- **Causa raíz 2:** el secreto administrativo vivía en `sessionStorage` (legible por JavaScript; un XSS lo exfiltraba).
- **Corrección:** patrón backend — `POST /studio/login` canjea el secreto UNA vez por una cookie `HttpOnly; SameSite=Strict` de 1 h (token HMAC stateless ligado al secreto vigente: rotarlo revoca todas las sesiones). La puerta `/api/*` acepta cookie de sesión o Bearer (clientes S2S). El secreto de larga vida jamás vuelve al navegador.
- **Pruebas:** XSS-01/02, SS-01 (HttpOnly+Strict), SS-02 (resuelve identidad + expira), SS-03 (rotación revoca), SS-04 (sin Web Storage para credenciales).

### §4.B Ciclo de vida de campañas
- **Causa raíz:** `/resume` aplicaba un UPDATE CIEGO a `RUNNING` — una campaña CANCELLED podía resucitarse; pause/cancel no verificaban estados; el worker podía completar la campaña con ítems en vuelo y no re-verificaba el estado antes de enviar.
- **Corrección:** máquina de estados explícita (`src/queue/campaign-lifecycle.ts`) con transiciones CONDICIONALES y ATÓMICAS (`UPDATE ... WHERE status IN <orígenes legales> AND organization_id = ?` — ownership y transición indivisibles). `CANCELLED` y `COMPLETED` TERMINALES (resucitar → 409). Worker: re-check de estado y ownership JUSTO antes del despacho (la cancelación durante los checks asíncronos aborta sin enviar); `DRAFT→RUNNING` condicional; `COMPLETED` solo sin ítems `PENDING` NI `DISPATCHING`.
- **Pruebas:** LC-01 (cancelada no se reanuda), LC-02 (terminales), LC-03 (ownership en la transición), LC-04 (cancelación durante checks → 0 envíos), LC-05 (no completar con vuelos en curso).

### §4.C Workers y colas
- La rama base ya traía claim atómico (`PENDING→DISPATCHING` con guard), `UNCERTAIN_DISPATCH` sin reintento ciego, reconciliación controlada de claims expirados y fail-closed de supresión/locks: verificados en verde (CLAIM-01..05 existentes). Añadidos en fase 2: re-check pre-despacho (LC-04) y guardia de completado (LC-05).

### §4.D Webhooks y leads
- **Causa raíz:** un lead con `campaignId` inexistente se insertaba con referencia huérfana.
- **Corrección:** `CAMPAIGN_NOT_FOUND` si la campaña no existe; `CAMPAIGN_ORG_MISMATCH` si pertenece a otra organización (binding cross-org ya existente se mantiene).
- **Pruebas:** LD-01 (huérfano rechazado), LD-02 (cross-org rechazado), LD-03 (propia aceptada y encolada).

### §4.E Protecciones fail-closed
- Supresión, locks, horarios, límites, fatiga, estado de campaña, resultado de despacho y reconciliación: todas en verde (tests de safeguards existentes + nuevos LC/LD).

### §7 CI
- El filtro de ramas ya era válido (`[main, 'fix/**']`); se añade `repair/**` para trazabilidad. Ningún paso con `continue-on-error`.

### Resultados reales (esta rama)
- Suite: **76/76** pruebas en 11 archivos (12 nuevas en `tests/segunda-reparacion.test.ts`).
- Sin envíos reales (dispatchers mock), sin campañas reales, sin cobros.


---

## Ciclo de auditoría 2026-11-11/12 — corrección integral y reauditoría goldfish (ciclos 1 y 2)

**Método.** 5 auditores independientes consolidaron 73 hallazgos deduplicados. Corrección
autónoma en 2 ciclos con regla "sin prueba verificable no se declara resuelto". El ciclo 2 fue
una REAUDITORÍA con revisores "goldfish" de contexto fresco (protocolo EGM de Google:
elephant-goldfish-model, Apache-2.0) sobre los diffs reales, sin el historial de la conversación.

### Resumen por severidad
- Críticas/altas de seguridad: resueltas (detalles por commit abajo).
- 0 vulnerabilidades críticas/altas de dependencias en runtime tras los bumps (quedan 5 moderadas
  conocidas en el CRM: react-syntax-highlighter/PrismJS DOM clobbering — fix breaking programado).

### Ciclo 1 — correcciones (commits: ver CHANGELOG)
- Batch B2/D2: clasificación de errores 5xx/timeout como UNCERTAIN (jamás reenvío a ciegas),
  eventId determinista CRM→WHATSPOWER con ventana de 5 min, rate limiting DURABLE en BD,
  fail-closed de secretos (webhook secret jamás como Bearer, secreto legado desactivado con
  claves por-org presentes), transacciones para org+user y para conexiones, dedup de webhooks
  Meta por waMessageId, cifrado AES-256-GCM + lookup por hash de secretos Telegram.
- Frontend (CRM): export con JWT en header (nunca en URL), deep-link Settings?tab, reset de
  formulario, TabsList con wrap, JSON.parse blindado.

### Ciclo 2 — reauditoría goldfish: hallazgos y resolución
| Sev | Hallazgo | Resolución |
| --- | --- | --- |
| CRITICA | CRM: useEffect del form de clientes sin deps (borraba cada tecla) | deps [open, editClient] — 569/569 |
| ALTA | CRM: backfill Telegram derivaba hash del ciphertext en estado parcial | hash SIEMPRE del valor en claro (descifra primero) |
| ALTA | ULTRA: sin busy_timeout (server+worker comparten db/) | PRAGMA busy_timeout=5000 en ambas aperturas |
| MEDIA | WP: sin WAL/busy_timeout | pragmas en createDatabase |
| MEDIA | WP: fail-open del limiter invisible | console.warn en el catch |
| MEDIA | WP: evento 'ya procesado sin resultado' si la ejecución falla tras el dedup | liberación de clave on-throw (reintento re-ejecuta) |
| MEDIA | CRM: statuses de Meta duplicados en reintentos | dedup por messageId también en statuses |
| MEDIA | CRM: migración de dedup irreversible | respaldo reversible Client_dedup_backup_20261111 |
| MEDIA | ULTRA: claim A4-10 ≠ código (columnas pesadas) | comentario sincronizado; proyección pendiente |
| BAJA | CRM: encryptSecret null silencioso; WP/ULTRA: limiter muertos, stacks en logs, tests dual-formato | resueltos |

### Residuales documentados (no bloqueantes, con riesgo conocido)
1. Prisma SQLite abre BEGIN DEFERRED: la re-verificación del límite de plan dentro de la
   transacción es best-effort; la cerradura definitiva contra duplicados es el UNIQUE
   (phoneNumberId) con P2002→409. Multi-instancia sobre PostgreSQL eliminaría la reserva.
2. ULTRA: API de campañas cambió contrato (201 + {campaigns:[...]}) — consumidor interno
   actualizado; terceros deben migrar (documentado en CHANGELOG).
3. WP A1-05: evento sin teléfono deduplicado 24 h — si el CRM corrige el dato debe emitir un
   eventId nuevo (comportamiento documentado).
4. CRM: 5 vulnerabilidades moderadas de dependencias (fix breaking programado).
5. Dedup check-then-act de webhooks conserva ventana TOCTOU microscópica ante POSTs
   simultáneos verdaderos (el índice parcial cierra la vía del daemon).

### Pruebas (verde al cierre)
- CRM (vitest): 569/569
- WHATSPOWER (node --test): 203/203
- ULTRA (node --test): 152/152
- TypeScript --noEmit: 0 errores en los 3 repos.
