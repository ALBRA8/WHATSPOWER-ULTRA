import { Http2ALockChecker } from './safety/lock-checker.ts'
import { Http2ASuppressionChecker } from './safety/suppression.ts'
import { HttpCrmDaemonDispatcher } from './adapters/dispatcher.ts'

async function executeSingleSupervisedPilot() {
  console.log('============================================================')
  console.log('  ALBRA: EJECUCIÓN DEL PRIMER ENVÍO REAL SUPERVISADO CAPA 2B')
  console.log('============================================================')

  const TARGET_PHONE = '573017543786'
  const EXACT_TEXT = 'Tengo estos zapatos para la venta.'
  const DAEMON_SECRET = process.env.INTERNAL_API_SECRET || 'crm_albra_internal_secret_key_fixed_length_for_daemon_2026'

  console.log(`[Paso 1] Destinatario validado: ${TARGET_PHONE}`)
  console.log(`[Paso 1] Mensaje exacto: "${EXACT_TEXT}"`)

  // 1. Verificación obligatoria de destinatario
  if (TARGET_PHONE !== '573017543786') {
    console.error('ERROR CRÍTICO: Destinatario no coincide con la autorización. Abortando.')
    process.exit(1)
  }

  // 2. JIT Lock Check en Capa 2A
  console.log('[Paso 2] Ejecutando JIT Lock Check en Capa 2A...')
  const lockChecker = new Http2ALockChecker({ baseUrl: 'http://localhost:3003', timeoutMs: 1500 })
  let lockResult
  try {
    lockResult = await lockChecker.checkLock(TARGET_PHONE)
    console.log('Resultado Lock Check:', lockResult)
    if (!lockResult.available) {
      console.error(`ABORTANDO: Contacto no disponible por lock en 2A (${lockResult.state || lockResult.error})`)
      process.exit(1)
    }
  } catch (err: any) {
    console.error('ABORTANDO (Fail-Closed): Error consultando locks en 2A:', err.message)
    process.exit(1)
  }

  // 3. JIT Suppression Check en Capa 2A
  console.log('[Paso 3] Ejecutando JIT Suppression Check en Capa 2A...')
  const suppressionChecker = new Http2ASuppressionChecker({ baseUrl: 'http://localhost:3003', timeoutMs: 1500 })
  let isSuppressed = false
  try {
    isSuppressed = await suppressionChecker.isSuppressed(TARGET_PHONE)
    console.log(`Resultado Suppression Check: suppressed = ${isSuppressed}`)
    if (isSuppressed) {
      console.error('ABORTANDO: Contacto figura en lista de supresión / opt-out activo.')
      process.exit(1)
    }
  } catch (err: any) {
    console.error('ABORTANDO (Fail-Closed): Error consultando supresiones en 2A:', err.message)
    process.exit(1)
  }

  // 4. Preparación del Dispatcher con salvaguarda por defecto
  const isAuthorized = process.env.CONFIRMED_PILOT_EXECUTION === 'true'
  console.log(`[Paso 4] Estado de autorización de despacho real: ${isAuthorized ? 'HABILITADO' : 'BLOQUEADO (allowRealDispatch=false)'}`)
  const dispatcher = new HttpCrmDaemonDispatcher({
    endpointUrl: 'http://localhost:3002/send',
    secret: DAEMON_SECRET,
    allowRealDispatch: isAuthorized,
  })

  let finalStatus = 'UNKNOWN'
  let messageId: string | undefined
  let errorDetail: string | undefined

  try {
    console.log('[Paso 5] Emitiendo POST /send al daemon WhatsApp Baileys...')
    const dispatchRes = await dispatcher.dispatch(TARGET_PHONE, EXACT_TEXT)
    console.log('Respuesta cruda del Dispatcher:', dispatchRes)

    if (dispatchRes.success) {
      finalStatus = 'SENT'
      messageId = dispatchRes.messageId
    } else if (dispatchRes.uncertain) {
      finalStatus = 'UNCERTAIN_DISPATCH'
      errorDetail = dispatchRes.error
    } else {
      finalStatus = 'FAILED'
      errorDetail = dispatchRes.error
    }
  } catch (err: any) {
    console.error('Excepción durante dispatch:', err.message)
    finalStatus = 'UNCERTAIN_DISPATCH'
    errorDetail = err.message
  } finally {
    // 5. Restauración INMEDIATA de la salvaguarda de seguridad
    dispatcher.allowRealDispatch = false
    console.log(`[Paso 6] Salvaguarda restaurada inmediatamente: allowRealDispatch = ${dispatcher.allowRealDispatch}`)
  }

  console.log('============================================================')
  console.log('  REPORTE FINAL DE EJECUCIÓN PILOTO C2B')
  console.log('============================================================')
  console.log(`Destinatario: ${TARGET_PHONE}`)
  console.log(`JIT Lock Check: ${lockResult.available ? 'LIBRE (OK)' : 'BLOQUEADO'}`)
  console.log(`JIT Suppression Check: ${!isSuppressed ? 'NO SUPRIMIDO (OK)' : 'SUPRIMIDO'}`)
  console.log(`Estado Final: ${finalStatus}`)
  console.log(`MessageId: ${messageId || 'N/A'}`)
  if (errorDetail) console.log(`Detalle Error: ${errorDetail}`)
  console.log(`allowRealDispatch restaurado: ${dispatcher.allowRealDispatch === false ? 'CONFIRMADO (false)' : 'ERROR'}`)
  console.log('============================================================')
}

executeSingleSupervisedPilot().catch((err) => {
  console.error('Error fatal en ejecución piloto:', err)
  process.exit(1)
})
