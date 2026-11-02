# StreamChat Hub

**Aplicación de escritorio para Windows** con chat unificado de **Twitch, Kick, YouTube y TikTok**, overlay transparente encima de otros programas y enlaces para compartir con amigos.

[**Descargar la última versión**](https://github.com/joseestebanmarinrincones-dot/StreamChatHub/releases/latest) · [Código fuente](https://github.com/joseestebanmarinrincones-dot/StreamChatHub)

Está inspirada en [Transparent Twitch Chat Overlay](https://github.com/baffler/Transparent-Twitch-Chat-Overlay) de baffler, pero reúne las cuatro plataformas en una sola ventana y añade overlay nativo, enlace público y QR.

> **Lectura para las plataformas, chat local para ti.** No envía mensajes a Twitch/Kick/YouTube/TikTok, no pide contraseñas y no inicia sesión. El compositor del overlay crea mensajes locales que se ven en la app, en el overlay y en el enlace que compartes.

> **Versión con TikFinity:** si ya tienes una instancia anterior abierta, ciérrala y abre `StreamChat Hub (TikFinity).exe` (o el acceso directo del escritorio). La nueva instancia usa el mismo `%APPDATA%\StreamChatHub` y conserva tu configuración.

---

## Abrir la aplicación

Tienes varias formas:

- **`StreamChat Hub.exe`** en el escritorio.
- `release\StreamChatHub-1.1.1-portable.exe` dentro del proyecto. Es portátil: no necesita instalación.
- `release\StreamChatHub-1.1.1-setup.exe` si prefieres instalarla como programa normal.

La primera vez Windows puede mostrar “Windows protegió tu PC” porque el ejecutable no tiene firma digital. Pulsa **Más información → Ejecutar de todas formas**.

Si ya tienes una versión anterior de StreamChat Hub abierta, ciérrala antes de abrir esta; solo puede haber una instancia a la vez.

También puede aparecer un aviso del **firewall de Windows**. Pulsa **Permitir** si quieres que tus amigos entren por Wi-Fi; si solo vas a usar el chat en tu PC, puedes cancelarlo.

No tienes que abrir el navegador ni escribir `localhost`. La app arranca su servidor interno sola y abre su propia ventana.

### Avisos de actualización

La app consulta GitHub al abrirse y cada 6 horas. Si hay una versión nueva, muestra una **notificación de Windows** y un aviso dentro de la app con el botón **Descargar**; nunca se actualiza sola ni interrumpe el directo. El aviso se puede cerrar con **Ahora no** y no vuelve a aparecer para esa versión.

También puedes comprobarlo a mano desde el menú de la bandeja del sistema → **Buscar actualizaciones**.

Los usuarios de la **1.0.0** no tienen este comprobador: deben instalar la **1.1.0** una vez manualmente. A partir de esa versión recibirán los avisos de las siguientes.

### Primeros pasos

1. Abre `StreamChat Hub.exe`.
2. Pulsa **Ajustes**.
3. Escribe tus canales.
4. Pulsa **Guardar y reconectar**.
5. Deja la app abierta mientras estás en directo.

### Canales

| Plataforma | Qué escribir | Notas |
|---|---|---|
| Twitch | `tu_canal` o `twitch.tv/tu_canal` | Lectura anónima, sin login. |
| Kick | `tu_canal` o `kick.com/tu_canal` | Detecta los IDs sola. |
| YouTube | `@tuCanal`, URL del directo o ID del vídeo | Con `@canal` busca el directo actual y se actualiza. |
| TikTok | `tuusuario` sin `@` o la fuente **TikFinity** | Directa: debe estar en directo. También puedes usar TikFinity (abajo). |

Puedes dejar canales vacíos: esas plataformas quedan desactivadas.

### TikTok con TikFinity

Si ya usas **TikFinity Desktop**, puedes dejar que TikFinity haga la conexión con TikTok y que StreamChat Hub reciba sus eventos por la API local. Es la opción recomendada si la conexión directa falla por firma, región o límites.

1. Abre **TikFinity Desktop** en este mismo PC y conecta tu directo de TikTok. Comprueba que su **Event API / API local** está activa (TikFinity muestra el endpoint local).
2. Deja TikFinity abierto durante el directo.
3. En StreamChat Hub: **Ajustes → TikTok → Fuente de TikTok → TikFinity (API local)**.
4. Comprueba la URL. Por defecto es `ws://localhost:21213/`.
5. Guarda. La tarjeta de TikTok debería decir **TikFinity conectado**.

No hace falta escribir el canal de TikTok en StreamChat Hub cuando usas TikFinity; el usuario lo elige TikFinity. Si cambiaste el puerto de la API local de TikFinity, actualiza la URL en Ajustes. No uses la conexión directa y TikFinity a la vez para el mismo directo: verías los eventos duplicados.

TikFinity entrega chat, regalos, entradas, compartidos, seguidores, suscripciones, likes y número de espectadores. Los avisos se controlan en **Avisos de TikTok**.

---

## Overlay encima de otras aplicaciones

La app puede mostrarse por encima de juegos, navegadores y cualquier otra ventana de tres formas:

### 1. Overlay flotante transparente

Pulsa **Overlay flotante** en el menú lateral o en **Compartir**.

- Se abre una capa transparente en la esquina inferior izquierda.
- Queda **siempre encima** de las demás aplicaciones.
- Es *click-through*: no bloquea clics ni el ratón del juego.
- Para mostrarla u ocultarla: **Ctrl + Alt + O**.
- Para moverla o cambiar su tamaño: **Ctrl + Alt + E**. Arrastra la barra superior y usa **Pequeño / Mediano / Grande**; pulsa **Listo** para guardar. La posición se recuerda.
- Para escribir un mensaje desde el overlay: **F8** o **Ctrl + Alt + M**. Escribe y pulsa **Enter**. Los mensajes son locales: se ven en esta app y en el overlay, y los amigos conectados también los reciben. No se envían a Twitch/Kick/YouTube/TikTok.
- También puedes controlarla desde el icono de la bandeja del sistema.
- Para cerrarla: vuelve a pulsar **Ctrl + Alt + O** o usa **Salir** en la bandeja.

Está pensada para leer el chat mientras juegas. El tamaño y estilo se ajustan en **Ajustes → Overlay y OBS**. En juegos, usa **ventana** o **pantalla completa sin bordes**; el modo exclusivo a pantalla completa puede tapar cualquier overlay de Windows.

### 2. Fijar la ventana principal

El botón de **chincheta** en la barra superior mantiene toda la app encima de otras ventanas. Vuelve a pulsarlo para desactivarlo.

### 3. OBS / Transparent Twitch Chat Overlay

Para OBS, añade una fuente **Navegador** con la URL que aparece en **Compartir → Overlay para OBS** (normalmente `http://localhost:3000/overlay?obs=1`, aunque el puerto puede variar). Copia siempre la URL desde la app.

El overlay de OBS **no se desvanece**: los mensajes se mantienen. La duración de **Ajustes → Overlay** solo afecta a la ventana flotante. El overlay de OBS guarda hasta 50 mensajes; los más antiguos se retiran cuando se supera ese límite para no salirse de la pantalla.

El overlay muestra un contador con el **total de espectadores de todas las plataformas conectadas**. Suma Twitch, Kick, YouTube y TikTok/TikFinity, y se actualiza solo cuando cambian los datos. El número se abrevia: `999`, `1k`, `2k`… `999k`, `1m`, `2m`. Puedes ocultarlo en **Ajustes → Overlay → Espectadores totales** o con `?viewers=0` en la URL.

Si usas **Transparent Twitch Chat Overlay**, añade una `Custom URL` con esa misma dirección. Así tienes el overlay también fuera de OBS.

El overlay tiene fondo transparente y acepta parámetros:

```text
/overlay?obs=1&max=50&font=18&bg=0.28&width=420&anchor=bottom-left
```

### Atajos de la app

| Atajo | Acción |
|---|---|
| `Ctrl + Alt + O` | Mostrar u ocultar el overlay flotante. |
| `Ctrl + Alt + E` | Mover y cambiar el tamaño del overlay. |
| `F8` o `Ctrl + Alt + M` | Abrir el compositor de mensajes. |
| `Enter` | Enviar el mensaje local. |
| `Esc` | Cerrar el compositor. |

Los atajos también están en el menú de la bandeja del sistema. `Ctrl + Alt + O` y `Ctrl + Alt + E` funcionan aunque la app no tenga el foco.

| Parámetro | Ejemplo | Qué hace |
|---|---|---|
| `max` | `8` | Máximo de mensajes en pantalla. |
| `font` | `18` | Tamaño de letra en píxeles. |
| `bg` | `0.28` | Opacidad del fondo de cada mensaje (0 a 1). |
| `width` | `420` | Ancho máximo de la lista. |
| `lifetime` | `30` | Segundos de la ventana flotante. En OBS se fuerza `0` (permanente). |
| `obs` | `1` | Fuerza el modo OBS: sin desvanecimiento y 50 mensajes por defecto. |
| `anchor` | `bottom-left` | `bottom-left`, `bottom-right`, `top-left`, `top-right`. |
| `platform` | `0` | Oculta el icono de plataforma. |
| `badges` | `0` | Oculta las insignias. |
| `viewers` | `0` | Oculta el total de espectadores. |
| `status` | `1` | Muestra el estado de las plataformas. |
| `demo` | `1` | Mensajes de ejemplo si el chat está vacío. |

---

## Compartir con amigos

Abre **Compartir** dentro de la app.

### Misma Wi-Fi

La app muestra un enlace `192.168.x.x:puerto` y un **código QR**. Tus amigos pueden abrirlo desde el móvil o el PC.

- Tu PC debe seguir encendido y con StreamChat Hub abierto.
- La primera vez Windows puede pedir permiso de firewall para la app. Acepta en redes privadas.
- Si el router tiene aislamiento de clientes, usa el enlace público.

### Cualquier lugar de internet

Pulsa **Crear enlace público**.

- Usa Cloudflare Tunnel y no hay que abrir puertos ni tocar el router.
- La primera vez descarga `cloudflared.exe` en la carpeta de datos de la app. En este PC ya está descargado.
- El enlace es temporal: si cierras el túnel o la app, deja de funcionar.
- Los invitados entran en **modo lectura**: no pueden abrir Ajustes ni cambiar canales.
- Comparte el enlace solo con quien quieras.

### Pasar la app a un amigo

Puedes copiar `StreamChat Hub.exe` y enviarlo: es portátil y no necesita Node ni instalación. Cada persona tendrá su propia configuración.

---

## Ajustes

### Filtros

- **Usuarios bloqueados**: separados por comas; funciona con nombres con o sin `@`.
- **Ocultar comandos**: ignora mensajes que empiezan por `!`.
- **Largo máximo** y **mostrar hora**.

### Overlay

- Máximo de mensajes, tamaño de letra, ancho, duración, posición y opacidad.
- La **duración** solo afecta a la ventana flotante. El overlay de OBS no se desvanece.
- **Espectadores totales**: suma los espectadores de Twitch, Kick, YouTube y TikTok/TikFinity. Se puede ocultar.
- Mostrar u ocultar iconos de plataforma e insignias.
- Vista previa integrada.
- **Copiar URL para OBS** en Compartir (también en la barra de edición del overlay).

### Avisos de TikTok

En **Ajustes → Avisos de TikTok** puedes activar o desactivar por separado:

- Entradas al directo.
- Regalos y donaciones.
- Compartidos.
- Nuevos seguidores.
- Suscripciones.
- Me gusta (desactivado por defecto porque puede ser muy frecuente).

Los avisos aparecen como tarjetas simples en la esquina superior derecha del overlay flotante y del overlay de OBS. También hay un botón **Probar avisos**.

### Avanzado

- **Kick Channel ID / Chatroom ID**: solo si la detección automática falla por Cloudflare. Hay un botón para abrir la API del canal y copiarlos.
- **TikTok Sign API key**: opcional; se guarda solo en tu PC. También se puede usar la variable de entorno `TIKTOK_SIGN_API_KEY`.

La configuración de la app se guarda en:

```text
%APPDATA%\StreamChatHub\config.json
```

No compartas ese archivo si tiene una clave de TikTok.

---

## Compilar desde el código

Requisitos: **Node.js 20 o superior**.

```bat
cd C:\Users\Gamer\Desktop\StreamChatHub
npm install
npm run app        REM abre la app en modo desarrollo
npm run dist       REM genera los .exe en release\
```

Resultados:

- `release\StreamChatHub-1.1.1-portable.exe`
- `release\StreamChatHub-1.1.1-setup.exe`

### Publicar una actualización

El aviso se basa en la última release de GitHub y en la versión de `package.json`:

1. Sube `version` en `package.json` y `package-lock.json` a un número mayor (por ejemplo `1.2.0`).
2. Actualiza `VERSION` en `server.mjs` y los nombres de los `.exe` en `Iniciar-StreamChat.bat`, README y LEEME.
3. Ejecuta `npm run dist`.
4. Crea una release en GitHub con el tag `v1.2.0` y adjunta el portable y el instalador.
5. Quien tenga la 1.1.0 o posterior recibirá el aviso al abrir la app o en la siguiente comprobación (cada 6 horas).

No hace falta publicar en Microsoft Store ni forzar la actualización: el usuario decide cuándo descargarla.

El modo navegador para desarrollo sigue disponible:

```bat
npm start
```

Abre `http://localhost:3000` y sirve para probar el servidor, pero la app de escritorio es la forma recomendada.

### Estructura

```text
StreamChatHub/
  electron/
    main.mjs              ventana, overlay nativo, bandeja y atajos
    preload.cjs           puente seguro con la app
  server.mjs              servidor interno, API, WebSocket y túnel
  src/                    conectores de las cuatro plataformas
  public/                 interfaz, overlay y estilos
  build/icon.png          icono de la aplicación
  release/                .exe generados
  config.json             configuración del modo desarrollo
```

---

## Solución de problemas

**Windows SmartScreen bloquea el .exe.**
Es normal en ejecutables sin firma. Pulsa **Más información → Ejecutar de todas formas**. Si prefieres, usa el instalador o compila tu propia versión.

**El overlay no aparece.**
Pulsa **Ctrl + Alt + O** o usa el icono de la bandeja. Comprueba que la app sigue abierta.

**El overlay no deja hacer clic.**
Es intencionado: es click-through para no molestar mientras juegas. Se oculta con el atajo o desde la bandeja.

**La app no arranca o se cierra.**
Comprueba que no haya otra instancia abierta. La app usa un puerto libre entre 3000 y 3100 y guarda datos en `%APPDATA%\StreamChatHub`.

**Mis amigos no pueden abrir el enlace de Wi-Fi.**
Revisa que estén en la misma red y que el firewall de Windows permita la app en redes privadas. Si no, crea el enlace público.

**Kick responde 403.**
Abre **Ajustes → Kick → IDs manuales**, pulsa **Ver IDs de este canal**, copia `id` y `chatroom.id` y guarda.

**YouTube no conecta.**
Comprueba que el canal está en directo y con el chat habilitado. Si usas `@handle`, espera unos segundos o pega la URL exacta del directo.

**TikTok no conecta.**
Para la conexión directa, el usuario debe estar en directo. Si el error habla de firma o límite, prueba **Ajustes → TikTok → Fuente: TikFinity** y deja TikFinity Desktop abierto y conectado. También puedes añadir una clave de Euler Stream si usas la conexión directa.

**El enlace público falla.**
Necesita conexión a internet y descargar `cloudflared.exe` la primera vez. También puedes descargarlo desde [Cloudflare](https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe) y guardarlo en `%APPDATA%\StreamChatHub\bin\cloudflared.exe`.

**Quiero empezar de cero.**
Cierra la app, borra `%APPDATA%\StreamChatHub\config.json` y vuelve a abrirla.

---

## Notas

- Las plataformas son de solo lectura: no se envían mensajes ni hay moderación en Twitch/Kick/YouTube/TikTok. El compositor del overlay crea mensajes locales para la app y el overlay compartido.
- Twitch y Kick se leen de forma anónima.
- YouTube y TikTok usan APIs internas no oficiales y pueden cambiar.
- El historial vive en memoria; al cerrar la app se vacía.
- El túnel público no tiene contraseña: cualquiera con la URL puede leer el chat.
- No se envían cookies, contraseñas ni tokens de Twitch/Kick.
- No está afiliado a Twitch, Kick, YouTube, TikTok, Cloudflare ni al proyecto original.

## Créditos

- Inspirado en [Transparent Twitch Chat Overlay](https://github.com/baffler/Transparent-Twitch-Chat-Overlay).
- Iconos de plataforma basados en [Simple Icons](https://simpleicons.org).
- TikTok mediante [`tiktok-live-connector`](https://github.com/zerodytrash/TikTok-Live-Connector) o la API local de [TikFinity](https://tikfinity.zerody.one/).
- YouTube mediante [`youtube-chat`](https://github.com/LinaTsukusu/youtube-chat).
- Túnel mediante [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).

## Licencia

MIT. Consulta `LICENSE`.
