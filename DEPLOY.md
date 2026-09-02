# Despliegue y secretos

## Estado: el CI está roto por facturación

`.github/workflows/fly-deploy.yml` corre en cada push a `master` pero falla desde el
2026-07-09:

    ensure depot builder failed (403): Your account has overdue invoices.
    https://fly.io/dashboard/daniel-gomez-880/billing

El 403 no bloquea solo la construcción de la imagen: **también bloquea `fly secrets set`**,
porque crear un secreto crea un release. Hasta que se regularice la facturación no se puede
ni desplegar por imagen ni configurar secretos.

## Cómo desplegar mientras tanto

`server.js` sirve `express.static('/data/public')` y `start.sh` copia `/data/` → `/app/` en
cada arranque, así que el volumen persistente es la fuente de verdad y se puede actualizar
por SFTP sin construir nada.

    export FLY_ACCESS_TOKEN=$(grep "^access_token:" "$HOME/.fly/config.yml" | sed 's/^access_token: //')
    export MSYS_NO_PATHCONV=1          # obligatorio en Git Bash, si no la ruta remota se convierte
    FLY="$HOME/.fly/bin/flyctl.exe"

    "$FLY" ssh sftp put public/index.html /data/public/index.html --app taskflow-cwti

Los HTML entran al instante. Un cambio en `server.js` necesita además
`"$FLY" machine restart <id> --app taskflow-cwti`.

### Dos trampas que ya han tirado el sitio

- **`sftp put` no sobrescribe** ("for safety"): hay que borrar o renombrar el remoto antes.
- **`ssh console -C` devuelve `Error: The handle is invalid` aunque el comando haya funcionado.**
  No es un fallo: el comando remoto se ejecutó. Nunca reintentar en bucle un comando
  destructivo basándose en ese código de salida — un `rm` se ejecuta dos veces y la segunda
  vez ya no hay backup que valga. Usar `--pty=false -q -C`, y para lecturas comprobar la
  salida, no el código de salida.

## Secretos: qué falta

Los valores que estaban escritos a mano en `start.sh`, `fly.toml` y `render.yaml` se han
sacado del repo, pero **siguen expuestos en la historia de git** (repo público
`github.com/dandres96/taskflow`, commit `5bdb953` para las llaves de R2). Sacarlos del
código no los invalida: hay que rotarlos.

1. **Rotar las llaves de R2 en Cloudflare** (R2 → Manage API tokens → revocar el token
   actual y crear uno nuevo).
2. Regularizar la facturación de Fly.
3. Configurar los secretos **antes** del primer despliegue por imagen:

       fly secrets set --app taskflow-cwti \
         JWT_SECRET="$(openssl rand -hex 32)" \
         R2_ACCOUNT_ID="..." \
         R2_ACCESS_KEY="<la nueva>" \
         R2_SECRET_KEY="<la nueva>" \
         R2_BUCKET="taskflow-videos" \
         R2_PUBLIC_URL="https://pub-....r2.dev"

   Rotar `JWT_SECRET` invalida todos los tokens: todo el mundo tendrá que volver a entrar.

`server.js` se niega a arrancar si está en Fly y falta `JWT_SECRET`, en vez de usar en
silencio el valor por defecto de desarrollo. Es decir: **si se despliega por imagen sin
haber configurado los secretos, la app no levanta** y el log dice exactamente qué correr.
Mientras no se despliegue por imagen, la máquina actual sigue usando el `JWT_SECRET` que
tiene ya en su configuración y nada cambia.

## Pendientes menores

- En móvil el header ocupa dos filas (124 px). Funciona; si molesta, dejar solo los emoji o
  meter las acciones en un menú.
- `completed_at` se usa en las consultas del dashboard pero no está en el `CREATE TABLE` de
  `server.js`: se añadió a mano en la base de datos de producción. Una base de datos nueva
  y vacía haría fallar el dashboard.
