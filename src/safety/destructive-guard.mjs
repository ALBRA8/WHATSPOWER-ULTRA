/**
 * M6 (ULTRA) — Guard destructivo para `smoke-live`.
 *
 * Problema del plan: smoke-live borra campañas AJENAS al terminar (riesgo
 * destructivo si alguien lo corre en producción). La rama ULTRA
 * `impl/fix-funcionales-20261112` tiene el fix propuesto; este guard portable
 * encapsula la regla y es el requisito mínimo de cualquier variante:
 *
 *  1) fail-closed: sin tag de corrida NO se borra nada
 *  2) candidatos normales: objetos de la org propia CON el tag de la corrida
 *  3) con `--force` explícito se amplía SOLO a objetos creados por la MISMA
 *     corrida (createdByRun) dentro de la org propia — una campaña de
 *     producción jamás es candidato, con o sin force
 *  4) objetos de OTRA organización: protegidos siempre (foreign_org_protected)
 *  5) el resultado incluye skipped con motivo, para auditoría
 */

export function computeDeletableTargets({ runTag, targets, orgId, force = false }) {
  if (!runTag || typeof runTag !== 'string') {
    return {
      deletable: [],
      skipped: (targets || []).map((t) => ({ id: t?.id, reason: 'no_run_tag_fail_closed' })),
      force,
    }
  }

  const deletable = []
  const skipped = []
  for (const t of targets || []) {
    if (!t || typeof t.id !== 'string') {
      skipped.push({ id: t?.id ?? null, reason: 'invalid_target' })
      continue
    }
    if (t.orgId !== orgId) {
      skipped.push({ id: t.id, reason: 'foreign_org_protected' })
      continue
    }
    const tagged = Array.isArray(t.tags) && t.tags.includes(runTag)
    const ownRun = t.createdByRun === runTag
    if (tagged || (force && ownRun)) {
      deletable.push({ id: t.id })
      continue
    }
    skipped.push({ id: t.id, reason: ownRun ? 'missing_tag_force_required' : 'production_object_protected' })
  }
  return { deletable, skipped, force }
}
