#!/usr/bin/env node
/**
 * build-site.mjs — arma el sitio estático que sirve el panel y las páginas
 * públicas, sin dependencias externas.
 *
 *   web/site/**  ->  build/**        (sitio público: index.html en la raíz)
 *
 * (panel único, 2026-11-16) El panel NO se copia aquí: lo sirve el servidor en
 * `/` (src/studio/dashboard-html.ts). `web/app/` se queda en el repositorio
 * como referencia, pero ya no se publica ni se sirve: no puede haber dos
 * paneles en la salida.
 *
 * `build/` es la carpeta de salida estándar del proyecto (la que se publica).
 * No toca `dist/` (ahí vive el backend compilado) ni ningún otro directorio.
 * Uso: node scripts/build-site.mjs [--out <dir>]
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const args = process.argv.slice(2)
const outFlag = args.indexOf('--out')
const outName = outFlag !== -1 && args[outFlag + 1] ? args[outFlag + 1] : 'build'
const outDir = resolve(root, outName)

const siteDir = join(root, 'web', 'site')

for (const dir of [siteDir]) {
  if (!existsSync(dir)) {
    console.error(`[build-site] falta el directorio ${dir}`)
    process.exit(1)
  }
}

// Se reconstruye desde cero para no arrastrar ficheros borrados.
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

cpSync(siteDir, outDir, { recursive: true })

/**
 * favicon.ico — un cuadrado verde con un punto blanco, 16x16 y 32 bits.
 * Se escribe en la salida y, si falta, también en web/site (para el servidor
 * en desarrollo, que sirve esa carpeta tal cual).
 */
function faviconIco () {
  const lado = 16
  const pixels = Buffer.alloc(lado * lado * 4)
  for (let y = 0; y < lado; y++) {
    for (let x = 0; x < lado; x++) {
      const dx = x - 7.5
      const dy = y - 7.5
      const dentro = Math.sqrt(dx * dx + dy * dy) <= 5.2
      const i = ((lado - 1 - y) * lado + x) * 4
      // BGRA
      pixels[i] = dentro ? 0xff : 0x30
      pixels[i + 1] = dentro ? 0xff : 0x94
      pixels[i + 2] = dentro ? 0xff : 0x00
      pixels[i + 3] = 0xff
    }
  }
  const mask = Buffer.alloc((lado / 8) * lado, 0)
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(lado, 4)
  header.writeInt32LE(lado * 2, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(pixels.length + mask.length, 20)
  const image = Buffer.concat([header, pixels, mask])
  const dir = Buffer.alloc(6)
  dir.writeUInt16LE(0, 0)
  dir.writeUInt16LE(1, 2)
  dir.writeUInt16LE(1, 4)
  const entry = Buffer.alloc(16)
  entry.writeUInt8(lado, 0)
  entry.writeUInt8(lado, 1)
  entry.writeUInt16LE(1, 4)
  entry.writeUInt16LE(32, 6)
  entry.writeUInt32LE(image.length, 8)
  entry.writeUInt32LE(6 + 16, 12)
  return Buffer.concat([dir, entry, image])
}

const ico = faviconIco()
writeFileSync(join(outDir, 'favicon.ico'), ico)
if (!existsSync(join(siteDir, 'favicon.ico'))) writeFileSync(join(siteDir, 'favicon.ico'), ico)


/** Recuento y tamaño de lo copiado, para que el build diga algo útil. */
function walk (dir, acc = { files: 0, bytes: 0 }) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, acc)
    else { acc.files += 1; acc.bytes += st.size }
  }
  return acc
}

const total = walk(outDir)
const mustHave = ['index.html', 'faq/index.html', 'nuevos-planes/index.html',
  'chatgptwhatson-alianza-perfecta/index.html', 'nueva-demo/index.html',
  'css/site.css', 'js/site.js',
  'favicon.ico', 'img/marca.svg', 'img/hero.svg']

const missing = mustHave.filter((p) => !existsSync(join(outDir, p)))
if (missing.length) {
  console.error('[build-site] faltan ficheros en la salida:\n  ' + missing.join('\n  '))
  process.exit(1)
}

// Marca de versión legible por el servidor y por quien mire la carpeta.
writeFileSync(join(outDir, 'build-info.json'), JSON.stringify({
  builtAt: new Date().toISOString(),
  files: total.files,
  bytes: total.bytes,
  routes: ['/', '/nuevos-planes/', '/faq/', '/chatgptwhatson-alianza-perfecta/', '/nueva-demo/']
}, null, 2) + '\n')

console.log(`[build-site] ${total.files} ficheros, ${(total.bytes / 1024).toFixed(1)} KiB -> ${outDir}`)
console.log('[build-site] rutas: / · /nuevos-planes/ · /faq/ · /chatgptwhatson-alianza-perfecta/ · /nueva-demo/')
console.log('[build-site] el panel no se copia: lo sirve el servidor en /')
