/**
 * Catálogo de Conocimiento y Bases Científicas de Neuromarketing
 * Basado en:
 * - Geert Hofstede (Dimensiones Culturales PDI, IDV, MAS, UAI, LTO)
 * - Clotaire Rapaille (The Culture Code, Códigos Simbólicos e Improntas)
 * - Gerald Zaltman (7 Metáforas Profundas de la Mente Subconsciente)
 * - Clayton Christensen (Jobs to be Done)
 * - Carl Jung / Margaret Mark (Arquetipos de Marca)
 * - Psicología Evolutiva (Los 5 Miedos Universales y Deseos Biológicos)
 */

export interface HofstedeIndex {
  pdi: number // Distancia al Poder (0-100)
  idv: number // Individualismo vs Colectivismo (0-100)
  mas: number // Masculinidad vs Feminidad (0-100)
  uai: number // Evitación de la Incertidumbre (0-100)
  lto: number // Orientación a Largo Plazo (0-100)
  culturalHookAdvice: string
}

export const CULTURAL_INDICES: Record<string, HofstedeIndex> = {
  COLOMBIA: {
    pdi: 67,
    idv: 13, // Altamente colectivista (familia, grupo, recomendaciones de amigos)
    mas: 64, // Orientado al logro y estatus social
    uai: 80, // Alta aversión a la incertidumbre (necesita garantías, pruebas, testimonios)
    lto: 13, // Corto plazo (recompensas inmediatas, facilidad aquí y ahora)
    culturalHookAdvice: 'Usar lenguaje cálido y cercano ("te ayudamos juntos"), testimonios de confianza y garantías explícitas para eliminar el miedo a ser estafado.',
  },
  MEXICO: {
    pdi: 81, // Alta jerarquía (respeto por la autoridad y el reconocimiento)
    idv: 30, // Colectivista (familia, orgullo de pertenencia)
    mas: 69, // Muy competitivo y enfocado en éxito material
    uai: 82, // Alta aversión a la incertidumbre (reglas claras, soporte humano garantizado)
    lto: 24, // Corto plazo (disfrute en el presente)
    culturalHookAdvice: 'Apelar al estatus personal, el orgullo del éxito, el respaldo de marcas sólidas y trato respetuoso pero empático.',
  },
  ARGENTINA: {
    pdi: 49,
    idv: 46, // Mayor individualismo en LATAM (pensamiento crítico y debate)
    mas: 56,
    uai: 86, // Máxima aversión a la incertidumbre económica (busca certezas y ROI tangible)
    lto: 20,
    culturalHookAdvice: 'Comunicación directa, inteligente, sin rodeos artificiales; destacar valor concreto y retorno de inversión real.',
  },
  CHILE: {
    pdi: 63,
    idv: 23,
    mas: 28, // Altamente femenino (valora calidad de vida, armonía, bienestar sobre agresión)
    uai: 86, // Aversión alta a la incertidumbre
    lto: 31,
    culturalHookAdvice: 'Tono mesurado, sin exageraciones ni promesas mágicas; destacar estabilidad, calidad certificada y tranquilidad.',
  },
  ESPANA: {
    pdi: 57,
    idv: 51,
    mas: 42,
    uai: 86,
    lto: 48,
    culturalHookAdvice: 'Claridad formal, honestidad transparente, evitar frases de venta vacías y enfatizar profesionalismo directo.',
  },
}

export const FIVE_CORE_FEARS = [
  {
    key: 'EXTINCTION',
    name: 'Extinción o Muerte',
    description: 'Miedo al colapso del negocio, ruina financiera o peligro de supervivencia.',
    antidote: 'Garantizar salvaguarda económica, estabilidad y continuidad asegurada.',
  },
  {
    key: 'MUTILATION',
    name: 'Mutilación o Daño',
    description: 'Miedo a perder partes del negocio, perder clientes clave o sufrir pérdidas de capital.',
    antidote: 'Protección integral, escudos contra pérdidas y seguridad de activos.',
  },
  {
    key: 'LOSS_OF_AUTONOMY',
    name: 'Pérdida de Autonomía o Control',
    description: 'Miedo a quedar atrapado en sistemas complejos o depender ciegamente de terceros.',
    antidote: 'Herramientas no-code, libertad de gestión, soberanía de datos y facilidad absoluta.',
  },
  {
    key: 'SEPARATION',
    name: 'Separación o Aislamiento',
    description: 'Miedo a quedarse fuera de las tendencias, desconectado del mercado o abandonado por clientes.',
    antidote: 'Comunidad exclusiva, soporte 24/7 y conexión multicanal constante.',
  },
  {
    key: 'EGO_THREAT',
    name: 'Amenaza al Ego o Vergüenza',
    description: 'Miedo a parecer anticuado, cometer errores públicos o no alcanzar el estatus deseado.',
    antidote: 'Reconocimiento, liderazgo de vanguardia y posicionamiento como referente exitoso.',
  },
]

export const ZALTMAN_METAPHORS = [
  {
    name: 'TRANSFORMACION',
    hookPhrase: 'El paso de la fricción al éxito total',
    example: 'Pasa de sufrir por ventas a tener un flujo automático de clientes calificados.',
  },
  {
    name: 'VIAJE',
    hookPhrase: 'La aventura guiada hacia tu objetivo',
    example: 'Acompañamos tu negocio en cada milla del camino hasta la meta de facturación.',
  },
  {
    name: 'CONTENEDOR',
    hookPhrase: 'Seguridad, protección y blindaje',
    example: 'Un entorno blindado contra bloqueos de WhatsApp y pérdida de prospectos.',
  },
  {
    name: 'CONTROL',
    hookPhrase: 'Poder y dominio de tu propio tiempo',
    example: 'Toma el timón de tus ventas sin depender de empleados o agencias externas.',
  },
  {
    name: 'EQUILIBRIO',
    hookPhrase: 'Paz mental, orden y balance de vida',
    example: 'Ventas constantes y automáticas mientras recuperas tus fines de semana.',
  },
  {
    name: 'CONEXION',
    hookPhrase: 'Vínculo humano y cercanía real',
    example: 'Conecta con tus clientes en el canal más íntimo del mundo: su WhatsApp.',
  },
  {
    name: 'RECURSO',
    hookPhrase: 'La herramienta definitiva de multiplicación',
    example: 'El activo digital que trabaja 24 horas al día multiplicando tus ingresos.',
  },
]

export const BRAND_ARCHETYPES = [
  {
    name: 'SOÑADOR',
    tone: 'Inspirador, visionario, poético y enfocado en cumplir anhelos profundos.',
    symbolicCode: 'SINFONIA',
  },
  {
    name: 'EXPLORADOR',
    tone: 'Audaz, aventurero, libre e innovador.',
    symbolicCode: 'LIBERTAD',
  },
  {
    name: 'CUIDADOR',
    tone: 'Empático, protector, seguro y dedicado al bienestar del cliente.',
    symbolicCode: 'REFUGIO',
  },
  {
    name: 'LIBERTADOR',
    tone: 'Rebelde, democratizador, rompe barreras tradicionales.',
    symbolicCode: 'EMPODERAMIENTO',
  },
  {
    name: 'EXPERTO_SABIO',
    tone: 'Analítico, riguroso, basado en datos comprobables y precisión.',
    symbolicCode: 'MAESTRIA',
  },
]
