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

  registerDispatch() {
    this.sentInCurrentBatch++
    this.lastDispatchTime = Date.now()
  }

  resetCooldown() {
    this.sentInCurrentBatch = 0
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
