# Ficha: WhatsPower-Ultra Campaign Studio (Nivel 3)

> Inspirada en: WhatsOn, WATI, SleekFlow y Kommo (solo como referencia funcional; no se copia código ni interfaz)  
> Metodología: ClonaKit · Sala Limpia  
> Proyecto: ALBRA8 / WHATSPOWER-ULTRA (Nivel 3)  
> Fecha: 26 de Octubre de 2026  

Esta ficha es la especificación funcional completa de la suite de **Difusión Masiva, Spintax, Anti-Ban y Chat Marketing** de WhatsPower-Ultra antes de su empaquetado final.

---

## 1. En una frase

Una consola web de difusión masiva para WhatsApp con protección anti-ban inteligente (Spintax recursivo, pausas humanas aleatorias y enfriamiento por lotes) que permite lanzar campañas masivas a listas externas y audiencias de **CRM-ALBRA**, midiendo clics y canalizando automáticamente las respuestas hacia los flujos conversacionales de **WhatsPower (Nivel 2)** y el pipeline de ventas de **CRM-ALBRA (Nivel 1)**.

---

## 2. Para quién y para qué

Para agencias, directores comerciales y negocios que necesitan escalar sus ventas por WhatsApp realizando difusiones masivas y reactivaciones de bases de datos frías sin pagar costes por mensaje a plataformas externas, protegiendo su línea de teléfono contra bloqueos de Meta y asegurando que cada contacto que responda sea atendido de inmediato por un bot calificador y un vendedor.

---

## 3. Funciones de la primera versión (MVP)

| # | Función | Qué hace, con tus palabras | Cómo se hará en la app |
|---|---|---|---|
| **1** | **Importador Inteligente de Audiencias** | Carga archivos CSV con listas de contactos, limpia y normaliza prefijos telefónicos (+57, +34, etc.) y descarta números duplicados. | Módulo `csv-importer.ts` con validación regex E.164 y deduplicación en memoria/disco. |
| **2** | **Motor Spintax Recursivo con Previsualizador** | Permite redactar mensajes con variaciones sintácticas `{Hola|Buen día|Saludos}` y ver en pantalla 5 ejemplos generados al instante. | Parser algorítmico `spintax.ts` con recursión de llaves anidadas y preview en la interfaz. |
| **3** | **Escudo Anti-Ban & Rate Throttler** | Controla el ritmo de despacho con intervalos aleatorios humanos (18 a 45 segundos) y pausas de enfriamiento obligatorias (ej. 10 min de reposo cada 25 envíos). | Temporizador dinámico `throttler.ts` con pausas programadas y tokens de descanso. |
| **4** | **Monitor de Despacho en Vivo (Live Dispatcher)** | Muestra una barra de progreso en tiempo real con contadores (Enviados, Pendientes, Fallidos) y botones de **Pausar**, **Reanudar** y **Cancelar**. | Worker en segundo plano `broadcast-worker.ts` con persistencia en `broadcast.db` y eventos por SSE/polling. |
| **5** | **JIT Lock & Suppression Shield** | Antes de disparar cada mensaje, verifica si el contacto está en diálogo activo en WhatsPower (Nivel 2) o en la lista de bajas (`BAJA`/`STOP`), cancelando el envío si corresponde. | Consulta Just-In-Time (`lock-checker.ts` y `suppression.ts`) contra el puerto 3003. |
| **6** | **Enlaces Rastreados y Conteo de Clics** | Acorta enlaces dentro del mensaje de difusión y contabiliza cuántos contactos hicieron clic para medir el interés real. | Endpoint de redirección `/t/:code` que suma clics y redirige al destino final. |

---

## 4. Pantallas

