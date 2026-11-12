export interface SecretPattern {
  id: string
  desc: string
  re: RegExp
}

export interface SecretFinding {
  pattern: string
  desc: string
  source: string
  line: number
  preview: string
  fingerprint: string
  raw?: string
}

export interface AllowlistEntry {
  file: string
  category: string
  fingerprint: string
  reason: string
  matchPrefix?: string
  synthetic?: boolean
}

export interface BaselineEntry {
  commit: string
  file: string
  category: string
  fingerprint: string
  status?: string
  rotation?: string
}

export const ALLOW_MARK: string
export const PATTERNS: SecretPattern[]
export function normalizePath(filePath: string): string
export function shouldSkipFile(filePath: string): boolean
export function parseSource(source: string): { isHistory: boolean; commit: string; file: string }
export function mask(value: string): string
export function computeFingerprint(value: string): string
export function scanText(text: string, source?: string): SecretFinding[]
export function validateAllowlist(entries: any): boolean
export function validateBaseline(entries: any): boolean
export function loadJsonList(filePath: string, required?: boolean): any[]
export function filterAllowlist(findings: SecretFinding[], allowlistOrPath: string | AllowlistEntry[]): { kept: SecretFinding[]; excluded: any[] }
export function filterBaseline(findings: SecretFinding[], baselineOrPath: string | BaselineEntry[]): { known: any[]; isNew: SecretFinding[] }
export function scanWorkingTree(options?: { execFn?: (cmd: string, opt?: any) => string; readFn?: (path: string, enc: string) => string }): SecretFinding[]
export function scanGitHistory(options?: { execFn?: (cmd: string, opt?: any) => string }): SecretFinding[]
