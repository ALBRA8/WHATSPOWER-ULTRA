# Capturas del panel original: la lista exacta que hace falta

Para cerrar la paridad no basta con leer la web de ventas: **el panel de verdad
está detrás de un login y nunca se ha podido ver**. En `parity/original/` solo
hay dos imágenes (`app-app-root.png` y `login-login.png`) y las dos son la
misma página de error del servidor, así que hoy la paridad del panel se apoya en
la FAQ pública y en suposiciones.

Estas capturas las tiene que hacer el propietario (o alguien con cuenta). Con
ellas se miden colores, tamaños, espacios y estados, y se cierran las filas de
`parity/matriz.md` que siguen en «parcial».

## Cómo hacerlas (reglas para que sirvan)

1. **Ventana completa**, no recortes: que se vea la barra lateral, la cabecera y
   el contenido. Tamaño de ventana **1440 × 900**.
2. **Una imagen por estado**, PNG. Nombre exacto: `NN-nombre.png` (los nombres ya
   están puestos en la tabla de abajo). Se guardan en
   `parity/original/capturas/`.
3. **Cuenta de prueba, datos inventados**. Nada de teléfonos, nombres ni
   conversaciones reales de clientes: si aparecen, se tapan antes de guardar.
4. Sin menus abiertos «de más»: si un estado necesita un menú o un modal, ese es
   otro número de la lista.
5. Si una pantalla no existe en el original, **guardar igualmente la captura de
   dónde debería estar** y decirlo; así se sabe que el hueco es del original.

## Prioridad 1 — con estas doce se puede empezar a medir

| # | Fichero | Pantalla | Qué debe verse |
|---|---|---|---|
| 01 | `01-login.png` | Entrada | Formulario completo, con logo, título, campos y botón. Sin escribir nada |
| 02 | `02-login-error.png` | Entrada, error | El mismo formulario con la credencial rechazada (mensaje rojo visible) |
| 03 | `03-onboarding-1.png` | Onboarding, paso 1 | El primer paso tal cual aparece tras entrar por primera vez |
| 04 | `04-resumen.png` | Resumen | La pantalla de inicio con sus tarjetas de números y su menú lateral |
| 05 | `05-conversaciones-lista.png` | Conversaciones | Lista de conversaciones a la izquierda, sin ninguna abierta |
| 06 | `06-conversaciones-chat.png` | Conversaciones | Un chat abierto: cabecera, mensajes, caja de escritura y botón de enviar |
| 07 | `07-campanas-lista.png` | Campañas | Tabla/lista de campañas con sus estados y el botón de crear |
| 08 | `08-campanas-asistente.png` | Campañas, asistente | Primer paso de creación (nombre, público o plantilla) |
| 09 | `09-contactos-lista.png` | Contactos | Tabla de contactos con sus columnas, filtros y botón de importar |
| 10 | `10-embudo.png` | Embudo / Kanban | El tablero con sus columnas y al menos una tarjeta en cada una |
| 11 | `11-ajustes.png` | Ajustes | La pantalla de ajustes con su menú interno |
| 12 | `12-menu-abierto.png` | Navegación | La barra lateral con el menú desplegado y el ítem activo marcado |

## Prioridad 2 — completan las trece secciones del inventario

| # | Fichero | Pantalla | Qué debe verse |
|---|---|---|---|
| 13 | `13-onboarding-2.png` … | Onboarding | Cada paso siguiente, numerado (`13`, `14`, …) hasta el último |
| 14 | `15-contactos-ficha.png` | Contactos | Un contacto abierto: datos, etiquetas, historial |
| 15 | `16-contactos-importar.png` | Contactos | La ventana de importar CSV (columnas, aviso de duplicados) |
| 16 | `17-embudo-tarjeta.png` | Embudo | Una tarjeta abierta con su detalle y su botón de mover |
| 17 | `18-campanas-monitor.png` | Campañas, envío | El monitor de una campaña en curso: progreso, enviados, fallos |
| 18 | `19-campanas-detalle.png` | Campañas | Una campaña terminada con su resumen de resultados |
| 19 | `20-rapidas.png` | Respuestas rápidas | Lista de respuestas guardadas |
| 20 | `21-rapidas-editar.png` | Respuestas rápidas | El formulario de alta/edición, con el atajo o el botón de insertar |
| 21 | `22-etiquetas.png` | Etiquetas | Lista de etiquetas con su color |
| 22 | `23-agentes.png` | Agentes / Equipo | Lista de agentes con rol y estado |
| 23 | `24-agentes-permisos.png` | Agentes | La pantalla de invitar o de permisos de un agente |
| 24 | `25-integraciones.png` | Integraciones | Estado de la conexión de WhatsApp y de la API |
| 25 | `26-integraciones-qr.png` | Integraciones | El paso de vincular el número (QR o formulario de credenciales) |
| 26 | `27-ajustes-notificaciones.png` | Ajustes | La pestaña de notificaciones/seguridad |
| 27 | `28-estado-vacio.png` | Cualquiera vacía | Una pantalla sin datos, para copiar el texto y el dibujo del estado vacío |
| 28 | `29-aviso.png` | Transversal | Un aviso flotante (mensaje de éxito o de error) recién mostrado |

## Prioridad 3 — móvil y movimiento

| # | Fichero | Qué debe verse |
|---|---|---|
| 29 | `30-movil-menu.png` | Ventana de **390 × 844**: el menú en móvil |
| 30 | `31-movil-conversaciones.png` | Móvil: lista de conversaciones |
| 31 | `32-movil-chat.png` | Móvil: un chat abierto |
| 32 | `33-movil-campanas.png` | Móvil: la lista de campañas |
| 33 | `34-envio.mp4` | **Vídeo de 15–30 s** creando y lanzando una campaña: enseña los pasos, los avisos y cuánto tarda |

## Qué se hace con cada captura

1. Se mide (colores, tamaños de letra, espacios, anchos de columna) y se apunta
   en `parity/matriz.md` la fila que cierra.
2. Lo que no se pueda medir de una imagen (comportamiento, tiempos) se marca
   como pendiente, no se supone.
3. Las que falten se quedan como hueco declarado: **una captura que no existe no
   se sustituye por una suposición**.

## Qué NO hace falta capturar

- La web de ventas (`whatson.mybusiness-up.es`): ya está capturada entera en
  `capture/` y en `web/site/` es solo referencia visual.
- La pantalla de pago ni ninguna con datos de tarjeta.
- Conversaciones con clientes reales.