### 4.1 Pantalla Principal: Consola de Campañas (`/campaigns`)
- **Zona Superior:** Métricas acumuladas: Campañas activas, Total enviados, Tasa de entrega promedio, Total clics generados.
- **Formulario de Creación de Campaña:**
  - Nombre de la campaña.
  - Selector de origen de audiencia: [Cargar archivo CSV] o [Filtrar audiencia de CRM-ALBRA].
  - Caja de texto del mensaje con soporte de variables (`{{nombre}}`, `{{empresa}}`) y botón para insertar bloques de Spintax `{A|B}`.
  - Caja de previsualización en vivo: botón "Ver otra variación" que genera al instante un ejemplo diferente.
  - Parámetros de velocidad: Modo Seguro (pausas 25s - 50s), Modo Equilibrado (15s - 30s) y tamaño de lote para enfriamiento.
  - Botón "Iniciar Campaña".

### 4.2 Pantalla de Monitoreo: Monitor de Despacho en Vivo (`/campaigns/:id/live`)
- Barra de progreso porcentual con animación en vivo.
- Contadores numéricos: Total destinatarios | Enviados exitosos | Pendientes | Errores | Omitidos por Lock activo.
- Botones de acción inmediata: ⏸️ Pausar Campaña | ▶️ Reanudar | ⏹️ Cancelar Campaña.
- Registro visual en caliente (Live Log) mostrando cada mensaje enviado y su latencia.

---

## 5. Flujos Paso a Paso

### Flujo 1: Despacho de Campaña Masiva con Protección Anti-Ban
1. El usuario sube un archivo `clientes_octubre.csv` con 100 teléfonos.
2. El importador normaliza los números y reporta 98 válidos y 2 duplicados descartados.
3. El usuario escribe la plantilla:  
   `{¡Hola|Buenas tardes} {{nombre}}! {Tenemos una novedad para ti|Queremos compartirte una oportunidad}: mira nuestro catálogo aquí: {{link}}`
4. Pulsa "Iniciar Campaña":
   - El worker encola los 98 mensajes en `broadcast.db`.
   - Contacto 1: Comprueba lock en WhatsPower (Libre) -> Genera spintax -> Envía vía Baileys -> Espera 22 segundos.
   - Contacto 2: Comprueba lock (Ocupado: el cliente está hablando con un vendedor) -> Omite el envío para no causar spam.
   - Al llegar al mensaje 25: El motor entra en modo "Enfriamiento" y descansa 8 minutos antes de continuar.
5. El cliente responde: WhatsPower (Nivel 2) detecta la respuesta entrante, bloquea futuros broadcasts a ese número y arranca el flujo calificador ManyChat.

---

## 6. Modelo de Datos y Persistencia

- Base de datos local privada SQLite en `db/broadcast.db`:
  - `campaigns`: `{ id, name, status, template_spintax, total_recipients, sent_count, failed_count, created_at }`
  - `broadcast_queue`: `{ id, campaign_id, phone, name, rendered_message, status, attempts, error, sent_at }`
  - `tracked_links`: `{ code, target_url, campaign_id, click_count, created_at }`
  - `suppression_list`: `{ phone, reason, created_at }`
- **Aislamiento Total:**
  - WhatsPower-Ultra **no toca** `db/custom.db` de CRM-ALBRA. Se comunica con Baileys por HTTP (`http://localhost:3002/send`) y con WhatsPower por HTTP (`http://localhost:3003`).

---

## 7. Para más adelante (Fuera de esta versión)

- Rotación automatizada de 5 chips físicos de WhatsApp con balanceo de carga.
- Verificación HLR previa para saber si el número tiene WhatsApp antes de enviar.

---

## 8. Identidad Propia

- **Nombre:** WhatsPower-Ultra Campaign Studio
- **Estilo Visual:** Interfaz de centro de mando oscuro (`slate-950`), barras de progreso con gradiente esmeralda (`#10b981`), contadores de latencia en milisegundos y consola de logs en monospace.
- **Idioma:** Español neutro.

---

## 9. Checklist de Sala Limpia ClonaKit

- [x] Funciones descritas con lenguaje propio; sin textos copiados de WhatsOn ni WATI.
- [x] Sin librerías propietarias ni código de terceros bajo copyright.
- [x] Construido en TypeScript puro (Node 22) sobre SQLite local y Baileys.
- [x] Respeta estrictamente los contratos del ecosistema ALBRA.
