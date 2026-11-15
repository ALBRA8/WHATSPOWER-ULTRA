/**
 * Importador y Validador de Audiencias CSV para Capa 2B
 */

export interface ParsedContact {
  phone: string
  name?: string
  variables?: Record<string, string>
  consentOrigin?: string
}

export interface ParseCsvOptions {
  requireConsentOrigin?: boolean
}

export interface ImportResult {
  contacts: ParsedContact[]
  totalProcessed: number
  validCount: number
  invalidCount: number
  duplicatesCount: number
}

/**
 * Canoniza un número telefónico móvil según reglas E.164 (Colombia):
 * - Remueve caracteres no numéricos
 * - 10 dígitos iniciando en 3 -> 573XXXXXXXXX
 * - 12 dígitos iniciando en 573 -> 573XXXXXXXXX
 * - Retorna null si no cumple formato móvil válido
 */
export function canonicalizePhone(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== 'string') return null
  const digits = raw.replace(/\D/g, '')

  if (digits.length === 10 && digits.startsWith('3')) {
    return `57${digits}`
  }

  if (digits.length === 12 && digits.startsWith('573')) {
    return digits
  }

  return null
}

export function parseAudienceCsv(csvContent: string, options?: ParseCsvOptions): ImportResult {
  const lines = csvContent
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  if (lines.length === 0) {
    return { contacts: [], totalProcessed: 0, validCount: 0, invalidCount: 0, duplicatesCount: 0 }
  }

  // Detectar delimitador (, o ;)
  const headerLine = lines[0]
  const delimiter = headerLine.includes(';') ? ';' : ','
  const headers = headerLine.split(delimiter).map((h) => h.trim().toLowerCase().replace(/^["']|["']$/g, ''))

  const phoneIdx = headers.findIndex((h) => h === 'phone' || h === 'telefono' || h === 'celular' || h === 'movil')
  if (phoneIdx === -1) {
    throw new Error('El archivo CSV debe contener una columna obligatoria "phone" (o "telefono"/"celular")')
  }

  const consentIdx = headers.findIndex(
    (h) =>
      h === 'consent_origin' ||
      h === 'origen_consentimiento' ||
      h === 'consent_source' ||
      h === 'fuente_consentimiento' ||
      h === 'consentimiento' ||
      h === 'origen'
  )

  if (options?.requireConsentOrigin && consentIdx === -1) {
    throw new Error(
      'CSV_CONSENT_REQUIRED: El archivo CSV debe contener una columna obligatoria con el origen del consentimiento ("consent_origin" o "origen_consentimiento") conforme a la Ley 1581 de 2012'
    )
  }

  const nameIdx = headers.findIndex((h) => h === 'name' || h === 'nombre')

  const seenPhones = new Set<string>()
  const contacts: ParsedContact[] = []
  let invalidCount = 0
  let duplicatesCount = 0

  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(delimiter).map((col) => col.trim().replace(/^["']|["']$/g, ''))
    const rawPhone = row[phoneIdx]
    const canonical = canonicalizePhone(rawPhone)

    if (!canonical) {
      invalidCount++
      continue
    }

    const consentOrigin = consentIdx !== -1 && row[consentIdx] ? row[consentIdx] : undefined
    if (options?.requireConsentOrigin && !consentOrigin) {
      invalidCount++
      continue
    }

    if (seenPhones.has(canonical)) {
      duplicatesCount++
      continue
    }

    seenPhones.add(canonical)

    const name = nameIdx !== -1 && row[nameIdx] ? row[nameIdx] : undefined
    const variables: Record<string, string> = {}

    headers.forEach((header, idx) => {
      if (idx !== phoneIdx && idx !== nameIdx && idx !== consentIdx && row[idx]) {
        variables[header] = row[idx]
      }
    })

    contacts.push({
      phone: canonical,
      name,
      variables: Object.keys(variables).length > 0 ? variables : undefined,
      consentOrigin,
    })
  }

  return {
    contacts,
    totalProcessed: lines.length - 1,
    validCount: contacts.length,
    invalidCount,
    duplicatesCount,
  }
}
