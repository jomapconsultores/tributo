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
