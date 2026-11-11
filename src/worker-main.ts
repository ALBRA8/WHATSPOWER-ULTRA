/**
 * worker-main.ts — PUNTO DE ENTRADA del proceso persistente de ULTRA
 * (OLEADA 2: procesos persistentes — decisión de negocio 2026-11-11).
 *
 * Proceso daemon que consume la cola de difusión de forma CONTINUA:
 *
 *   node --experimental-strip-types src/worker-main.ts
 *   (o: npm run worker)
 *
 * Cableado de producción (mismos adaptadores que server.ts, sin duplicar
 * lógica — regla 1 del proyecto):
 *   - Dispatcher POR ORGANIZACIÓN: TRANSPORT_ENGINE=meta_cloud →
 *     MetaCloudDispatcher (credenciales Meta de CADA org, decisión
 *     2026-11-11 #7); en su defecto HttpCrmDaemonDispatcher (puente al
 *     daemon del CRM), ambos con salvaguarda ALLOW_REAL_DISPATCH.
 *   - Locks 2A y supresiones JIT (Composite: local + servicio 2A) —
 *     desactivables solo para desarrollo aislado (WHATSPOWER_ENABLED=false).
 *   - Recuperación ante caídas al arrancar (recoverFromCrash) y
 *     reconciliación de claims expirados en cada tick.
 *
 * Fail-closed de producción (orden de cierre 2026-11-06): con
 * NODE_ENV=production, si la configuración es insegura el proceso NO arranca
 * (productionConfigProblems) y la salvaguarda de despacho queda activa.
 * Parada graciosa: SIGTERM/SIGINT detienen el bucle y ESPERAN el tick en
 * vuelo antes de salir (los ítems DISPATCHING terminan su ciclo; nada se
 * pierde ni se duplica).
 */
import { createBroadcastDatabase } from './db.ts'
import { BroadcastEngine } from './queue/broadcast-worker.ts'
import { PersistentBroadcastWorker } from './queue/persistent-worker.ts'
import { HttpCrmDaemonDispatcher } from './adapters/dispatcher.ts'
import { MetaCloudDispatcher } from './adapters/meta-cloud-dispatcher.ts'
import { Http2ALockChecker, StandaloneLockChecker } from './safety/lock-checker.ts'
import { LocalSuppressionStore, Http2ASuppressionChecker, CompositeSuppressionChecker } from './safety/suppression.ts'
import { productionConfigProblems } from './security.ts'

// Carga el .env del repo si existe (mismo patrón que Capa 2A/3).
try { process.loadEnvFile() } catch { /* sin .env: se usa el entorno del proceso */ }

const isProduction = process.env.NODE_ENV === 'production'

// Guard fail-closed: en producción la configuración insegura NO arranca el
// worker (jamás valores en el log — solo los nombres de las variables).
if (isProduction) {
  const problems = productionConfigProblems()
  if (problems.length > 0) {
    console.error('[worker 2B ✋] Arranque bloqueado por configuración insegura/incompleta:')
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
}

if (process.env.ALLOW_REAL_DISPATCH !== 'true') {
  console.warn('[worker 2B AVISO] ALLOW_REAL_DISPATCH != true: todo despacho quedará BLOQUEADO por la salvaguarda (fail-closed).')
}

const db = createBroadcastDatabase(process.env.BROADCAST_DB_PATH)

const whatsPowerEnabled = process.env.WHATSPOWER_ENABLED !== 'false'
const useMetaCloud = process.env.TRANSPORT_ENGINE === 'meta_cloud'
const dispatcher = useMetaCloud
  ? new MetaCloudDispatcher()
  : new HttpCrmDaemonDispatcher({ allowRealDispatch: process.env.ALLOW_REAL_DISPATCH === 'true' })

const engine = new BroadcastEngine({
  db,
  dispatcher,
  lockChecker: whatsPowerEnabled ? new Http2ALockChecker({ enabled: true }) : new StandaloneLockChecker(),
  suppressionStore: whatsPowerEnabled
    ? new CompositeSuppressionChecker(new LocalSuppressionStore(db), new Http2ASuppressionChecker())
    : new LocalSuppressionStore(db),
})

// Recuperación ante caídas ANTES de consumir (ítems transitorios de una
// ejecución anterior vuelven a un estado honesto y reclamable).
const recovery = engine.recoverFromCrash()
if (recovery.recoveredCount > 0) {
  console.log(`[worker 2B] Recuperación ante caídas: ${recovery.recoveredCount} ítems transitorios restablecidos`)
}

const worker = new PersistentBroadcastWorker({
  engine,
  tickIntervalMs: Number(process.env.WORKER_TICK_MS || 5_000),
  itemsPerCampaignPerTick: Number(process.env.WORKER_ITEMS_PER_CAMPAIGN || 5),
  maxCampaignsPerTick: Number(process.env.WORKER_MAX_CAMPAIGNS || 20),
  staleClaimSeconds: Number(process.env.WORKER_STALE_SECONDS || 900),
  logger: (line) => console.log(line),
})

console.log(`[worker 2B] proceso persistente ULTRA iniciado (transporte=${useMetaCloud ? 'meta_cloud POR ORGANIZACIÓN' : 'crm_daemon'}, db=${process.env.BROADCAST_DB_PATH || '<repo>/db/broadcast.db'})`)
worker.start()

async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`[worker 2B] ${signal} recibido: parada graciosa (esperando tick en vuelo)…`)
  try {
    await worker.stop()
  } finally {
    process.exit(0)
  }
}

process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM') })
process.on('SIGINT', () => { void gracefulShutdown('SIGINT') })

// Errores no capturados: el worker NO muere por un fallo de un tick/campaña,
// pero un fallo del propio bucle de eventos se reporta y termina limpio.
process.on('uncaughtException', (err) => {
  console.error('[worker 2B] excepción no capturada (parada de emergencia):', err.message)
  void gracefulShutdown('uncaughtException')
})
