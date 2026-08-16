// ------------------------------------------------------------
// Desarrollado por Marco Antonio Posligua San Martín
// ------------------------------------------------------------
//
// Corre EN LA APP. Su único trabajo es recoger la solicitud que el sistema
// publica al tocar "Enviar al SRI" y dejarla guardada para el otro lado.
//
// Por qué hace falta este puente: la extensión no puede leer el portapapeles
// sin permisos incómodos, y la app no puede escribir en el almacenamiento de la
// extensión (son orígenes distintos). El único canal que ambos comparten es un
// `postMessage` en la misma pestaña, que es lo que se escucha acá.
//
// Se acepta SOLO lo que viene de esta misma ventana y con la marca esperada: un
// mensaje de otro origen no puede colarse como solicitud.

const MARCA = 'jomap-devolucion-paquete';
const MARCA_CONSTANCIA = 'jomap-devolucion-constancia';
// La constancia sí puede esperar: registra algo que YA pasó en el SRI, y el
// usuario puede tardar en volver a la pestaña de la app (o volver mañana).
const VIGENCIA_CONSTANCIA_HORAS = 24;

window.addEventListener('message', (ev) => {
  if (ev.source !== window) return;                 // nada de otras ventanas
  const dato = ev.data;
  if (!dato || dato.tipo !== MARCA || !dato.paquete) return;
  const p = dato.paquete;
  if (!p.items || !p.contribuyente || !p.periodo) return;   // no es una solicitud

  chrome.storage.local.set({
    solicitud: {
      paquete: p,
      // Con cuándo llegó: una solicitud vieja no se presenta sola porque quedó
      // guardada de la semana pasada. Ver `contenido-sri.js`.
      cuando: Date.now(),
    },
  });
});

// Y el viaje de vuelta: la constancia que el enviador dejó guardada desde el
// portal se le entrega a la app. Se hace al cargar y cada vez que esta pestaña
// vuelve al frente, que es justo el momento en que el usuario regresa del SRI.
const entregarConstancia = () => {
  chrome.storage.local.get('constancia', ({ constancia }) => {
    if (!constancia || !constancia.constancia) return;
    const horas = (Date.now() - (constancia.cuando || 0)) / 3600000;
    if (horas > VIGENCIA_CONSTANCIA_HORAS) {
      chrome.storage.local.remove('constancia');
      return;
    }
    // Se consume al entregarla: registrar dos veces el mismo envío sería
    // pisar la constancia buena con una repetida.
    chrome.storage.local.remove('constancia', () => {
      // '*' por lo mismo que en el enviador: el mensaje va a esta misma ventana
      // —la de la app— y ningún tercero lo ve.
      window.postMessage({
        tipo: MARCA_CONSTANCIA,
        solicitud_id: constancia.solicitud_id || null,
        constancia: constancia.constancia,
      }, '*');
    });
  });
};

// La app tarda en montar la pantalla y en enganchar su escucha; entregar en el
// acto sería hablarle a nadie.
setTimeout(entregarConstancia, 1500);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) setTimeout(entregarConstancia, 400);
});
window.addEventListener('focus', () => setTimeout(entregarConstancia, 400));
