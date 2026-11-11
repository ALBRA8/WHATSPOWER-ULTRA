import type { Dispatcher, DispatchResult } from '../types.ts'
import { OrgWaCredentialRegistry, EnvOrgWaSource } from '../org-wa-credentials.ts'

export interface MetaCloudConfig {
  /**
   * OLEADA 2 (decisión 2026-11-11): las credenciales se resuelven POR
   * ORGANIZACIÓN desde el registro (env META_ORG_CREDENTIALS / índice
   * META_ORG_NUMBERS, o vía CRM). La credencial global META_ACCESS_TOKEN
   * YA NO es una vía de envío: cada campaña despacha con las credenciales de
   * SU organización (puntos 2, 6, 7 y 8). Inyectable para pruebas.
   */
  registry?: OrgWaCredentialRegistry
  apiVersion?: string
  /** Solo pruebas/salas limpias: simulación explícita, sin red. */
  mockMode?: boolean
  /** Inyectable para pruebas sin red real. */
  fetchImpl?: typeof fetch
  /** Guarda anti-envío real (default: env ALLOW_REAL_DISPATCH). */
  allowRealDispatch?: boolean
}

/**
 * Adaptador Oficial Meta Cloud API POR ORGANIZACIÓN
 * (WhatsApp Business Platform / BSP).
 *
 * REGLAS (decisión de negocio 2026-11-11):
 *  - Cada organización despacha con SU token y SU número (phone_number_id de
 *    la conexión registrada en CRM o declarada en env).
 *  - Una organización jamás usa, consulta ni modifica las conexiones de otra:
 *    el registro verifica la pertenencia org↔número (fail-closed).
 *  - Sin organización, sin conexión propia o sin credencial resoluble → el
 *    despacho de ESA organización se rechaza; las demás siguen operativas
 *    (desconexión/revocación aislada, punto 9).
 *  - NINGÚN envío real sin ALLOW_REAL_DISPATCH=true (salvaguarda dura,
 *    independiente de la configuración — orden de cierre 2026-11-06).
 */
export class MetaCloudDispatcher implements Dispatcher {
  registry: OrgWaCredentialRegistry
  apiVersion: string
  mockMode: boolean
  allowRealDispatch: boolean
  private fetchImpl: typeof fetch
  /** Registro de despachos para pruebas y observabilidad (sin secretos). */
  dispatchedMessages: Array<{ to: string; text: string; messageId: string; timestamp: number; organizationId: string; phoneNumberId: string }> = []

  constructor(config?: MetaCloudConfig) {
    this.registry = config?.registry ?? new OrgWaCredentialRegistry([new EnvOrgWaSource()])
    this.apiVersion = config?.apiVersion ?? process.env.META_GRAPH_VERSION ?? 'v21.0'
    // Mock SOLO explícito (mockMode=true): nunca por ausencia de credenciales
    // (prohibido el Mock silencioso; sin conexión la org FALLA, no simula).
    this.mockMode = config?.mockMode ?? false
    this.fetchImpl = config?.fetchImpl ?? fetch
    this.allowRealDispatch = config?.allowRealDispatch ?? (process.env.ALLOW_REAL_DISPATCH === 'true')
  }

  async dispatch(to: string, text: string, organizationId?: string): Promise<DispatchResult> {
    const formattedPhone = to.replace(/\D/g, '')

    // Modo simulación (sala limpia): NO envía nada real.
    if (this.mockMode) {
      const messageId = `wamid.HBgL${Date.now()}${Math.random().toString(36).substring(2, 7)}`
      this.dispatchedMessages.push({ to: formattedPhone, text, messageId, timestamp: Date.now(), organizationId: organizationId ?? '', phoneNumberId: 'mock' })
      return { success: true, messageId }
    }

    // SALVAGUARDA DURA (orden de cierre 2026-11-06): NINGÚN envío real sale por
    // Meta Cloud sin ALLOW_REAL_DISPATCH=true, INDEPENDIENTEMENTE de la
    // configuración. Fail-closed. PRIMERO el kill-switch físico; después la
    // identidad de organización.
    if (!this.allowRealDispatch) {
      return {
        success: false,
        error: 'DISPATCH_BLOCKED_BY_SAFETY_GUARD: envío real vía Meta Cloud bloqueado — ALLOW_REAL_DISPATCH no está en true (fail-closed)',
      }
    }

    // B3/P0.1 — IDENTIDAD OBLIGATORIA: sin organización no hay envío (el
    // despacho jamás adivina una org "por defecto").
    if (!organizationId || typeof organizationId !== 'string') {
      return {
        success: false,
        error: 'ORG_REQUIRED: el despacho Meta Cloud exige la organización de la campaña (fail-closed, decisión #8)',
      }
    }

    // 1) Conexión(es) de ESA organización (una org puede tener varios números
    //    según su plan; la campaña sale por el primero conectado).
    const connections = await this.registry.listForOrg(organizationId)
    if (connections.length === 0) {
      return {
        success: false,
        error: `NO_CONNECTED_NUMBER: la organización ${organizationId} no tiene números de WhatsApp conectados (fail-closed; las demás organizaciones siguen operativas)`,
      }
    }
    const connection = connections[0]

    // 2) Credencial de ESA organización para ESE número (la fuente re-verifica
    //    la pertenencia; una credencial de org-a jamás entrega token de org-b).
    const credential = await this.registry.resolveCredential(organizationId, connection.phoneNumberId)
    if (!credential) {
      return {
        success: false,
        error: 'CREDENTIAL_UNAVAILABLE: sin credencial resoluble para la organización (fail-closed)',
      }
    }

    return this.dispatchViaGraph(credential, formattedPhone, text)
  }

  private async dispatchViaGraph(
    credential: { organizationId: string; phoneNumberId: string; accessToken: string },
    formattedPhone: string,
    text: string,
  ): Promise<DispatchResult> {
    const url = `https://graph.facebook.com/${this.apiVersion}/${credential.phoneNumberId}/messages`
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: formattedPhone,
      type: 'text',
      text: {
        preview_url: true,
        body: text,
      },
    }

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${credential.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      })

      if (!response.ok) {
        const errText = await response.text()
        return {
          success: false,
          error: `META_CLOUD_API_HTTP_${response.status}: ${errText}`,
        }
      }

      const data = (await response.json()) as { messages?: Array<{ id: string }> }
      const messageId = data.messages?.[0]?.id || `meta_msg_${Date.now()}`

      this.dispatchedMessages.push({ to: formattedPhone, text, messageId, timestamp: Date.now(), organizationId: credential.organizationId, phoneNumberId: credential.phoneNumberId })
      return {
        success: true,
        messageId,
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        success: false,
        error: `META_CLOUD_NETWORK_ERROR: ${message}`,
      }
    }
  }
}
