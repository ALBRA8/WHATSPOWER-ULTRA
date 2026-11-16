#!/usr/bin/env node
/**
 * scripts/build-site.mjs
 * Genera el sitio público estático en build/sitio/ copiando las 5 páginas
 * de web/sitio/ y el CSS compartido, y copia web/site/ a la raíz de build/.
 *
 * Uso: node scripts/build-site.mjs
 * Salida: build/sitio/ con index.html, planes.html, faq.html, alianza-ia.html, demo.html, site.css
 */

import { mkdirSync, copyFileSync, readdirSync, existsSync, rmSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const raiz = join(__dirname, "..");
const origenSitio = join(raiz, "web", "sitio");
const origenSite = join(raiz, "web", "site");
const destinoSitio = join(raiz, "build", "sitio");
const destinoBuild = join(raiz, "build");

const rutasEsperadas = [
  "/",
  "/sitio/",
  "/sitio/planes.html",
  "/sitio/faq.html",
  "/sitio/alianza-ia.html",
  "/sitio/demo.html",
];

function main() {
  if (!existsSync(origenSitio)) {
    console.error(`[build-site] ERROR: no existe ${origenSitio}`);
    process.exit(1);
  }

  // Limpiar destino si existe
  if (existsSync(destinoBuild)) rmSync(destinoBuild, { recursive: true, force: true });
  mkdirSync(destinoSitio, { recursive: true });

  // Copiar web/sitio a build/sitio (6 ficheros)
  const ficheros = readdirSync(origenSitio).filter((f) => !f.startsWith("."));
  let count = 0;
  for (const f of ficheros) {
    copyFileSync(join(origenSitio, f), join(destinoSitio, f));
    count++;
  }

  // También copiar web/site a build/ si existe (para assets y páginas de aterrizaje)
  if (existsSync(origenSite)) {
    cpSync(origenSite, destinoBuild, { recursive: true });
    // Asegurar que build/sitio se mantiene intacto
    if (!existsSync(destinoSitio)) {
      mkdirSync(destinoSitio, { recursive: true });
    }
    for (const f of ficheros) {
      copyFileSync(join(origenSitio, f), join(destinoSitio, f));
    }
  }

  console.log(`[build-site] ${count} ficheros copiados a ${destinoSitio}`);
  console.log("[build-site] Rutas generadas:");
  for (const r of rutasEsperadas) console.log(`  ${r}`);
}

main();
