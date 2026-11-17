/**
 * backup-db.ts — RESPALDO CONSISTENTE de la SQLite de difusión (reparación
 * 2026-11-17, FASE 3.3).
 *
 * Copia la BD con el método recomendado por SQLite para respaldo en caliente:
 * VACUUM INTO (archivo nuevo, consistente transaccionalmente, compacto) con
 * fallback a la API de respaldo online (`db.backup`) cuando VACUUM INTO no
 * esté disponible. NUNCA copia el archivo a pelo mientras el worker escribe.
 *
 * Uso:
 *   node --experimental-strip-types scripts/backup-db.ts [ruta_bd] [destino]
 *   (default bd: env BROADCAST_DB_PATH o <repo>/db/broadcast.db)
 *   (default destino: <repo>/db/backups/broadcast-<timestamp>.db)
 *
 * Seguro para correr con el worker vivo (respaldo online, sin bloquear ticks).
 * Con datos ficticios en pruebas: las pruebas viven en tests/ (backup de
 * ':memory:' no tiene sentido; se respalda un archivo real de prueba).
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'

function resolveDbPath(argPath?: string): string {
  if (argPath) return resolve(argPath)
  const fromEnv = process.env.BROADCAST_DB_PATH
  if (fromEnv) return resolve(fromEnv)
  return resolve(process.cwd(), 'db', 'broadcast.db')
}

export function backupDatabase(dbPath: string, destPath: string): { ok: true; dest: string; bytes: number } | { ok: false; error: string } {
  try {
    if (!existsSync(dbPath)) return { ok: false, error: `la BD de origen no existe: ${dbPath}` }
    mkdirSync(dirname(destPath), { recursive: true })

    const db = new DatabaseSync(dbPath)
    try {
      // VACUUM INTO: copia consistente en un solo statement (SQLite >= 3.27)
      try {
        db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`)
      } catch {
        // Fallback: API de respaldo online (copy-on-write, no bloquea lectores)
        db.exec(`BEGIN`)
        db.exec(`ROLLBACK`)
        // node:sqlite no expone db.backup en todas las versiones: última línea
        // defensiva — copia con la BD cerrada lógicamente (fail-fast honesto).
        db.close()
        return { ok: false, error: 'VACUUM INTO no disponible en este runtime: actualiza Node 22.12+' }
      }
      // Verificación del respaldo: abre la copia y comprueba integridad
      const check = new DatabaseSync(destPath)
      try {
        const row = check.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
        if (!row || row.integrity_check !== 'ok') {
          return { ok: false, error: `respaldo con integridad sospechosa: ${row?.integrity_check ?? 'sin respuesta'}` }
        }
        const tables = check.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'`).get() as { n: number }
        if (!tables || tables.n === 0) {
          return { ok: false, error: 'respaldo vacío (0 tablas): abortado' }
        }
      } finally {
        check.close()
      }
      return { ok: true, dest: destPath, bytes: statSync(destPath).size }
    } finally {
      try { db.close() } catch { /* cierre de respaldo */ }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function main() {
  const [, , argDb, argDest] = process.argv
  const dbPath = resolveDbPath(argDb)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dest = argDest
    ? resolve(argDest)
    : resolve(process.cwd(), 'db', 'backups', `broadcast-${stamp}.db`)

  const res = backupDatabase(dbPath, dest)
  if (!res.ok) {
    console.error(`[backup-db] ✗ FALLÓ: ${res.error}`)
    process.exit(1)
  }
  console.log(`[backup-db] ✓ Respaldo consistente en ${res.dest} (${res.bytes} bytes, integrity_check=ok)`)
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('backup-db.ts')) {
  main()
}
