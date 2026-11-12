export interface AuditResult {
  total: number
  verified: any[]
  synthetic: any[]
  invalid: any[]
  duplicates: any[]
  directAuditResults: any[]
  totalHistoryFindings: number
  historyFindingsMatchingBaseline: number
  unauthorizedFindings: any[]
  orphanedEntries: any[]
  totalAllowlistEntries: number
  totalWorkingTreeFindings: number
  unauthorizedWorkingTreeFindings: any[]
  orphanedAllowlistEntries: any[]
}

export function verifySyntheticEvidence(entry: any, blobContent: string, detectedFindings: any[]): boolean

export function auditBaseline(options?: {
  execFn?: (cmd: string, opt?: any) => string
  readFn?: (path: string, enc?: string) => string
  baselinePath?: string
  allowlistPath?: string
  baselineEntries?: any[]
  allowlistEntries?: any[]
  scanHistory?: boolean
  scanWorkingTree?: boolean
}): AuditResult

export function runCli(): void
