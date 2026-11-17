# OWNER_TODO — Acciones que SOLO el dueño puede ejecutar

**Actualizado:** 2026-11-17 · **Rama:** `repair/produccion-real`

## 0. Nuevas tareas de esta sesión (reparación 2026-11-17)
- [ ] **Rotar el PAT de GitHub** usado en esta sesión (estuvo en texto de chat) tras validar el push: revocar y crear uno con alcance mínimo (`repo` de los 3 repos).
- [ ] **Docker compose build + up en el PC** (sin docker en el entorno de trabajo): `docker compose build` de ULTRA y del CRM; verificar arranque de server + worker + daemon.
- [ ] **Instalar el unit systemd del daemon** (RUNBOOK §3.1): copiar la unit de referencia a `/etc/systemd/system/albra-daemon.service`, ajustar `WorkingDirectory` y `systemctl enable --now`.
- [ ] **Programar respaldo diario de la BD**: cron/tarea programada con `node --experimental-strip-types scripts/backup-db.ts` (ver RUNBOOK §3.2) y verificar la restauración una vez al mes.
- [ ] **Confirmar DEMO_MODE=false en el .env de producción** y `TRUST_PROXY=true` SOLO si hay proxy inverso de confianza delante.
- [ ] **Contratar líneas SIM secundarias para calentamiento** (jamás el número principal) y definir el ritmo de calentamiento del pacing antes de la primera campaña real.

---




## 1. Credenciales y seguridad
- [ ] **Rotar el PAT de GitHub** compartido en chat (tras el merge, revocar y crear uno con alcance mínimo).
- [ ] **Purgar el historial git** con `git filter-repo` si se desea (el historial de ULTRA se escaneó COMPLETO: 0 hallazgos; no hay nada que purgar, decisión informativa).

## 2. Canal oficial (FASE 1)
- [ ] Cuenta **Meta Business** verificada + app + **número oficial** de Cloud API por organización (`org-wa-credentials`).
- [ ] **Plantillas aprobadas** por Meta (el `TemplateRegistry` modela estados; sin aprobación no hay envíos fuera de ventana).
- [ ] Webhook de Meta → URL pública con appSecret real.

## 3. Piloto
- [ ] Autorizar por escrito la prueba real mínima y proveer CSV inicial con **origen del consentimiento** (exigido por el importador).

## 4. Despliegue (PC del dueño)
- [ ] **Docker compose build + up en el PC**: NO ejecutable en el entorno de trabajo remoto (sin docker). Dockerfile/compose presentes.
- [ ] `.env` reales (incluye `ADMIN_API_KEYS`, `WEBHOOK_LEAD_SECRETS` por org, `WHATSPOWER_ORG_CREDENTIALS` por org).
- [ ] Ajustar ventanas de operación si difieren del default (nuevo en esta sesión: `BUSINESS_HOURS_START/END`, `THROTTLE_*` con defaults idénticos al histórico).
- [ ] Revisar `docs/RUNBOOK.md`.

## 5. Legal
- [ ] Términos y Política de Privacidad definitivos (Ley 1581).

## 6. Integración
- [ ] Merge autorizado de `repair/produccion-real` → `main`.

## 7. Panel: lo que falta para usarlo con clientes reales (cierre 2026-11-16)
- [ ] **Número y token de Meta Cloud** reales (por organización) y `ALLOW_REAL_DISPATCH=true` en el entorno: sin eso el panel funciona y prueba todo, pero los envíos salen al transporte de pruebas.
- [ ] **Secretos reales fuera del repo**: `INTERNAL_API_SECRET` (daemon del CRM) y `WEBHOOK_LEAD_SECRETS` (firma HMAC v2 del webhook y de los leads). El panel solo guarda la máscara de los últimos 4.
- [ ] **Revisión visual** del panel frente al original (capturas del dueño): el cierre fue funcional, no visual.
- [ ] **Abrirlo en un navegador de verdad y a 390 px** (móvil): aquí no hay navegador (el consentimiento para abrirlo se denegó), así que lo responsive está comprobado leyendo las reglas y los atributos de la página servida, no viéndolo. Ruta: `npm run dev` (o el arranque que uses) y abrir `/`, luego `/` con la ventana estrecha o el móvil.
- [ ] **Probar el flujo real de consentimiento** con un contacto de prueba y confirmar que aparece en el reporte de cumplimiento.
- [ ] **Decidir sobre el chatbot** que anuncia la web de ventas: el original NO lo trae como pantalla (inventario §4.1–4.13), así que no está en el panel; si se quiere, es un desarrollo nuevo, no una paridad pendiente.
