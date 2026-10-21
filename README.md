# GTT bot ⚽

Bot de Discord del equipo GTT, enfocado a la productividad y a tener la información del reto a mano. Corre en **Cloudflare Workers**: Discord llama al Worker por HTTP con cada comando `/` y un cron publica el resumen diario. No hay ningún servidor que mantener encendido y el plan gratuito sobra.

## Comandos

| comando | qué hace |
|---|---|
| `/tarea crear titulo responsable area [detalle]` | crea un post en 📋 tareas con las etiquetas 📥 To do + área y avisa al responsable |
| `/tarea estado estado` | dentro del post: cambia la etiqueta de estado (To do → En curso → Review → Hecho, o Bloqueado) y conserva el área |
| `/tarea lista [estado] [responsable]` | tareas abiertas (o las de un estado/persona), con su responsable |
| `/experimento titulo hipotesis resultado [spellf1 split macrof1 enlace notas]` | publica el experimento en 🔬 experimentos; compara spellF1 **solo** con el baseline del mismo split (0,2433 partido · 0,3256 público) y avisa si se ha medido en la ventana pública |
| `/resumen` | cuenta atrás, tareas por estado, bloqueadas, en marcha, sin responsable, PRs abiertas, último deploy y última entrada del log |
| `/countdown` | lo que queda hasta el 17-nov, 23:59 |
| `/reto tema` | chuleta: `metrica`, `datos`, `entrega`, `reglas`, `enlaces` |
| `/log` | las 5 últimas entradas del log de la web |
| `/archivo discord` | para miembros de **⚽ GTT Team**: descarga de forma efímera la última copia privada, `archivo-discord.md` y `manifest.json` |

**Resumen diario:** todos los días a las 07:00 UTC (08:00 en Barcelona en horario de invierno) en 💬 general. El horario se cambia en `wrangler.toml`.

**Archivo de Discord:** GitHub Actions lo sincroniza cada 6 h (minuto 15, UTC) en Supabase Storage. El comando no vuelve a leer el servidor entero: entrega esa última copia privada.

## Puesta en marcha (una vez)

> Los tokens son credenciales: van en `.dev.vars` (en `.gitignore`) y en los secrets de Cloudflare/GitHub Actions. **Nunca** en git ni en el chat.

### 1. Crear la aplicación en Discord
1. https://discord.com/developers/applications → **New Application** → `GTT`.
2. **General Information**: copia el *Application ID* y la *Public Key*. Sube como icono `../discord/gtt-github-avatar.png`.
3. **Bot**: *Reset Token* y cópialo. Activa también el privileged intent **Message Content**: sin él Discord enumera el historial, pero puede devolver sus textos vacíos.
4. **Installation**: deja solo *Guild Install*; scopes `bot` + `applications.commands`. O directamente abre (cambiando `APP_ID`):
   ```
   https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot+applications.commands&permissions=326417599488&guild_id=1562076469172117586
   ```
   Permisos: ver canales, enviar mensajes, insertar enlaces, leer el historial, gestionar hilos, crear hilos públicos y enviar mensajes en hilos.
5. En Discord, dale al bot el rol **🤖 Bots**.

### 2. Credenciales locales
Crea `bot/.dev.vars`:
```
DISCORD_APPLICATION_ID=...
DISCORD_PUBLIC_KEY=...
DISCORD_BOT_TOKEN=...
```

### 3. Desplegar en Cloudflare
```bash
cd bot
npm install
npx wrangler login                           # abre el navegador; cuenta de Cloudflare gratuita
npx wrangler secret put DISCORD_APPLICATION_ID
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SECRET_KEY
npm run deploy                               # imprime la URL: https://gtt-bot.<tu-subdominio>.workers.dev
npm run register                             # da de alta los comandos / en el servidor
```

### 4. Conectar Discord con el Worker
Developer Portal → **General Information** → *Interactions Endpoint URL* = la URL del deploy → **Save**. Discord envía un PING firmado; si el Worker responde, se guarda.

## Desarrollo

```bash
npm test            # tests unitarios (node:test)
npm run typecheck
npm run deploy      # tras cambiar código
npm run register    # tras cambiar src/commands.ts
npx wrangler tail   # logs en directo del Worker
```

| fichero | contenido |
|---|---|
| `src/index.ts` | entrada: verifica la firma, enruta comandos, cron |
| `src/commands.ts` | definición de los comandos (la que se registra) |
| `src/config.ts` | IDs del servidor y canales, deadline, etiquetas, baselines |
| `src/tareas.ts` | foro de tareas |
| `src/experimento.ts` | registro de experimentos |
| `src/info.ts` | cuenta atrás, chuleta del reto, GitHub y log |
| `src/resumen.ts` | resumen (comando + diario) |
| `src/archive.ts` | lectura y render seguro de canales, hilos y mensajes de Discord |
| `src/archivo.ts` | estado incremental y entrega restringida del archivo privado |
| `src/supabase.ts` | cliente REST mínimo para el bucket privado de Supabase |
| `scripts/sync-discord-archive.ts` | entrada de la sincronización ejecutada por GitHub Actions |
| `.github/workflows/sync-discord-archive.yml` | programación cada 6 h y ejecución manual |

## Almacenamiento privado del archivo

En Supabase crea un bucket llamado exactamente `discord-archives` y déjalo como **privado**. No crees URL pública, política pública ni enlaces firmados compartidos: el Worker lo lee con la clave secreta y adjunta el contenido únicamente en la respuesta efímera de Discord.

