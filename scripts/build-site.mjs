#!/usr/bin/env node
/**
 * scripts/build-site.mjs
 * Genera el sitio público estático en build/sitio/ copiando las 5 páginas
 * de web/sitio/ y el CSS compartido. Sin minify, solo copia literal.
 *
 * Uso: node scripts/build-site.mjs
 * Salida: build/sitio/ con index.html, planes.html, faq.html, alianza-ia.html, demo.html, site.css
 */

import { mkdirSync, copyFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const raiz = join(__dirname, "..");
const origen = join(raiz, "web", "sitio");
const destino = join(raiz, "build", "sitio");

const rutasEsperadas = [
  "/",
  "/sitio/",
  "/sitio/planes.html",
  "/sitio/faq.html",
  "/sitio/alianza-ia.html",
  "/sitio/demo.html",
];

function main() {
  if (!existsSync(origen)) {
    console.error(`[build-site] ERROR: no existe ${origen}`);
    process.exit(1);
  }

  // Limpiar destino si existe
  if (existsSync(destino)) rmSync(destino, { recursive: true, force: true });
  mkdirSync(destino, { recursive: true });

  const ficheros = readdirSync(origen).filter((f) => !f.startsWith("."));
  let count = 0;
  for (const f of ficheros) {
    copyFileSync(join(origen, f), join(destino, f));
    count++;
  }

  console.log(`[build-site] ${count} ficheros copiados a ${destino}`);
  console.log("[build-site] Rutas generadas:");
  for (const r of rutasEsperadas) console.log(`  ${r}`);
}

main();
