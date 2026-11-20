/**
 * M4 (ULTRA) — Pacing durable para el despacho manual `/step`.
 *
 * Problema del plan: el `/step` manual despacha sin ritmo porque no pasa
 * `durablePacing` al server. Solución: gate de pacing con lease por campaña en
 * SQLite (node:sqlite o better-sqlite3) — el MISMO gate para el despacho automático y el
 * manual, así el ritmo es una propiedad de la CAMPAÑA, no de quién la dispara.
 *
 * Uso:
 *   const pacing = createDurablePacing({ dbPath: './data/pacing.db' })
 *   const gate = pacing.acquire(campaignId, { minIntervalMs: 45000, dailyCap: 500 })
 *   if (!gate.allowed) → HTTP 429 con gate.retryAfterMs (el step espera)
 *   ...enviar el mensaje...
 *   pacing.release(campaignId)         // fin del step
 *
 * Propiedades verificadas (tests/kits/m4-durable-pacing.test.ts):
 *  - primera adquisición OK; segunda antes del intervalo → 429 con retryAfterMs
 *  - DURABLE: reabrir la BD mantiene el intervalo (el reinicio no lo salta)
 *  - cap diario: alcanzado el cap → allowed=false hasta el día siguiente
 *  - release limpia el lease pero conserva el contador diario
 */
import { createRequire } from 'module'
import { mkdirSync } from 'fs'
import { dirname } from 'path'

const require = createRequire(import.meta.url)

function getDatabaseConstructor() {
  try {
    const { DatabaseSync } = require('node:sqlite')
    if (DatabaseSync) return DatabaseSync
  } catch {}
  try {
    const b = require('better-sqlite3')
    return b.default || b
  } catch {}
  throw new Error('No SQLite implementation found (neither node:sqlite nor better-sqlite3)')
}

const Database = getDatabaseConstructor()

/**
 * Fábrica del gate de pacing.
 * @param {{ dbPath?: string, clock?: () => number }} opts
 */
export function createDurablePacing({ dbPath, clock = () => Date.now() } = {}) {
  if (!dbPath) throw new Error('[pacing] dbPath es requerido (fail-closed: sin persistencia no hay pacing durable)')
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  if (typeof db.pragma === 'function') {
    db.pragma('journal_mode = WAL')
  } else {
    db.exec('PRAGMA journal_mode = WAL;')
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS CampaignPacing (
      campaignId TEXT PRIMARY KEY,
      leaseHolder TEXT,
      leaseAt INTEGER,
      lastSendAt INTEGER,
      dailyDate TEXT,
      dailyCount INTEGER NOT NULL DEFAULT 0
    );
  `)

  const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10)

  return {
    /**
     * Adquiere el turno de envío de UNA campaña. Devuelve { allowed, retryAfterMs,
     * dailyRemaining }. El lease es exclusivo por campaña: dos `/step` simultáneos
     * no pueden ambos enviar (SQLite serializa la escritura).
     */
    acquire(campaignId, { minIntervalMs = 30_000, dailyCap = 1000, holder = 'manual-step' } = {}) {
      const now = clock()
      const row = db.prepare('SELECT * FROM CampaignPacing WHERE campaignId = ?').get(campaignId)
      const dailyDate = dayKey(now)
      const dailyCount = row && row.dailyDate === dailyDate ? row.dailyCount : 0
      if (dailyCount >= dailyCap) {
        return { allowed: false, retryAfterMs: null, dailyRemaining: 0, reason: 'daily_cap_reached' }
      }
      if (row && row.leaseHolder && row.leaseHolder !== holder && now - row.leaseAt < 60_000) {
        // Lease vivo de otro step: el paso actual no puede solaparse.
        return { allowed: false, retryAfterMs: 60_000 - (now - row.leaseAt), dailyRemaining: dailyCap - dailyCount, reason: 'lease_busy' }
      }
      if (row && row.lastSendAt && now - row.lastSendAt < minIntervalMs) {
        return { allowed: false, retryAfterMs: minIntervalMs - (now - row.lastSendAt), dailyRemaining: dailyCap - dailyCount, reason: 'interval' }
      }
      db.prepare(`
        INSERT INTO CampaignPacing (campaignId, leaseHolder, leaseAt, lastSendAt, dailyDate, dailyCount)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(campaignId) DO UPDATE SET
          leaseHolder = excluded.leaseHolder,
          leaseAt = excluded.leaseAt,
          dailyDate = excluded.dailyDate,
          dailyCount = excluded.dailyCount
      `).run(campaignId, holder, now, row?.lastSendAt ?? null, dailyDate, dailyCount)
      return { allowed: true, retryAfterMs: 0, dailyRemaining: dailyCap - dailyCount, reason: null }
    },

    /** Registra el envío real (activa el intervalo para el siguiente step). */
    recordSend(campaignId, ms = clock()) {
      db.prepare(`
        UPDATE CampaignPacing SET lastSendAt = ?,
          dailyCount = dailyCount + 1,
          dailyDate = ?
        WHERE campaignId = ?
      `).run(ms, dayKey(ms), campaignId)
    },

    /** Libera el lease al terminar el step (el contador diario se conserva). */
    release(campaignId) {
      db.prepare('UPDATE CampaignPacing SET leaseHolder = NULL, leaseAt = NULL WHERE campaignId = ?').run(campaignId)
    },

    close() {
      db.close()
    },
  }
}
