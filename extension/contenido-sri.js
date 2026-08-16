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

chrome.storage.local.get('solicitud', ({ solicitud }) => {
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
