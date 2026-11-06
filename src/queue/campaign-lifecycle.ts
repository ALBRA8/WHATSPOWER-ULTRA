import type { DatabaseSync } from 'node:sqlite'

/**
 * Máquina de estados de campañas (segunda reparación — orden §4.B).
 *
 * Causa raíz corregida: /resume aplicaba un UPDATE CIEGO a RUNNING — una
 * campaña CANCELLED podía "resucitarse". Ahora toda transición es CONDICIONAL
 * y ATÓMICA (UPDATE ... WHERE status IN <orígenes legales>): si el estado actual
 * no está entre los orígenes legales del destino, la operación se rechaza con
 * 409 y la fila NO cambia.
 *
 *   DRAFT ──▶ RUNNING ──▶ COMPLETED (terminal)
 *     │  ▲      │  ▲
 *     ▼  │      ▼  │
 *  CANCELLED ◀── PAUSED
 *
 *  - CANCELLED y COMPLETED son TERMINALES: ninguna transición sale de ellos.
 *  - La pertenencia a la organización se verifica en el MISMO UPDATE
 *    (organization_id = ?): ownership y transición son indivisibles.
 */

export type CampaignStatus =
  | 'DRAFT'
  | 'RUNNING'
  | 'PAUSED'
  | 'PAUSED_OFF_HOURS'
  | 'PAUSED_COOLDOWN'
  | 'CANCELLED'
  | 'COMPLETED'
  | 'FAILED'

/** Orígenes legales para cada destino (el inverso del grafo anterior). */
const LEGAL_SOURCES: Record<string, CampaignStatus[]> = {
  RUNNING: ['DRAFT', 'PAUSED', 'PAUSED_OFF_HOURS', 'PAUSED_COOLDOWN'],
  PAUSED: ['RUNNING', 'DRAFT'],
  PAUSED_OFF_HOURS: ['RUNNING'],
  PAUSED_COOLDOWN: ['RUNNING'],
  CANCELLED: ['DRAFT', 'RUNNING', 'PAUSED', 'PAUSED_OFF_HOURS', 'PAUSED_COOLDOWN'],
  COMPLETED: ['RUNNING'],
  FAILED: ['RUNNING', 'DRAFT'],
}

export type TransitionResult =
  | { ok: true; from: string }
  | { ok: false; code: 'NOT_FOUND' | 'ILLEGAL_TRANSITION'; from?: string; message: string }

export function transitionCampaignStatus(
  db: DatabaseSync,
  campaignId: string,
  organizationId: string,
  to: CampaignStatus,
  extraSet: Record<string, unknown> = {}
): TransitionResult {
  const sources = LEGAL_SOURCES[to]
  if (!sources || sources.length === 0) {
    return { ok: false, code: 'ILLEGAL_TRANSITION', message: `el estado destino ${to} no admite transición` }
  }

  const current = db.prepare('SELECT status FROM campaigns WHERE id = ? AND organization_id = ?').get(campaignId, organizationId) as
    | { status: string }
    | undefined
  if (!current) {
    return { ok: false, code: 'NOT_FOUND', message: 'Campaña no encontrada' }
  }
  if (!sources.includes(current.status as CampaignStatus)) {
    return {
      ok: false,
      code: 'ILLEGAL_TRANSITION',
      from: current.status,
      message: `transición ${current.status} → ${to} no permitida (${current.status} es terminal o el destino no es legal desde ahí)`,
    }
  }

  const extraKeys = Object.keys(extraSet)
  const setClause = ['status = ?', ...extraKeys.map((k) => `${k} = ?`)].join(', ')
  const params = [to, ...extraKeys.map((k) => extraSet[k])]
  const res = db.prepare(
    `UPDATE campaigns SET ${setClause} WHERE id = ? AND organization_id = ? AND status IN (${sources.map(() => '?').join(', ')})`
  ).run(...params, campaignId, organizationId, ...sources)

  // node:sqlite devuelve changes como number | bigint
  if (Number(res.changes) !== 1) {
    // Otra operación cambió el estado entre la lectura y el UPDATE (carrera):
    // la transición NO se aplicó.
    const nowStatus = (db.prepare('SELECT status FROM campaigns WHERE id = ? AND organization_id = ?').get(campaignId, organizationId) as { status?: string } | undefined)?.status
    return {
      ok: false,
      code: 'ILLEGAL_TRANSITION',
      from: nowStatus,
      message: `la campaña cambió de estado durante la operación (estado actual: ${nowStatus ?? 'desconocido'}); ${current.status} → ${to} no aplicada`,
    }
  }
  return { ok: true, from: current.status }
}

/** ¿Está la campaña en un estado desde el cual el worker PUEDE despachar? */
export function isDispatchableStatus(status: string): boolean {
  return status === 'RUNNING' || status === 'DRAFT'
}
