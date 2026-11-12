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
}

export const ALLOW_MARK: string
export const PATTERNS: SecretPattern[]
export function shouldSkipFile(filePath: string): boolean
export function parseSource(source: string): { isHistory: boolean; commit: string; file: string }
export function mask(value: string): string
export function computeFingerprint(value: string): string
export function scanText(text: string, source?: string): SecretFinding[]
export function loadJsonList(filePath: string): any[]
export function filterAllowlist(findings: SecretFinding[], allowlistPath: string): { kept: SecretFinding[]; excluded: any[] }
export function filterBaseline(findings: SecretFinding[], baselinePath: string): { known: any[]; isNew: SecretFinding[] }
export function scanWorkingTree(): SecretFinding[]
export function scanGitHistory(): SecretFinding[]
