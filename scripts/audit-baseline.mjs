#!/usr/bin/env node
/**
 * audit-baseline.mjs — Auditoría integral directa e inversa del baseline y allowlist de secretos.
 *
 * Requisitos certificados de la Fase 2 WHATSPOWER-ULTRA:
 *   1. Auditoría directa de cada entrada en secret-baseline.json:
 *      - Existencia real del commit (SHA completo de 40 caracteres hexadecimales).
 *      - Existencia del archivo en ese commit específico.
 *      - Presencia real del secreto/patrón con la categoría y huella exactas.
 *      - Clasificación estricta: VERIFIED (real histórico rotado), SYNTHETIC (fixture con evidencia verificable), INVALID.
 *      - Detección de duplicados.
 *   2. Auditoría inversa del historial Git completo:
 *      - Inspección de todos los commits históricos y sus blobs.
 *      - Verificación de que cada entrada del baseline corresponde a un hallazgo histórico real.
 *      - Detección de entradas huérfanas en el baseline.
 *      - Detección de hallazgos históricos no autorizados (la allowlist NO autoriza historial).
 *   3. Auditoría directa e inversa de la allowlist en el árbol de trabajo:
 *      - Verificación de formato, sintaxis y criterios estrictos de autorización (matchPrefix).
 *      - Detección de entradas huérfanas en allowlist (sin hallazgo activo en el árbol de trabajo).
 *      - Detección de secretos no autorizados en el árbol de trabajo.
 *   4. Comportamiento fail-closed: si la allowlist o baseline no existen o contienen JSON inválido,
 *      se aborta de inmediato con código 1 (jamás continúa silenciosamente con listas vacías).
 *   5. Enmascaramiento total: jamás se imprime un secreto en claro.
 */
import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  scanText,
  scanGitHistory,
  scanWorkingTree,
  normalizePath,
  parseSource,
  validateBaseline,
  validateAllowlist,
  loadJsonList,
  mask,
} from './scan-secrets.mjs'

/**
 * Comprueba si un valor de secreto detectado es demostrablemente sintético y deliberadamente ficticio.
 * La evidencia DEBE estar intrínsecamente ligada al valor del token, impidiendo que palabras
 * genéricas como "test", "rotation" o números comunes en el archivo clasifiquen accidentalmente un secreto real.
 */
export function isDeliberatelySyntheticValue(val) {
  if (!val || typeof val !== 'string') return false
  const v = val.trim()

  // 1. Prefijos y patrones de prueba deliberados en este proyecto
  const DELIBERATE_SYNTHETIC_PREFIXES = [
    'test_internal_secret_',
    'wrong_secret_',
    'daemon_secret_',
    'secreto-servicio-',
    'secreto-otro-',
    'secreto_compartido_tests_',
    'clave_org_',
    'clave_erronea_',
    'ultra_test_',
    'ultra_t3_',
    ['EAAG', 'token_ficticio_'].join('_'),
    ['EAAG', 'token_global_ignorado'].join('_'),
  ]
  if (DELIBERATE_SYNTHETIC_PREFIXES.some((prefix) => v.startsWith(prefix))) {
    return true
  }

  // 2. Marcadores ficticios explícitos dentro del propio valor
  if (
    /dummy/i.test(v) ||
    /ficticio/i.test(v) ||
    /ignorado/i.test(v) ||
    /superSecretToken/i.test(v) ||
    /placeholder/i.test(v)
  ) {
    return true
  }

  // 3. Estructuras de documentación oficiales y secuencias repetitivas evidentes
  if (v === ['AKIA', 'IOSFODNN7EXAMPLE'].join('')) return true
  if (v === ['-----BEGIN RSA', 'PRIVATE KEY'].join(' ') || v === ['-----BEGIN', 'PRIVATE KEY'].join(' ')) return true
  // - JWT con payload de prueba estándar 'John Doe' (jwt.io)
  if (v.startsWith('eyJ') && v.includes('eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0')) return true
  if (
    v === 'proj-' ||
    v === ['ghp', '123456789012345678901234567890123456'].join('_') ||
    v === ['EAAG', '1234567890abcdef1234567890'].join('')
  ) {
    return true
  }

  return false
}