En **Connect** copia `SUPABASE_URL`; en **Settings → API Keys → Secret keys** crea una clave `sb_secret_...`. El Worker necesita ambas para leer el archivo al responder `/archivo`; añádelas sin pegarlas en git, Discord ni este README:

```bash
cd bot
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SECRET_KEY
```

### Sincronización programada en GitHub Actions

En GitHub → repositorio `gtt-bot` → **Settings → Secrets and variables → Actions**, añade estos tres *Repository secrets*:

```text
DISCORD_BOT_TOKEN
SUPABASE_URL
SUPABASE_SECRET_KEY
```

El workflow **Sync Discord archive** se ejecuta a `:15` cada seis horas en UTC y también puede iniciarse desde **Actions → Sync Discord archive → Run workflow**. GitHub puede retrasar un cron en horas de mucha carga: úsalo como sincronización periódica, no como ejecución a una hora exacta. El workflow no publica artefactos de GitHub ni escribe en el repositorio; usa esos secretos únicamente para leer Discord y actualizar el bucket privado.

La primera ejecución crea la copia completa. Las siguientes descubren canales/hilos y piden solo los mensajes posteriores al último mensaje guardado por canal. Supabase conserva un único objeto privado, `latest-archive.json`, que se sobrescribe cuando cambia el estado: no se acumulan snapshots completos. Los mensajes de canales eliminados o temporalmente inaccesibles se retienen en el histórico; las omisiones actuales quedan señaladas en el manifiesto.

Para probar la misma sincronización desde un equipo autorizado, con las tres variables ya presentes en el entorno:

```bash
cd bot
npm run sync:discord-archive
```

No ejecutes esta prueba en una terminal cuyo historial, logs o entorno compartas. El flujo normal es la Action. El único cron de Cloudflare sigue siendo el resumen diario de las 07:00 UTC; no hay cron de archivado en el Worker.

## Archivo local completo de Discord

Para conservar el contexto de trabajo, el exportador lee **todos los canales del servidor que el bot puede leer**, sus hilos activos (también privados si Discord se los expone), y los hilos archivados públicos. En canales de texto también intenta los privados archivados: con **Manage Threads** obtiene todos; sin ese permiso, recupera los privados a los que el bot se hubiera unido. Pagina el historial completo y escribe Markdown cronológico, con enlaces a los mensajes originales, en `context/`. Toda esa carpeta está en `.gitignore`: contiene conversaciones privadas del equipo y **no se debe commitear, publicar ni adjuntar a issues/PRs**.

```bash
cd bot
npm run export:discord
# Alternativa: una carpeta nueva, siempre relativa y dentro de bot/context/:
npm run export:discord -- --out context/discord-2026-10-21
```

El destino no puede existir: así una exportación nunca pisa ni mezcla un archivo anterior. Se prepara en una carpeta temporal y se publica de una vez al acabar. Cada salida incluye `index.md` y `manifest.json`, que indican si el resultado es parcial y enumeran las omisiones. Por seguridad, si hubo cualquier omisión el comando termina con error después de guardar el archivo; úsalo solo tras revisar el manifiesto y aceptar el resultado parcial:

```bash
npm run export:discord -- --out context/discord-2026-10-21 --allow-partial
```

Necesita `DISCORD_BOT_TOKEN` en `.dev.vars`; usa `DISCORD_GUILD_ID` si se quiere sobrescribir el servidor configurado en `src/config.ts`. No necesita desplegar el Worker ni modifica mensajes. El bot debe tener, en cada canal/hilo relevante, **View Channel** y **Read Message History**; para enumerar todos los privados archivados necesita además **Manage Threads**. Activa también el privileged intent **Message Content** en Developer Portal → Bot: sin él, Discord puede devolver el texto de los mensajes vacío aunque el historial se enumere.

El índice solo lista lo que el token pudo leer; permisos por canal, hilos privados no unidos y errores de Discord pueden excluir contenido, y quedan registrados tanto por stderr como en el manifiesto. Discord no permite a un bot exportar los MD privados de los miembros ni conversaciones ajenas al bot: esos contenidos requieren exportación voluntaria de cada persona y nunca se mezclan con este archivo del servidor. Los adjuntos **no se descargan**: el archivo solo guarda su nombre, metadatos y enlace HTTPS si Discord lo proporcionó.

## Archivo bajo demanda en Discord

Un miembro con el rol **⚽ GTT Team** puede ejecutar `/archivo discord`. El Worker contesta de forma **efímera** y adjunta el Markdown único y el manifiesto derivados de la última copia privada de Supabase: no comparte tokens, no publica enlaces públicos y no vuelve a recorrer Discord cuando alguien ejecuta el comando. Incluye los canales/hilos que el bot podía leer durante la sincronización; si Discord deniega algún canal o hilo, se entrega igualmente como archivo **parcial** y queda señalado en `manifest.json`.

El adjunto está limitado al menor entre el límite anunciado por Discord para esa interacción y 8 MiB. Si lo supera, el usuario recibe un error privado; la copia completa sigue privada en Storage y habrá que dividir el formato de entrega antes de adjuntarlo. Esto evita enviar exportaciones truncadas o intentar adjuntar archivos que Discord rechazaría.

**Notas**
- Las etiquetas del foro se leen por nombre: si se renombran, actualizar `STATUS_TAGS`/`AREA_TAGS` en `src/config.ts`.
- La API de GitHub sin token permite 60 peticiones/hora por IP, y las IPs de Cloudflare son compartidas. Si `/resumen` muestra «no disponible» en PRs o en el deploy, añade un token de solo lectura: `npx wrangler secret put GITHUB_TOKEN`.
- El bot nunca lee ni publica datos del partido.
