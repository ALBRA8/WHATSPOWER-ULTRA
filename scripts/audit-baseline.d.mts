export interface AuditResult {
  total: number
  verified: any[]
  synthetic: any[]
  invalid: any[]
  duplicates: any[]
  directAuditResults: any[]
  totalHistoryFindings: number
  historyFindingsMatchingBaseline: number
  historyFindingsMatchingAllowlist: number
  unauthorizedFindings: any[]
  orphanedEntries: any[]
}

export function auditBaseline(options?: {
  execFn?: (cmd: string, opt?: any) => string
  readFn?: (path: string, enc?: string) => string
  baselinePath?: string
  allowlistPath?: string
  baselineEntries?: any[]
  allowlistEntries?: any[]
  scanHistory?: boolean
}): AuditResult

export function runCli(): void
