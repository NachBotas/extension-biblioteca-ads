# Biblioteca Ads Pro

Extensión de Chrome para la [Biblioteca de anuncios de Meta](https://www.facebook.com/ads/library/).

## Qué hace

Todo funciona **dentro de la misma página** de la Biblioteca de anuncios: arriba de los resultados aparece la barra de filtros y cada tarjeta de Facebook suma sus días activo, el destino del botón y los botones para guardar y descargar.

- **Filtra por destino del botón**: Visitar perfil, Mensaje (WhatsApp, Messenger, Instagram Direct), Sitio web, Llamada, App, o Sin botón.
- **Filtra por texto exacto del botón** ("Más información", "Enviar mensaje", "Comprar"…), por formato (video, imagen, carrusel), por plataforma, por estado y por cantidad de versiones.
- **Días activo**: cada anuncio muestra cuántos días lleva circulando. Podés filtrar (7+, 30+, 60+, 90+ o un número propio) y ordenar por más o menos días.
- **Descarga** videos (en HD si existe) e imágenes, de a uno, seleccionados o todos los filtrados. Se guardan en `Descargas/Biblioteca Ads Pro/<Anunciante>/`.
- **Guardar para después**: guarda el link permanente del anuncio, sus datos y una miniatura en carpetas. Los guardados se abren en un panel lateral en la misma pestaña (con notas, búsqueda, carpetas y exportación).
- **Transcribir videos** con el botón "Transcribir video" de cada anuncio, o varios a la vez desde la selección. Podés elegir:
  - **Groq** o **OpenAI** (Whisper por API): rápido y sin consumir recursos de tu compu. Necesita una clave, que se pega una sola vez en la configuración (botón "Transcripción" de la barra, o en las opciones de la extensión). El video se envía a ese servicio, con un límite de 25 MB.
  - **En esta compu** (Whisper local): gratis, sin claves y privado. La primera vez baja el modelo (~240 MB el preciso, ~75 MB el liviano) y lo deja guardado. Transcribe de a un video con un solo núcleo para no trabar la compu, y libera la memoria al terminar.
  Las transcripciones quedan guardadas, se ven en Guardados y salen en el Excel.
- **Exportar a Excel (.xlsx) o CSV** con links clickeables, días activo, destino, CTA, URL de destino, texto, etc.
- **Cargar todos**: va pidiendo más resultados a Facebook hasta llegar al final de la búsqueda.

## Instalación (modo desarrollador)

1. Descargá o cloná esta carpeta.
2. En Chrome, abrí `chrome://extensions`.
3. Activá **Modo de desarrollador** (arriba a la derecha).
4. Hacé clic en **Cargar descomprimida** y elegí la carpeta del proyecto (la que tiene `manifest.json`).
5. Abrí la Biblioteca de anuncios y hacé una búsqueda: la barra aparece arriba de los resultados.

Para actualizar a una versión nueva: reemplazá los archivos de la carpeta y tocá el botón de recargar (⟳) de la extensión en `chrome://extensions`. Después recargá la pestaña de la Biblioteca.

## Cómo funciona

`src/inject/hook.js` corre dentro de la página y lee las mismas respuestas que usa Facebook para mostrar los anuncios (GraphQL y los datos del HTML inicial). Por eso los datos son exactos (fechas, CTA, URLs de video) y no dependen del diseño de la página. `src/content/content.js` reconoce cada tarjeta de Facebook por su "Identificador de la biblioteca", le agrega los botones y aplica los filtros ocultando tarjetas. Para ordenar, convierte el contenedor de resultados en una sola grilla y reordena las tarjetas con CSS, sin mover nodos de Facebook, así el scroll infinito sigue funcionando. Si alguna vez no logra reconocer las tarjetas, por ejemplo porque Facebook cambió su diseño, aparece un botón abajo a la derecha que abre una vista en grilla de respaldo.

| Archivo | Para qué sirve |
| --- | --- |
| `src/inject/hook.js` | Intercepta los datos de anuncios |
| `src/shared/core.js` | Normalización, clasificación por destino, filtros, orden, íconos |
| `src/shared/card.js` | Tarjeta de anuncio (panel y guardados) |
| `src/shared/export.js` | Generador de .xlsx y CSV (sin librerías) |
| `src/content/content.js` | Integración en la página: barra, botones en tarjetas, filtros, orden, panel de guardados |
| `src/pages/saved.*` | Página de anuncios guardados |
| `src/background.js` | Descargas, miniaturas y cola de transcripción (Groq/OpenAI o local) |
| `src/offscreen/` | Documento invisible que corre Whisper localmente (solo mientras se usa) |
| `src/shared/settings.js` | Configuración de transcripción (panel en la página y opciones) |
| `vendor/transformers/` | Transformers.js 3.8.1 + ONNX Runtime Web (Apache-2.0 / MIT) |

## Límites a tener en cuenta

- La Biblioteca **no publica el objetivo de la campaña**. El "destino" se deduce del tipo de botón (CTA), su texto y la URL a la que lleva. Es muy confiable para perfil, WhatsApp, Messenger y web, pero no es el objetivo real que se configuró en el Administrador de anuncios.
- Los **links de video e imagen de Facebook vencen** después de unos días. Por eso al guardar se conserva el link permanente del anuncio (`facebook.com/ads/library/?id=…`) y una miniatura propia. Si una descarga desde *Guardados* falla, abrí el anuncio y descargalo de nuevo.
- La **inversión** solo es pública para anuncios políticos o de la UE. Si viene el alcance de la UE, se puede ordenar por eso.
- Si Facebook cambia el formato interno de sus datos, puede hacer falta ajustar `hook.js` o `core.js`.

## Pruebas

```bash
node test/e2e.js test/out
```

`node test/perf.js . 300` mide el rendimiento con 300 anuncios en una página que cambia todo el tiempo (`node test/perf.js none 300` mide la misma página sin la extensión, para comparar). Con `FILLER=150 DIGIT_NOISE=1` se simula un DOM pesado como el de Facebook.

`node test/transcribe.js` prueba la transcripción: Whisper local real (baja el modelo de Hugging Face) y la API estilo OpenAI simulada. Con `MODEL=base` usa el modelo liviano.

`test/e2e.js` carga la extensión en Chromium sobre una Biblioteca simulada (`test/mock.js`) y prueba los filtros, el guardado, la descarga, la exportación y "Cargar todos". Deja capturas en `test/out/`.
