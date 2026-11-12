#!/usr/bin/env node
/**
 * audit-baseline.mjs — Auditoría integral directa e inversa del baseline de secretos.
 *
 * Requisitos certificados de la Fase 2 WHATSPOWER-ULTRA:
 *   1. Auditoría directa de cada entrada en secret-baseline.json:
 *      - Existencia real del commit (SHA completo de 40 caracteres hexadecimales).
 *      - Existencia del archivo en ese commit específico.
 *      - Presencia real del secreto/patrón con la categoría y huella exactas.
 *      - Clasificación estricta: VERIFIED (real histórico), SYNTHETIC (fixture de prueba), INVALID.
 *      - Detección de duplicados.
 *   2. Auditoría inversa del historial Git completo:
 *      - Inspección de todos los commits históricos y sus blobs.
 *      - Verificación de que cada entrada del baseline corresponde a un hallazgo histórico real.
 *      - Detección de entradas huérfanas o sin correspondencia histórica.
 *      - Detección de hallazgos históricos no autorizados.
 *   3. Enmascaramiento total: jamás se imprime un secreto en claro.
 *   4. Comportamiento fail-closed: finaliza con código 0 únicamente si el 100%
 *      de las comprobaciones pasa; finaliza con código 1 ante cualquier inconsistencia.
 */
import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  scanText,
  scanGitHistory,
  normalizePath,
  parseSource,
  validateBaseline,
  validateAllowlist,
  loadJsonList,
  mask,
} from './scan-secrets.mjs'

