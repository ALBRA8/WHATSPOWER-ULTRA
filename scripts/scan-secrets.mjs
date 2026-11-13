#!/usr/bin/env node
/**
 * scan-secrets.mjs — Escáner de secretos y credenciales para WHATSPOWER-ULTRA.
 *
 * Detecta patrones de tokens y credenciales sensibles en archivos tracked por Git
 * y opcionalmente en el historial completo de commits (--history).
 *
 * Controles de seguridad certificados:
 *   - Idempotencia estricta: expresiones regulares sin bandera 'g' en .test()/.exec().
 *   - Sin exclusiones de carpetas globales: allowlist y baseline se auditan activamente.
 *   - Enmascaramiento completo en logs (jamás se imprime un secreto en claro).
 *   - Validación de integridad estricta en allowlist y baseline (formato, tipos, hashes).
 *   - Coincidencia de ruta exacta normalizada (prohibido suffix matching / endsWith).
 *   - Excepciones históricas ligadas a la cuádrupla (commit exacto, archivo exacto, categoría, huella).
 *   - Comportamiento fail-closed: cualquier fallo de Git, JSON inválido o lectura inaccesible
 *     aborta el proceso con código de salida distinto de cero (código 1).
 */
import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'

export const ALLOW_MARK = 'scan-secrets:allow'

/**
 * Patrones de detección SIN bandera 'g' para garantizar idempotencia y evitar
 * que el puntero lastIndex genere falsos negativos en líneas consecutivas.
 */
