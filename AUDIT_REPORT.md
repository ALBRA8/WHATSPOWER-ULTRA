# AUDIT_REPORT — WHATSPOWER-ULTRA

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
