import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDurablePacing } from '../src/safety/durable-pacing.mjs'

/**
 * Kit M4 (ULTRA) — pacing durable para /step manual: mismo gate para automático
 * y manual, lease exclusivo por campaña, cap diario, durabilidad al reabrir.
 */
describe('kit M4 — durable-pacing', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const tmpDb = () => {
    const d = mkdtempSync(join(tmpdir(), 'm4kit-'))
    dirs.push(d)
    return join(d, 'pacing.db')
  }

  it('sin dbPath lanza (fail-closed)', () => {
    assert.throws(() => createDurablePacing({} as any), /dbPath es requerido/)
  })

  it('intervalo: primer step permitido, segundo antes del intervalo → 429 con retryAfterMs', () => {
    let now = Date.parse('2026-11-20T08:00:00Z')
    const pacing = createDurablePacing({ dbPath: tmpDb(), clock: () => now })
    try {
      const g1 = pacing.acquire('camp-1', { minIntervalMs: 45_000, dailyCap: 100 })
      assert.equal(g1.allowed, true)
      pacing.recordSend('camp-1', now)
      now += 10_000 // 10 s después: antes del intervalo
      const g2 = pacing.acquire('camp-1', { minIntervalMs: 45_000, dailyCap: 100 })
      assert.equal(g2.allowed, false)
      assert.equal(g2.reason, 'interval')
      assert.equal(g2.retryAfterMs, 35_000)
      now += 40_000 // 50 s después del envío: intervalo cumplido
      assert.equal(pacing.acquire('camp-1', { minIntervalMs: 45_000, dailyCap: 100 }).allowed, true)
    } finally {
      pacing.close()
    }
  })

  it('lease exclusivo: otro step dentro del lease → 429 lease_busy', () => {
    let now = Date.parse('2026-11-20T08:00:00Z')
    const pacing = createDurablePacing({ dbPath: tmpDb(), clock: () => now })
    try {
      assert.equal(pacing.acquire('camp-2', { minIntervalMs: 0, dailyCap: 100, holder: 'manual-step-1' }).allowed, true)
      const g = pacing.acquire('camp-2', { minIntervalMs: 0, dailyCap: 100, holder: 'manual-step-2' })
      assert.equal(g.allowed, false)
      assert.equal(g.reason, 'lease_busy')
      // El MISMO holder puede re-adquirir (retry interno legítimo)
      assert.equal(pacing.acquire('camp-2', { minIntervalMs: 0, dailyCap: 100, holder: 'manual-step-1' }).allowed, true)
    } finally {
      pacing.close()
    }
  })

  it('cap diario alcanzado → rechazo hasta el día siguiente; release conserva el contador', () => {
    let now = Date.parse('2026-11-20T08:00:00Z')
    const pacing = createDurablePacing({ dbPath: tmpDb(), clock: () => now })
    try {
      pacing.acquire('camp-3', { minIntervalMs: 0, dailyCap: 2, holder: 'h' })
      pacing.recordSend('camp-3', now)
      now += 300_000
      pacing.recordSend('camp-3', now)
      const g = pacing.acquire('camp-3', { minIntervalMs: 0, dailyCap: 2, holder: 'h' })
      assert.equal(g.allowed, false)
      assert.equal(g.reason, 'daily_cap_reached')
      pacing.release('camp-3')
      // Día siguiente: contador reinicia
      now = Date.parse('2026-11-21T08:00:00Z')
      const gNext = pacing.acquire('camp-3', { minIntervalMs: 0, dailyCap: 2, holder: 'h' })
      assert.equal(gNext.allowed, true)
      assert.equal(gNext.dailyRemaining, 2)
    } finally {
      pacing.close()
    }
  })

  it('DURABLE: reabrir la BD mantiene intervalo y contador diario (el reinicio no lo salta)', () => {
    const dbPath = tmpDb()
    const T0 = Date.parse('2026-11-20T09:00:00Z')
    const a = createDurablePacing({ dbPath, clock: () => T0 })
    a.acquire('camp-4', { minIntervalMs: 60_000, dailyCap: 10, holder: 'h' })
    a.recordSend('camp-4', T0)
    a.close()

    const b = createDurablePacing({ dbPath, clock: () => T0 + 10_000 })
    try {
      const g = b.acquire('camp-4', { minIntervalMs: 60_000, dailyCap: 10, holder: 'h' })
      assert.equal(g.allowed, false)
      assert.equal(g.reason, 'interval')
      assert.equal(g.retryAfterMs, 50_000)
    } finally {
      b.close()
    }
  })
})
