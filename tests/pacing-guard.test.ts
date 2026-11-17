/**
 * pacing-guard.test.ts — (reparación 2026-11-17) FASE 1.D
 *
 * WORKER_DISABLE_PACING=1|true desactiva el throttling anti-baneo del worker.
 * En producción eso está PROHIBIDO (el pacing protege el número de bloqueos):
 *  1. productionConfigProblems lo marca como problema fatal en producción.
 *  2. El proceso worker-main ABORTA con exit code 1 al arrancar en producción
 *     con pacing desactivado (se verifica con un proceso hijo real, sin
 *     despachar nada y sin tocar .wa-auth ni QR).
 *  3. En desarrollo/laboratorio el guard NO aplica (compatibilidad).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { productionConfigProblems } from '../src/security.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WORKER_MAIN = join(__dirname, '..', 'src', 'worker-main.ts')

function runWorker(env: Record<string, string>): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', WORKER_MAIN], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (d) => (output += d))
    child.stderr.on('data', (d) => (output += d))
    child.on('close', (code) => resolve({ code, output }))
  })
}

test('FASE 1.D — WORKER_DISABLE_PACING prohibido en producción', async (t) => {
  await t.test('1.D.1 productionConfigProblems marca el pacing desactivado como problema fatal', () => {
    const problems = productionConfigProblems({ NODE_ENV: 'production', WORKER_DISABLE_PACING: '1' } as NodeJS.ProcessEnv)
    assert.ok(problems.some((p) => p.includes('WORKER_DISABLE_PACING')), 'WORKER_DISABLE_PACING=1 en producción debe aparecer como problema')
    const problemsTrue = productionConfigProblems({ NODE_ENV: 'production', WORKER_DISABLE_PACING: 'true' } as NodeJS.ProcessEnv)
    assert.ok(problemsTrue.some((p) => p.includes('WORKER_DISABLE_PACING')), 'WORKER_DISABLE_PACING=true también')
    // en desarrollo es legítimo (laboratorio)
    const dev = productionConfigProblems({ NODE_ENV: 'development', WORKER_DISABLE_PACING: '1' } as NodeJS.ProcessEnv)
    assert.ok(!dev.some((p) => p.includes('WORKER_DISABLE_PACING')), 'en desarrollo/laboratorio el pacing desactivado es legítimo')
  })

  await t.test('1.D.2 el proceso worker ABORTA con exit 1 en producción con pacing desactivado', { timeout: 60_000 }, async () => {
    const { code, output } = await runWorker({
      NODE_ENV: 'production',
      WORKER_DISABLE_PACING: '1',
      // Resto de configuración VÁLIDA para que el ÚNICO motivo del bloqueo sea el pacing:
      ADMIN_API_KEYS: 'ultra_pacing_guard_admin_key_min32chars:org_test',
      WEBHOOK_LEAD_SECRET: 'pacing_guard_webhook_secret_min24chars_ok',
      INTERNAL_API_SECRET: 'pacing_guard_internal_secret_min24chars_ok',
      ALLOW_REAL_DISPATCH: 'false',
      WHATSPOWER_ENABLED: 'false',
      BROADCAST_DB_PATH: ':memory:',
    })
    // El guard general de producción bloquearía por DEMO_MODE heredado del .env;
    // el mensaje del pacing DEBE estar en la salida si llegó a ese guard.
    assert.ok(
      output.includes('WORKER_DISABLE_PACING') || output.includes('pacing'),
      `la salida debe nombrar el bloqueo de pacing: ${output.slice(0, 400)}`
    )
    assert.equal(code, 1, 'el worker NO arranca (exit 1)')
    assert.ok(!output.includes('proceso persistente ULTRA iniciado'), 'el bucle del worker jamás inicia')
  })

  await t.test('1.D.3 en desarrollo el pacing desactivado NO aborta por el guard de pacing', () => {
    const problems = productionConfigProblems({ NODE_ENV: 'development', WORKER_DISABLE_PACING: 'true' } as NodeJS.ProcessEnv)
    assert.equal(problems.filter((p) => p.includes('WORKER_DISABLE_PACING')).length, 0)
    // El guard explícito del worker exige isProduction: se verifica por código fuente
    const src = readFileSync(WORKER_MAIN, 'utf8')
    assert.match(src, /isProduction && pacingDisabled/, 'el guard explícito condiciona a producción')
  })
})
