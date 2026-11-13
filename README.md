# WHATSPOWER ULTRA (Nivel 3 ALBRA) — Suite de Difusión Masiva y Escudo Anti-Ban

> **Paridad 100% WhatsOn, WATI y SleekFlow para el Ecosistema CRM ALBRA**  
> Diseñado bajo metodología Clean-Room / ClonaKit. Funciona como un "enchufe" ("anillo al dedo"): opera de manera 100% autónoma junto a **CRM-ALBRA (Nivel 1)** sin requerir obligatoriamente el Nivel 2, o se integra con **WHATSPOWER (Nivel 2)** para respetar los locks de atención humana y flujos conversacionales.

---

## 🚀 Capacidades Principales (WhatsOn & WATI 100% Parity)

1. **Campaign Studio UI (`/campaigns`)**:
   - Panel web interactivo para redactar plantillas con previsualizador Spintax en vivo.
   - Ingesta y validación de archivos CSV con de-duplicación automática y normalización internacional (+57 Colombia).
   - Selector visual de cadencia Anti-Ban (Humano, Conservador, Agresivo).
   - Monitor de progreso en tiempo real con barra de porcentaje, desglose de estados (*Enviados, Omitidos, Suprimidos*) y controles de pausa/reanudación/cancelación.
2. **Motor Spintax Recursivo y Determinista**:
   - Sintaxis anidada `{Hola|Buen día {amigo|estimado}}` que genera infinitas variaciones únicas por mensaje.
   - Semilla determinista criptográfica (`seed = campaignId_phone`) para garantizar trazabilidad e idempotencia.
   - Inyección de variables dinámicas (`{{nombre}}`, `{{empresa}}`, etc.).
3. **Escudo Anti-Ban de 5 Capas**:
   - **Throttler con Jitter**: Espaciado aleatorio entre mensajes (ej. 15-35s) imitando comportamiento humano real.
   - **Enfriamiento por Lotes (Batch Cooldown)**: Pausa obligatoria tras cada ráfaga de 25 mensajes.
   - **Ventana de Horario Comercial**: Bloquea y suspende envíos fuera del horario permitido (08:00 - 20:00).
   - **Control de Fatiga**: Impide bombardear al mismo prospecto si ya recibió una difusión en los últimos 7 días.
   - **Pre-dispatch JIT (<50ms)**: Comprobación de última milésima de segundo para cancelar envíos si el cliente abrió un chat o solicitó baja.
4. **Acortador y Rastreador de Enlaces (`/t/:code`)**:
   - Generación de enlaces cortos para registrar clics únicos y métricas de atribución antes de redirigir al destino final.
5. **Recuperación Ante Caídas (Crash Recovery)**:
   - Persistencia SQLite transaccional. Si el servidor se apaga a mitad de un lote, al arrancar restablece los ítems transitorios sin provocar dobles envíos ni pérdidas de estado.

---

## 🔌 Conectividad Modular "Plug & Play" (Anillo al Dedo)

`WHATSPOWER ULTRA` soporta dos modalidades de conexión:

### Modalidad A: Suite Completa (Nivel 1 + Nivel 2 + Nivel 3)
- Con `WHATSPOWER_ENABLED=true` (por defecto):
- WhatsPower Ultra consulta Just-In-Time los locks de conversación a `http://localhost:3003/api/internal/locks/:phone`. Si un cliente está en medio de un flujo o hablando con un humano en WhatsPower Nivel 2, el mensaje masivo se omite (*LOCK_EXCLUDED*) de inmediato para no arruinar la experiencia.

### Modalidad B: Standalone Directo con CRM (Nivel 1 + Nivel 3, sin Nivel 2)
- Con `WHATSPOWER_ENABLED=false`:
- WhatsPower Ultra activa el `StandaloneLockChecker` y la supresión local autónoma.
- Se conecta **directamente** al Daemon de WhatsApp del CRM-ALBRA (puerto 3002) sin intentar conectar al puerto 3003 ni fallar por timeout.

---

## 🛠️ Instalación y Puesta en Marcha

### 1. Requisitos
- Node.js 22+ (con soporte nativo para TypeScript y SQLite).
- CRM-ALBRA ejecutándose en los puertos 3000 y 3002.

### 2. Configuración (`.env`)
Copiar `.env.example` a `.env`:
```bash
cp .env.example .env
```
Variables clave:
```ini
PORT=3004
WHATSAPP_DAEMON_URL=http://localhost:3002
INTERNAL_API_SECRET=<secreto-compartido-minimo-24-caracteres>  # generar valor propio; nunca reutilizar valores publicados
AGENTIC_2A_URL=http://localhost:3003
WHATSPOWER_ENABLED=true    # true para Suite Completa, false para Standalone con solo CRM
WHATSPOWER_ORG_CREDENTIALS=<orgId>:<credencial-de-servicio>
ALLOW_REAL_DISPATCH=false  # Salvaguarda física: false para simulación, true solo en producción autorizada
```

**Credencial de WHATSPOWER:** `WHATSPOWER_ORG_CREDENTIALS` debe contener los mismos pares `orgId:credencial` que `ORG_SERVICE_CREDENTIALS` en WHATSPOWER. Genera una credencial aleatoria independiente por organización; no reutilices `INTERNAL_API_SECRET` ni `CRM_INTERNAL_CREDENTIALS`. Sin credencial coincidente, la consulta JIT de locks falla de forma segura y Ultra no despacha. Mantén `ALLOW_REAL_DISPATCH=false` durante las pruebas.

### 3. Ejecutar el Servidor y Campaign Studio
```bash
npm start
```
Abrir en el navegador:
👉 **`http://localhost:3004/campaigns`**

### 4. Pruebas Automatizadas
```bash
npm test
```
Ejecuta la suite de pruebas unitarias, de paridad WhatsOn, contratos y modularidad plug-and-play.

`npm run test:e2e` actualmente invoca el mismo ejecutor de pruebas que `npm test`; no equivale por sí solo a una prueba E2E contra servicios vivos.

Para probar la conexión real Ultra → WHATSPOWER (puerto 3003), configura una organización de laboratorio dedicada: añade `org_smoke_ultra:<credencial-aleatoria>` tanto a `ORG_SERVICE_CREDENTIALS` de WHATSPOWER como a `WHATSPOWER_ORG_CREDENTIALS` de Ultra. No uses credenciales de producción. Mantén `ALLOW_REAL_DISPATCH=false` en ambos servicios.

Smoke contra servicios vivos (requiere WHATSPOWER :3003 y Ultra :3004 en marcha; audiencia ficticia y limpieza de la campaña creada por la prueba):
```bash
node scripts/smoke-live.mjs
```
