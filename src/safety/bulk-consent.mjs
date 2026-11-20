/**
 * M2 (ULTRA) — Alta masiva de consentimiento (Ley 1581 de Colombia).
 *
 * Problema del plan: sin columna `consent_origin` ni bulk endpoint, las
 * campañas reales saltan a SKIPPED_NO_CONSENT o INCITAN a fabricar
 * consentimientos (peor opción posible legalmente). Consecuencia mientras no
 * se aplique: **no operar campañas**.
 *
 * Solución portable: función pura que procesa el lote con validación estricta
 * y devuelve SOLO operaciones legítimas. Reglas Ley 1581 que aplica:
 *  - origen del consentimiento OBLIGATORIO y de catálogo cerrado
 *    (web_form | double_optin | physical_written | call_recording | contract)
 *  - evidencia OBLIGATORIA para cada fuente (URL de formulario, registro de
 *    doble opt-in, escaneo del escrito, id de grabación, id de contrato)
 *  - fecha de obtención OBLIGATORIA y no futura
 *  - phone E.164 Colombia o email válido (al menos un canal)
 *  - revocación: consentimiento revocado es origin='revoked' (tombstone
 *    auditable), jamás borrado de la fila
 * El SQL del schema (ALTER TABLE aditivo) y el endpoint wrapper van en README.
 */

export const CONSENT_ORIGINS = ['web_form', 'double_optin', 'physical_written', 'call_recording', 'contract']

export const EVIDENCE_REQUIRED = {
  web_form: (e) => typeof e?.url === 'string' && /^https?:\/\/.+/.test(e.url),
  double_optin: (e) => typeof e?.confirmationId === 'string' && e.confirmationId.length >= 6,
  physical_written: (e) => typeof e?.documentRef === 'string' && e.documentRef.length >= 4,
  call_recording: (e) => typeof e?.recordingId === 'string' && e.recordingId.length >= 4,
  contract: (e) => typeof e?.contractRef === 'string' && e.contractRef.length >= 4,
}

const E164_CO = /^\+57\d{10}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Procesa un lote y lo separa en aceptados/rechazados. NUNCA lanza: los
 * inválidos van a `rejected` con su motivo (para auditoría y para dar feedback
 * accionable al operador); los válidos a `accepted` listos para el UPDATE/INSERT.
 */
export function processBulkConsent(rows, nowMs = Date.now()) {
  const accepted = []
  const rejected = []
  const seenContacts = new Set()

  rows.forEach((row, index) => {
    const reject = (reason) => rejected.push({ index, reason })

    if (typeof row?.contactId !== 'string' || !row.contactId.trim()) return reject('contactId inválido')
    if (seenContacts.has(row.contactId)) return reject('contactId duplicado en el lote')
    seenContacts.add(row.contactId)

    const hasChannel = (typeof row.phone === 'string' && E164_CO.test(row.phone)) ||
      (typeof row.email === 'string' && EMAIL_RE.test(row.email))
    if (!hasChannel) return reject('canal requerido: phone E.164 Colombia (+57…) o email válido')

    if (typeof row.consentOrigin !== 'string' || !CONSENT_ORIGINS.includes(row.consentOrigin)) {
      return reject(`consentOrigin debe ser uno de: ${CONSENT_ORIGINS.join(', ')}`)
    }
    if (!EVIDENCE_REQUIRED[row.consentOrigin](row.evidence)) {
      return reject(`evidencia insuficiente para consentOrigin=${row.consentOrigin}`)
    }

    const obtainedAt = typeof row.obtainedAt === 'string' ? Date.parse(row.obtainedAt) : NaN
    if (Number.isNaN(obtainedAt)) return reject('obtainedAt debe ser fecha ISO válida')
    if (obtainedAt > nowMs) return reject('obtainedAt no puede ser futura (consentimiento fabricado)')

    accepted.push({ contactId: row.contactId, consentOrigin: row.consentOrigin, obtainedAt: new Date(obtainedAt).toISOString() })
  })

  return { accepted, rejected }
}

/** Tombstone de revocación (jamás DELETE): auditable por Ley 1581. */
export function revocationUpdate(contactId, revokedAt) {
  if (!contactId?.trim()) return null
  const ts = Date.parse(revokedAt)
  if (Number.isNaN(ts) || ts > Date.now()) return null
  return { contactId, consentOrigin: 'revoked', evidence: `revokedAt=${new Date(ts).toISOString()}` }
}