export function auditBaseline(options = {}) {
  const execFn = options.execFn || execSync
  const readFn = options.readFn || readFileSync
  const baselinePath = options.baselinePath || resolve('scripts/security/secret-baseline.json')
  const allowlistPath = options.allowlistPath || resolve('scripts/security/secret-allowlist.json')
  const runHistoryScan = options.scanHistory !== false

  let baselineEntries
  if (options.baselineEntries && Array.isArray(options.baselineEntries)) {
    baselineEntries = options.baselineEntries
  } else if (!existsSync(baselinePath)) {
    throw new Error(`Archivo baseline no encontrado: ${baselinePath}`)
  } else {
    try {
      const content = readFn(baselinePath, 'utf8')
      baselineEntries = JSON.parse(content)
    } catch (err) {
      throw new Error(`JSON de baseline corrupto o inválido: ${err.message}`)
    }
  }
  validateBaseline(baselineEntries)

  let allowlistEntries = []
  if (options.allowlistEntries && Array.isArray(options.allowlistEntries)) {
    allowlistEntries = options.allowlistEntries
  } else if (existsSync(allowlistPath)) {
    try {
      const content = readFn(allowlistPath, 'utf8')
      allowlistEntries = JSON.parse(content)
    } catch (err) {
      allowlistEntries = []
    }
  }
  if (allowlistEntries.length > 0) {
    validateAllowlist(allowlistEntries)
  }

  // -------------------------------------------------------------------------
  // 1. Auditoría directa de las entradas del baseline
  // -------------------------------------------------------------------------
  const directAuditResults = []
  const duplicates = []
  const seenEntries = new Set()

  // Carga eficiente de commits válidos del repositorio para evitar sobrecarga de subprocesos
  const validCommits = new Set()
  try {
    const revOutput = execFn('git rev-list --all', { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    for (const line of revOutput.split('\n')) {
      const c = line.trim().toLowerCase()
      if (c) validCommits.add(c)
    }
  } catch (err) {
    // Si falla execFn (e.g. en mocks controlados), fallback a comprobación individual
  }

  // Caché de blobs por (commit:file) para deduplicar lecturas de Git
  const blobCache = new Map()

  for (let idx = 0; idx < baselineEntries.length; idx++) {
    const entry = baselineEntries[idx]
    const key = `${entry.commit.toLowerCase()}:${normalizePath(entry.file)}:${entry.category}:${entry.fingerprint.toLowerCase()}`

    if (seenEntries.has(key)) {
      duplicates.push({ index: idx, entry, key })
    }
    seenEntries.add(key)

    let commitExists = false
    let fileExists = false
    let findingExists = false
    let detectedFindings = []
    let reason = ''

    // Validar SHA de 40 caracteres hexadecimales
    if (!/^[0-9a-fA-F]{40}$/.test(entry.commit)) {
      reason = `SHA inválido: ${entry.commit}`
    } else {
      const commitLower = entry.commit.toLowerCase()
      if (validCommits.has(commitLower)) {
        commitExists = true
      } else {
        try {
          const type = execFn(`git cat-file -t ${entry.commit}`, { encoding: 'utf8' }).trim()
          if (type === 'commit') commitExists = true
          else reason = `Objeto Git no es un commit: ${type}`
        } catch (err) {
          reason = `Commit no existe en el repositorio: ${entry.commit}`
        }
      }
    }

    if (commitExists) {
      const normFile = normalizePath(entry.file)
      const blobKey = `${entry.commit.toLowerCase()}:${normFile}`

      let blobContent
      let blobError = null

      if (blobCache.has(blobKey)) {
        const cached = blobCache.get(blobKey)
        blobContent = cached.blobContent
        blobError = cached.blobError
        fileExists = cached.fileExists
      } else {
        try {
          blobContent = execFn(`git show ${entry.commit}:${JSON.stringify(entry.file)}`, {
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
          })
          fileExists = true
          blobCache.set(blobKey, { fileExists: true, blobContent, blobError: null })
        } catch (err) {
          blobError = err.message
          fileExists = false
          blobCache.set(blobKey, { fileExists: false, blobContent: null, blobError })
        }
      }

      if (!fileExists) {
        reason = `Archivo ${entry.file} no existía en el commit ${entry.commit}: ${blobError || 'no encontrado'}`
      } else if (blobContent) {
        const scanned = scanText(blobContent, `commit ${entry.commit} (${normFile})`)
        detectedFindings = scanned.filter(
          (f) =>
            f.pattern === entry.category &&
            f.fingerprint.toLowerCase() === entry.fingerprint.toLowerCase()
        )
        if (detectedFindings.length > 0) {
          findingExists = true
        } else {
          reason = `No se detectó hallazgo con categoría ${entry.category} y huella ${entry.fingerprint} en el archivo`
        }
      }
    }

    // Clasificación individual de la entrada
    let classification = 'INVALID'
    if (commitExists && fileExists && findingExists) {
      const isSynthetic =
        entry.file.startsWith('tests/') ||
        entry.file.startsWith('scripts/security/') ||
        entry.status === 'synthetic-test-fixture'
      classification = isSynthetic ? 'SYNTHETIC' : 'VERIFIED'
    }

    directAuditResults.push({
      index: idx,
      commit: entry.commit,
      file: entry.file,
      category: entry.category,
      fingerprint: entry.fingerprint,
      status: entry.status,
      rotation: entry.rotation,
      commitExists,
      fileExists,
      findingExists,
      classification,
      reason,
      findingsCount: detectedFindings.length,
    })
  }

  const verified = directAuditResults.filter((r) => r.classification === 'VERIFIED')
  const synthetic = directAuditResults.filter((r) => r.classification === 'SYNTHETIC')
  const invalid = directAuditResults.filter((r) => r.classification === 'INVALID')

  // -------------------------------------------------------------------------
  // 2. Auditoría inversa: cotejo exhaustivo con el historial Git
  // -------------------------------------------------------------------------
  const matchedBaselineIndices = new Set()
  const unauthorizedFindings = []
  let totalHistoryFindings = 0
  let historyFindingsMatchingBaseline = 0
  let historyFindingsMatchingAllowlist = 0

  if (runHistoryScan) {
    const historyFindings = scanGitHistory({ execFn })
    totalHistoryFindings = historyFindings.length

    for (const h of historyFindings) {
      const src = parseSource(h.source)
      if (!src.isHistory || !src.commit) {
        unauthorizedFindings.push(h)
        continue
      }

      const normFile = normalizePath(src.file)

      // Verificar correspondencia con baseline
      let matchedInBaseline = false
      baselineEntries.forEach((b, bIdx) => {
        if (
          src.commit.toLowerCase() === b.commit.toLowerCase() &&
          normFile === normalizePath(b.file) &&
          h.pattern === b.category &&
          h.fingerprint.toLowerCase() === b.fingerprint.toLowerCase()
        ) {
          matchedBaselineIndices.add(bIdx)
          matchedInBaseline = true
        }
      })

      if (matchedInBaseline) {
        historyFindingsMatchingBaseline++
        continue
      }

      // Si no coincide con baseline, verificar si está justificado en allowlist
      const matchedInAllowlist = allowlistEntries.some(
        (a) =>
          normFile === normalizePath(a.file) &&
          h.pattern === a.category &&
          h.fingerprint.toLowerCase() === a.fingerprint.toLowerCase()
      )

      if (matchedInAllowlist) {
        historyFindingsMatchingAllowlist++
      } else {
        unauthorizedFindings.push(h)
      }
    }
  }

  // Registros huérfanos: entradas en baseline que no corresponden a ningún hallazgo del historial
  const orphanedEntries = []
  for (let i = 0; i < baselineEntries.length; i++) {
    if (runHistoryScan && !matchedBaselineIndices.has(i)) {
      orphanedEntries.push({ index: i, entry: baselineEntries[i] })
    }
  }

  return {
    total: baselineEntries.length,
    verified,
    synthetic,
    invalid,
    duplicates,
    directAuditResults,
    totalHistoryFindings,
    historyFindingsMatchingBaseline,
    historyFindingsMatchingAllowlist,
    unauthorizedFindings,
    orphanedEntries,
  }
}

export function runCli() {
  try {
    console.log('🔍 [AUDITORÍA DE BASELINE] Iniciando auditoría directa e inversa de seguridad...')
    const result = auditBaseline()

    console.log('\n================================================================================')
    console.log('📊 REPORTE CONSOLIDADO DE AUDITORÍA DE BASELINE DE SECRETOS')
    console.log('================================================================================')
    console.log(`• Total de entradas en baseline:                ${result.total}`)
    console.log(`• Entradas VERIFIED (secretos históricos reales):  ${result.verified.length}`)
    console.log(`• Entradas SYNTHETIC (fixtures controlados):       ${result.synthetic.length}`)
    console.log(`• Entradas INVALID (fallos de correspondencia):     ${result.invalid.length}`)
    console.log(`• Registros duplicados:                           ${result.duplicates.length}`)
    console.log(`• Registros huérfanos en baseline:                ${result.orphanedEntries.length}`)
    console.log(`• Total de hallazgos en historial Git:             ${result.totalHistoryFindings}`)
    console.log(`• Hallazgos autorizados por baseline:              ${result.historyFindingsMatchingBaseline}`)
    console.log(`• Hallazgos autorizados por allowlist:             ${result.historyFindingsMatchingAllowlist}`)
    console.log(`• Hallazgos históricos no autorizados:             ${result.unauthorizedFindings.length}`)

    if (result.duplicates.length > 0) {
      console.error('\n❌ ENTRADAS DUPLICADAS DETECTADAS EN EL BASELINE:')
      for (const d of result.duplicates) {
        console.error(`   [Índice ${d.index}] ${d.key}`)
      }
    }

    if (result.invalid.length > 0) {
      console.error('\n❌ ENTRADAS INVÁLIDAS DETECTADAS EN EL BASELINE:')
      for (const inv of result.invalid) {
        console.error(
          `   [Índice ${inv.index}] Commit: ${inv.commit} | Archivo: ${inv.file} | Patrón: ${inv.category}:${inv.fingerprint} -> Causa: ${inv.reason}`
        )
      }
    }

    if (result.orphanedEntries.length > 0) {
      console.error('\n❌ ENTRADAS HUÉRFANAS DETECTADAS (sin correspondencia en historial Git):')
      for (const orph of result.orphanedEntries) {
        console.error(
          `   [Índice ${orph.index}] Commit: ${orph.entry.commit} | Archivo: ${orph.entry.file} | Patrón: ${orph.entry.category}:${orph.entry.fingerprint}`
        )
      }
    }

    if (result.unauthorizedFindings.length > 0) {
      console.error('\n❌ HALLAZGOS HISTÓRICOS NO AUTORIZADOS:')
      for (const unauth of result.unauthorizedFindings) {
        console.error(
          `   Fuente: ${unauth.source}:${unauth.line} | Patrón: ${unauth.pattern} | Huella: ${unauth.fingerprint} | Vista previa: ${mask(unauth.preview)}`
        )
      }
    }

    const hasErrors =
      result.invalid.length > 0 ||
      result.duplicates.length > 0 ||
      result.orphanedEntries.length > 0 ||
      result.unauthorizedFindings.length > 0

    if (hasErrors) {
      console.error('\n❌ RESULTADO FINAL: AUDITORÍA DE BASELINE RECHAZADA (FAIL-CLOSED).')
      process.exit(1)
    }

    console.log('\n================================================================================')
    console.log('✅ RESULTADO FINAL: AUDITORÍA DE BASELINE 100% SATISFACTORIA (APROBADO)')
    console.log('================================================================================')
    process.exit(0)
  } catch (err) {
    console.error(`\n❌ ERROR EN AUDITORÍA DE BASELINE (FAIL-CLOSED): ${err.message}`)
    process.exit(1)
  }
}

if (process.argv[1] && process.argv[1].endsWith('audit-baseline.mjs')) {
  runCli()
}
