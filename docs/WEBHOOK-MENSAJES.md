# docs/WEBHOOK-MENSAJES.md — Webhook de entrada de mensajes

> Contrato del webhook que recibe mensajes entrantes de WhatsApp (desde el daemon Baileys o desde Meta Cloud API) y los persiste en el motor WHATSPOWER-ULTRA.

---

## 1 · Endpoint

```
POST /api/audiences/webhook-lead
```

Recibe leads en tiempo real desde Facebook Ads, TikTok Ads, Typeform o cualquier webhook personalizado. Los guarda en la tabla `realtime_leads` de la base de datos SQLite privada (`db/broadcast.db`).

---

## 2 · Cabeceras

| Cabecera | Obligatoria | Descripción |
|---|---|---|
| `Content-Type` | Sí | `application/json` |
| `X-Webhook-Signature` | Sí (en producción) | Firma HMAC v2: `t=<timestamp>,v1=<hmac>` |
| `X-Webhook-Source` | No | Origen declarado: `facebook_ads`, `tiktok_ads`, `typeform`, `custom_webhook` |
| `User-Agent` | No | Se registra para telemetría |

---

## 3 · Firma HMAC v2

### 3.1 Esquema

La cabecera `X-Webhook-Signature` tiene el formato:

```
t=1700000000,v1=abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890
```

### 3.2 Cálculo

```
hmac_sha256(
  key = INTERNAL_API_SECRET,
  message = "{timestamp}.{cuerpo_json_crudo}"
)
```

- `timestamp`: segundos desde epoch (Unix).
- `cuerpo_json_crudo`: el cuerpo de la petición tal cual llega (sin reformatar).
- El secreto `INTERNAL_API_SECRET` se configura en `.env` (mínimo 24 caracteres).

### 3.3 Verificación

1. Extraer `t` y `v1` de la cabecera.
2. Recalcular el HMAC con el mismo algoritmo sobre `{t}.{cuerpo}`.
3. Comparar con `v1` (comparación de tiempo constante).
4. **Ventana de tolerancia:** 5 minutos (300 segundos). Si `|ahora - t| > 300`, rechazar con 401.

### 3.4 Fail-closed

Si la cabecera falta, está mal formada, o la firma no coincide → **401 Unauthorized**. Nunca se acepta una petición sin firma válida en producción.

---

## 4 · Cuerpo de la petición

### 4.1 Ejemplo de alta (lead nuevo)

```bash
curl -X POST http://localhost:3004/api/audiences/webhook-lead \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Signature: t=1700000000,v1=$(echo -n '1700000000.{"source":"facebook_ads","phone":"573017543786","name":"Lead desde Facebook Ads"}' | openssl dgst -sha256 -hmac "$INTERNAL_API_SECRET" -binary | xxd -p)" \
  -H "X-Webhook-Source: facebook_ads" \
  -d '{
    "source": "facebook_ads",
    "phone": "573017543786",
    "name": "Lead desde Facebook Ads",
    "email": "lead@ejemplo.com",
    "campaign": "lead_form_black_friday"
  }'
```

### 4.2 Respuesta de éxito (200)

```json
{
  "success": true,
  "leadId": "lead_4dc77633-2c99-4a6d-8cff-1810c56aeea2",
  "canonicalPhone": "573017543786"
}
```

### 4.3 Ejemplo de error 401 (firma inválida)

```bash
curl -X POST http://localhost:3004/api/audiences/webhook-lead \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Signature: t=1700000000,v1=firma_invalida" \
  -d '{"source":"facebook_ads","phone":"573017543786"}'
```

```json
{
  "error": "Firma HMAC inválida o expirada"
}
```

### 4.4 Ejemplo de error 503 (modo seguro)

Cuando `ALLOW_REAL_DISPATCH=false` y el servicio no está listo para procesar:

```json
{
  "error": "Servicio en modo seguro. ALLOW_REAL_DISPATCH=false"
}
```

---

## 5 · Evento duplicado (idempotencia)

Si se recibe el mismo lead dos veces (misma combinación `source + phone + window_5min`):

- **Primera vez:** se inserta en `realtime_leads` con `processed=0`, se devuelve `leadId`.
- **Segunda vez:** se detecta el duplicado, se devuelve el `leadId` original, **no se inserta de nuevo**.

```json
{
  "success": true,
  "leadId": "lead_4dc77633-2c99-4a6d-8cff-1810c56aeea2",
  "canonicalPhone": "573017543786",
  "duplicated": true
}
```

---

## 6 · Modelo de datos

Tabla `realtime_leads` (SQLite, `db/broadcast.db`):

| Campo | Tipo | Descripción |
|---|---|---|
| `id` | TEXT PK | `lead_<uuid>` |
| `phone` | TEXT | Teléfono normalizado E.164 |
| `name` | TEXT | Nombre del lead (opcional) |
| `source` | TEXT | `facebook_ads` / `tiktok_ads` / `typeform` / `custom_webhook` |
| `campaign_id` | TEXT | ID de campaña asociada (opcional) |
| `payload_json` | TEXT | Payload completo en JSON |
| `processed` | INTEGER | 0 = pendiente, 1 = ya reactivo |
| `created_at` | INTEGER | Timestamp Unix |

---

## 7 · Reglas de seguridad

1. **Ningún secreto en logs:** el `INTERNAL_API_SECRET` nunca se registra. Solo la máscara de los últimos 4 caracteres.
2. **Comparación de tiempo constante:** para prevenir timing attacks en la verificación de firma.
3. **Ventana de tolerancia de 5 min:** evita replay attacks.
4. **Rate limiting recomendado:** 100 peticiones/minuto por IP (configurable en el reverse proxy).
5. **HTTPS obligatorio en producción:** el webhook nunca debe servir sobre HTTP plano.

---

## 8 · Integración con el motor

Cuando un lead se ingesta:
1. Se persiste en `realtime_leads` con `processed=0`.
2. Queda disponible para reactivación en futuras campañas.
3. El motor de difusión puede consultarlo al crear audiencias desde CRM-ALBRA.
4. Si el lead responde a un broadcast, WhatsPower (Nivel 2) detecta la respuesta entrante y bloquea futuros broadcasts a ese número (escudo anti-ban, capa 5 JIT).
