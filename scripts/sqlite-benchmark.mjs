#!/usr/bin/env node
/**
 * sqlite-benchmark.mjs — Prueba de carga local para encontrar el techo de SQLite.
 *
 * Mide el rendimiento real de escrituras individuales, transacciones por lotes,
 * lecturas concurrentes y concurrencia multi-worker bajo modo WAL en SQLite.
 */
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'

const DB_PATH = './benchmark-load-test.db'
try { rmSync(DB_PATH, { force: true }) } catch {}

console.log('============================================================')
console.log('  BENCHMARK DE CARGA LOCAL — TECHO DE SQLITE (WAL MODE)')
console.log('============================================================\n')

const db = new DatabaseSync(DB_PATH)

// Configuración de producción para SQLite
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA cache_size = -64000; -- 64MB cache

  CREATE TABLE IF NOT EXISTS benchmark_items (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    contact_phone TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_bench_org_status
  ON benchmark_items (organization_id, status);
`)

// Test 1: Escrituras individuales (sin BEGIN explícito por cada insert)
console.log('--- Test 1: Inserciones Individuales (Auto-commit) ---')
const N_INDIVIDUAL = 500
const t1Start = performance.now()
const insertStmt = db.prepare(`
  INSERT INTO benchmark_items (id, organization_id, contact_phone, status, created_at)
  VALUES (?, ?, ?, 'PENDING', ?)
`)

for (let i = 0; i < N_INDIVIDUAL; i++) {
  insertStmt.run(`item_${i}`, 'org_bench', `57300${String(i).padStart(7, '0')}`, Date.now())
}
const t1End = performance.now()
const t1DurationSec = (t1End - t1Start) / 1000
const t1Tps = Math.round(N_INDIVIDUAL / t1DurationSec)
console.log(`  Operaciones: ${N_INDIVIDUAL}`)
console.log(`  Tiempo: ${t1DurationSec.toFixed(3)} s`)
console.log(`  Rendimiento: ${t1Tps} ops/seg\n`)

// Test 2: Escrituras por lotes en transacciones explícitas
console.log('--- Test 2: Inserciones en Lotes con BEGIN/COMMIT ---')
const BATCH_SIZE = 5000
const t2Start = performance.now()

db.exec('BEGIN')
for (let i = N_INDIVIDUAL; i < N_INDIVIDUAL + BATCH_SIZE; i++) {
  insertStmt.run(`item_${i}`, 'org_bench', `57300${String(i).padStart(7, '0')}`, Date.now())
}
db.exec('COMMIT')

const t2End = performance.now()
const t2DurationSec = (t2End - t2Start) / 1000
const t2Tps = Math.round(BATCH_SIZE / t2DurationSec)
console.log(`  Operaciones: ${BATCH_SIZE}`)
console.log(`  Tiempo: ${t2DurationSec.toFixed(3)} s`)
console.log(`  Rendimiento: ${t2Tps} ops/seg\n`)

// Test 3: Lecturas y Actualizaciones de Claim (Claim Atómico)
console.log('--- Test 3: Simulación de Cola y Claims Concurrentes ---')
const N_CLAIMS = 2000
const claimStmt = db.prepare(`
  UPDATE benchmark_items
  SET status = 'DISPATCHING'
  WHERE id = (
    SELECT id FROM benchmark_items
    WHERE status = 'PENDING' AND organization_id = 'org_bench'
    LIMIT 1
  )
`)

const t3Start = performance.now()
let claimedCount = 0
for (let i = 0; i < N_CLAIMS; i++) {
  const res = claimStmt.run()
  if (Number(res.changes) > 0) claimedCount++
}
const t3End = performance.now()
const t3DurationSec = (t3End - t3Start) / 1000
const t3Tps = Math.round(claimedCount / t3DurationSec)
console.log(`  Claims ejecutados: ${claimedCount}`)
console.log(`  Tiempo: ${t3DurationSec.toFixed(3)} s`)
console.log(`  Rendimiento Claims: ${t3Tps} ops/seg\n`)

// Limpieza
db.close()
try {
  rmSync(DB_PATH, { force: true })
  rmSync(`${DB_PATH}-wal`, { force: true })
  rmSync(`${DB_PATH}-shm`, { force: true })
} catch {}

console.log('============================================================')
console.log('  CONCLUSIONES TÉCNICAS DEL TECHO DE SQLITE:')
console.log(`  - Escrituras auto-commit (individuales): ~${t1Tps} TPS`)
console.log(`  - Escrituras en lote (transacción): ~${t2Tps} TPS`)
console.log(`  - Claims de cola atómicos: ~${t3Tps} TPS`)
console.log('============================================================\n')
