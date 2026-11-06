export interface ThrottlerOptions {
  minIntervalMs: number
  maxIntervalMs: number
  batchSize: number
  cooldownMs: number
  businessHoursStart: number // 8
  businessHoursEnd: number // 18
  timezone: string // 'America/Bogota'
}

export const DEFAULT_THROTTLER_OPTIONS: ThrottlerOptions = {
  minIntervalMs: 15_000,
  maxIntervalMs: 35_000,
  batchSize: 25,
  cooldownMs: 300_000, // 5 min
  businessHoursStart: 8,
  businessHoursEnd: 18,
  timezone: 'America/Bogota',
}

export class Throttler {
  options: ThrottlerOptions
  sentInCurrentBatch: number = 0
  lastDispatchTime: number = 0
  /** Momento en que empezó la pausa de enfriamiento (para el vencimiento temporal). */
  cooldownStartedAt: number = 0

  constructor(options?: Partial<ThrottlerOptions>) {
    this.options = { ...DEFAULT_THROTTLER_OPTIONS, ...options }
  }

  calculateNextInterval(): number {
    const min = this.options.minIntervalMs
    const max = this.options.maxIntervalMs
    return Math.floor(Math.random() * (max - min + 1)) + min
  }

  isCooldownNeeded(): boolean {
    return this.sentInCurrentBatch >= this.options.batchSize
  }

  /** ¿Venció ya la pausa de enfriamiento? (contrato §5: cooldown con vencimiento temporal) */
  isCooldownExpired(): boolean {
    if (!this.isCooldownNeeded()) return true
    return Date.now() - this.cooldownStartedAt >= this.options.cooldownMs
  }

  registerDispatch() {
    this.sentInCurrentBatch++
    this.lastDispatchTime = Date.now()
    if (this.isCooldownNeeded() && !this.cooldownStartedAt) {
      this.cooldownStartedAt = Date.now()
    }
  }

  resetCooldown() {
    this.sentInCurrentBatch = 0
    this.cooldownStartedAt = 0
  }

  /** Intervalo de pacing que el llamador debe respetar antes del siguiente despacho. */
  nextPacingDelayMs(): number {
    return this.calculateNextInterval()
  }

  isWithinBusinessHours(customDate?: Date): boolean {
    const now = customDate || new Date()
    // Obtener hora local de la zona configurada
    const timeString = now.toLocaleTimeString('en-US', {
      timeZone: this.options.timezone,
      hour12: false,
      hour: 'numeric',
    })
    const hour = parseInt(timeString, 10)
    return hour >= this.options.businessHoursStart && hour < this.options.businessHoursEnd
  }
}
