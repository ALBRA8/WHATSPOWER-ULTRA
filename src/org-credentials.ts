/**
 * B3 — RESOLUCIÓN DE CREDENCIALES DE SERVICIO POR ORGANIZACIÓN (Capa 2B).
 *
 * Cada organización tiene SU credencial de servicio frente a Capa 2A
 * (WHATSPOWER). El secreto global (INTERNAL_API_SECRET) YA NO se usa para
 * las llamadas de servicio: un secreto compartido sustituía la validación de
 * organización (cualquier poseedor podía operar el contexto de cualquier org).
 *
 * Fuente: env WHATSPOWER_ORG_CREDENTIALS formato "orgId:credencial,orgId2:credencial2".
 * Los valores NUNCA se loguean. Si una org no tiene credencial → null y los
 * clientes de servicio fallan CERRADO sin llamar a la red.
 */

let cache: Map<string, string> | null = null
let cacheSource = ''

function parseCredentials(raw: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf(':')
    if (idx <= 0) continue
    const orgId = pair.slice(0, idx).trim()
    const credential = pair.slice(idx + 1).trim()
    if (orgId && credential) map.set(orgId, credential)
  }
  return map
}

/**
 * Devuelve la credencial de servicio de la organización, o null si no está
 * configurada (fail-closed en el llamador: jamás se cae a un secreto global).
 */
export function resolveOrgServiceCredential(orgId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!orgId || typeof orgId !== 'string') return null
  const raw = env.WHATSPOWER_ORG_CREDENTIALS || ''
  if (raw !== cacheSource) {
    cache = parseCredentials(raw)
    cacheSource = raw
  }
  return cache?.get(orgId) ?? null
}

/** Invalida la caché (para pruebas). */
export function resetOrgCredentialCache(): void {
  cache = null
  cacheSource = ''
}
