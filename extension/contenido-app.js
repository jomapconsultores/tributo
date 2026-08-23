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
const MARCA_COMPROBANTES_APP = 'jomap-devolucion-comprobantes-app';
const MARCA_COMPROBANTES_OK = 'jomap-devolucion-comprobantes-ingresados';
const MARCA_COMPROBANTES_PEDIDO = 'jomap-devolucion-comprobantes-pedido';
// La constancia sí puede esperar: registra algo que YA pasó en el SRI, y el
// usuario puede tardar en volver a la pestaña de la app (o volver mañana).
const VIGENCIA_CONSTANCIA_HORAS = 24;

// Dónde vive el sistema, anotado desde el propio sistema. El enviador lo
// necesita en el portal para poder ENTREGARLE el listado de comprobantes:
// abre esta app en una pestaña y se lo pasa, sin copiar ni pegar. Nadie más
// puede saberlo —el portal no tiene por qué conocer la dirección de la app— y
// acá se sabe sin preguntar: es la página en la que corre este script.
chrome.storage.local.set({ app_origen: location.origin });

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

// Y los COMPROBANTES que el enviador trajo de la grilla del portal. Se
// entregan igual que la constancia, pero NO se consumen al entregarlos: solo se
// borran cuando la app avisa que los ingresó. Si el usuario está en otra
// pantalla —o abrió otro contribuyente— el listado tiene que seguir esperando,
// o el mes se perdería por haber vuelto a la pestaña en el momento equivocado.
const entregarComprobantes = () => {
  chrome.storage.local.get('comprobantes', ({ comprobantes }) => {
    if (!comprobantes || !comprobantes.bulto) return;
    const horas = (Date.now() - (comprobantes.cuando || 0)) / 3600000;
    if (horas > VIGENCIA_CONSTANCIA_HORAS) {
      chrome.storage.local.remove('comprobantes');
      return;
    }
    window.postMessage({ tipo: MARCA_COMPROBANTES_APP, bulto: comprobantes.bulto }, '*');
  });
};

// La app confirma cuando ya los ingresó: recién ahí se sueltan. Y cuando abre
// la pantalla de devoluciones los pide, porque navegar dentro de la app no
// dispara ningún `focus` y el listado se quedaría esperando sin que nadie lo
// reclame.
window.addEventListener('message', (ev) => {
  if (ev.source !== window) return;
  const tipo = ev.data && ev.data.tipo;
  if (tipo === MARCA_COMPROBANTES_OK) chrome.storage.local.remove('comprobantes');
  else if (tipo === MARCA_COMPROBANTES_PEDIDO) setTimeout(entregarComprobantes, 200);
});

// La app tarda en montar la pantalla y en enganchar su escucha; entregar en el
// acto sería hablarle a nadie.
const entregar = () => { entregarConstancia(); entregarComprobantes(); };
setTimeout(entregar, 1500);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) setTimeout(entregar, 400);
});
window.addEventListener('focus', () => setTimeout(entregar, 400));
