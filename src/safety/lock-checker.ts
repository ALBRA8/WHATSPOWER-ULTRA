import type { LockChecker, LockCheckResult } from '../types.ts'

/**
 * LockChecker para modo Plug & Play Standalone (cuando Nivel 2 WhatsPower no está contratado ni activo)
 */
export class StandaloneLockChecker implements LockChecker {
  async checkLock(_phone: string): Promise<LockCheckResult> {
    return { available: true }
  }
}

export class Http2ALockChecker implements LockChecker {
  baseUrl: string
  timeoutMs: number
  enabled: boolean

  constructor(options?: { baseUrl?: string; timeoutMs?: number; enabled?: boolean }) {
    this.enabled = options?.enabled ?? (process.env.WHATSPOWER_ENABLED !== 'false')
    this.baseUrl = options?.baseUrl || process.env.AGENTIC_2A_URL?.replace('/api/inbound', '') || 'http://localhost:3003'
    this.timeoutMs = options?.timeoutMs || 1500
  }

  async checkLock(phone: string): Promise<LockCheckResult> {
    // Si Nivel 2 no está habilitado, opera en modo enchufe directo (sin dependencia de Nivel 2)
    if (!this.enabled) {
      return { available: true }
    }

    const encodedPhone = encodeURIComponent(phone)
    const url = `${this.baseUrl}/api/internal/locks/${encodedPhone}`

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      })

      if (!response.ok) {
        // Fail-Closed: respuesta no 200 -> no disponible
        return {
          available: false,
          error: `HTTP_${response.status}_LOCK_CHECK_FAILED`,
        }
      }

      const data = await response.json() as { phone: string; locked: boolean; lock?: { current_state: string } }

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
 * MockLockChecker para pruebas unitarias en sala limpia
 */
export class MockLockChecker implements LockChecker {
  lockedPhones: Map<string, string> = new Map()
  simulateTimeout: boolean = false
  simulateError: boolean = false

  setLock(phone: string, state: string) {
    this.lockedPhones.set(phone, state)
  }

  releaseLock(phone: string) {
    this.lockedPhones.delete(phone)
  }

  async checkLock(phone: string): Promise<LockCheckResult> {
    if (this.simulateTimeout || this.simulateError) {
      return {
        available: false,
        error: 'MOCK_FAIL_CLOSED_SIMULATION',
      }
    }

    if (this.lockedPhones.has(phone)) {
      return {
        available: false,
        state: this.lockedPhones.get(phone),
      }
    }

    return { available: true }
  }
}
