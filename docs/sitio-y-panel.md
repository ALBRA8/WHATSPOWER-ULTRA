# Panel y sitio público: qué hay y cómo se llega

> **Reescrito el 2026-11-16.** La versión anterior daba por hecho que el
> programa (`/`) era el estudio antiguo y que el panel vivía en `/app/`. Ya no
> es así: **hay un solo panel** y es la portada del servidor.

## Las tres cosas que sirve el servidor

| Dirección | Qué es | Dónde está el código |
|---|---|---|
| `/` y `/campaigns` | **El panel** (lo único que se usa a diario) | `src/studio/dashboard-html.ts` |
| `/login` | Pantalla de entrada del panel | `src/studio/dashboard-html.ts` |
| `/app`, `/app/`, `/app/…`, `/panel` | Enlaces antiguos: redirigen a `/` | `STATIC_REDIRECTS` en `src/server.ts` |
| `/studio` | Estudio antiguo de campañas, intacto | `src/studio/campaign-studio-html.ts` |
| `/sitio/` (y `/sitio`, `/inicio`) | Páginas públicas de referencia visual | `web/site/` → `build/` |
| `/api/*` | API real del panel (401 sin sesión) | `src/dashboard/api.ts` |

El panel no es una maqueta: entra por `/login`, guarda en la misma base de
datos que el motor de envío y llama a los endpoints reales. Se sirve como HTML
desde TypeScript, no como ficheros estáticos.

## Qué pasó con el segundo panel (`web/app/`)

Había una segunda aplicación en `web/app/` (8 ficheros: `index.html`, `app.js`,
`api.js`, `store.js`, `ui.js`, `views-core.js`, `views-more.js`, `app.css`) que
se abría en `/app/` y se copiaba a `build/app/`. Se ha retirado para que no
existan dos paneles:

- `/app/…` ya no la sirve: redirige a `/` (código 302).
- `scripts/build-site.mjs` ya no la copia a `build/`.
- Los ficheros siguen en `web/app/` como referencia, **no se han borrado**.

**Pendiente (esto sí es trabajo, no está hecho):** esa segunda aplicación tenía
pantallas que el panel único todavía no tiene — *Plantillas*, *Chatbot*,
*Bandeja de conversaciones*, *Reportes*, *Enlaces* y *Bajas/Consentimiento*.
Hasta que se porten al panel, esas funciones no se pueden usar desde la
interfaz. La lista de trabajo está en `PROMPT FINALIZAR.txt` (Bloque A).

## Qué NO hay que romper

- `/` y `/campaigns` deben seguir devolviendo el panel (`navRoot` en el HTML).
- `/studio` debe seguir respondiendo 200: tiene sus propias pruebas.
- `/sitio/` es **solo referencia visual**, no el producto.
- `dist/` no se toca (ahí vive el backend compilado); `build/` es la salida.

## Cómo comprobarlo sin arrancar nada

```bash
npm run build                              # escribe build/ (sitio público)
npm run tsc                                # tipos
node --test tests/static-web-routes.test.ts # rutas: /app/→/, /, /sitio/, /studio
node scripts/run-tests.mjs                 # la suite completa
```

Las pruebas de rutas (`tests/static-web-routes.test.ts`) comprueban justo esto:
que `/app/…` redirige al panel, que el panel responde en `/` y `/campaigns`,
que el sitio público vive en `/sitio/` y que ninguna ruta deja leer ficheros de
fuera de su carpeta.
