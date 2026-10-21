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

**Resumen diario:** todos los días a las 07:00 UTC (08:00 en Barcelona en horario de invierno) en 💬 general. El horario se cambia en `wrangler.toml`.

## Puesta en marcha (una vez)

> Los tokens son credenciales: van en `.dev.vars` (en `.gitignore`) y en los secrets de Cloudflare. **Nunca** en git ni en el chat.

### 1. Crear la aplicación en Discord
1. https://discord.com/developers/applications → **New Application** → `GTT`.
2. **General Information**: copia el *Application ID* y la *Public Key*. Sube como icono `../discord/gtt-github-avatar.png`.
3. **Bot**: *Reset Token* y cópialo. No hacen falta *Privileged Gateway Intents*.
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

**Notas**
- Las etiquetas del foro se leen por nombre: si se renombran, actualizar `STATUS_TAGS`/`AREA_TAGS` en `src/config.ts`.
- La API de GitHub sin token permite 60 peticiones/hora por IP, y las IPs de Cloudflare son compartidas. Si `/resumen` muestra «no disponible» en PRs o en el deploy, añade un token de solo lectura: `npx wrangler secret put GITHUB_TOKEN`.
- El bot nunca lee ni publica datos del partido.