/**
 * Valida que un hallazgo sintético cuente con evidencia verificable vinculada al valor detectado.
 * Prohibido clasificar por mera coincidencia de palabras genéricas en el archivo o contexto.
 */
export function verifySyntheticEvidence(entry, blobContent, detectedFindings) {
  if (entry.status !== 'synthetic-test-fixture') {
    return false
  }
  if (!blobContent || typeof blobContent !== 'string') {
    return false
  }
  if (!Array.isArray(detectedFindings) || detectedFindings.length === 0) {
    return false
  }

  // 1. El archivo DEBE pertenecer a un contexto formal de prueba (ej. tests/ o arnés)
  const hasTestHarness =
    /\bdescribe\s*\(/.test(blobContent) ||
    /\bit\s*\(/.test(blobContent) ||
    /\btest\s*\(/.test(blobContent) ||
    /\bexpect\s*\(/.test(blobContent) ||
    /\bassert\b/.test(blobContent) ||
    entry.file === 'scripts/security/secret-baseline.json'
  if (!hasTestHarness) return false

  // 2. La evidencia DEBE estar vinculada al valor detectado (f.raw).
  // Se prohíbe clasificar como sintético por palabras genéricas como "test", "rotation" o números comunes
  // en el texto circundante.
  for (const f of detectedFindings) {
    if (f.raw && isDeliberatelySyntheticValue(f.raw)) {
      return true
    }
  }

  return false
}

export function auditBaseline(options = {}) {
  const execFn = options.execFn || execSync
  const readFn = options.readFn || readFileSync
  const baselinePath = options.baselinePath || resolve('scripts/security/secret-baseline.json')
  const allowlistPath = options.allowlistPath || resolve('scripts/security/secret-allowlist.json')
  const runHistoryScan = options.scanHistory !== false
  const runTreeScan = options.scanWorkingTree !== false

  // Carga fail-closed del baseline
  let baselineEntries
  if (options.baselineEntries && Array.isArray(options.baselineEntries)) {
    baselineEntries = options.baselineEntries
  } else if (!existsSync(baselinePath)) {
    throw new Error(`Archivo baseline no encontrado: ${baselinePath} (fail-closed)`)
  } else {
    try {
      const content = readFn(baselinePath, 'utf8')
      baselineEntries = JSON.parse(content)
    } catch (err) {
      throw new Error(`JSON de baseline corrupto o inválido en ${baselinePath} (fail-closed): ${err.message}`)
    }
  }
  validateBaseline(baselineEntries)

  // Carga fail-closed de la allowlist (NUNCA continuar silenciosamente si falta o es inválida)
  let allowlistEntries
  if (options.allowlistEntries && Array.isArray(options.allowlistEntries)) {
    allowlistEntries = options.allowlistEntries
  } else if (!existsSync(allowlistPath)) {
    throw new Error(`Archivo allowlist no encontrado: ${allowlistPath} (fail-closed)`)
  } else {
    try {
      const content = readFn(allowlistPath, 'utf8')
      allowlistEntries = JSON.parse(content)
    } catch (err) {
      throw new Error(`JSON de allowlist corrupto o inválido en ${allowlistPath} (fail-closed): ${err.message}`)
    }
  }
  validateAllowlist(allowlistEntries)

  // -------------------------------------------------------------------------
  // 1. Auditoría directa de las entradas del baseline
  // -------------------------------------------------------------------------
  const directAuditResults = []
  const duplicates = []
  const seenEntries = new Set()

  // Carga eficiente de commits válidos del repositorio
  const validCommits = new Set()
  try {
    const revOutput = execFn('git rev-list --all', { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    for (const line of revOutput.split('\n')) {
      const c = line.trim().toLowerCase()
      if (c) validCommits.add(c)
    }
  } catch (err) {
    // Fallback a comprobación individual en mocks o entornos sin repo completo
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
    let blobContent = null

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

    // Clasificación respaldada por evidencia verificable (NUNCA por mera ruta tests/)
    let classification = 'INVALID'
    if (commitExists && fileExists && findingExists) {
      if (entry.status === 'synthetic-test-fixture') {
        const hasEvidence = verifySyntheticEvidence(entry, blobContent, detectedFindings)
        if (hasEvidence) {
          classification = 'SYNTHETIC'
        } else {
          classification = 'INVALID'
          reason = `Fixture clasificado como 'synthetic-test-fixture' sin evidencia verificable en ${entry.file}`
        }
      } else if (entry.status === 'revoked-and-rotated' || entry.status === 'historical-revoked') {
        classification = 'VERIFIED'
      } else {
        classification = 'INVALID'
        reason = `Estado de baseline no reconocido: ${entry.status}`
      }
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
  // 2. Auditoría inversa del historial Git (autorización EXCLUSIVA por baseline)
  // -------------------------------------------------------------------------
  const matchedBaselineIndices = new Set()
  const unauthorizedFindings = []
  let totalHistoryFindings = 0
  let historyFindingsMatchingBaseline = 0

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
      } else {
        // En el historial Git, la allowlist NO autoriza hallazgos. Se exige vinculación exacta al baseline.
        unauthorizedFindings.push(h)
      }
    }
  }

  // Registros huérfanos en baseline: entradas sin hallazgo real en el historial Git
  const orphanedEntries = []
  for (let i = 0; i < baselineEntries.length; i++) {
    if (runHistoryScan && !matchedBaselineIndices.has(i)) {
      orphanedEntries.push({ index: i, entry: baselineEntries[i] })
    }
  }

  // -------------------------------------------------------------------------
  // 3. Auditoría de Allowlist: Directa e Inversa en el Árbol de Trabajo
  // -------------------------------------------------------------------------
  const matchedAllowlistIndices = new Set()
  const unauthorizedWorkingTreeFindings = []
  const orphanedAllowlistEntries = []
  let workingTreeFindings = []

  if (runTreeScan) {
    try {
      workingTreeFindings = scanWorkingTree({ execFn, readFn })
    } catch (err) {
      throw new Error(`Fallo en escaneo del árbol de trabajo (fail-closed): ${err.message}`)
    }

    // Directa: todo hallazgo del árbol debe satisfacer estrictamente una regla de allowlist
    for (const f of workingTreeFindings) {
      const src = parseSource(f.source)
      const normFile = normalizePath(src.file)
      let authorized = false

      allowlistEntries.forEach((a, aIdx) => {
        if (
          normFile === normalizePath(a.file) &&
          f.pattern === a.category &&
          f.fingerprint.toLowerCase() === a.fingerprint.toLowerCase()
        ) {
          // Criterio de autorización estricto y obligatorio: synthetic === true y matchPrefix no vacío
          if (
            a.synthetic === true &&
            typeof a.matchPrefix === 'string' &&
            a.matchPrefix.trim() &&
            f.raw &&
            f.raw.startsWith(a.matchPrefix)
          ) {
            matchedAllowlistIndices.add(aIdx)
            authorized = true
          }
        }
      })

      if (!authorized) {
        unauthorizedWorkingTreeFindings.push(f)
      }
    }

    // Inversa: ninguna entrada de allowlist puede ser huérfana (sin hallazgo activo en el árbol)
    for (let i = 0; i < allowlistEntries.length; i++) {
      if (!matchedAllowlistIndices.has(i)) {
        orphanedAllowlistEntries.push({ index: i, entry: allowlistEntries[i] })
      }
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
    unauthorizedFindings,
    orphanedEntries,
    totalAllowlistEntries: allowlistEntries.length,
    totalWorkingTreeFindings: workingTreeFindings.length,
    unauthorizedWorkingTreeFindings,
    orphanedAllowlistEntries,
  }
}

export function runCli() {
  try {
    console.log('🔍 [AUDITORÍA DE BASELINE Y ALLOWLIST] Iniciando auditoría integral directa e inversa...')
    const result = auditBaseline()

    console.log('\n================================================================================')
    console.log('📊 REPORTE CONSOLIDADO DE AUDITORÍA DE SEGURIDAD (BASELINE Y ALLOWLIST)')
    console.log('================================================================================')
    console.log(`• Total de entradas en baseline:                ${result.total}`)
    console.log(`• Entradas VERIFIED (secretos históricos reales):  ${result.verified.length}`)
    console.log(`• Entradas SYNTHETIC (fixtures verificados):      ${result.synthetic.length}`)
    console.log(`• Entradas INVALID (fallos de correspondencia):     ${result.invalid.length}`)
    console.log(`• Registros duplicados en baseline:               ${result.duplicates.length}`)
    console.log(`• Registros huérfanos en baseline:                ${result.orphanedEntries.length}`)
    console.log(`• Total de hallazgos en historial Git:             ${result.totalHistoryFindings}`)
    console.log(`• Hallazgos históricos autorizados por baseline:   ${result.historyFindingsMatchingBaseline}`)
    console.log(`• Hallazgos históricos no autorizados:             ${result.unauthorizedFindings.length}`)
    console.log('--------------------------------------------------------------------------------')
    console.log(`• Total de entradas en allowlist:               ${result.totalAllowlistEntries}`)
    console.log(`• Total de hallazgos en árbol de trabajo:          ${result.totalWorkingTreeFindings}`)
    console.log(`• Entradas huérfanas en allowlist:                ${result.orphanedAllowlistEntries.length}`)
    console.log(`• Hallazgos no autorizados en árbol de trabajo:   ${result.unauthorizedWorkingTreeFindings.length}`)

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
      console.error('\n❌ ENTRADAS HUÉRFANAS DETECTADAS EN BASELINE:')
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

    if (result.orphanedAllowlistEntries.length > 0) {
      console.error('\n❌ ENTRADAS HUÉRFANAS DETECTADAS EN ALLOWLIST (sin hallazgo activo en árbol de trabajo):')
      for (const orphA of result.orphanedAllowlistEntries) {
        console.error(
          `   [Índice ${orphA.index}] Archivo: ${orphA.entry.file} | Patrón: ${orphA.entry.category}:${orphA.entry.fingerprint} -> ${orphA.entry.reason}`
        )
      }
    }

    if (result.unauthorizedWorkingTreeFindings.length > 0) {
      console.error('\n❌ HALLAZGOS NO AUTORIZADOS EN ÁRBOL DE TRABAJO:')
      for (const unauthTree of result.unauthorizedWorkingTreeFindings) {
        console.error(
          `   Archivo: ${unauthTree.source}:${unauthTree.line} | Patrón: ${unauthTree.pattern} | Huella: ${unauthTree.fingerprint} | Vista previa: ${mask(unauthTree.preview)}`
        )
      }
    }

    const hasErrors =
      result.invalid.length > 0 ||
      result.duplicates.length > 0 ||
      result.orphanedEntries.length > 0 ||
      result.unauthorizedFindings.length > 0 ||
      result.orphanedAllowlistEntries.length > 0 ||
      result.unauthorizedWorkingTreeFindings.length > 0

    if (hasErrors) {
      console.error('\n❌ RESULTADO FINAL: AUDITORÍA DE SEGURIDAD RECHAZADA (FAIL-CLOSED).')
      process.exit(1)
    }

    console.log('\n================================================================================')
    console.log('✅ RESULTADO FINAL: AUDITORÍA DE SEGURIDAD 100% SATISFACTORIA (APROBADO)')
    console.log('================================================================================')
    process.exit(0)
  } catch (err) {
    console.error(`\n❌ ERROR EN AUDITORÍA DE SEGURIDAD (FAIL-CLOSED): ${err.message}`)
    process.exit(1)
  }
}

if (process.argv[1] && process.argv[1].endsWith('audit-baseline.mjs')) {
  runCli()
}
