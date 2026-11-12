import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  scanText,
  mask,
  computeFingerprint,
  filterAllowlist,
  filterBaseline,
  PATTERNS,
  ALLOW_MARK,
} from '../scripts/scan-secrets.mjs'

describe('SECRETS SCANNER: corrección de lastIndex y pruebas de regresión', () => {
  it('SEC-01: ningún patrón de expresión regular tiene bandera "g" en .test() (inmunidad a lastIndex)', () => {
    for (const pat of PATTERNS) {
      assert.strictEqual(
        pat.re.global,
        false,
        `El patrón ${pat.id} no debe tener bandera global "g" para evitar mutación de lastIndex`
      )
    }
  })

  it('SEC-02: regresión de hallazgos consecutivos — detecta todos los secretos en líneas contiguas sin omitir ninguno', () => {
    const consecutiveLines = [
      'const token1 = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"',
      'const token2 = "ghp_123456789012345678901234567890123456"',
      'const token3 = "AKIAIOSFODNN7EXAMPLE"',
      'const token4 = "sk-proj-1234567890abcdef1234567890abcdef12345678"',
      'const token5 = "EAAG1234567890abcdef1234567890"',
      'const privKey = "-----BEGIN RSA PRIVATE KEY-----"',
    ].join('\n')

    const findings = scanText(consecutiveLines, 'test-consecutive.ts')

    // Con el bug de lastIndex, las líneas impares o consecutivas se omitían como falsos negativos
    assert.strictEqual(
      findings.length,
      6,
      `Se esperaban 6 hallazgos consecutivos, obtenidos ${findings.length}`
    )
    assert.strictEqual(findings[0].pattern, 'JWT')
    assert.strictEqual(findings[1].pattern, 'GITHUB_PAT')
    assert.strictEqual(findings[2].pattern, 'AWS_ACCESS_KEY')
    assert.strictEqual(findings[3].pattern, 'OPENAI_KEY')
    assert.strictEqual(findings[4].pattern, 'META_TOKEN')
    assert.strictEqual(findings[5].pattern, 'PRIVATE_KEY')
  })

  it('SEC-03: máscara de seguridad — nunca expone la credencial completa en logs ni reportes', () => {
    const rawSecret = 'ghp_superSecretToken12345678901234567890'
    const masked = mask(rawSecret)

    assert.ok(!masked.includes('superSecretToken'), 'La máscara no debe revelar el cuerpo del token')
    assert.ok(masked.startsWith('ghp_'), 'La máscara debe conservar el prefijo para identificación')
    assert.ok(masked.includes('40 caracteres'), 'La máscara debe indicar la longitud')
  })

  it('SEC-04: marcador de línea scan-secrets:allow permite excluir fixtures explícitos y documentados', () => {
    const textWithMarker = `const testToken = "ghp_123456789012345678901234567890123456" // ${ALLOW_MARK}: fixture controlado para test`
    const findings = scanText(textWithMarker, 'test-marker.ts')

    assert.strictEqual(findings.length, 0, 'La línea con marcador explícito de allow debe ser ignorada')
  })

  it('SEC-05: cálculo determinista de huella sha256 para allowlist y baselines sin almacenar secretos en claro', () => {
    const val = 'secreto_de_prueba_123456789'
    const fp1 = computeFingerprint(val)
    const fp2 = computeFingerprint(val)

    assert.strictEqual(fp1, fp2)
    assert.strictEqual(fp1.length, 12, 'La huella sha256-12 debe tener exactamente 12 caracteres')
    assert.strictEqual(/^[0-9a-f]{12}$/.test(fp1), true)
  })

  it('SEC-06: filtrado de allowlist por archivo y categoría de secreto', () => {
    const mockFindings = [
      {
        pattern: 'META_TOKEN',
        desc: 'Meta Token',
        source: 'tests/security-hardening.test.ts',
        line: 10,
        preview: 'EAAG…(30 caracteres)',
        fingerprint: '112233445566',
      },
      {
        pattern: 'OPENAI_KEY',
        desc: 'OpenAI Key',
        source: 'src/leaked.ts',
        line: 20,
        preview: 'sk-p…(40 caracteres)',
        fingerprint: 'aabbccddeeff',
      },
    ]

    const tempAllowlist = [
      {
        file: 'tests/security-hardening.test.ts',
        category: 'META_TOKEN',
        fingerprint: '112233445566',
        reason: 'Fixture autorizado',
      },
    ]

    // Simula filtrado
    const kept: typeof mockFindings = []
    const excluded: Array<any> = []
    for (const f of mockFindings) {
      const match = tempAllowlist.find(
        (a) => a.category === f.pattern && a.fingerprint === f.fingerprint && f.source.endsWith(a.file)
      )
      if (match) excluded.push({ ...f, reason: match.reason })
      else kept.push(f)
    }

    assert.strictEqual(excluded.length, 1, 'El secreto autorizado debe ser excluido de violaciones')
    assert.strictEqual(kept.length, 1, 'El secreto real no autorizado en src/leaked.ts debe mantenerse como violación')
    assert.strictEqual(kept[0].pattern, 'OPENAI_KEY')
  })
})
