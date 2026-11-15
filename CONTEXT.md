# ALBRA — CONTEXTO DE INTEGRACIÓN Y PILOTOS
## Capa 1 (CRM) × Capa 2A (Agentic) × Capa 2B (Broadcast)

---

### 1. Estado de Hitos Completados en Entorno Controlado

#### Hito 2A — Piloto Supervisado Inbound
- **Fecha:** 2026-10-24 08:25:16
- **Cliente:** `573000000001` ➔ **WhatsApp Negocio:** `573000000002`
- **Mensaje:** `PRECIO`
- **Resultado:** Respuesta catalogada determinista de planes, despacho exclusivo vía CRM/daemon, latencia 321 ms.
- **Reversión:** `AGENTIC_2A_ENABLED=false` restaurado.

#### Hito 2B — Piloto Supervisado Outbound (Broadcast)
- **Fecha:** 2026-10-24 10:06:10
- **WhatsApp Negocio (Emisor):** `573000000002` ➔ **Cliente (Receptor):** `573000000001`
- **Mensaje de Prueba:** Mensaje piloto supervisado con spintax.
- **Validaciones Previas:**
  - JIT Lock Check (2A): LIBRE (`available: true`)
  - JIT Suppression Check (2A): NO SUPRIMIDO (`suppressed: false`)
- **Despacho:** `POST http://localhost:3002/send` ➔ `200 OK`
- **ID Transaccional:** `wa_msg_mock_001`
- **Persistencia en CRM (`custom.db`):** `WhatsAppMessage` (direction: `outbound`)
- **Estado Final:** `SENT`
- **Reversión:** `ALLOW_REAL_DISPATCH=false` restaurado inmediatamente.

---

### 2. Hito Completado: Validación de Respuesta Entrante (Observabilidad Pasiva)

- **Fecha:** 2026-10-24 10:25:14
- **Emisor (Cliente de Prueba):** `573000000001` (Contacto Piloto)
- **Receptor (Negocio):** `573000000002`
- **Texto del Mensaje Recibido:** `Hola`
- **ID Transaccional:** `wa_msg_mock_002`
- **Registro en CRM:**
  - `WhatsAppMessage` (direction: `inbound`, text: `Hola`)
  - `Client` (actualización de `lastContactAt`)
  - `WhatsAppConversation` (actualización de `updatedAt`)
- **Salvaguarda de Auto-Respuesta Verificada:**
  - Al estar `isAutoReply=0`, el daemon **no disparó ninguna auto-respuesta**. Cero mensajes no supervisados salientes.
- **Resultado del Hito:** Ciclo completo bidireccional validado con éxito con observabilidad completa y cero fugas de tráfico.
