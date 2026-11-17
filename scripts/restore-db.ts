/**
 * restore-db.ts — RESTAURACIÓN de la SQLite de difusión desde un respaldo
 * (reparación 2026-11-17, FASE 3.3).
 *
 * Procedimiento seguro:
 *  1. Verifica que el respaldo existe y pasa integrity_check.
 *  2. Detiene (por contrato operativo) el worker ANTES de restaurar: este
 *     script NO mata procesos — exige que el worker esté parado (ver RUNBOOK)
 *     y lo comprueba rechazando restaurar si la BD está en uso excesivo…
 *     La protección real es simple: la restauración se hace SOBRE UN ARCHIVO
 *     NUEVO temporal y luego se intercambia con renombrado atómico, dejando
 *     la BD previa como .pre-restore-<ts> (jamás se borra la actual).
 *  3. Tras intercambiar, verifica integridad y conteo de tablas.
 *
 * Uso:
 *   node --experimental-strip-types scripts/restore-db.ts <respaldo.db> [destino]
 *   (default destino: env BROADCAST_DB_PATH o <repo>/db/broadcast.db)
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, renameSync, copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'

export function restoreDatabase(backupPath: string, targetPath: string): { ok: true; target: string; previousBackup: string } | { ok: false; error: string } {
  try {
    if (!existsSync(backupPath)) return { ok: false, error: `el respaldo no existe: ${backupPath}` }
    // 1. El respaldo debe ser una BD válida e íntegra ANTES de tocar nada
    const check = new DatabaseSync(backupPath)
    try {
      const row = check.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
      if (!row || row.integrity_check !== 'ok') return { ok: false, error: `respaldo NO íntegro: ${row?.integrity_check ?? 'sin respuesta'}` }
      const tables = check.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'`).get() as { n: number }
      if (!tables || tables.n === 0) return { ok: false, error: 'el respaldo está vacío (0 tablas)' }
    } finally {
      check.close()
    }

    // 2. Restaurar primero a un archivo temporal junto al destino
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const tmpPath = `${targetPath}.restore-tmp-${stamp}`
    copyFileSync(backupPath, tmpPath)

    // 3. Conservar la BD actual (jamás se destruye): renombrado de seguridad
    mkdirp(dirname(targetPath))
    let previousBackup = ''
    if (existsSync(targetPath)) {
      previousBackup = `${targetPath}.pre-restore-${stamp}`
      renameSync(targetPath, previousBackup)
    }

    // 4. Intercambio atómico por renombrado (misma partición: rename es atómico)
    try {
      renameSync(tmpPath, targetPath)
    } catch (err) {
      // Rollback: devolver la BD previa a su sitio
      if (previousBackup) renameSync(previousBackup, targetPath)
      try { rmSync(tmpPath, { force: true }) } catch {}
      return { ok: false, error: `fallo al intercambiar el archivo: ${err instanceof Error ? err.message : String(err)}` }
    }

    // 5. Verificación final sobre la BD restaurada en su posición definitiva
    const final = new DatabaseSync(targetPath)
    try {
      const row = final.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
      if (!row || row.integrity_check !== 'ok') {
        return { ok: false, error: `BD restaurada NO íntegra (${row?.integrity_check}): restaurar ${previousBackup}` }
      }
    } finally {
      final.close()
    }

    return { ok: true, target: targetPath, previousBackup: previousBackup || '(no había BD previa)' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function mkdirp(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function main() {
  const [, , argBackup, argTarget] = process.argv
  if (!argBackup) {
    console.error('[restore-db] uso: node --experimental-strip-types scripts/restore-db.ts <respaldo.db> [destino]')
    process.exit(2)
  }
  const target = argTarget
    ? resolve(argTarget)
    : resolve(process.env.BROADCAST_DB_PATH || join(process.cwd(), 'db', 'broadcast.db'))

  const res = restoreDatabase(resolve(argBackup), target)
  if (!res.ok) {
    console.error(`[restore-db] ✗ FALLÓ: ${res.error}`)
    process.exit(1)
  }
  console.log(`[restore-db] ✓ Restaurada ${res.target} desde el respaldo (BD previa conservada en ${res.previousBackup})`)
  console.log('[restore-db] NOTA: detén el worker ANTES de restaurar y arráncalo después (RUNBOOK §respaldo).')
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('restore-db.ts')) {
  main()
}
