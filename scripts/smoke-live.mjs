/**
 * SMOKE E2E de WHATSPOWER ULTRA (Nivel 3) contra servicios vivos.
 * MODO SALA LIMPIA: audiencia 100% ficticia (5730000000xx), 0 envíos reales.
 * Valida: health, Studio, spintax, validador CSV, creación de campaña con
 * pre-filtrado (locks reales de 2A en :3003) y bloqueo físico de despacho.
 *
 * Uso: node scripts/smoke-live.mjs   (servicios :3003 y :3004 en marcha)
 */
const ULTRA = 'http://localhost:3004'
let passed = 0
let failed = 0

function check(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  ✅ [PASS] ${name}`)
  } else {
    failed++
    console.log(`  ❌ [FAIL] ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// Audiencia 100% ficticia: válidos, uno inválido, un duplicado
const CSV = [
  'phone,name',
  '573000000001,Smoke Uno',
  '573000000002,Smoke Dos',
  '573000000003,Smoke Tres',
  '573000000001,Smoke Duplicado',
  '3000000000,Faltante',
  '123,Invalido',
].join('\n')

const SPINTAX = '{Hola|Buen día|Qué tal} {{name}}, {te escribimos|te contactamos} de ALBRA. Responde BAJA para no recibir más mensajes.'

async function main() {
  console.log('============================================================')
  console.log('  SMOKE ULTRA :3004 — MODO SIMULACIÓN (0 envíos reales)')
  console.log('============================================================')

  // T1. Health
  const h = await fetch(`${ULTRA}/api/health`).then((r) => r.json())
  check('T1 health', h.status === 'ok' && h.service === 'whatspower-ultra')

  // T2. Campaign Studio HTML
  const studio = await fetch(`${ULTRA}/campaigns`)
  const html = await studio.text()
  check('T2 Studio HTML', studio.status === 200 && html.includes('Campaña'))

  // T3. Spintax con variables (alias name/nombre)
  const s1 = await fetch(`${ULTRA}/api/spintax/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ template: SPINTAX, name: 'Smoke' }),
  }).then((r) => r.json())
  const renderedOk = typeof s1.rendered === 'string' && s1.rendered.includes('Smoke') && !s1.rendered.includes('{{')
  check('T3 spintax render + variables', renderedOk, JSON.stringify(s1))

  // T4. Validador CSV (dedupe + normalización + descarte)
  const csvRes = await fetch(`${ULTRA}/api/audiences/preview-csv`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csvContent: CSV }),
  }).then((r) => r.json())
  const phones = (csvRes.contacts || []).map((c) => c.phone)
  const dedupOk = phones.filter((p) => p === '573000000001').length === 1
  const noInvalid = !phones.includes('123')
  // 3 válidos + 3000000000 normalizado a 573000000000 (móvil CO válido); 123 descartado
  check('T4 CSV dedupe+validación+normalización', dedupOk && noInvalid && phones.length === 4 && phones.includes('573000000000'), JSON.stringify(phones))

  // T5. Crear campaña (pre-filtrado Fase 1: locks reales contra 2A :3003)
  const camp = await fetch(`${ULTRA}/api/campaigns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      organizationId: 'org_smoke_ultra',
      name: 'SMOKE-SIMULACION-01',
      templateSpintax: SPINTAX,
      csvContent: CSV,
    }),
  }).then((r) => r.json())
  check('T5 campaña creada', !!camp.id && camp.status === 'DRAFT' && camp.totalTargets === 4, JSON.stringify(camp))

  // T6. Step de despacho fuera de horario (o con salvaguarda si es horario hábil)
  const step1 = await fetch(`${ULTRA}/api/campaigns/${camp.id}/step`, { method: 'POST' }).then((r) => r.json())
  const step2 = await fetch(`${ULTRA}/api/campaigns/${camp.id}/step`, { method: 'POST' }).then((r) => r.json())
  const offHours = step1.status === 'PAUSED_OFF_HOURS' || step2.status === 'PAUSED_OFF_HOURS'
  check('T6 step procesado', !!step1.status && !!step2.status, JSON.stringify({ step1, step2 }))

  // T7. Estados finales: NADA enviado realmente (0 SENT)
  const detail = await fetch(`${ULTRA}/api/campaigns/${camp.id}`).then((r) => r.json())
  const items = detail.items || []
  const allBlocked = items.every((i) => i.status !== 'SENT')
  const guardError = items.some((i) => (i.error_reason || '').includes('DISPATCH_BLOCKED_BY_SAFETY_GUARD'))
  // Bloqueo válido: fuera de horario comercial (anti-ban) o salvaguarda física del dispatcher
  check('T7 0 envíos reales (cero SENT)', allBlocked, JSON.stringify(items.map((i) => i.status)))
  check('T8 bloqueo anti-ban verificado (OFF_HOURS o salvaguarda física)', offHours || guardError, `offHours=${offHours} guard=${guardError} estados=${JSON.stringify(items.map((i) => i.status))}`)

  // T9. Cancelar campaña smoke (dejar estado limpio)
  const cancelled = await fetch(`${ULTRA}/api/campaigns/${camp.id}/cancel`, { method: 'POST' }).then((r) => r.json())
  check('T9 campaña cancelada', cancelled.ok === true)

  // T10. Cleanup: eliminar campañas/ítems SMOKE-% de broadcast.db (no dejar basura)
  const { DatabaseSync } = await import('node:sqlite')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const db = new DatabaseSync(join(repoRoot, 'db', 'broadcast.db'))
  // Cleanup estrictamente acotado a la campaña creada por ESTA ejecución.
  // Nunca borrar otras campañas con prefijo SMOKE de otra prueba/organización.
  db.prepare('DELETE FROM campaign_items WHERE campaign_id = ?').run(camp.id)
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(camp.id)
  const leftover = db.prepare('SELECT COUNT(*) AS n FROM campaigns WHERE id = ?').get(camp.id)
  db.close()
  check('T10 cleanup campaña smoke propia', leftover.n === 0)

  console.log('============================================================')
  console.log(`  RESULTADO: ${passed} PASS / ${failed} FAIL`)
  console.log('  MODO SIMULACIÓN: cero mensajes salieron por WhatsApp.')
  console.log('============================================================')
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('SMOKE ERROR:', e)
  process.exit(1)
})
