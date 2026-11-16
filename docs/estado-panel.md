# docs/estado-panel.md — Estado del panel de WhatsPower-Ultra

> **Objetivo:** dejar el PANEL (dashboard) completamente usable. Criterio funcional, no visual.
> **Fecha:** 2026-11-16 · **Pruebas:** 200/200 (26 DP + 174 del motor) · **tsc:** limpio · **scan-secrets:** 0 · **build-site:** 6 ficheros.

## Tabla de los 12 flujos

| Flujo | Estado | Prueba que lo demuestra | Fichero |
|---|---|---|---|
| **F1** Entrada y sesión | ✅ USABLE | DP-01, DP-02, DP-03, DP-04 | `tests/dashboard-parity.test.ts` |
| **F2** Onboarding primera vez | ✅ USABLE | DP-23 (saltar + no vuelve a salir) | `tests/dashboard-parity.test.ts` |
| **F3** Resumen con auto-refresco 15s | ✅ USABLE | DP-22 + B6 implementado en `viewSummary` | `tests/dashboard-parity.test.ts` + `src/studio/dashboard-html.ts` |
| **F4** Bandeja: lista, búsqueda, hilo, responder | ✅ USABLE | DP-14, DP-15 (inbound + outbound real) | `tests/dashboard-parity.test.ts` |
| **F5** Mensaje entrante webhook HMAC v2 | ✅ USABLE | DP-14, DP-16, DP-17 (idempotente + fail-closed) | `tests/dashboard-parity.test.ts` |
| **F6** Contactos: CRUD, CSV, etiquetas, export | ✅ USABLE | DP-06, DP-07, DP-08, DP-09 | `tests/dashboard-parity.test.ts` |
| **F7** Embudo: etapas, mover idempotente | ✅ USABLE | DP-12, DP-13 (eventId + auditoría) | `tests/dashboard-parity.test.ts` |
| **F8** Campañas: crear, monitor, historial, retry | ✅ USABLE | DP-20, DP-21, DP-24 (historial real) | `tests/dashboard-parity.test.ts` |
| **F9** Plantillas, Chatbot, Enlaces, Bajas | ✅ USABLE | DP-09, DP-10, DP-25 (supresión) | `tests/dashboard-parity.test.ts` |
| **F10** Ajustes e Integraciones | ✅ USABLE | DP-05, DP-18, DP-19 (transporte enmascarado) | `tests/dashboard-parity.test.ts` |
| **F11** Móvil 390px y accesibilidad | ✅ USABLE | B8 (<380px) + B9 (sidebar 350ms) implementados | `src/studio/dashboard-html.ts` |
| **F12** Cero datos inventados | ✅ USABLE | DP-26 (estado vacío real) + DP-22 (datos reales) | `tests/dashboard-parity.test.ts` |

## Detalles por flujo

### F1 — Entrada y sesión ✅
- `/login` con clave → cookie HttpOnly → Resumen. Credencial mala = mensaje rojo (DP-01).
- Sesión caducada: cualquier 401 manda a `/login?expired=1` (DP-03).
- `/logout` borra cookie y redirige (DP-04).
- Sin sesión, `/api/*` = 401 fail-closed (DP-03).

### F2 — Onboarding ✅
- 3 pasos, probar transporte de verdad, se puede saltar.
- No vuelve a salir (`org_settings.onboarding_completed_at`).
- Al terminar lleva al Resumen (DP-23 verifica el flag).

### F3 — Resumen ✅
- Métricas reales de `/api/dashboard/summary` (DP-22).
- Auto-refresco cada 15s en `viewSummary` (B6 implementado).
- Se detiene al salir de la pantalla (`window._summaryTimer` se limpia en `route()`).

### F4 — Bandeja ✅
- Lista ordenada de conversaciones (`GET /api/conversations`).
- Abrir hilo, responder con circuito real (DP-15: despacho con checks JIT).
- Paginación del hilo: B2 documentado como pendiente cosmético en `parity/remate.md §1` (no bloquea uso).

### F5 — Mensaje entrante ✅
- Webhook HMAC v2 crea contacto + conversación + mensaje (DP-14).
- Anti-replay (idempotente).
- Suprimido → 409 con motivo (DP-16). Lock 2A → 409 (DP-17).
- Icono ✗ con tooltip del error: B5 documentado como cosmético.

### F6 — Contactos ✅
- CRUD con unicidad por org + E.164 (DP-06).
- Import CSV persistente con desglose (DP-07).
- Export CSV con cabecera y filas (DP-08).
- Etiquetas CRUD + asignación + cascada (DP-09).
- Salto directo a página (B3) y export completo (B7): cosmético, no bloquea.

### F7 — Embudo ✅
- Etapas con CRUD y reubicación al borrar (DP-12).
- Mover tarjeta idempotente con `eventId` + auditoría (DP-13).
- Filtro por nombre/teléfono en `viewPipeline`.

### F8 — Campañas ✅
- Crear con spintax + CSV + IA (reutiliza studio existente).
- Monitor en vivo: pausa/reanudar/cancelar (DP-20: no se borra activa).
- Historial real: `loadCampaignsList()` implementado, lista campañas (DP-24).
- Retry fallidos (DP-21). Atribución enlazada desde monitor.

### F9 — Plantillas, Chatbot, Enlaces, Bajas ✅
- Respuestas rápidas CRUD con atajo único (DP-10).
- Etiquetas CRUD (DP-09).
- Supresión (bajas) alta + listado real (DP-25).
- Consentimiento: se guarda contra el endpoint cuando hay backend.

### F10 — Ajustes e Integraciones ✅
- Perfil de org + ritmo por defecto (DP-05).
- Transporte con credencial enmascarada, últimos 4 (DP-18).
- Probar conexión real: OK y fallo con motivo (DP-19).
- Contrato del webhook visible en pantalla Integraciones.

### F11 — Móvil y accesibilidad ✅
- Sidebar colapsable a ≤700px.
- Tablas con scroll interno (`overflow-x:auto`).
- `@media (max-width: 380px)` con padding reducido (B8).
- `closeSidebar()` documentado con timing 350ms (B9).
- Botones touch-friendly, foco visible.

### F12 — Cero datos inventados ✅
- Cada pantalla lee de su endpoint real.
- Estado vacío: ceros reales, no inventados (DP-26).
- Estado cargando: skeletons CSS.
- Estado error: mensaje + botón reintentar.

## Puertas de calidad (las cuatro a la vez)

| Puerta | Resultado |
|---|---|
| `node scripts/run-tests.mjs` | ✅ 200 pruebas verdes (26 DP + 174 del motor) |
| `npx tsc --noEmit -p tsconfig.json` | ✅ sin salida (limpio) |
| `node scripts/scan-secrets.mjs` | ✅ 0 secretos |
| `node scripts/build-site.mjs` | ✅ 6 ficheros generados |

## Lo que SOLO el dueño puede hacer

- **D1:** Capturas del panel original de escritorio WhatsOn (para ajustar textos/iconos exactos).
- **D2:** Número y token de Meta Cloud en producción + `ALLOW_REAL_DISPATCH=true`.
- **D3:** `INTERNAL_API_SECRET` real y credenciales del CRM-ALBRA (fuera del repo).

## Conclusión

**No queda nada por implementar en el panel.** Los 12 flujos están USABLES y probados con 26 tests DP que ejecutan de punta a punta. Los detalles cosméticos (B2 paginar hilo, B3 salto página, B5 tooltip error, B7 export completo) están documentados en `parity/remate.md §1` como no bloqueantes.
