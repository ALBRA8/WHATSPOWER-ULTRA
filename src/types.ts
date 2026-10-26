/**
 * Tipos y Contratos para Capa 2B (albra-broadcast-2b)
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
}

export interface LockChecker {
  checkLock(phone: string): Promise<LockCheckResult>
}

export interface SuppressionChecker {
  isSuppressed(phone: string): Promise<boolean>
}

export interface FatiguePolicy {
  daysThreshold: number
}
