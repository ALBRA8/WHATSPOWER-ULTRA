# parity/remate.md — Fase 5: Handoff (detalles que quedan y decisiones)

**Fecha:** 2026-11-15 · Verificación: 20/20 (parity/verificacion.md) · Pruebas: 196/196 · tsc limpio · scan de secretos limpio.

## 1. Lista corta y concreta de detalles restantes (con archivo:línea)

Ninguno bloquea el uso del dashboard. Cosmética y casos raros para la siguiente pasada:

| Detalle | Dónde | Qué falta exactamente |
|---|---|---|
| Transición del sidebar en móvil capturada a medias en `23-movil-contactos.png` | `src/studio/dashboard-html.ts` (media query ≤700px) | Es solo el timing de la captura (200 ms de transición); confirmado cerrado en `24-movil-chat.png`. Si se quiere, subir el wait tras `closeSidebar()` |
| Toast de error de chat podría truncarse en textos muy largos | `src/studio/dashboard-html.ts` (función `toast`, `max-width:340px`) | Añadir `word-break` y recorte a ~200 caracteres |
| Paginación del chat (hilo) | `src/dashboard/api.ts` (GET /api/conversations/:phone) | El hilo devuelve TODOS los mensajes; con miles, añadir `?limit&before` |
| Contador de páginas en contactos | `src/studio/dashboard-html.ts` (`viewContacts`) | Solo «Anterior/Siguiente + X de N»; falta salto directo a página |
| Filas kanban: búsqueda dentro del tablero | `src/studio/dashboard-html.ts` (`viewPipeline`) | Carga hasta 200 contactos (`?limit=200`); con más, paginar por columna |
| Icono de envío fallido en el hilo | `src/studio/dashboard-html.ts` (`renderThreadMessages`) | Hoy `✗` junto a la hora; podría enlazar al `error` real del mensaje (tooltip) |
| Métricas del Resumen no se auto-refrescan | `src/studio/dashboard-html.ts` (`viewSummary`) | Refresco manual al entrar; añadir polling 15 s si se desea «en vivo» |
| Export CSV limitado a 200 | `src/dashboard/api.ts` (GET /api/contacts/export.csv) | Ampliar a exportación completa paginada o streaming |
| Responsive del creador de campañas en pantallas <380 px | `src/studio/dashboard-html.ts` (`.two-col`) | Funciona en 390 px; por debajo, el CSV/preview puede requerir scroll horizontal |
| Documentar el webhook entrante en `docs/` | `docs/` (nuevo archivo propuesto: `WEBHOOK-MENSAJES.md`) | El contrato ya está pintado en la pantalla Integraciones; falta versión en docs con ejemplos curl |

## 2. Decisiones tomadas (y por qué)

1. **Alcance del «original»:** `whatson.mybusiness-up.es` es el sitio de marketing; el producto original es **software de escritorio Windows** (FAQ verificada en vivo). El inventario funcional se construyó con el encargo del propietario + FAQ real + fichas clean-room del repo (`parity/inventario-original.md §1`). Paridad «en uso», no visual — coherente con la sala limpia.
2. **El creador y el monitor de campañas NO se rediseñaron:** se reutilizaron tal cual (mismos IDs/funciones) dentro de la nueva pantalla Campañas; el studio legado sigue servido e intacto en `/studio`. El único cambio de comportamiento: `/` y `/campaigns` sirven ahora el dashboard completo (lo que pide el encargo) — ajustado en `tests/whatson-exhaustive.test.ts:137-150` con comentario.
3. **Todo aditivo:** 9 tablas nuevas (`IF NOT EXISTS`), ~25 endpoints nuevos y 2 páginas nuevas; cero renombres/movimientos del motor de broadcast. Los 174 tests previos quedaron intactos y verdes (solo se tocó la aserción de la ruta `/` del test WO-06, cambio documentado).
4. **Secretos jamás en la BD ni en la UI:** la configuración de transporte guarda solo máscara de últimos 4 (`src/dashboard/store.ts`, `updateTransport`); la prueba de Meta Cloud usa el token SOLO en memoria en esa petición.
5. **Envío de chat con fail-closed real:** supresión (local+2A) → lock 2A → dispatcher; suprimido/lock → 409 con el motivo exacto en el toast (`src/dashboard/api.ts`, bloque «messages»).
6. **Idempotencia del kanban:** `POST /api/pipeline/move` exige `eventId` y usa `event_idempotency` (patrón Oleada 2 del CRM); repetir el evento es un no-op devuelto como `duplicate:true`.
7. **Org por identidad:** identidades ligadas nunca ven otras orgs (probado en DP-22); identidad de servicio selecciona org con `?orgId` (documentado en `src/dashboard/api.ts`, `orgOf`).
8. **Etapa por defecto:** todo contacto nuevo nace en la primera etapa para que el embudo nunca aparezca vacío con datos reales.
9. **Onboarding sin bloqueo:** se puede saltar; guarda transporte probado de verdad y no vuelve a aparecer (`org_settings.onboarding_completed_at`).

## 3. Qué NO pude comprobar (límites honestos)

- **La app privada del original WhatsOn** (dashboard real de escritorio): no es accesible por web; la paridad se ancló al encargo + FAQ. Si el propietario aporta capturas del original, ajustar textos/iconos exactos en una pasada siguiente.
- **Despacho por Meta Cloud real** (Graph API): la prueba de integración valida token contra Graph, pero no se enviaron mensajes reales de Meta (requiere número/token de producción y autorización `ALLOW_REAL_DISPATCH` del propietario).
- **Lock/supresión 2A en vivo** (Capa 2 desplegada): verificado con el circuito local (`WHATSPOWER_ENABLED=false` + stubs con contrato real); el comportamiento con la 2A real se rige por el mismo código Composite ya probado por la suite existente.
- **Multi-dispositivo/sesiones simultáneas** del dashboard: probado un solo navegador por org; la sesión es stateless HMAC por clave, pero no se probó rotación de clave en caliente con usuarios dentro.
- **Volumen:** contactos hasta 200 en kanban y 500 en campañas (límites de paginación existentes); no se hicieron pruebas de carga.
