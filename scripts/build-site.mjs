#!/usr/bin/env node
/**
 * scripts/build-site.mjs
 * Genera la carpeta build/ para el despliegue del panel único (sin páginas de venta).
 */

import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const raiz = join(__dirname, "..");
const destino = join(raiz, "build");

function faviconIco() {
  const lado = 16;
  const pixels = Buffer.alloc(lado * lado * 4);
  for (let y = 0; y < lado; y++) {
    for (let x = 0; x < lado; x++) {
      const dx = x - 7.5;
      const dy = y - 7.5;
      const dentro = Math.sqrt(dx * dx + dy * dy) <= 5.2;
      const i = ((lado - 1 - y) * lado + x) * 4;
      pixels[i] = dentro ? 0xff : 0x30;
      pixels[i + 1] = dentro ? 0xff : 0x94;
      pixels[i + 2] = dentro ? 0xff : 0x00;
      pixels[i + 3] = 0xff;
    }
  }
  const mask = Buffer.alloc((lado / 8) * lado, 0);
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(lado, 4);
  header.writeInt32LE(lado * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(pixels.length + mask.length, 20);
  const image = Buffer.concat([header, pixels, mask]);
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry.writeUInt8(lado, 0);
  entry.writeUInt8(lado, 1);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(image.length, 8);
  entry.writeUInt32LE(6 + 16, 12);
  return Buffer.concat([dir, entry, image]);
}

function main() {
  if (existsSync(destino)) rmSync(destino, { recursive: true, force: true });
  mkdirSync(destino, { recursive: true });

  writeFileSync(join(destino, "favicon.ico"), faviconIco());
  writeFileSync(join(destino, "build-info.json"), JSON.stringify({
    dashboardOnly: true,
    builtAt: new Date().toISOString(),
    panel: "/"
  }, null, 2) + "\n");

  console.log("[build-site] build/ generado. Páginas de venta retiradas: el servidor sirve exclusivamente el dashboard en /.");
}

main();
