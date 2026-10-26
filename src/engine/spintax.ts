import { createHash } from 'node:crypto'

/**
 * Generador pseudoaleatorio simple y determinista (Linear Congruential Generator)
 * a partir de una semilla numérica.
 */
class DeterministicRandom {
  state: number

  constructor(seedString: string) {
    const hash = createHash('sha256').update(seedString).digest('hex')
    this.state = parseInt(hash.slice(0, 8), 16)
  }

  next(): number {
    this.state = (this.state * 1664525 + 1013904223) % 4294967296
    return this.state / 4294967296
  }

  choice<T>(array: T[]): T {
    if (array.length === 0) throw new Error('Array vacío')
    const idx = Math.floor(this.next() * array.length)
    return array[idx]
  }
}

/**
 * Resuelve sintaxis Spintax {A|B|C} de forma anidada y determinística por contacto.
 * 
 * PROPÓSITO: Variación léxica legítima para personalización y evitar monotonía.
 * NO es un mecanismo diseñado para evadir sistemas antispam.
 */
export function renderSpintax(
  template: string,
  options?: {
    seed?: string
    variables?: Record<string, string>
  }
): string {
  const rng = new DeterministicRandom(options?.seed || 'default_seed_albra')

  let result = template

  // 1. Reemplazo de variables {{name}}, {{var}}, etc.
  if (options?.variables) {
    for (const [key, val] of Object.entries(options.variables)) {
      const regex = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'gi')
      result = result.replace(regex, val || '')
    }
  }

  // Limpiar variables no provistas (ej. {{name}} -> '')
  result = result.replace(/\{\{\s*[\w.-]+\s*\}\}/g, '')

  // 2. Resolución iterativa de Spintax {A|B|C} desde los bloques más internos
  const spintaxRegex = /\{([^{}]+)\}/
  let match: RegExpExecArray | null

  while ((match = spintaxRegex.exec(result)) !== null) {
    const optionsList = match[1].split('|')
    const chosen = rng.choice(optionsList)
    result = result.replace(match[0], chosen)
  }

  // Normalizar espacios múltiples
  return result.replace(/[ \t]{2,}/g, ' ').trim()
}
