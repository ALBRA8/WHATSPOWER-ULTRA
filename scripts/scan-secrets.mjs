#!/usr/bin/env node
/**
 * scan-secrets.mjs — Escáner de secretos y credenciales para WHATSPOWER-ULTRA.
 *
 * Detecta patrones de tokens y credenciales sensibles en archivos tracked por Git
 * y opcionalmente en el historial completo de commits (--history).
 *
 * Correcciones de seguridad aplicadas:
 *   - Cero falsos negativos por 'lastIndex': patrones sin bandera 'g' en .test() o
 *     instanciación limpia e idempotente por línea.
 *   - No se excluyen carpetas completas de tests ni documentación sin justificar.
 *   - Se enmascaran todas las credenciales encontradas (nunca se imprimen completas en logs).
 *   - Soporte para allowlist documentada y marcador de línea 'scan-secrets:allow'.
 *   - Soporte para escaneo de historial Git con baseline para commits históricos.
 */
import { execSync } from 'node:child_process'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
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

export function shouldSkipFile(filePath) {
  const normalized = filePath.replace(/\\/g, '/')
  if (SKIP_FILE_EXTENSIONS.test(normalized)) return true
  if (SKIP_FILENAMES.has(normalized)) return true
  // Las bases de datos de allowlist y baseline del escáner no se auto-escanean
  if (normalized.startsWith('scripts/security/')) return true
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
      // Uso de patrón sin 'g': .exec() y .test() no sufren de estado interno mutable
      const match = pattern.re.exec(line)
      if (match) {
        const raw = (match[1] || match[0]).trim()
        if (DUMMY_HINTS.some((h) => h.test(raw))) continue

        const fingerprint = computeFingerprint(raw)
        findings.push({
          pattern: pattern.id,
          desc: pattern.desc,
          source,
          line: lineNo,
          preview: mask(raw),
          fingerprint,
        })
      }
    }
  })

  return findings
}

export function loadJsonList(filePath) {
  try {
    if (existsSync(filePath)) {
      return JSON.parse(readFileSync(filePath, 'utf8'))
    }
  } catch {}
  return []
}

export function filterAllowlist(findings, allowlistPath) {
  const allowlist = loadJsonList(allowlistPath)
  const kept = []
  const excluded = []

  for (const f of findings) {
    const match = allowlist.find(
      (a) =>
        a.category === f.pattern &&
        a.fingerprint === f.fingerprint &&
        (f.source.replace(/\\/g, '/').endsWith(a.file.replace(/\\/g, '/')) || a.file === '*')
    )
    if (match) excluded.push({ ...f, reason: match.reason })
    else kept.push(f)
  }

  return { kept, excluded }
}

export function filterBaseline(findings, baselinePath) {
  const baseline = loadJsonList(baselinePath)
  const known = []
  const isNew = []

  for (const f of findings) {
    const match = baseline.find(
      (b) =>
        b.category === f.pattern &&
        b.fingerprint === f.fingerprint
    )
    if (match) known.push({ ...f, status: match.status, rotation: match.rotation })
    else isNew.push(f)
  }

  return { known, isNew }
}

export function scanWorkingTree() {
  let files = []
  try {
    files = execSync('git ls-files', { encoding: 'utf8' })
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean)
  } catch {
    return []
  }

  const findings = []
  for (const file of files) {
    if (shouldSkipFile(file)) continue
    if (!existsSync(file)) continue
    try {
      const content = readFileSync(file, 'utf8')
      findings.push(...scanText(content, file))
    } catch {}
  }

  return findings
}

export function scanGitHistory() {
  const findings = []
  let commits = []
  try {
    commits = execSync('git rev-list --all', { encoding: 'utf8' })
      .split('\n')
      .map((c) => c.trim())
      .filter(Boolean)
  } catch {
    return []
  }

  console.log(`Auditoría de historial Git: escaneando ${commits.length} commits...`)
  const scannedBlobs = new Set()

  for (const commit of commits) {
    try {
      const files = execSync(`git show ${commit} --format= --name-only --diff-filter=AM`, {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      })
        .split('\n')
        .map((f) => f.trim())
        .filter(Boolean)

      for (const file of files) {
        if (shouldSkipFile(file)) continue
        const blobKey = `${commit.slice(0, 8)}:${file}`
        if (scannedBlobs.has(blobKey)) continue
        scannedBlobs.add(blobKey)

        try {
          const blob = execSync(`git show ${commit}:${JSON.stringify(file)}`, {
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
          })
          findings.push(...scanText(blob, `commit ${commit.slice(0, 8)} (${file})`))
        } catch {}
      }
    } catch {}
  }

  return findings
}

function main() {
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
}

if (process.argv[1] && process.argv[1].endsWith('scan-secrets.mjs')) {
  main()
}
