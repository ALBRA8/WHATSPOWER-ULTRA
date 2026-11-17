/**
 * consent.ts — helper de pruebas para el ConsentStore obligatorio.
 *
 * (reparación 2026-11-17) Con el consentStore OBLIGATORIO en BroadcastEngine,
 * las pruebas que esperan despachos exitosos deben SEMBRAR consentimiento
 * previo vigente (Ley 1581) para los contactos de cada campaña.
 * Sembrar por campaña (leyendo los ítems reales en la BD) evita duplicar los
 * teléfonos ficticios y funciona tanto con campañas creadas vía CSV como con
 * ítems insertados directamente.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { ConsentStore } from '../../src/safety/consent-store.ts'

/** Otorga consentimiento ACTIVE a todos los contactos de una campaña. */
export function seedConsentForCampaign(
  db: DatabaseSync,
  consentStore: ConsentStore,
  organizationId: string,
  campaignId: string,
): void {
  const rows = db.prepare(
    'SELECT DISTINCT contact_phone FROM campaign_items WHERE campaign_id = ?'
  ).all(campaignId) as Array<{ contact_phone: string }>
  for (const row of rows) {
    consentStore.recordConsent({
      organizationId,
      contactPhone: row.contact_phone,
      whoAuthorized: 'Usuario Demo',
      channel: 'WHATSAPP_OPTIN',
      textShown: 'Autorizo recibir comunicaciones de la organización (datos de prueba)',
      source: 'test_seed',
    })
  }
}

/** Otorga consentimiento ACTIVE a un teléfono concreto (datos de prueba). */
export function seedConsentPhone(
  consentStore: ConsentStore,
  organizationId: string,
  phone: string,
): void {
  consentStore.recordConsent({
    organizationId,
    contactPhone: phone,
    whoAuthorized: 'Usuario Demo',
    channel: 'WHATSAPP_OPTIN',
    textShown: 'Autorizo recibir comunicaciones de la organización (datos de prueba)',
    source: 'test_seed',
  })
}
