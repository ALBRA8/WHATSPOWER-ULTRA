#!/usr/bin/env node
/**
 * run-tests.mjs — Ejecutor multiplataforma de pruebas para WHATSPOWER-ULTRA.
 *
 * Ejecuta todas las pruebas en `tests/*.test.ts` (incluyendo las pruebas de seguridad
 * y salvaguardas antes excluidas: pilot-safeguards.test.ts y bajas-circuit.test.ts).
 * Compatible con Windows, Linux y GitHub Actions CI.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const testsDir = join(process.cwd(), 'tests')
const testFiles = readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.ts'))
  .sort()
  .map((f) => join('tests', f))

console.log(`[run-tests] Ejecutando ${testFiles.length} archivos de prueba...`)

const args = ['--experimental-strip-types', '--test', ...testFiles]
const result = spawnSync(process.execPath, args, { stdio: 'inherit' })

process.exit(result.status ?? 0)
