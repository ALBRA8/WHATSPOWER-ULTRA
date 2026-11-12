import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  scanText,
  mask,
  computeFingerprint,
  filterAllowlist,
  filterBaseline,
  validateAllowlist,
  validateBaseline,
  normalizePath,
  scanWorkingTree,
  scanGitHistory,
  parseSource,
  PATTERNS,
  ALLOW_MARK,
  type SecretFinding,
  type AllowlistEntry,
  type BaselineEntry,
} from '../scripts/scan-secrets.mjs'

const SHA_VALID_A = '11223344556677889900aabbccddeeff00112233'
const SHA_VALID_B = '1122334499887766554433221100ffeeddccbbaa' // comparte los primeros 8 chars con A
const SHA_DIFF    = '99887766554433221100ffeeddccbbaa00112233'

describe('SECRETS SCANNER: Validación Estricta de SHA Completo (40 chars) y Pruebas Reales', () => {
  it('SEC-01: ningún patrón de expresión regular tiene bandera "g" en .test()/.exec() (inmunidad a lastIndex)', () => {
    for (const pat of PATTERNS) {
      assert.strictEqual(
        pat.re.global,
        false,
        `El patrón ${pat.id} no debe tener bandera global "g" para evitar mutación de lastIndex`
      )
    }
  })

  it('SEC-02: regresión de hallazgos consecutivos — detecta todos los secretos en líneas contiguas sin omitir ninguno', () => {
    const jwt = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'].join('.')
    const ghp = ['ghp', '123456789012345678901234567890123456'].join('_')
    const aws = ['AKIA', 'IOSFODNN7EXAMPLE'].join('')
    const openai = ['sk-proj', '1234567890abcdef1234567890abcdef12345678'].join('-')
    const meta = ['EAAG', '1234567890abcdef1234567890'].join('')
    const privKey = ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' ')

    const consecutiveLines = [
      `const token1 = "${jwt}"`,
      `const token2 = "${ghp}"`,
      `const token3 = "${aws}"`,
      `const token4 = "${openai}"`,
      `const token5 = "${meta}"`,
      `const privKey = "${privKey}"`,
    ].join('\n')

    const findings = scanText(consecutiveLines, 'test-consecutive.ts')

    assert.strictEqual(findings.length, 6, `Se esperaban 6 hallazgos consecutivos, obtenidos ${findings.length}`)
    assert.strictEqual(findings[0].pattern, 'JWT')
    assert.strictEqual(findings[1].pattern, 'GITHUB_PAT')
    assert.strictEqual(findings[2].pattern, 'AWS_ACCESS_KEY')
    assert.strictEqual(findings[3].pattern, 'OPENAI_KEY')
    assert.strictEqual(findings[4].pattern, 'META_TOKEN')
    assert.strictEqual(findings[5].pattern, 'PRIVATE_KEY')
  })

  it('SEC-03: máscara de seguridad — nunca expone la credencial completa en logs ni reportes', () => {
    const rawSecret = ['ghp', 'superSecretToken12345678901234567890'].join('_')
    const masked = mask(rawSecret)

    assert.ok(!masked.includes('superSecretToken'), 'La máscara no debe revelar el cuerpo del token')
    assert.ok(masked.startsWith('ghp_'), 'La máscara debe conservar el prefijo para identificación')
    assert.ok(masked.includes('40 caracteres'), 'La máscara debe indicar la longitud')
  })

  it('SEC-04: marcador de línea scan-secrets:allow permite excluir fixtures explícitos y documentados', () => {
    const dummyGhp = ['ghp', '123456789012345678901234567890123456'].join('_')
    const textWithMarker = `const testToken = "${dummyGhp}" // ${ALLOW_MARK}: fixture controlado para test`
    const findings = scanText(textWithMarker, 'test-marker.ts')

    assert.strictEqual(findings.length, 0, 'La línea con marcador explícito de allow debe ser ignorada')
  })

  it('SEC-05: cálculo determinista de huella sha256 determinista de 12 hex', () => {
    const val = 'secreto_de_prueba_123456789'
    const fp1 = computeFingerprint(val)
    const fp2 = computeFingerprint(val)

    assert.strictEqual(fp1, fp2)
    assert.strictEqual(fp1.length, 12)
    assert.strictEqual(/^[0-9a-f]{12}$/.test(fp1), true)
  })

  it('SEC-06: llamada a función real filterAllowlist filtra excepciones legítimas y conserva violaciones', () => {
    const mockFindings: SecretFinding[] = [
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

    const tempAllowlist: AllowlistEntry[] = [
      {
        file: 'tests/security-hardening.test.ts',
        category: 'META_TOKEN',
        fingerprint: '112233445566',
        reason: 'Fixture autorizado',
      },
    ]

    const { kept, excluded } = filterAllowlist(mockFindings, tempAllowlist)

    assert.strictEqual(excluded.length, 1, 'El hallazgo de la allowlist debe ser excluido')
    assert.strictEqual(kept.length, 1, 'El hallazgo no permitido debe mantenerse como violación')
    assert.strictEqual(kept[0].pattern, 'OPENAI_KEY')
  })

  // =========================================================================
  // SUITE OBLIGATORIA: SHA-01 a SHA-10 (Validación estricta de 40 caracteres)
  // =========================================================================

  it('SHA-01: una coincidencia con SHA completo idéntico (40 hex) se acepta en el baseline', () => {
    const baseline: BaselineEntry[] = [
      {
        commit: SHA_VALID_A,
        file: 'tests/valid.ts',
        category: 'CONFIG_SECRET',
        fingerprint: 'cafebeef1234',
        status: 'synthetic-test-fixture',
        rotation: 'dummy',
      },
    ]
    const finding: SecretFinding = {
      pattern: 'CONFIG_SECRET',
      desc: 'Secret',
      source: `commit ${SHA_VALID_A} (tests/valid.ts)`,
      line: 10,
      preview: 'secr…(20 caracteres)',
      fingerprint: 'cafebeef1234',
    }

    const { known, isNew } = filterBaseline([finding], baseline)
    assert.strictEqual(known.length, 1, 'Debe ser reconocido como conocido con SHA completo exacto')
    assert.strictEqual(isNew.length, 0)
  })

  it('SHA-02: un SHA diferente se rechaza y se marca como violación nueva (isNew)', () => {
    const baseline: BaselineEntry[] = [
      {
        commit: SHA_VALID_A,
        file: 'tests/valid.ts',
        category: 'CONFIG_SECRET',
        fingerprint: 'cafebeef1234',
      },
    ]
    const finding: SecretFinding = {
      pattern: 'CONFIG_SECRET',
      desc: 'Secret',
      source: `commit ${SHA_DIFF} (tests/valid.ts)`,
      line: 10,
      preview: 'secr…(20 caracteres)',
      fingerprint: 'cafebeef1234',
    }

    const { known, isNew } = filterBaseline([finding], baseline)
    assert.strictEqual(isNew.length, 1, 'Un SHA de commit diferente debe ser marcado como violación nueva')
    assert.strictEqual(known.length, 0)
  })

  it('SHA-03: dos SHA distintos que comparten los primeros ocho caracteres NO pueden autorizarse mutuamente', () => {
    // SHA_VALID_A y SHA_VALID_B comparten '11223344', pero son commits completamente distintos
    assert.strictEqual(SHA_VALID_A.slice(0, 8), SHA_VALID_B.slice(0, 8))
    assert.notStrictEqual(SHA_VALID_A, SHA_VALID_B)

    const baseline: BaselineEntry[] = [
      {
        commit: SHA_VALID_A,
        file: 'tests/file.ts',
        category: 'CONFIG_SECRET',
        fingerprint: 'cafebeef1234',
      },
    ]
    const finding: SecretFinding = {
      pattern: 'CONFIG_SECRET',
      desc: 'Secret',
      source: `commit ${SHA_VALID_B} (tests/file.ts)`,
      line: 10,
      preview: 'secr…(20 caracteres)',
      fingerprint: 'cafebeef1234',
    }

    const { known, isNew } = filterBaseline([finding], baseline)
    assert.strictEqual(isNew.length, 1, 'Coincidencia parcial de 8 caracteres NO debe autorizar el commit')
    assert.strictEqual(known.length, 0)
  })

  it('SHA-04: un SHA de ocho caracteres en el baseline se rechaza por validateBaseline (fail-closed)', () => {
    const badBaseline = [
      {
        commit: '11223344', // solo 8 caracteres
        file: 'tests/file.ts',
        category: 'CONFIG_SECRET',
        fingerprint: 'cafebeef1234',
      },
    ]

    assert.throws(
      () => validateBaseline(badBaseline),
      /exactamente 40 caracteres hexadecimales/
    )
  })

  it('SHA-05: un SHA de 39 caracteres se rechaza por validateBaseline (fail-closed)', () => {
    const sha39 = '1'.repeat(39)
    assert.strictEqual(sha39.length, 39)

    const badBaseline = [
      {
        commit: sha39,
        file: 'tests/file.ts',
        category: 'CONFIG_SECRET',
        fingerprint: 'cafebeef1234',
      },
    ]

    assert.throws(
      () => validateBaseline(badBaseline),
      /exactamente 40 caracteres hexadecimales/
    )
  })

  it('SHA-06: un SHA de 41 caracteres se rechaza por validateBaseline (fail-closed)', () => {
    const sha41 = '1'.repeat(41)
    assert.strictEqual(sha41.length, 41)

    const badBaseline = [
      {
        commit: sha41,
        file: 'tests/file.ts',
        category: 'CONFIG_SECRET',
        fingerprint: 'cafebeef1234',
      },
    ]

    assert.throws(
      () => validateBaseline(badBaseline),
      /exactamente 40 caracteres hexadecimales/
    )
  })

  it('SHA-07: un SHA con caracteres no hexadecimales se rechaza por validateBaseline (fail-closed)', () => {
    const shaNonHex = '11223344556677889900aabbccddeeffzzzzzzzz' // z no es hex
    assert.strictEqual(shaNonHex.length, 40)

    const badBaseline = [
      {
        commit: shaNonHex,
        file: 'tests/file.ts',
        category: 'CONFIG_SECRET',
        fingerprint: 'cafebeef1234',
      },
    ]

    assert.throws(
      () => validateBaseline(badBaseline),
      /exactamente 40 caracteres hexadecimales/
    )
  })

  it('SHA-08: el historial produce fuentes con SHA completos de 40 caracteres, no truncados', () => {
    const fakeExec = (cmd: string) => {
      if (cmd.includes('rev-list')) {
        return `${SHA_VALID_A}\n`
      }
      if (cmd.includes('--name-only')) {
        return 'src/example.ts\n'
      }
      if (cmd.includes('show')) {
        const dummyToken = ['EAAG', '1234567890abcdef1234567890'].join('')
        return `const token = "${dummyToken}"\n`
      }
      return ''
    }

    const findings = scanGitHistory({ execFn: fakeExec })
    assert.strictEqual(findings.length, 1)

    // La fuente generada debe conservar los 40 caracteres exactos
    assert.strictEqual(findings[0].source, `commit ${SHA_VALID_A} (src/example.ts)`)

    // Y parseSource debe recuperar el commit completo de 40 caracteres
    const parsed = parseSource(findings[0].source)
    assert.strictEqual(parsed.isHistory, true)
    assert.strictEqual(parsed.commit, SHA_VALID_A.toLowerCase())
    assert.strictEqual(parsed.commit.length, 40)
  })

  it('SHA-09: una ruta distinta se rechaza aunque el SHA, categoría y huella coincidan', () => {
    const baseline: BaselineEntry[] = [
      {
        commit: SHA_VALID_A,
        file: 'tests/original.ts',
        category: 'CONFIG_SECRET',
        fingerprint: 'cafebeef1234',
      },
    ]
    const finding: SecretFinding = {
      pattern: 'CONFIG_SECRET',
      desc: 'Secret',
      source: `commit ${SHA_VALID_A} (tests/otra-ruta.ts)`,
      line: 10,
      preview: 'secr…(20 caracteres)',
      fingerprint: 'cafebeef1234',
    }

    const { known, isNew } = filterBaseline([finding], baseline)
    assert.strictEqual(isNew.length, 1, 'Ruta distinta debe rechazarse aunque el commit coincida')
    assert.strictEqual(known.length, 0)
  })

  it('SHA-10: una categoría o huella diferente se rechaza aunque el resto coincida', () => {
    const baseline: BaselineEntry[] = [
      {
        commit: SHA_VALID_A,
        file: 'tests/valid.ts',
        category: 'CONFIG_SECRET',
        fingerprint: 'cafebeef1234',
      },
    ]

    // 1. Misma huella pero diferente categoría -> rechazo
    const findingDiffCat: SecretFinding = {
      pattern: 'META_TOKEN',
      desc: 'Meta',
      source: `commit ${SHA_VALID_A} (tests/valid.ts)`,
      line: 10,
      preview: 'secr…(20 caracteres)',
      fingerprint: 'cafebeef1234',
    }
    const resCat = filterBaseline([findingDiffCat], baseline)
    assert.strictEqual(resCat.isNew.length, 1)
    assert.strictEqual(resCat.known.length, 0)

    // 2. Misma categoría pero diferente huella -> rechazo
    const findingDiffFp: SecretFinding = {
      pattern: 'CONFIG_SECRET',
      desc: 'Secret',
      source: `commit ${SHA_VALID_A} (tests/valid.ts)`,
      line: 10,
      preview: 'secr…(20 caracteres)',
      fingerprint: '000000000000',
    }
    const resFp = filterBaseline([findingDiffFp], baseline)
    assert.strictEqual(resFp.isNew.length, 1)
    assert.strictEqual(resFp.known.length, 0)
  })

  // =========================================================================
  // PRUEBAS DE FAIL-CLOSED Y VALIDACIÓN ESTRUCTURAL
  // =========================================================================

  it('SEC-FAIL-01: Coincidencias por sufijo de ruta son RECHAZADAS en allowlist y baseline', () => {
    const allowlistMock: AllowlistEntry[] = [
      {
        file: 'tests/foo.ts',
        category: 'CONFIG_SECRET',
        fingerprint: '112233445566',
        reason: 'Fixture legítimo',
      },
    ]
    const finding: SecretFinding = {
      pattern: 'CONFIG_SECRET',
      desc: 'Secret',
      source: 'malicious/tests/foo.ts',
      line: 5,
      preview: 'secr…(20 caracteres)',
      fingerprint: '112233445566',
    }

    const { kept, excluded } = filterAllowlist([finding], allowlistMock)
    assert.strictEqual(kept.length, 1)
    assert.strictEqual(excluded.length, 0)
  })

  it('SEC-FAIL-02: Allowlist con comodín o sin justificación es rechazada por validateAllowlist', () => {
    assert.throws(
      () => validateAllowlist([{ file: '*', category: 'JWT', fingerprint: '112233445566', reason: 'excesivo' }]),
      /no comodín/
    )
    assert.throws(
      () => validateAllowlist([{ file: 'tests/a.ts', category: 'JWT', fingerprint: '112233445566', reason: '' }]),
      /reason/
    )
  })

  it('SEC-FAIL-03: Error al ejecutar Git en scanWorkingTree produce fallo fail-closed (throw)', () => {
    const fakeExecFail = () => {
      throw new Error('fatal: not a git repository')
    }
    assert.throws(
      () => scanWorkingTree({ execFn: fakeExecFail }),
      /Fallo de Git al listar archivos rastreados \(fail-closed\)/
    )
  })

  it('SEC-FAIL-04: Historial Git vacío o incompleto produce fallo fail-closed (throw)', () => {
    const fakeExecEmpty = (cmd: string) => {
      if (cmd.includes('rev-list')) return ''
      return ''
    }
    assert.throws(
      () => scanGitHistory({ execFn: fakeExecEmpty }),
      /Historial Git vacío o incompleto/
    )
  })

  it('SEC-FAIL-05: Detección de secretos en los propios archivos de seguridad', () => {
    const fakeToken = ['ghp', 'secretInsideAllowlistFile1234567890'].join('_')
    const badContent = JSON.stringify([
      { file: 'tests/a.ts', category: 'GITHUB_PAT', fingerprint: '112233445566', reason: `Token real: ${fakeToken}` },
    ])
    const findings = scanText(badContent, 'scripts/security/secret-allowlist.json')
    assert.strictEqual(findings.length, 1)
    assert.strictEqual(findings[0].pattern, 'GITHUB_PAT')
  })
})
