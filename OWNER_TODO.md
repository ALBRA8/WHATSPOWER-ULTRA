# OWNER_TODO — Acciones que SOLO el dueño puede ejecutar

**Actualizado:** 2026-11-15 · **Rama:** `repair/produccion-real`

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
