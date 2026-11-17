# MATRIZ DE PRODUCCIÓN REAL — WHATSPOWER-ULTRA (2026-11-17)

**Rama:** `repair/produccion-real` · **Método:** cada casilla con evidencia EJECUTADA en esta sesión.

## Veredicto final transparente (sesión reparación 2026-11-17)

| Área | Veredicto | Evidencia |
|---|---|---|
| Consentimiento Ley 1581 en worker | ✅ CERRADO | `ConsentStore` obligatorio fail-closed; JIT incondicional; bajas revocan — 269/269 |
| Login demo / rate limit | ✅ CERRADO | 403 en producción; intentos acumulativos; IP por socket salvo TRUST_PROXY |
| Pacing anti-baneo | ✅ CERRADO | WORKER_DISABLE_PACING prohibido en producción (exit 1, proceso hijo real) |
| Rastreo de clics anónimo | ✅ CERRADO | IP hasheada sha256(ip:salt)[:16], TRUST_PROXY estricto — suite dedicada |
| Circuito de bajas (normalización) | ✅ CERRADO | Teléfono normalizado en supresión (baja +57… ≡ contacto 573…) |
| Flujo cruzado CRM→ULTRA | ✅ VERIFICADO | 7/7 en `tests/e2e-cross-flow.test.ts` (sin envío real; salvaguarda física probada) |
| Node 22 / runtime | ✅ ALINEADO | engines >=22.12.0 + .nvmrc 22.14 en los 3 repos; decisión documentada |
| Respaldo/restauración BD | ✅ OPERATIVO | backup-db.ts + restore-db.ts probados con datos ficticios |
| Aviso canal no oficial | ✅ DOCUMENTADO | README + UI de transporte |
| Docker compose | ⛔ PENDIENTE (dueño) | Sin docker en el entorno; Dockerfile/compose revisados estáticamente |
| Canal Meta Cloud oficial | ⛔ PENDIENTE (dueño) | Requiere cuenta Meta Business verificada + número + plantillas |
| Rotación multi-cuenta automática | ⛔ NO IMPLEMENTADA | Sin código; declarado honestamente en la matriz de paridad |
| Despacho real (WhatsApp) | 🟦 BLINDADO | `ALLOW_REAL_DISPATCH=false` por defecto: jamás envío real sin orden expresa |

**Veredicto de la sesión: reparación de producción COMPLETA en código y pruebas; los pendientes requieren exclusivamente acción del dueño (credenciales, Meta, docker, SIM de calentamiento).**

---

# MATRIZ DE PRODUCCIÓN REAL — WHATSPOWER-ULTRA (histórico 2026-11-15) (2026-11-15)

**Rama:** `repair/produccion-real` · **Método:** evidencia EJECUTADA por casilla.

## A. Construcción y calidad

| Casilla | Estado | Evidencia ejecutada |
|---|---|---|
| TypeScript `tsc --noEmit` | ✅ LISTO | exit 0 |
| Suite completa | ✅ LISTO | **194/194** en 36 suites (runner multiplataforma) |
| `npm audit` | ✅ LISTO | 0 vulnerabilidades |
| Node alineado | ✅ LISTO | engines `>=22.12.0`, `.nvmrc` 22.14, Dockerfile node:22-alpine, CI node 22 |
| Healthcheck + métricas | ✅ LISTO | `/api/health` 200 con cola (pending/inFlight), envíos sent/failed/uncertain, memoria |
| Benchmark SQLite | ✅ LISTO (sesión previa) | 70,914 inserts/s batch; 2,541 claims/s en WAL — cubre demanda; criterio de migración a Postgres documentado |
| Worker persistente | ✅ LISTO | bucle 5s con parada graciosa SIGTERM verificada en el E2E; leases con renovación (H8) |
| Docker compose | ⛔ NO EJECUTADO | Sin docker en el entorno de trabajo (OWNER_TODO §4) |

## B. Canal oficial (FASE 1)

