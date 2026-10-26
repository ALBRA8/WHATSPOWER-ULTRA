/**
 * ALBRA — CONFIGURACIÓN Y ESTADO DEL PRIMER PILOTO CONTROLADO C2B
 *
 * REGLAS INNEGOCIABLES:
 * - Audiencia restringida exclusivamente al número personal del operador.
 * - Plantilla fija acordada: 'que servicios tienes?'
 * - Estado: BLOQUEADO (LOCKED). Ningún despacho puede ejecutarse hasta
 *   que el usuario autorice expresamente y proporcione su número real.
 */

export interface PilotConfiguration {
  pilotId: string
  campaignName: string
  authorized: boolean
  operatorPhoneCanonical: string | null
  templateSpintax: string
  lockReason: string
  safetyRequirements: string[]
}

export const PILOT_SUPERVISED_CONFIG: PilotConfiguration = {
  pilotId: 'pilot_c2b_supervised_01',
  campaignName: 'PILOTO_SUPERVISADO_C2B_OPERADOR',
  authorized: false, // ESTRICTAMENTE BLOQUEADO
  operatorPhoneCanonical: '573017543786', // Cliente destinatario
  templateSpintax: 'Tengo estos zapatos para la venta.',
  lockReason: 'AWAITING_EXPLICIT_USER_AUTHORIZATION_BEFORE_REAL_SEND',
  safetyRequirements: [
    'allowRealDispatch must remain false until explicit authorization',
    'AGENTIC_2A_ENABLED must remain false in CRM environment',
    'Sender is CRM/negocio (573163301286)',
    'Recipient is cliente (573017543786)',
    'JIT lock and suppression checks must execute immediately before POST',
    'UNCERTAIN_DISPATCH must block blind automated retries',
  ],
}

/**
 * Validador de salvaguarda de ejecución del piloto.
 * Impide cualquier procesamiento si no se cumplen todas las pre-condiciones.
 */
export function validatePilotPreconditions(config: PilotConfiguration = PILOT_SUPERVISED_CONFIG): {
  canExecute: boolean
  blockers: string[]
} {
  const blockers: string[] = []

  if (!config.authorized) {
    blockers.push('PILOT_NOT_AUTHORIZED: Falta autorización explícita del usuario')
  }

  if (!config.operatorPhoneCanonical) {
    blockers.push('OPERATOR_PHONE_MISSING: [PENDIENTE — NÚMERO DEL OPERADOR] no configurado')
  }

  if (process.env.AGENTIC_2A_ENABLED === 'true') {
    blockers.push('AGENTIC_2A_ENABLED_ACTIVE: 2A debe permanecer desactivado')
  }

  return {
    canExecute: blockers.length === 0,
    blockers,
  }
}
