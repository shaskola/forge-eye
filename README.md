# Forge Eye

Overlay de escritorio para ver y hablar con tus agentes de **T3 Code** mientras juegas (por ejemplo Warframe en ventana sin bordes).

No sustituye a T3. Se conecta a T3 en esta misma máquina, se queda siempre encima del juego y te deja mirar el estado de los hilos o mandar un mensaje corto sin cambiar de ventana.

## Cómo se ve

Lista de agentes sobre el juego:

![Forge Eye mostrando agentes de T3 sobre Warframe](docs/overlay-lista.png)

Chat de un agente, con herramientas y respuesta:

![Forge Eye con el chat de un agente sobre Warframe](docs/overlay-chat.png)

## Si no programas: descargar el EXE

1. Abre [Releases](https://github.com/shaskola/forge-eye/releases).
2. En la versión más reciente descarga **uno** de estos archivos:
   - **ForgeEye-Portable-…exe** — no instala nada. Lo abres y listo. Recomendado para probar.
   - **ForgeEye-Setup-…exe** — instalador. Crea acceso directo en el menú Inicio.
3. Windows puede mostrar un aviso de SmartScreen porque el archivo aún no está firmado. Elige **Más información** y después **Ejecutar de todas formas**.
4. Deja **T3 Code abierto** en esta misma PC. Forge Eye no funciona si T3 no está corriendo.
5. En T3: **Settings → Connections → Create Link**. Copia el enlace.
6. En Forge Eye pega el enlace y empareja una vez. La sesión queda guardada; no hace falta repetirlo cada vez.

El juego tiene que estar en **ventana sin bordes** (borderless). Pantalla completa exclusiva suele tapar el overlay.

### Atajos

| Acción | Teclas |
|--------|--------|
| Ocultar / mostrar todo | `Ctrl+Shift+H` |
| Mostrar / ocultar panel | `Ctrl+Shift+A` |
| Pulsar el overlay (o devolver clics al juego) | `Ctrl+Shift+C` |
| Modo mover (arrastrar la ventana) | `Ctrl+Shift+D` |
| Traer el overlay al frente | `Ctrl+Shift+F` |
| Enviar mensaje | `Enter` |
| Nueva línea en el mensaje | `Shift+Enter` |

Posición inicial: esquina inferior izquierda. Icono en la bandeja del sistema para mostrar el panel o salir.

La opacidad se ajusta en el engranaje de **Ajustes** (queda guardada). Por defecto el overlay deja pasar los clics al juego; `Ctrl+Shift+C` lo hace pulsable.

### Qué vas a ver

- **trabajando** — el agente está en un turno o hay trabajo en segundo plano.
- **listo** — no hay trabajo activo en ese hilo.
- **error** — T3 reportó un fallo.

Si Forge Eye dice “sin emparejar”, falta el Create Link. Si dice “T3 offline”, T3 no está abierto o no responde en `http://127.0.0.1:3773`.

## Requisitos

- Windows 10 u 11, 64 bits
- [T3 Code](https://t3.chat) instalado y abierto en esta máquina (puerto `3773`)
- Un enlace de pairing creado en T3 (un solo uso; si falla, crea otro)

## Desarrollo (código)

Necesitas Node.js 22 o superior.

```bash
npm install
npm run dev
```

Eso abre Vite en el puerto **5177** y lanza Electron. La ventana es transparente y siempre encima. Forge Eye no incrusta la UI de T3: habla con T3 por WebSocket.

Otros comandos:

```bash
npm run build    # genera dist + dist-electron
npm start        # abre Electron usando esa build (sin recarga en caliente)
npm run dist     # genera los EXE en la carpeta release/
```

La sesión de T3 se guarda en `%APPDATA%\forge-eye\t3-session.json`. No va al repositorio. Para desemparejar, usa la opción en la app o borra ese archivo.

## Publicar un Release con EXE

Cada vez que quieras una versión descargable:

1. Sube el código a `main`.
2. Actualiza `"version"` en `package.json` (por ejemplo `0.1.1`).
3. Crea y publica una etiqueta que empiece con `v`:

```bash
git tag v0.1.1
git push origin v0.1.1
```

GitHub Actions (workflow **Release**) construye los dos EXE en un runner de Windows y los adjunta a un [GitHub Release](https://github.com/shaskola/forge-eye/releases) con el mismo nombre de etiqueta.

También puedes disparar el workflow a mano en la pestaña **Actions** (queda el artefacto, pero solo publica Release si la corrida viene de una etiqueta `v…`).

Para generar los EXE en tu PC, sin GitHub:

```bash
npm run dist
```

Los archivos salen en `release/ForgeEye-Setup-….exe` y `release/ForgeEye-Portable-….exe`.