export const PATTERNS = [
  { id: 'JWT', desc: 'Token JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { id: 'GITHUB_PAT', desc: 'GitHub Personal Access Token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { id: 'AWS_ACCESS_KEY', desc: 'AWS Access Key ID', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'SLACK_TOKEN', desc: 'Token de Slack', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'GOOGLE_API_KEY', desc: 'Google Cloud API Key', re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { id: 'STRIPE_SECRET', desc: 'Clave Secreta Stripe', re: /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}\b/ },
  { id: 'OPENAI_KEY', desc: 'OpenAI API Key', re: /\bsk-(proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { id: 'ANTHROPIC_KEY', desc: 'Anthropic API Key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'META_TOKEN', desc: 'Meta / WhatsApp Access Token', re: /\bEAAG[0-9A-Za-z_-]{20,}\b/ },
  { id: 'PRIVATE_KEY', desc: 'Clave Privada PEM', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY/ },
  {
    id: 'CONFIG_SECRET',
    desc: 'Asignación literal de secreto de configuración',
    re: /(?:password|passwd|secret|api[_-]?key|apikey|auth[_-]?token|access[_-]?token)["']?\s*[:=]\s*["']([A-Za-z0-9_+/=.,:!#$%^&*()-]{16,})["']/i,
  },
]

// Valores dummy conocidos de prueba (literales o patrones de prueba mínimos y seguros)
const DUMMY_HINTS = [
  /^REDACTED$/i, /^placeholder$/i, /^your[_-]/i, /^example[_-]/i, /^change?me$/i, /^dummy/i,
  /^xxx+$/i, /^<[^>]+>$/, /^\$\{.*\}$/, /^ci-test-/i, /^ci-only-/i, /^ultra_test_key_/i,
  /^ultra_contract_admin_/i, /^test-/i,
]

const SKIP_FILE_EXTENSIONS = /\.(png|jpe?g|gif|webp|pdf|zip|gz|ico|woff2?|ttf|db|sqlite3?|lock)$/i
const SKIP_FILENAMES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'])

export function normalizePath(filePath) {
  if (typeof filePath !== 'string') return ''
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

export function shouldSkipFile(filePath) {
  const normalized = normalizePath(filePath)
  if (SKIP_FILE_EXTENSIONS.test(normalized)) return true
  if (SKIP_FILENAMES.has(normalized)) return true
  return false
}

export function mask(value) {
  if (!value || typeof value !== 'string') return '[REDACTED]'
  if (value.length <= 8) return '****'
  return `${value.slice(0, 4)}…(${value.length} caracteres)`
}

export function computeFingerprint(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

/**
 * Escanea un texto línea por línea usando expresiones regulares sin bandera 'g',
 * garantizando cero falsos negativos causados por lastIndex.
 */
export function scanText(text, source = 'inline') {
  const findings = []
  const lines = text.split('\n')

  lines.forEach((line, idx) => {
    const lineNo = idx + 1
    if (line.includes(ALLOW_MARK)) return

    for (const pattern of PATTERNS) {
      const match = pattern.re.exec(line)
      if (match) {
        const raw = (match[1] || match[0]).trim()
        if (DUMMY_HINTS.some((h) => h.test(raw))) continue

        const fingerprint = computeFingerprint(raw)
        findings.push({
          pattern: pattern.id,
          desc: pattern.desc,
          source: normalizePath(source),
          line: lineNo,
          preview: mask(raw),
          fingerprint,
          raw,
        })
      }
    }
  })

  return findings
}

export function validateAllowlist(entries) {
  if (!Array.isArray(entries)) {
    throw new Error('Allowlist inválida: el contenido raíz debe ser un array JSON (fail-closed)')
  }
  const validCategories = new Set(PATTERNS.map((p) => p.id))
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (!e || typeof e !== 'object') {
      throw new Error(`Allowlist entrada #${i} inválida: debe ser un objeto JSON (fail-closed)`)
    }
    if (typeof e.file !== 'string' || !e.file.trim() || e.file === '*' || e.file.includes('*')) {
      throw new Error(`Allowlist entrada #${i} inválida: 'file' debe ser una ruta específica y no comodín ('*')`)
    }
    if (typeof e.category !== 'string' || !validCategories.has(e.category)) {
      throw new Error(`Allowlist entrada #${i} inválida: categoría desconocida '${e.category}'`)
    }
    if (typeof e.fingerprint !== 'string' || !/^[0-9a-f]{12}$/i.test(e.fingerprint)) {
      throw new Error(`Allowlist entrada #${i} inválida: huella sha256 inválida '${e.fingerprint}' (debe tener 12 hex)`)
    }
    if (typeof e.reason !== 'string' || !e.reason.trim()) {
      throw new Error(`Allowlist entrada #${i} inválida: 'reason' es obligatoria y debe justificar la excepción`)
    }
    if (typeof e.matchPrefix !== 'string' || !e.matchPrefix.trim()) {
      throw new Error(`Allowlist entrada #${i} inválida: 'matchPrefix' es obligatorio y debe ser una cadena no vacía (fail-closed)`)
    }
    if (e.synthetic !== true) {
      throw new Error(`Allowlist entrada #${i} inválida: 'synthetic' es obligatorio y debe ser estrictamente true (fail-closed)`)
    }
  }
  return true
}

export function validateBaseline(entries) {
  if (!Array.isArray(entries)) {
    throw new Error('Baseline inválido: el contenido raíz debe ser un array JSON (fail-closed)')
  }
  const validCategories = new Set(PATTERNS.map((p) => p.id))
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (!e || typeof e !== 'object') {
      throw new Error(`Baseline entrada #${i} inválida: debe ser un objeto JSON (fail-closed)`)
    }
    if (typeof e.commit !== 'string' || !/^[0-9a-fA-F]{40}$/.test(e.commit)) {
      throw new Error(`Baseline entrada #${i} inválida: 'commit' debe ser un hash Git SHA-1 completo de exactamente 40 caracteres hexadecimales`)
    }
    if (typeof e.file !== 'string' || !e.file.trim() || e.file.includes('*')) {
      throw new Error(`Baseline entrada #${i} inválida: 'file' debe ser una ruta de archivo específica`)
    }
    if (typeof e.category !== 'string' || !validCategories.has(e.category)) {
      throw new Error(`Baseline entrada #${i} inválida: categoría desconocida '${e.category}'`)
    }
    if (typeof e.fingerprint !== 'string' || !/^[0-9a-f]{12}$/i.test(e.fingerprint)) {
      throw new Error(`Baseline entrada #${i} inválida: huella sha256 inválida '${e.fingerprint}'`)
    }
  }
  return true
}

export function loadJsonList(filePath, required = true) {
  if (!existsSync(filePath)) {
    if (required) throw new Error(`Archivo de seguridad no encontrado: ${filePath} (fail-closed)`)
    return []
  }
  try {
    const content = readFileSync(filePath, 'utf8')
    return JSON.parse(content)
  } catch (err) {
    throw new Error(`Error al leer o parsear JSON en ${filePath} (fail-closed): ${err.message}`)
  }
}

export function filterAllowlist(findings, allowlistOrPath) {
  const entries = Array.isArray(allowlistOrPath) ? allowlistOrPath : loadJsonList(allowlistOrPath, true)
  validateAllowlist(entries)
  const kept = []
  const excluded = []

  for (const f of findings) {
    const src = parseSource(f.source)
    // Coherencia con control histórico: la allowlist JAMÁS autoriza hallazgos del historial Git
    if (src.isHistory) {
      kept.push(f)
      continue
    }

    const normFile = normalizePath(src.file)
    const match = entries.find(
      (a) =>
        a.category === f.pattern &&
        a.fingerprint.toLowerCase() === f.fingerprint.toLowerCase() &&
        normFile === normalizePath(a.file)
    )

    if (match) {
      // Criterio de autorización estricto fail-closed:
      // 1. match.synthetic === true
      // 2. match.matchPrefix debe ser string no vacío
      // 3. f.raw debe ser obligatoriamente un string no vacío
      // 4. f.raw debe comenzar estrictamente con match.matchPrefix
      const hasValidRule =
        match.synthetic === true &&
        typeof match.matchPrefix === 'string' &&
        match.matchPrefix.trim().length > 0

      const hasValidRawMatch =
        typeof f.raw === 'string' &&
        f.raw.trim().length > 0 &&
        f.raw.startsWith(match.matchPrefix)

      if (!hasValidRule || !hasValidRawMatch) {
        kept.push(f)
        continue
      }
      excluded.push({ ...f, reason: match.reason, authorizedBy: 'allowlist' })
    } else {
      kept.push(f)
    }
  }

  return { kept, excluded }
}

export function parseSource(source) {
  const m = source.match(/^commit\s+([0-9a-fA-F]{40})\s+\((.+)\)$/)
  if (m) {
    return { isHistory: true, commit: m[1].toLowerCase(), file: normalizePath(m[2]) }
  }
  return { isHistory: false, commit: '', file: normalizePath(source) }
}

export function filterBaseline(findings, baselineOrPath) {
  const entries = Array.isArray(baselineOrPath) ? baselineOrPath : loadJsonList(baselineOrPath)
  validateBaseline(entries)
  const known = []
  const isNew = []

  for (const f of findings) {
    const src = parseSource(f.source)
    if (!src.isHistory || !src.commit) {
      isNew.push(f)
      continue
    }
    const normFile = normalizePath(src.file)
    const match = entries.find(
      (b) =>
        b.category === f.pattern &&
        b.fingerprint.toLowerCase() === f.fingerprint.toLowerCase() &&
        src.commit.toLowerCase() === b.commit.toLowerCase() &&
        normFile === normalizePath(b.file)
    )
    if (match) known.push({ ...f, status: match.status, rotation: match.rotation })
    else isNew.push(f)
  }

  return { known, isNew }
}

export function scanWorkingTree(options = {}) {
  const execFn = options.execFn || execSync
  const readFn = options.readFn || readFileSync
  let files = []
  try {
    files = execFn('git ls-files', { encoding: 'utf8' })
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean)
  } catch (err) {
    throw new Error(`Fallo de Git al listar archivos rastreados (fail-closed): ${err.message}`)
  }

  const findings = []
  for (const file of files) {
    if (shouldSkipFile(file)) continue
    const normFile = normalizePath(file)
    try {
      const content = readFn(file, 'utf8')
      findings.push(...scanText(content, normFile))
    } catch (err) {
      throw new Error(`No se pudo leer el archivo rastreado ${file} (fail-closed): ${err.message}`)
    }
  }

  return findings
}

export function scanGitHistory(options = {}) {
  const execFn = options.execFn || execSync
  const findings = []
  let commits = []
  try {
    commits = execFn('git rev-list --all', { encoding: 'utf8' })
      .split('\n')
      .map((c) => c.trim())
      .filter(Boolean)
  } catch (err) {
    throw new Error(`Fallo de Git al obtener historial de commits (fail-closed): ${err.message}`)
  }

  if (commits.length === 0) {
    throw new Error('Historial Git vacío o incompleto (shallow clone sin historial) — escaneo incompleto (fail-closed)')
  }

  console.log(`Auditoría de historial Git: escaneando ${commits.length} commits...`)
  const scannedBlobs = new Set()

  for (const commit of commits) {
    let files = []
    try {
      files = execFn(`git show ${commit} --format= --name-only --diff-filter=AM`, {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      })
        .split('\n')
        .map((f) => f.trim())
        .filter(Boolean)
    } catch (err) {
      throw new Error(`Error de Git al inspeccionar commit ${commit} (fail-closed): ${err.message}`)
    }

    for (const file of files) {
      if (shouldSkipFile(file)) continue
      const normFile = normalizePath(file)
      const blobKey = `${commit}:${normFile}`
      if (scannedBlobs.has(blobKey)) continue
      scannedBlobs.add(blobKey)

      try {
        const blob = execFn(`git show ${commit}:${JSON.stringify(file)}`, {
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
        })
        findings.push(...scanText(blob, `commit ${commit} (${normFile})`))
      } catch (err) {
        throw new Error(`Error al leer blob de Git para ${commit}:${normFile} (fail-closed): ${err.message}`)
      }
    }
  }

  return findings
}

function main() {
  try {
    const args = process.argv.slice(2)
    const doHistory = args.includes('--history')
    const allowlistPath = resolve('scripts/security/secret-allowlist.json')
    const baselinePath = resolve('scripts/security/secret-baseline.json')

    console.log('🔍 Iniciando escaneo de seguridad y detección de secretos en WHATSPOWER-ULTRA...')
    const treeFindings = scanWorkingTree()
    const { kept: activeViolations, excluded: allowedFindings } = filterAllowlist(treeFindings, allowlistPath)

    if (allowedFindings.length > 0) {
      console.log(`ℹ️  ${allowedFindings.length} hallazgo(s) justificado(s) en allowlist (${allowlistPath}):`)
      for (const a of allowedFindings) {
        console.log(`   [${a.pattern}] ${a.source}:${a.line} — ${a.reason}`)
      }
    }

    let historyViolations = []
    if (doHistory) {
      const historyFindings = scanGitHistory()
      const { isNew, known } = filterBaseline(historyFindings, baselinePath)
      if (known.length > 0) {
        console.log(`ℹ️  ${known.length} hallazgo(s) históricos conocidos en baseline (${baselinePath}):`)
        for (const k of known) {
          console.log(`   [${k.pattern}] ${k.source} (Estado: ${k.status})`)
        }
      }
      historyViolations = isNew
    }

    const totalFailures = activeViolations.length + historyViolations.length

    if (totalFailures > 0) {
      console.error(`\n❌ ESCÁNER DE SECRETOS DETUVO EL PROCESO: Se detectaron ${totalFailures} secreto(s) no autorizados:`)
      for (const v of activeViolations) {
        console.error(`   [ÁRBOL] ${v.pattern} en ${v.source}:${v.line} -> Vista previa: ${v.preview} [Huella: ${v.fingerprint}]`)
      }
      for (const h of historyViolations) {
        console.error(`   [HISTORIAL] ${h.pattern} en ${h.source}:${h.line} -> Vista previa: ${h.preview} [Huella: ${h.fingerprint}]`)
      }
      console.error('\nAcción requerida: Elimina las credenciales y rótalas inmediatamente.')
      process.exit(1)
    }

    console.log('✅ Escaneo de secretos completado: 0 secretos no autorizados detectados.')
    process.exit(0)
  } catch (err) {
    console.error(`\n❌ ESCÁNER DE SECRETOS FALLÓ (FAIL-CLOSED): ${err.message}`)
    process.exit(1)
  }
}

if (process.argv[1] && process.argv[1].endsWith('scan-secrets.mjs')) {
  main()
}
