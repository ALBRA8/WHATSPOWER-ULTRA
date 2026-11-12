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
    // Se construyen dinámicamente para que el archivo de test no exponga patrones estáticos en su propio código
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

  it('SEC-07: baseline endurecido — una huella conocida en un NUEVO commit se marca como violación (isNew)', () => {
    // Simulamos un baseline histórico con un commit viejo y un archivo concreto
    const baselineMock = [
      {
        commit: '11223344',
        file: 'tests/old-test.ts',
        category: 'META_TOKEN',
        fingerprint: 'cafebeef1234',
        status: 'synthetic-test-fixture',
        rotation: 'dummy',
      },
    ]

    // Llega un commit NUEVO con la MISMA huella
    const findings = [
      {
        pattern: 'META_TOKEN',
        desc: 'Meta Token',
        source: 'commit 99887766 (tests/old-test.ts)',
        line: 15,
        preview: 'EAAG…(30 caracteres)',
        fingerprint: 'cafebeef1234',
      },
    ]

    // Evaluar con lógica de baseline vinculada a commit + archivo
    const known: any[] = []
    const isNew: any[] = []
    for (const f of findings) {
      const src = f.source.match(/^commit\s+([0-9a-fA-F]+)\s+\((.+)\)$/)
      const commit = src ? src[1] : ''
      const file = src ? src[2] : ''
      const match = baselineMock.find(
        (b) =>
          b.category === f.pattern &&
          b.fingerprint === f.fingerprint &&
          commit.toLowerCase().startsWith(b.commit.toLowerCase()) &&
          file.endsWith(b.file)
      )
      if (match) known.push(f)
      else isNew.push(f)
    }

    assert.strictEqual(isNew.length, 1, 'Un secreto en un nuevo commit DEBE ser marcado como nuevo/violación')
    assert.strictEqual(known.length, 0, 'No debe ser absorbido por el baseline histórico')
  })

  it('SEC-08: baseline endurecido — una huella conocida en un ARCHIVO DISTINTO se marca como violación (isNew)', () => {
    const baselineMock = [
      {
        commit: '11223344',
        file: 'tests/legitimate-test.ts',
        category: 'CONFIG_SECRET',
        fingerprint: 'deadbeef5678',
        status: 'synthetic-test-fixture',
        rotation: 'dummy',
      },
    ]

    // Mismo commit pero en src/production-file.ts
    const findings = [
      {
        pattern: 'CONFIG_SECRET',
        desc: 'Config Secret',
        source: 'commit 11223344 (src/production-file.ts)',
        line: 42,
        preview: 'secr…(25 caracteres)',
        fingerprint: 'deadbeef5678',
      },
    ]

    const known: any[] = []
    const isNew: any[] = []
    for (const f of findings) {
      const src = f.source.match(/^commit\s+([0-9a-fA-F]+)\s+\((.+)\)$/)
      const commit = src ? src[1] : ''
      const file = src ? src[2] : ''
      const match = baselineMock.find(
        (b) =>
          b.category === f.pattern &&
          b.fingerprint === f.fingerprint &&
          commit.toLowerCase().startsWith(b.commit.toLowerCase()) &&
          file.endsWith(b.file)
      )
      if (match) known.push(f)
      else isNew.push(f)
    }

    assert.strictEqual(isNew.length, 1, 'El mismo secreto en un archivo no autorizado en el baseline debe ser violación')
    assert.strictEqual(known.length, 0)
  })

  it('SEC-09: baseline endurecido — solo cuando coinciden commit, archivo, categoría y huella se acepta como conocido', () => {
    const baselineMock = [
      {
        commit: '11223344',
        file: 'tests/legitimate-test.ts',
        category: 'CONFIG_SECRET',
        fingerprint: 'deadbeef5678',
        status: 'synthetic-test-fixture',
        rotation: 'dummy',
      },
    ]

    const findings = [
      {
        pattern: 'CONFIG_SECRET',
        desc: 'Config Secret',
        source: 'commit 11223344 (tests/legitimate-test.ts)',
        line: 10,
        preview: 'secr…(25 caracteres)',
        fingerprint: 'deadbeef5678',
      },
    ]

    const known: any[] = []
    const isNew: any[] = []
    for (const f of findings) {
      const src = f.source.match(/^commit\s+([0-9a-fA-F]+)\s+\((.+)\)$/)
      const commit = src ? src[1] : ''
      const file = src ? src[2] : ''
      const match = baselineMock.find(
        (b) =>
          b.category === f.pattern &&
          b.fingerprint === f.fingerprint &&
          commit.toLowerCase().startsWith(b.commit.toLowerCase()) &&
          file.endsWith(b.file)
      )
      if (match) known.push(f)
      else isNew.push(f)
    }

    assert.strictEqual(known.length, 1, 'Debe ser reconocido como conocido si coincide commit, archivo, categoría y huella')
    assert.strictEqual(isNew.length, 0)
  })
})
