/**
 * Tipos y Contratos para Capa 2B (albra-broadcast-2b)
 *
 * (tercera reparación 5.A) Toda verificación de seguridad (locks de Capa 2A y
 * supresiones) es POR ORGANIZACIÓN: los chequeos reciben la organización de la
 * campaña y los clientes HTTP la propagan como X-Org-Id, validando el eco de
 * la organización en las respuestas (fail-closed ante respuesta sin/mismatch).
 */

export type CampaignStatus =
  | 'DRAFT'
  | 'SCHEDULED'
  | 'RUNNING'
  | 'PAUSED_COOLDOWN'
  | 'PAUSED_OFF_HOURS'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED'

export type CampaignItemStatus =
  | 'PENDING'
  | 'LOCK_EXCLUDED'
  | 'SUPPRESSED'
  | 'FATIGUE_EXCLUDED'
  | 'DISPATCHING'
  | 'SENT'
  | 'FAILED_RETRYABLE'
  | 'FAILED_FATAL'
  | 'ABORTED_LOCK_ACTIVE'
  | 'SKIPPED_LOCK_UNAVAILABLE'
  | 'SKIPPED_SUPPRESSION_UNAVAILABLE'
  | 'UNCERTAIN_DISPATCH'

export interface Campaign {
  id: string
  organizationId: string
  name: string
  templateSpintax: string
  status: CampaignStatus
  scheduledAt?: number
  startedAt?: number
  finishedAt?: number
  totalTargets: number
  sentCount: number
  failedCount: number
  skippedCount: number
  createdAt: number
}

export interface CampaignItem {
  id: string
  campaignId: string
  contactPhone: string
  contactName?: string
  variables?: Record<string, string>
  renderedText?: string
  status: CampaignItemStatus
  lockCheckedAt?: number
  dispatchedAt?: number
  errorReason?: string
  messageId?: string
  retryCount: number
  idempotencyKey: string
}

export interface DispatchResult {
  success: boolean
  messageId?: string
  error?: string
  uncertain?: boolean
}

export interface Dispatcher {
  dispatch(to: string, text: string): Promise<DispatchResult>
}

export interface LockCheckResult {
  available: boolean
  state?: string
  error?: string
  /** true cuando el fallo es de CONTRATO/CONTEXT (org ausente/desconocida/desajustada),
   *  no una denegación legítima de seguridad — auditable de forma distinta. */
  contractError?: boolean
}

export interface LockChecker {
  /**
   * (tercera reparación 5.A) La organización es OBLIGATORIA: el lock consultado
   * es el de (organización, teléfono). Implementaciones standalone pueden
   * ignorarla, jamás usar una org ajena.
   */
  checkLock(phone: string, organizationId: string): Promise<LockCheckResult>
}

export interface SuppressionChecker {
  /**
   * (tercera reparación 5.B) La supresión es POR ORGANIZACIÓN (más la lista
   * global documentada de requisitos legales). La org es obligatoria.
   */
  isSuppressed(phone: string, organizationId: string): Promise<boolean>
}

export interface FatiguePolicy {
  daysThreshold: number
}
