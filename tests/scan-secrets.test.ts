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
  PATTERNS,
  ALLOW_MARK,
  type SecretFinding,
  type AllowlistEntry,
  type BaselineEntry,
} from '../scripts/scan-secrets.mjs'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function runBaselineCase(baseline: unknown[], finding: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'scan-secrets-baseline-'))
  const baselinePath = join(dir, 'baseline.json')
  writeFileSync(baselinePath, JSON.stringify(baseline), 'utf8')
  try {
    return filterBaseline([finding] as any[], baselinePath)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('SECRETS SCANNER: Auditoría y Pruebas Reales de Seguridad', () => {
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

  it('SEC-07: filterBaseline real rechaza la misma huella en un commit nuevo', () => {
    const baseline = [
      {
        commit: '11223344',
        file: 'tests/old-test.ts',
        category: 'META_TOKEN',
        fingerprint: 'cafebeef1234',
        status: 'synthetic-test-fixture',
        rotation: 'dummy',
      },
    ]
    const finding = {
      pattern: 'META_TOKEN',
      desc: 'Meta Token',
      source: 'commit 99887766 (tests/old-test.ts)',
      line: 15,
      preview: 'EAAG…(30 caracteres)',
      fingerprint: 'cafebeef1234',
    }

    const result = runBaselineCase(baseline, finding)
    assert.strictEqual(result.isNew.length, 1)
    assert.strictEqual(result.known.length, 0)
  })

  it('SEC-08: filterBaseline real rechaza la misma huella en otra ruta', () => {
    const baseline = [
      {
        commit: '11223344',
        file: 'tests/legitimate-test.ts',
        category: 'CONFIG_SECRET',
        fingerprint: 'deadbeef5678',
        status: 'synthetic-test-fixture',
        rotation: 'dummy',
      },
    ]
    const finding = {
      pattern: 'CONFIG_SECRET',
      desc: 'Config Secret',
      source: 'commit 11223344 (src/production-file.ts)',
      line: 42,
      preview: 'secr…(25 caracteres)',
      fingerprint: 'deadbeef5678',
    }

    const result = runBaselineCase(baseline, finding)
    assert.strictEqual(result.isNew.length, 1)
    assert.strictEqual(result.known.length, 0)
  })

  it('SEC-09: filterBaseline real solo acepta coincidencia exacta de commit, ruta, categoría y huella', () => {
    const baseline = [
      {
        commit: '11223344',
        file: 'tests/legitimate-test.ts',
        category: 'CONFIG_SECRET',
        fingerprint: 'deadbeef5678',
        status: 'synthetic-test-fixture',
        rotation: 'dummy',
      },
    ]
    const finding = {
      pattern: 'CONFIG_SECRET',
      desc: 'Config Secret',
      source: 'commit 11223344 (tests/legitimate-test.ts)',
      line: 10,
      preview: 'secr…(25 caracteres)',
      fingerprint: 'deadbeef5678',
    }

    const result = runBaselineCase(baseline, finding)
    assert.strictEqual(result.known.length, 1)
    assert.strictEqual(result.isNew.length, 0)
  })

  it('SEC-10: filterBaseline real rechaza coincidencias por sufijo de ruta', () => {
    const baseline = [
      {
        commit: '11223344',
        file: 'tests/legitimate-test.ts',
        category: 'CONFIG_SECRET',
        fingerprint: 'deadbeef5678',
        status: 'synthetic-test-fixture',
        rotation: 'dummy',
      },
    ]
    const finding = {
      pattern: 'CONFIG_SECRET',
      desc: 'Config Secret',
      source: 'commit 11223344 (attacker/tests/legitimate-test.ts)',
      line: 10,
      preview: 'secr…(25 caracteres)',
      fingerprint: 'deadbeef5678',
    }

    const result = runBaselineCase(baseline, finding)
    assert.strictEqual(result.isNew.length, 1)
    assert.strictEqual(result.known.length, 0)
  })

  it('SEC-NEG-01: MISMA huella en OTRO commit es marcada como violación nueva (isNew)', () => {
    const baselineMock: BaselineEntry[] = [
      {
        commit: '11223344',
        file: 'tests/old-test.ts',
        category: 'META_TOKEN',
        fingerprint: 'cafebeef1234',
        status: 'synthetic-test-fixture',
        rotation: 'dummy',
      },
    ]

    const findings: SecretFinding[] = [
      {
        pattern: 'META_TOKEN',
        desc: 'Meta Token',
        source: 'commit 99887766 (tests/old-test.ts)',
        line: 15,
        preview: 'EAAG…(30 caracteres)',
        fingerprint: 'cafebeef1234',
      },
    ]

    const { known, isNew } = filterBaseline(findings, baselineMock)

    assert.strictEqual(isNew.length, 1, 'Debe marcarse como isNew porque el commit es diferente')
    assert.strictEqual(known.length, 0, 'No debe ser autorizado por el baseline')
  })

  it('SEC-NEG-02: MISMA huella en OTRO archivo es marcada como violación nueva (isNew)', () => {
    const baselineMock: BaselineEntry[] = [
      {
        commit: '11223344',
        file: 'tests/legitimate-test.ts',
        category: 'CONFIG_SECRET',
        fingerprint: 'deadbeef5678',
        status: 'synthetic-test-fixture',
        rotation: 'dummy',
      },
    ]

    const findings: SecretFinding[] = [
      {
        pattern: 'CONFIG_SECRET',
        desc: 'Config Secret',
        source: 'commit 11223344 (src/production-file.ts)',
        line: 42,
        preview: 'secr…(25 caracteres)',
        fingerprint: 'deadbeef5678',
      },
    ]

    const { known, isNew } = filterBaseline(findings, baselineMock)

    assert.strictEqual(isNew.length, 1, 'Misma huella en archivo distinto DEBE ser violación nueva')
    assert.strictEqual(known.length, 0)
  })

  it('SEC-NEG-03: MISMO archivo con contexto histórico diferente (commit no emparentado)', () => {
    const baselineMock: BaselineEntry[] = [
      {
        commit: 'abcdef12',
        file: 'tests/test-file.ts',
        category: 'JWT',
        fingerprint: '010203040506',
      },
    ]

    const findings: SecretFinding[] = [
      {
        pattern: 'JWT',
        desc: 'Token JWT',
        source: 'commit 12345678 (tests/test-file.ts)',
        line: 1,
        preview: 'eyJ…(20 caracteres)',
        fingerprint: '010203040506',
      },
    ]

    const { known, isNew } = filterBaseline(findings, baselineMock)

    assert.strictEqual(isNew.length, 1, 'Contexto histórico no coincidente debe ser marcado como violación')
    assert.strictEqual(known.length, 0)
  })

  it('SEC-NEG-04: Coincidencias por sufijo de ruta son RECHAZADAS (no match por endsWith)', () => {
    const allowlistMock: AllowlistEntry[] = [
      {
        file: 'tests/foo.ts',
        category: 'CONFIG_SECRET',
        fingerprint: '112233445566',
        reason: 'Fixture legítimo',
      },
    ]

    const findings: SecretFinding[] = [
      {
        pattern: 'CONFIG_SECRET',
        desc: 'Secret',
        source: 'malicious/tests/foo.ts',
        line: 5,
        preview: 'secr…(20 caracteres)',
        fingerprint: '112233445566',
      },
    ]

    const { kept, excluded } = filterAllowlist(findings, allowlistMock)

    assert.strictEqual(kept.length, 1, 'Ruta con coincidencia por sufijo NO debe coincidir con la allowlist')
    assert.strictEqual(excluded.length, 0)
  })

  it('SEC-NEG-05: Baseline manipulado — valida estructura y lanza error fail-closed', () => {
    assert.throws(() => validateBaseline('no-array' as any), /Baseline inválido/)

    assert.throws(
      () => validateBaseline([{ file: 'a.ts', category: 'JWT', fingerprint: '112233445566' }]),
      /commit/
    )

    assert.throws(
      () => validateBaseline([{ commit: '11223344', file: '*.ts', category: 'JWT', fingerprint: '112233445566' }]),
      /file/
    )

    assert.throws(
      () => validateBaseline([{ commit: '11223344', file: 'a.ts', category: 'INVENTADA', fingerprint: '112233445566' }]),
      /categoría desconocida/
    )

    assert.throws(
      () => validateBaseline([{ commit: '11223344', file: 'a.ts', category: 'JWT', fingerprint: 'corta' }]),
      /huella sha256/
    )
  })

  it('SEC-NEG-06: Allowlist excesiva — prohíbe comodines y campos vacíos (fail-closed)', () => {
    assert.throws(
      () => validateAllowlist([{ file: '*', category: 'JWT', fingerprint: '112233445566', reason: 'excesivo' }]),
      /no comodín/
    )

    assert.throws(
      () => validateAllowlist([{ file: 'tests/a.ts', category: 'JWT', fingerprint: '112233445566', reason: '' }]),
      /reason/
    )
  })

  it('SEC-NEG-07: Error al ejecutar Git en scanWorkingTree produce fallo fail-closed (throw)', () => {
    const fakeExecFail = () => {
      throw new Error('fatal: not a git repository')
    }

    assert.throws(
      () => scanWorkingTree({ execFn: fakeExecFail }),
      /Fallo de Git al listar archivos rastreados \(fail-closed\)/
    )
  })

  it('SEC-NEG-08: Historial incompleto (commits vacíos o shallow) produce fallo fail-closed (throw)', () => {
    const fakeExecEmpty = (cmd: string) => {
      if (cmd.includes('rev-list')) return ''
      return ''
    }

    assert.throws(
      () => scanGitHistory({ execFn: fakeExecEmpty }),
      /Historial Git vacío o incompleto/
    )
  })

  it('SEC-NEG-09: Archivos no rastreados o inaccesibles producen fallo fail-closed (throw)', () => {
    const fakeExec = (cmd: string) => {
      if (cmd.includes('ls-files')) return 'src/unreadable.ts\n'
      return ''
    }
    const fakeReadFail = () => {
      throw new Error('EACCES: permission denied')
    }

    assert.throws(
      () => scanWorkingTree({ execFn: fakeExec, readFn: fakeReadFail }),
      /No se pudo leer el archivo rastreado src\/unreadable\.ts \(fail-closed\)/
    )
  })

  it('SEC-NEG-10: Detección de secretos en los propios archivos de seguridad', () => {
    const fakeToken = ['ghp', 'secretInsideAllowlistFile1234567890'].join('_')
    const badContent = JSON.stringify([
      { file: 'tests/a.ts', category: 'GITHUB_PAT', fingerprint: '112233445566', reason: `Token real: ${fakeToken}` },
    ])

    const findings = scanText(badContent, 'scripts/security/secret-allowlist.json')

    assert.strictEqual(findings.length, 1, 'Debe detectar secretos inyectados en la propia allowlist')
    assert.strictEqual(findings[0].pattern, 'GITHUB_PAT')
  })
})
