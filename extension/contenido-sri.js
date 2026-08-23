// ------------------------------------------------------------
// Desarrollado por Marco Antonio Posligua San Martín
// ------------------------------------------------------------
//
// Corre EN EL PORTAL DEL SRI. Toma la solicitud que dejó la app y mete el
// enviador dentro de la página para que haga el trámite.
//
// Por qué se inyecta en la página en vez de correr acá: un content script vive
// en un mundo aislado y no ve `PrimeFaces` ni `jQuery`, que es justo lo que el
// enviador necesita para manejar los combos del portal. Insertando un <script>
// el código corre en el mismo mundo que la aplicación del SRI.
//
// Y por qué la solicitud CADUCA: quedaría guardada en el navegador, y entrar al
// portal días después no puede disparar una presentación que nadie pidió hoy.

const VIGENCIA_MINUTOS = 30;

// El origen del sistema, para el enviador. Lo anota `contenido-app.js` la
// primera vez que se abre la app con la extensión puesta; si todavía no pasó,
// se toma del propio manifiesto, que es donde están declarados los sitios de la
// app. Va inyectado SIEMPRE —haya o no solicitud— porque el primer paso del
// trámite (traer la grilla al sistema) ocurre justo cuando no hay ninguna.
const origenDelSistema = (guardado) => {
  if (guardado) return guardado;
  try {
    const cs = (chrome.runtime.getManifest().content_scripts || [])
      .find((x) => (x.js || []).indexOf('contenido-app.js') >= 0) || {};
    const url = (cs.matches || []).filter((m) => m.indexOf('https://') === 0)[0];
    return url ? new URL(url.replace(/\*$/, '')).origin : '';
  } catch (e) {
    return '';
  }
};

const inyectarDatos = (origen, llave, api) => {
  if (!origen && !llave) return;
  const s = document.createElement('script');
  s.textContent =
    (origen ? 'window.__jomapAppOrigen = ' + JSON.stringify(origen) + ';' : '') +
    // Sin llave el enviador no trabaja: es lo que ata el bajador a una persona
    // autorizada y a una máquina.
    (llave ? 'window.__jomapLlave = ' + JSON.stringify(llave) + ';' : '') +
    (api ? 'window.__jomapApi = ' + JSON.stringify(api) + ';' : '');
  (document.head || document.documentElement).appendChild(s);
  s.remove();
};

const inyectar = (paquete) => {
  // 1) La solicitud, en el mundo de la página.
  const datos = document.createElement('script');
  datos.textContent = 'window.__jomapDevolucionPaquete = ' + JSON.stringify(paquete) + ';';
  (document.head || document.documentElement).appendChild(datos);
  datos.remove();

  // 2) El enviador, que la va a encontrar ahí.
  const codigo = document.createElement('script');
  codigo.src = chrome.runtime.getURL('enviador.js');
  codigo.onload = () => codigo.remove();
  (document.head || document.documentElement).appendChild(codigo);
};

// El camino de vuelta: lo que el SRI contestó al presentar. El enviador lo
// publica al terminar y acá se guarda para la app, que es la que puede marcar la
// solicitud como presentada. Antes esa constancia moría en esta pestaña y el
// sistema seguía mostrando Borrador un trámite ya hecho.
window.addEventListener('message', (ev) => {
  if (ev.source !== window) return;
  const dato = ev.data;
  if (!dato || dato.tipo !== 'jomap-devolucion-constancia' || !dato.constancia) return;
  chrome.storage.local.set({
    constancia: {
      solicitud_id: dato.solicitud_id || null,
      constancia: dato.constancia,
      cuando: Date.now(),
    },
  });
});

// El otro camino de vuelta: el LISTADO de comprobantes que el portal muestra.
// Antes había que copiarlo a mano y pegarlo en la app, y el mes se perdía cada
// vez que el portapapeles fallaba o alguien cerraba la pestaña sin pegar. Ahora
// viaja igual que la constancia, y se le acusa recibo al enviador para que diga
// la verdad sobre si llegó (sin extensión no lo escucha nadie).
window.addEventListener('message', (ev) => {
  if (ev.source !== window) return;
  const dato = ev.data;
  if (!dato || dato.tipo !== 'jomap-devolucion-comprobantes') return;
  const b = dato.bulto;
  if (!b || !Array.isArray(b.filas) || !b.filas.length) return;
  chrome.storage.local.set({
    comprobantes: { bulto: b, cuando: Date.now() },
  }, () => {
    window.postMessage({ tipo: 'jomap-devolucion-comprobantes-recibidos' }, '*');
  });
});

chrome.storage.local.get(
  ['solicitud', 'app_origen', 'bajadores_llave', 'bajadores_api'],
  ({ solicitud, app_origen, bajadores_llave, bajadores_api }) => {
  const origen = origenDelSistema(app_origen);
  // La API se inyecta SOLO si la publicó la app: el origen del sistema no es la
  // dirección del backend, y adivinarla dejaba al marcador preguntando permiso
  // donde no hay a quién.
  inyectarDatos(origen, bajadores_llave, bajadores_api);
  if (!solicitud || !solicitud.paquete) return;
  const minutos = (Date.now() - (solicitud.cuando || 0)) / 60000;
  if (minutos > VIGENCIA_MINUTOS) {
    chrome.storage.local.remove('solicitud');
    return;
  }
  // Se consume UNA vez: si no, volver a entrar al portal más tarde en el día
  // relanzaría el trámite. La app la vuelve a publicar cuando haga falta.
  chrome.storage.local.remove('solicitud', () => inyectar(solicitud.paquete));
});
