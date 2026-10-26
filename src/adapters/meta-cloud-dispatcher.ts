import type { Dispatcher, DispatchResult } from '../types.ts'

export interface MetaCloudConfig {
  phoneNumberId?: string
  accessToken?: string
  apiVersion?: string
  mockMode?: boolean
}

/**
 * Adaptador Oficial Meta Cloud API (WhatsApp Business Platform / BSP)
 * Permite despachar mediante la infraestructura oficial de Meta con soporte de cuenta verificada
 */
export class MetaCloudDispatcher implements Dispatcher {
  phoneNumberId: string
  accessToken: string
  apiVersion: string
  mockMode: boolean
  dispatchedMessages: Array<{ to: string; text: string; messageId: string; timestamp: number }> = []

  constructor(config?: MetaCloudConfig) {
    this.phoneNumberId = config?.phoneNumberId || process.env.META_PHONE_NUMBER_ID || '100000000000000'
    this.accessToken = config?.accessToken || process.env.META_ACCESS_TOKEN || ''
    this.apiVersion = config?.apiVersion || 'v19.0'
    this.mockMode = config?.mockMode ?? (!this.accessToken || process.env.META_MOCK_MODE === 'true')
  }

  async dispatch(to: string, text: string): Promise<DispatchResult> {
    const formattedPhone = to.replace(/\D/g, '')

    // Si opera en modo simulación (Sala Limpia)
    if (this.mockMode) {
      const messageId = `wamid.HBgL${Date.now()}${Math.random().toString(36).substring(2, 7)}`
      this.dispatchedMessages.push({ to: formattedPhone, text, messageId, timestamp: Date.now() })
      return {
        success: true,
        messageId,
      }
    }

    const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`
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
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
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

      this.dispatchedMessages.push({ to: formattedPhone, text, messageId, timestamp: Date.now() })
      return {
        success: true,
        messageId,
      }
    } catch (err: any) {
      return {
        success: false,
        error: `META_CLOUD_NETWORK_ERROR: ${err?.message || err}`,
      }
    }
  }
}
