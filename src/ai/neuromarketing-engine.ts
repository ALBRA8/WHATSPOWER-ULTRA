import {
  CULTURAL_INDICES,
  FIVE_CORE_FEARS,
  ZALTMAN_METAPHORS,
  BRAND_ARCHETYPES,
  type HofstedeIndex,
} from './neuromarketing-catalog.ts'

export interface TargetAnalysisRequest {
  country?: string
  industry?: string
  productDescription: string
  targetAudience?: string
  mainPainPoint?: string
  primaryGoal?: string
}

export interface TargetAnalysisResult {
  country: string
  culturalProfile: HofstedeIndex
  primaryFearTargeted: { key: string; name: string; antidote: string }
  recommendedMetaphor: { name: string; hookPhrase: string; example: string }
  recommendedArchetype: { name: string; tone: string; symbolicCode: string }
  neuromarketingGuidelines: string[]
}

export interface SpintaxGenerationOptions {
  productName: string
  country?: string
  mainBenefit: string
  painPoint?: string
  callToAction?: string
  brandArchetype?: string
  zaltmanMetaphor?: string
}

export class NeuromarketingEngine {
  /**
   * Analiza el mercado objetivo y perfila la psicología subconsciente de la audiencia
   */
  analyzeTargetMarket(request: TargetAnalysisRequest): TargetAnalysisResult {
    const rawCountry = (request.country || 'COLOMBIA').toUpperCase().trim()
    const culturalProfile = CULTURAL_INDICES[rawCountry] || CULTURAL_INDICES['COLOMBIA']
    const country = CULTURAL_INDICES[rawCountry] ? rawCountry : 'COLOMBIA'

    // Selección heurística de Miedo y Metáfora basada en perfil cultural y necesidad
    let fearIndex = 2 // Pérdida de autonomía por defecto
    if (culturalProfile.uai > 80) {
      fearIndex = 1 // Mutilación / Pérdida de dinero y seguridad
    } else if (culturalProfile.mas > 65) {
      fearIndex = 4 // Amenaza al Ego / Estatus
    }
    const primaryFear = FIVE_CORE_FEARS[fearIndex]

    // Metáfora según orientación cultural
    let metaphorIndex = 0 // Transformación
    if (culturalProfile.uai > 80) {
      metaphorIndex = 2 // Contenedor / Blindaje y Seguridad
    } else if (culturalProfile.idv > 40) {
      metaphorIndex = 3 // Control y Autonomía
    }
    const recommendedMetaphor = ZALTMAN_METAPHORS[metaphorIndex]

    // Arquetipo según el tono del negocio
    let archetypeIndex = 0 // Soñador
    if (request.industry?.toLowerCase().includes('segur') || request.industry?.toLowerCase().includes('financ')) {
      archetypeIndex = 2 // Cuidador
    } else if (request.industry?.toLowerCase().includes('soft') || request.industry?.toLowerCase().includes('tech')) {
      archetypeIndex = 4 // Experto Sabio
    }
    const recommendedArchetype = BRAND_ARCHETYPES[archetypeIndex]

    const guidelines = [
      `Adaptación Cultural (${country}): ${culturalProfile.culturalHookAdvice}`,
      `Gatillo de Seguridad Subconsciente: Apagar el miedo a "${primaryFear.name}" mediante: ${primaryFear.antidote}`,
      `Marco Metafórico: Estructurar la comunicación bajo la metáfora de "${recommendedMetaphor.name}" (${recommendedMetaphor.hookPhrase}).`,
      `Voz de Marca: Encarnar el arquetipo "${recommendedArchetype.name}" con código simbólico central: "${recommendedArchetype.symbolicCode}".`,
      'Principio Jobs to be Done: El cliente no compra el software, compra resolver una fricción vital sin perder tiempo.',
    ]

    return {
      country,
      culturalProfile,
      primaryFearTargeted: {
        key: primaryFear.key,
        name: primaryFear.name,
        antidote: primaryFear.antidote,
      },
      recommendedMetaphor,
      recommendedArchetype,
      neuromarketingGuidelines: guidelines,
    }
  }

