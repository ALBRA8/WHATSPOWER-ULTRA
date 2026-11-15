# Panel y sitio público: cómo se abren

Este documento explica las dos partes nuevas y cómo llegar a ellas. No hace
falta instalar nada más: el servidor del proyecto ya las sirve.

> **Lo que importa es el panel.** `/app/` es la aplicación que se usa a diario
> (crear campañas, contactos, chatbot, bajas, reportes). Las páginas de
> `/sitio/` son solo una referencia visual del sitio original: nada de lo que
> se hace en el panel depende de ellas y no hace falta abrirlas para trabajar.

## Qué hay

| Dirección | Qué es | De dónde sale |
|---|---|---|
| `/app/` | El panel de control (Campañas, Contactos, Plantillas, Chatbot, Bandeja, Reportes, Enlaces, Bajas, Ajustes) | `web/app/` |
| `/sitio/` | El sitio público (inicio, planes, preguntas, alianza con IA, demo) | `web/site/` |
| `/` y `/campaigns` | El *Campaign Studio* que ya existía, sin cambios | `src/studio/campaign-studio-html.ts` |
| `/api/...` | La API de siempre, con su autenticación | `src/server.ts` |

## Cómo se arranca

```bash
npm start                 # servidor en http://127.0.0.1:3004
```

Después, en el navegador:

- Panel: `http://127.0.0.1:3004/app/`
- Sitio: `http://127.0.0.1:3004/sitio/`

El servidor sirve el panel y el sitio **sin autenticación** porque son solo
páginas: no exponen datos. Todo lo que son datos sigue pasando por `/api/*`,
que exige clave administrativa (`ADMIN_API_KEYS`) o la sesión de `/studio/login`.

## Cómo se construye la versión estática

```bash
npm run build             # web/  ->  build/
npm run build:all         # comprueba tipos y luego construye
```

`build/` es lo que se publica en cualquier alojamiento estático o en el
servidor del proyecto. Se genera desde `web/` y está ignorado por git, así que
no se versiona. Si `build/` no existe, el servidor sirve directamente desde
`web/`: nunca se queda sin páginas.

## Conectar el panel con el servidor

En el panel, botón **Conectar servidor** (arriba a la derecha): se escribe el
secreto de administración una vez y el servidor devuelve una cookie de sesión.
El secreto no se guarda en el código ni en el almacenamiento del navegador.

Si el servidor no responde, el panel **no finge que envía**: deja guardar la
campaña como borrador local y lo dice en pantalla.

## Datos de ejemplo

La primera vez, el panel se rellena con contactos, plantillas y campañas de
ejemplo guardados en el navegador (clave `whatspower.ultra.v1`), para poder
tocar todas las pantallas sin servidor. En **Ajustes** hay un botón para
volver a sembrarlos y otro para borrarlo todo.