| Casilla | Estado | Evidencia ejecutada |
|---|---|---|
| Meta Cloud API por organización | ✅ LISTO (código+pruebas) | `tests/fase1-meta-official-channel.test.ts` + `tests/wave2-org-meta-cloud.test.ts` |
| Ventana 24h + plantillas | ✅ LISTO | `messaging-window.ts` + `template-registry.ts` (suites en verde) |
| Errores Meta sin reintentos ciegos | ✅ LISTO | `meta-error-classifier.ts`: límites/quality/permanentes vs UNCERTAIN |
| Cuenta Meta real / plantillas aprobadas | ⛔ REQUIERE DUEÑO | OWNER_TODO §2 |

## C. Consentimiento y Ley 1581 (FASE 2)

| Casilla | Estado | Evidencia ejecutada |
|---|---|---|
| JIT guard de consentimiento en despacho | ✅ LISTO | E2E real: sin consentimiento → `SKIPPED_NO_CONSENT` (<50 ms pre-despacho) |
| Registro/revocación auditada | ✅ LISTO | `consent_records` + `consent_audit_log`; bajas revocan (pruebas fase2) |
| CSV exige origen del consentimiento | ✅ LISTO | importador con `consent_origin` obligatorio (pruebas + UI studio) |
| Bajas / opt-out por organización | ✅ LISTO | política por org con complemento global restringido (docs/POLITICA-SUPRESION.md) |
| Clics sin IP cruda (TRUST_PROXY) | ✅ LISTO | hash SHA-256-16 con sal por env (pruebas fase2) |
| Exportación/borrado por contacto | ✅ LISTO | `/api/compliance/contact-data` GET/DELETE |

## D. Motor de difusión (fiabilidad)

| Casilla | Estado | Evidencia ejecutada |
|---|---|---|
| Claim atómico + ownership | ✅ LISTO | `queue-claim`, `null-org-quarantine` en 194/194; H8 lease renewal |
| Pacing durable + cooldown | ✅ LISTO | F9/F10 (jitter 15-35s, cooldown con vencimiento y respeto de pausas) |
| Ventana horaria anti-ban | ✅ LISTO | off-hours → `PAUSED_OFF_HOURS` (hallazgo 10); ahora ajustable por env |
| Salvaguarda ALLOW_REAL_DISPATCH | ✅ LISTO | doble gate (flag+env) verificada en E2E: SENT=0 |
| Reconciliación UNCERTAIN | ✅ LISTO | jamás re-enfocado automáticamente (contract-v11 en verde) |

## E. Integración (FASE 5)

| Casilla | Estado | Evidencia ejecutada |
|---|---|---|
| Locks/supresión 2B→2A | ✅ LISTO | E2E real: `LOCK_EXCLUDED` vía credencial por organización |
| Ingesta de leads org-bound | ✅ LISTO | R6b (webhook org A jamás añade a campaña de org B) |
| Pacing real en E2E | ✅ LISTO | 3 contactos procesados por pasos con pacing ajustado por env |

## F. UI (navegador real)

| Casilla | Estado | Evidencia ejecutada |
|---|---|---|
| Campaign Studio + Historial | ✅ LISTO | 200; `logTbody` presente (Playwright) |
| Métricas en caliente | ✅ LISTO | mSent/mFailed/mSkipped/mTotal presentes |
| Vista móvil 390px | ✅ LISTO | overflow 0px |

## G. Seguridad

| Casilla | Estado | Evidencia ejecutada |
|---|---|---|
| Escáner árbol | ✅ LISTO | exit 0 |
| Escáner historial completo | ✅ LISTO | **0 hallazgos** (historial limpio) |
| Rate limits + HMAC v2 + fail-closed | ✅ LISTO | security-hardening + contract-v11 en 194/194 |

## H. Bloqueos para producción

1. Cuenta Meta Business + número oficial + plantillas aprobadas (OWNER_TODO §2).
2. Docker compose + `.env` reales en el PC (OWNER_TODO §4).
3. Rotación del PAT (OWNER_TODO §1).
4. Merge autorizado de `repair/produccion-real` → `main`.
