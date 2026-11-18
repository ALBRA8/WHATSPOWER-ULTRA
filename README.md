# WHATSPOWER ULTRA (Nivel 3 ALBRA) — Suite de Difusión Masiva y Escudo Anti-Ban

> **Suite de Difusión Masiva y Escudo Anti-Ban para el Ecosistema CRM ALBRA**  
> Diseñado bajo metodología Clean-Room / ClonaKit. Funciona como un "enchufe" ("anillo al dedo"): opera de manera 100% autónoma junto a **CRM-ALBRA (Nivel 1)** sin requerir obligatoriamente el Nivel 2, o se integra con **WHATSPOWER (Nivel 2)** para respetar los locks de atención humana y flujos conversacionales.

> ⚠️ **Aviso Importante — Canal no oficial de WhatsApp**: el transporte Baileys (daemon de WhatsApp del CRM) es un canal **no oficial** basado en emulación de WhatsApp Web. Su uso conlleva **riesgo inherente de bloqueo o suspensión del número por parte de Meta**. Se recomienda **calentar líneas** (envíos graduales con el pacing del worker) y usar **números secundarios**, nunca el número principal del negocio. Para producción comercial, usa el transporte oficial **Meta WhatsApp Cloud API**.

---

## 🚀 Capacidades Principales de Difusión Masiva y Protección Anti-Ban

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
ALLOW_REAL_DISPATCH=false  # Salvaguarda física: false para simulación, true solo en producción autorizada
```

### 3. Ejecutar el Servidor y Campaign Studio
```bash
npm start
```
Abrir en el navegador:
- 👉 **`http://localhost:3004/`** — Dashboard de paridad completo (login, resumen, chat, contactos, embudo, campañas, etiquetas, agentes, integraciones, ajustes). Requiere sesión. **Es el único panel.**
- 👉 **`http://localhost:3004/login`** — Pantalla de acceso.
- 👉 **`http://localhost:3004/studio`** — Campaign Studio legado (intacto).
- 👉 **`http://localhost:3004/sitio/`** — Sitio público de referencia (inicio, planes, FAQ, alianza IA, demo).

Las direcciones antiguas `/app/` y `/panel` ya no abren una segunda aplicación: redirigen a `/`. El detalle está en `docs/sitio-y-panel.md`.

### 3.b. Acceso directo al ecosistema desde el CRM (SSO de un solo uso)
El botón **Ecosistema** del CRM (capa 1) abre este dashboard con sesión de operador, sin repetir
credenciales: el CRM emite un enlace firmado de UN SOLO USO (`ECOSYSTEM_SSO_SECRET` compartido,
HMAC-SHA256, TTL 90 s) que se canjea en `GET /studio/login-ecosystem` (302 a `/` con cookie
HttpOnly). Es un SSO consciente del dueño: funciona en producción SOLO con el secreto configurado
(fail-closed: 404 sin él); el login-demo ANÓNIMO conserva su bloqueo total en producción.
Pruebas: `tests/ecosystem-login.test.ts`.

### 3.c. Pantalla de acceso real en /studio y errores SSO explicados (2026-11-17)
El Campaign Studio (`/studio`) ya NO usa `window.prompt` bloqueante (antes dejaba el body
vacío al cancelar): muestra una PANTALLA DE ACCESO con el secreto clásico, el botón de modo
demo (si `DEMO_MODE=true` y fuera de producción) y el enlace "Volver al CRM" (`CRM_BASE_URL`).
Un fallo del canje SSO (403/404/429) responde una página HTML con el motivo (caducado /
ya usado / no configurado) y el enlace para reintentar desde el CRM. El login-demo anónimo
del dashboard conserva su bloqueo total en producción. Pruebas: `tests/ecosystem-login.test.ts`
(cadena canje → cookie → `GET /api/campaigns` 200 incluida).

### 3.b. Modo claro/oscuro
El dashboard tiene un toggle de tema en el topbar (botón 🌙/☀️). Un clic cambia entre modo oscuro (por defecto) y modo claro. La preferencia se guarda en `localStorage` y se restaura al recargar.

### 4. Pruebas Automatizadas
```bash
npm test
```
Ejecuta la suite completa de pruebas unitarias, contratos, consentimiento Ley 1581, salvaguardas y modularidad plug-and-play.

Pruebas E2E de integración (requieren la Capa 2A viva en `:3003` y el secreto interno en `.env`):
```bash
npm run test:e2e
```
Incluye las salvaguardas pre-piloto (6 checks: fail-closed, 401, UNCERTAIN_DISPATCH aislado, arranque limpio) y el circuito completo de bajas CRM → 2A → 2B con 0 envíos reales.

Smoke contra servicios vivos (modo simulación, 0 envíos reales, limpieza propia):
```bash
node scripts/smoke-live.mjs
```

### 5. Escaneo de secretos
```bash
npm run security:scan
```
Busca tokens, API keys, contraseñas y private keys en el código. Sale con código 1 si encuentra algo crítico.

### 6. Compilación TypeScript
```bash
npm run tsc
```
Verifica tipos sin emitir ficheros. Debe salir sin errores.

## Denylist de PII con pepper (HMAC)

`npm run check:pii` escanea el árbol rastreado por git y bloquea valores prohibidos y teléfonos colombianos no autorizados. Los valores prohibidos del operador no se publican ni en texto plano ni como hash adivinable: viven SOLO como **HMAC-SHA256** en `scripts/pii-hashlist.json`, firmados con una clave secreta (**pepper**) que **nunca se compromete**. Sin la clave no se puede calcular el HMAC de un candidato, así que la hashlist publicada no permite verificar ni un solo intento de adivinación (a diferencia de un `sha256(sal+valor)` simple, que cualquiera puede comparar contra sus candidatos).

Comportamiento del escáner según el pepper:

| Estado del pepper | Comprobación de valores prohibidos | Árbol limpio |
| --- | --- | --- |
| `ok` | Completa: hashlist + patrones genéricos + lista local | exit 0 |
| `ausente` | Desactivada: genéricos + lista local, con **aviso prominente** (y `::warning::` en Actions) | exit 0 |
| `no coincide` | Desactivada: genéricos + lista local, con **aviso prominente** que lo indica | exit 0 |

**Generar un pepper nuevo** (una sola vez; guárdelo en su gestor de contraseñas):

```bash
openssl rand -hex 32   # nunca lo comitee ni lo pegue en issues, logs o chats
```

**Cargarlo:**

- **Local**: guarde el hex en `scripts/pii-pepper.local` (ya está en `.gitignore`; admite `# comentarios`, el prefijo `PII_PEPPER=` o el hex solo en la primera línea).
- **CI**: `gh secret set PII_PEPPER --body "<hex>"` (o *Settings → Secrets and variables → Actions → New repository secret*). El workflow ya lo pasa al escáner.

**Regenerar la hashlist sin publicar valores** (requiere el pepper; no imprime valores):

```bash
PII_PEPPER="<hex>" node scripts/pii-denylist-build.mjs \
  --from-git "scripts/check-pii.mjs@<revision-antigua>" \
  --out scripts/pii-hashlist.json
```

`--from-file <archivo-privado>` y `--from-stdin` aceptan líneas `tipo:valor` (`name|handle|lid|phone`). El pepper jamás aparece en la hashlist ni en la salida del comando.

**Rotación**: genere un pepper nuevo, regenere la hashlist, haga commit de la hashlist y actualice el secreto de Actions y su `scripts/pii-pepper.local` en cada máquina. Los valores reales nunca salen de su equipo: al repo solo llega el HMAC.
