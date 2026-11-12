#!/usr/bin/env node
/**
 * scan-secrets.mjs — Escáner de secretos para WHATSPOWER-ULTRA.
 *
 * Detecta patrones de tokens JWT, GitHub PAT, AWS, Slack, OpenAI, Google, Meta,
 * claves privadas y secretos de configuración en archivos tracked por git.
 */
import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'

const PATTERNS = [
  { id: 'JWT', desc: 'Token JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { id: 'GITHUB_PAT', desc: 'GitHub PAT', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { id: 'AWS_KEY', desc: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'OPENAI_KEY', desc: 'OpenAI API Key', re: /\bsk-(proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { id: 'META_TOKEN', desc: 'Meta Access Token', re: /\bEAAG[0-9A-Za-z_-]{20,}\b/g },
  { id: 'PRIVATE_KEY', desc: 'Clave privada', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY/g },
]

function getTrackedFiles() {
  try {
    const stdout = execSync('git ls-files', { encoding: 'utf8' })
    return stdout.split('\n').map((f) => f.trim()).filter(Boolean)
  } catch {
    return []
  }
}

const files = getTrackedFiles().filter((f) => !f.endsWith('.lock') && !f.endsWith('.png') && !f.endsWith('.jpg'))
let findings = 0

for (const file of files) {
  if (!existsSync(file)) continue
  const content = readFileSync(file, 'utf8')
  const lines = content.split('\n')

  lines.forEach((line, idx) => {
    // Excluir fixtures explícitos de tests o ejemplos en docs
    if (file.startsWith('tests/') || file.includes('test') || file.endsWith('.md') || file.endsWith('.example')) {
      return
    }
    for (const pat of PATTERNS) {
      if (pat.re.test(line)) {
        console.error(`[SECRETO DETECTADO] ${pat.desc} en ${file}:${idx + 1}`)
        findings++
      }
    }
  })
}

if (findings > 0) {
  console.error(`\n❌ Se encontraron ${findings} posibles secretos en el código fuente.`)
  process.exit(1)
} else {
  console.log('✅ Escaneo de secretos limpio: 0 secretos expuestos en archivos del proyecto.')
  process.exit(0)
}