  /**
   * Genera plantillas Spintax de alta conversión incorporando principios de neuromarketing
   */
  generateNeuromarketingSpintax(options: SpintaxGenerationOptions): {
    spintaxTemplate: string
    neuroAnalysis: {
      symbolicHook: string
      fearAntidoteUsed: string
      callToActionStyle: string
    }
  } {
    const analysis = this.analyzeTargetMarket({
      country: options.country,
      productDescription: options.productName,
      mainPainPoint: options.painPoint,
    })

    const benefit = options.mainBenefit || 'multiplicar tus ventas y ahorrar tiempo cada día'
    const pain = options.painPoint || 'perder clientes valiosos por no responder a tiempo'
    const cta = options.callToAction || '¿Te gustaría ver cómo funciona en 2 minutos?'

    // Generar Spintax determinista multi-capa con 4 etapas psicológicas:
    // 1. Saludo cálido y personalizado
    // 2. Conexión empática con la fricción (dolor/miedo subconsciente)
    // 3. Revelación de la solución (metáfora de transformación)
    // 4. Llamado a la acción de baja fricción (micro-compromiso)
    const spintaxTemplate = `{¡Hola|Buen día|Hola qué tal} {{nombre}}! {Espero que todo vaya de maravilla.|¿Cómo va tu semana?|Un gusto saludarte.}

{Sabemos lo frustrante que es|Muchos emprendedores nos comentan lo difícil que resulta} ${pain}.

{Por eso creamos|Precisamente para solucionar esto diseñamos} *${options.productName}*: {la forma más simple y segura de|la herramienta diseñada para} ${benefit}, {sin complicaciones técnicas|con respaldo garantizado paso a paso}.

${cta} {Escribe SI para enviarte los detalles.|¿Te comparto una breve demo sin compromiso?|Solo respóndeme con un pulgar arriba 👍 y te muestro.}`

    return {
      spintaxTemplate,
      neuroAnalysis: {
        symbolicHook: `Arquetipo ${analysis.recommendedArchetype.name} - Código ${analysis.recommendedArchetype.symbolicCode}`,
        fearAntidoteUsed: analysis.primaryFearTargeted.antidote,
        callToActionStyle: 'Micro-compromiso de baja fricción (Respuesta de una palabra)',
      },
    }
  }

  /**
   * Construye un Master Prompt 360° para LLMs externos basado en el temario del curso
   */
  buildMasterPrompt(options: {
    businessName: string
    country: string
    productCategory: string
    targetAudience: string
    uniqueSellingProposition: string
  }): string {
    const analysis = this.analyzeTargetMarket({
      country: options.country,
      productDescription: options.productCategory,
      targetAudience: options.targetAudience,
    })

    return `Eres Multiverse GPT, el estratega maestro de Neuromarketing, Copywriting Persuasivo y Ventas con Inteligencia Artificial.

OBJETIVO:
Diseñar la estrategia maestra de mensajes y variaciones Spintax para "${options.businessName}", perteneciente a la categoría "${options.productCategory}" dirigida a "${options.targetAudience}" en "${options.country}".

MARCOS CIENTÍFICOS OBLIGATORIOS QUE DEBES APLICAR:
1. Contexto Cultural (Geert Hofstede para ${options.country}):
   - PDI (Distancia al poder): ${analysis.culturalProfile.pdi}/100
   - IDV (Individualismo vs Colectivismo): ${analysis.culturalProfile.idv}/100
   - UAI (Evitación de Incertidumbre): ${analysis.culturalProfile.uai}/100
   - Guía cultural: ${analysis.culturalProfile.culturalHookAdvice}

2. Psicología Subconsciente (Clotaire Rapaille & Gerald Zaltman):
   - Código Simbólico: "${analysis.recommendedArchetype.symbolicCode}"
   - Arquetipo de Marca dominante: "${analysis.recommendedArchetype.name}"
   - Metáfora Profunda: "${analysis.recommendedMetaphor.name}" (${analysis.recommendedMetaphor.hookPhrase})

3. Matriz de Miedos y Deseos:
   - Miedo primario a desactivar: ${analysis.primaryFearTargeted.name} -> Solución: ${analysis.primaryFearTargeted.antidote}
   - Jobs to be Done: El cliente contrata nuestra solución para resolver fricciones vitales con certeza y rapidez.

4. Propuesta de Valor Única (USP):
   "${options.uniqueSellingProposition}"

ENTREGABLE REQUERIDO:
Genera 3 plantillas Spintax anidadas para difusión masiva por WhatsApp que cumplan con la fórmula:
[Gancho de Atención y Empatía] + [Neutralización del Miedo] + [Revelación de la Metáfora] + [Llamado a la Acción de Cero Fricción].`
  }
}
