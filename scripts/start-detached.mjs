/**
 * Launcher detached de WHATSPOWER ULTRA (Nivel 3, puerto 3004).
 * Doble fork + unref: el servidor sobrevive al cierre de la shell/sesión del sandbox.
 * Uso: node scripts/start-detached.mjs
 * Log: server.log en la raíz del repo.
 */
import { spawn } from 'child_process'
import { openSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = openSync(join(repoRoot, 'server.log'), 'a')

const child = spawn('node', ['--experimental-strip-types', 'src/server.ts'], {
  cwd: repoRoot,
  detached: true,
  stdio: ['ignore', out, out],
  env: { ...process.env },
})

child.unref()
console.log(`[ultra] servidor detached pid=${child.pid} log=${join(repoRoot, 'server.log')}`)
