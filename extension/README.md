# Enviador-DEVOLUCIÓN — extensión de Chrome

Hace el último tramo que el sistema no puede hacer solo: **presentar la solicitud
de devolución de IVA dentro del portal del SRI**, sin que nadie toque nada en esa
pestaña.

## Por qué existe

El portal del SRI vive detrás de un login SSO que se renueva en cada navegación,
así que el servidor del Gestor Tributario **no puede entrar**: el trámite tiene
que hacerse en el navegador donde está la sesión. Con el marcador
(*bookmarklet*) eso ya funciona, pero hay que tocarlo una vez en cada envío.

La extensión quita ese toque: la app publica la solicitud, la extensión la
guarda, y al abrirse el portal la inyecta y el recorrido arranca solo.

## Qué hace, en orden

1. `contenido-app.js` corre en el Gestor Tributario y escucha la solicitud que
   la app publica al tocar **📤 Enviar al SRI**. La guarda con su hora.
2. `contenido-sri.js` corre en el portal del SRI, la recupera y la inyecta en la
   página junto con el enviador.
3. `enviador.js` —el mismo código del marcador, generado de la misma fuente—
   marca los comprobantes, les pone el tipo de gasto, procesa, guarda, entra a
   *Envío de solicitud* y presenta.
4. Al terminar publica la **constancia** del portal; `contenido-sri.js` la
   guarda y `contenido-app.js` se la entrega a la app cuando el usuario vuelve a
   esa pestaña. Recién ahí la solicitud queda **Presentada** en el sistema.

El paso 4 no es un adorno: sin él el trámite quedaba hecho en el SRI y en
**Borrador** en el sistema, porque marcarlo dependía de que alguien regresara a
pegar la constancia a mano —y con el recorrido automático ya nadie regresa—.
La app solo la registra si el portal confirmó con *"Carga de archivo realizada
exitosamente"*; si no, avisa y la deja en Borrador.

Tres resguardos deliberados: la solicitud **caduca a los 30 minutos** y se
**consume al usarla** —entrar al portal al otro día no puede disparar una
presentación que nadie pidió hoy—, y la constancia **también se consume**, para
no registrar dos veces el mismo envío. La constancia vale 24 horas: registra
algo que ya ocurrió, y el usuario puede volver a la app recién al día siguiente.

## Instalar

1. `chrome://extensions` → activar **Modo de desarrollador**.
2. **Cargar descomprimida** → elegir esta carpeta (`extension/`).
3. Listo. No pide clave ni configuración.

Para verificar que quedó: entrá al Gestor Tributario, tocá *Enviar al SRI* en una
solicitud y mirá que en el portal aparezca el panel verde trabajando solo.

## Mantener

`enviador.js` es **generado**: se edita `sri_downloader/bookmarklet_devolucion.js`
y se corre `node scripts/build_bookmarklets.mjs`, que actualiza a la vez el
marcador y la extensión. Así no pueden divergir.

Si cambia el dominio de la app, hay que agregarlo en `matches` del
`manifest.json` (hoy: `tributos.pensamiento-libre.org` y `localhost:5173`).

## Sin extensión

Todo sigue funcionando igual con el marcador: la app copia la solicitud al
portapapeles y el enviador la lee de ahí. La extensión solo ahorra el toque.
