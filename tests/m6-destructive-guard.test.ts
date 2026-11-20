import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeDeletableTargets } from '../src/safety/destructive-guard.mjs'

/**
 * Kit M6 (ULTRA) — guard destructivo de smoke-live: jamás borra campañas
 * ajenas ni de producción; fail-closed sin tag de corrida.
 */
describe('kit M6 — destructive-guard (smoke-live)', () => {
  const orgId = 'org-ultra'
  const runTag = 'smoke-20261120'
  const targets = [
    { id: 'camp-smoke-1', orgId, tags: [runTag], createdByRun: runTag },   // candidato normal
    { id: 'camp-smoke-2', orgId, tags: [], createdByRun: runTag },          // propio de la corrida, sin tag
    { id: 'camp-prod-1', orgId, tags: ['produccion'], createdByRun: 'otra-corrida' }, // producción propia
    { id: 'camp-otra-org', orgId: 'org-otra', tags: [runTag], createdByRun: runTag }, // de OTRA org
  ]

  it('fail-closed: sin runTag NO se borra nada', () => {
    const res = computeDeletableTargets({ runTag: undefined, targets, orgId })
    assert.deepEqual(res.deletable, [])
    assert.equal(res.skipped.length, targets.length)
    assert.ok(res.skipped.every((s) => s.reason === 'no_run_tag_fail_closed'))
  })

  it('sin force: solo candidatos con el tag de la corrida', () => {
    const res = computeDeletableTargets({ runTag, targets, orgId, force: false })
    assert.deepEqual(res.deletable, [{ id: 'camp-smoke-1' }])
    assert.deepEqual(res.skipped, [
      { id: 'camp-smoke-2', reason: 'missing_tag_force_required' },
      { id: 'camp-prod-1', reason: 'production_object_protected' },
      { id: 'camp-otra-org', reason: 'foreign_org_protected' },
    ])
  })

  it('con force: amplía SOLO a propios de la misma corrida; producción jamás', () => {
    const res = computeDeletableTargets({ runTag, targets, orgId, force: true })
    assert.deepEqual(res.deletable, [{ id: 'camp-smoke-1' }, { id: 'camp-smoke-2' }])
    assert.deepEqual(res.skipped, [
      { id: 'camp-prod-1', reason: 'production_object_protected' },
      { id: 'camp-otra-org', reason: 'foreign_org_protected' },
    ])
  })

  it('la org ajena está protegida SIEMPRE (incluso con tag de la corrida)', () => {
    const res = computeDeletableTargets({ runTag, targets, orgId, force: true })
    assert.equal(res.deletable.every((d) => d.id !== 'camp-otra-org'), true)
  })

  it('targets inválidos o nulos se reportan como skipped, no rompen', () => {
    const res = computeDeletableTargets({ runTag, targets: [null, { orgId }], orgId })
    assert.deepEqual(res.deletable, [])
    assert.deepEqual(res.skipped.map((s) => s.reason), ['invalid_target', 'invalid_target'])
  })
})
