import type { Dispatcher, DispatchResult } from '../types.ts'

export class MockDispatcher implements Dispatcher {
  dispatched: Array<{ to: string; text: string; timestamp: number }> = []
  shouldFail: boolean = false
  failureReason: string = 'MOCK_DISPATCH_FAILED'

  async dispatch(to: string, text: string, _organizationId?: string): Promise<DispatchResult> {
    if (this.shouldFail) {
      return { success: false, error: this.failureReason }
    }

    const messageId = `mock_wa_msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    this.dispatched.push({ to, text, timestamp: Date.now() })
    return { success: true, messageId }
  }
}

export class HttpCrmDaemonDispatcher implements Dispatcher {
  endpointUrl: string
  secret: string
  allowRealDispatch: boolean

  constructor(options?: { endpointUrl?: string; secret?: string; allowRealDispatch?: boolean }) {
    this.endpointUrl = options?.endpointUrl || (process.env.WHATSAPP_DAEMON_URL ? `${process.env.WHATSAPP_DAEMON_URL}/send` : 'http://localhost:3002/send')
    this.secret = options?.secret || process.env.INTERNAL_API_SECRET || ''
    this.allowRealDispatch = options?.allowRealDispatch ?? false
  }

  async dispatch(to: string, text: string, organizationId?: string): Promise<DispatchResult> {
    // SALVAGUARDA FÍSICA (orden de cierre 2026-11-06): si no se autoriza explícitamente el
    // envío real, BLOQUEAR SIEMPRE — la condición anterior por substring ':3002' era
    // bypasseable cambiando el host/puerto del daemon.
    if (!this.allowRealDispatch) {
      return {
        success: false,
        error: 'DISPATCH_BLOCKED_BY_SAFETY_GUARD: envío real bloqueado — allowRealDispatch no está autorizado (fail-closed)',
      }
    }

    // B3 — IDENTIDAD DE ORGANIZACIÓN OBLIGATORIA (fail-closed, sin red):
    // el despacho NOMBRA su organización (P0.1: el daemon jamás acepta "la
    // sesión global"). Sin organización no se despacha.
    if (!organizationId || typeof organizationId !== 'string') {
      return {
        success: false,
        error: 'TENANT_CONTEXT_INVALID: dispatch exige organizationId de la campaña (el daemon no acepta despachos sin organización)',
      }
    }

    try {
      const response = await fetch(this.endpointUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.secret}`,
          'X-Org-Id': organizationId,
        },
        body: JSON.stringify({ to, text, orgId: organizationId }),
        signal: AbortSignal.timeout(5000),
      })

      if (!response.ok) {
        let errDetail = ''
        try {
          const errJson = await response.json() as { error?: string }
          errDetail = errJson.error || JSON.stringify(errJson)
        } catch {
          errDetail = await response.text().catch(() => '')
        }
        return {
          success: false,
          error: `DAEMON_HTTP_${response.status}: ${errDetail || response.statusText}`,
        }
      }

      let data: any
      try {
        data = await response.json()
      } catch (jsonErr: any) {
        // Respuesta malformada del servidor
        return {
          success: false,
          uncertain: true,
          error: `DAEMON_MALFORMED_RESPONSE: Servidor retornó HTTP 200 pero cuerpo no es JSON válido (${jsonErr.message})`,
        }
      }

      if (!data || typeof data !== 'object' || !data.success) {
        return {
          success: false,
          error: data?.error || 'DAEMON_UNKNOWN_FAILURE: success !== true en respuesta',
        }
      }

      return { success: true, messageId: data.messageId }
    } catch (err: any) {
      const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.message?.includes('timeout')
      // Si ocurrió un timeout tras enviar los bytes, el resultado es INCIERTO (el daemon pudo haber enviado)
      return {
        success: false,
        uncertain: isTimeout,
        error: isTimeout
          ? `DISPATCH_UNCERTAIN_TIMEOUT: No se recibió confirmación del daemon a tiempo (${err.message})`
          : `DISPATCH_NETWORK_ERROR: ${err?.message || err}`,
      }
    }
  }
}
