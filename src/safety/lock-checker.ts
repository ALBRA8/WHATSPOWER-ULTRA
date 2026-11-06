import type { DatabaseSync } from 'node:sqlite'
import type { LockChecker, LockCheckResult } from '../types.ts'
import { resolveOrgServiceCredential } from '../org-credentials.ts'

/**
 * LockChecker para modo Plug & Play Standalone (cuando Nivel 2 WhatsPower no está contratado ni activo)
 * (tercera reparación 5.A) No consulta a nadie: "disponible" SIEMPRE es un
 * resultado LOCAL explícito del modo standalone, jamás una respuesta de red
 * malinterpretada. La organización se acepta por contrato pero no se usa.
 */
export class StandaloneLockChecker implements LockChecker {
  async checkLock(_phone: string, _organizationId: string): Promise<LockCheckResult> {
    return { available: true }
  }
}

/**
 * (tercera reparación 5.A) CLASIFICACIÓN DE ERRORES — la causa raíz del
 * bloqueo 2A↔2B: una incompatibilidad de contrato (p. ej. falta de X-Org-Id →
 * 400) era indistinguible de una denegación de seguridad legítima. Ahora:
 *  - Toda petición envía `X-Org-Id` (además del Bearer).
 *  - La respuesta DEBE confirmar la organización (eco `organizationId`):
 *    sin eco → TENANT_UNVERIFIED; eco distinto → TENANT_MISMATCH; ambos son
 *    contractError=true (fail-closed, auditable como fallo de contrato).
 *  - HTTP != 200 → fail-closed (no despachar).
 *  - Timeout/red → fail-closed (no despachar).
 */
export class Http2ALockChecker implements LockChecker {
  baseUrl: string
  timeoutMs: number
  enabled: boolean

  constructor(options?: { baseUrl?: string; timeoutMs?: number; enabled?: boolean }) {
    this.enabled = options?.enabled ?? (process.env.WHATSPOWER_ENABLED !== 'false')
    this.baseUrl = options?.baseUrl || process.env.AGENTIC_2A_URL?.replace('/api/inbound', '') || 'http://localhost:3003'
    this.timeoutMs = options?.timeoutMs || 1500
  }

  async checkLock(phone: string, organizationId: string): Promise<LockCheckResult> {
    // Si Nivel 2 no está habilitado, opera en modo enchufe directo (sin dependencia de Nivel 2)
    if (!this.enabled) {
      return { available: true }
    }
    if (!organizationId || typeof organizationId !== 'string') {
      // Fail-closed de contexto: sin organización NO se consulta ni se despacha
      return { available: false, contractError: true, error: 'TENANT_CONTEXT_INVALID: checkLock exige organizationId de la campaña' }
    }

    // B3: credencial de servicio VINCULADA a esta organización. Sin ella la
    // llamada NO se hace (fail-closed, sin red): el secreto global ya no
    // sustituye la validación de organización.
    const orgCredential = resolveOrgServiceCredential(organizationId)
    if (!orgCredential) {
      return {
        available: false,
        contractError: true,
        error: `TENANT_CREDENTIAL_MISSING: sin credencial de servicio registrada para ${organizationId} (configura WHATSPOWER_ORG_CREDENTIALS "orgId:credencial")`,
      }
    }

    const encodedPhone = encodeURIComponent(phone)
    const url = `${this.baseUrl}/api/internal/locks/${encodedPhone}`

    try {
      const headers: Record<string, string> = {
        'Accept': 'application/json',
        'X-Org-Id': organizationId,
        'Authorization': `Bearer ${orgCredential}`,
      }
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      })

      if (!response.ok) {
        // Fail-Closed: respuesta no 200 -> no disponible. Un 400/403 por
        // organización se marca como error de CONTRATO (auditable, no es un lock).
        const contract = response.status === 400 || response.status === 403
        return {
          available: false,
          contractError: contract,
          error: contract
            ? `TENANT_CONTEXT_REJECTED_${response.status}: Capa 2A rechazó el contexto de organización (contrato X-Org-Id)`
            : `HTTP_${response.status}_LOCK_CHECK_FAILED`,
        }
      }

      const data = await response.json() as {
        phone: string
        locked: boolean
        organizationId?: string
        lock?: { current_state: string; organization_id?: string }
      }

      // (5.A) VERIFICACIÓN ESTRICTA DEL ECO DE ORGANIZACIÓN: la respuesta debe
      // corresponder a la MISMA organización que se consultó. Una respuesta sin
      // eco o desajustada NO se acepta como "libre" (jamás se confunde una
      // incompatibilidad de contrato con un resultado de seguridad legítimo).
      if (typeof data.organizationId !== 'string' || data.organizationId.length === 0) {
        return { available: false, contractError: true, error: 'TENANT_UNVERIFIED: Capa 2A no confirmó la organización en la respuesta' }
      }
      if (data.organizationId !== organizationId) {
        return { available: false, contractError: true, error: `TENANT_MISMATCH: Capa 2A respondió para ${data.organizationId}, se consultó ${organizationId}` }
      }

      if (data.locked) {
        return {
          available: false,
          state: data.lock?.current_state || 'LOCKED_UNKNOWN',
        }
      }

      return {
        available: true,
      }
    } catch (err: any) {
      // Fail-Closed estricto ante timeout o error de red: NUNCA despachar si 2A no responde
      return {
        available: false,
        error: `LOCK_UNAVAILABLE: ${err?.message || 'NETWORK_TIMEOUT'}`,
      }
    }
  }
}

/**
 * MockLockChecker para pruebas unitarias en sala limpia (clave por org+teléfono)
 */
export class MockLockChecker implements LockChecker {
  lockedPhones: Map<string, string> = new Map()
  simulateTimeout: boolean = false
  simulateError: boolean = false
  /** Simular respuesta SIN eco de organización (contrato roto) */
  simulateMissingOrgEcho: boolean = false
  /** Simular eco de OTRA organización */
  simulateWrongOrgEcho?: string
  lastCalledWith: { phone: string; organizationId: string } | null = null

  setLock(phone: string, state: string, organizationId: string = '*') {
    this.lockedPhones.set(`${organizationId}\u0000${phone}`, state)
  }

  releaseLock(phone: string, organizationId: string = '*') {
    this.lockedPhones.delete(`${organizationId}\u0000${phone}`)
  }

  async checkLock(phone: string, organizationId: string): Promise<LockCheckResult> {
    this.lastCalledWith = { phone, organizationId }
    if (this.simulateTimeout || this.simulateError) {
      return {
        available: false,
        error: 'MOCK_FAIL_CLOSED_SIMULATION',
      }
    }
    if (this.simulateMissingOrgEcho || this.simulateWrongOrgEcho) {
      return {
        available: true,
        contractError: true,
        error: this.simulateMissingOrgEcho ? 'TENANT_UNVERIFIED (simulado)' : `TENANT_MISMATCH (simulado: ${this.simulateWrongOrgEcho})`,
      }
    }
    const state = this.lockedPhones.get(`${organizationId}\u0000${phone}`)
    if (state) {
      return { available: false, state }
    }
    return { available: true }
  }
}
