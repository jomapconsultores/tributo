// La llave que hace que un marcador funcione, incrustada al generarlo.
//
// Los bajadores son código que corre en el navegador de quien los tiene: se
// pueden copiar, y ningún candado escrito dentro del JS aguanta a quien sepa
// editarlo. Lo que sí se puede es que no sirvan SIN PERMISO VIVO: el marcador,
// antes de tocar el portal del SRI, le pregunta al sistema si su llave sigue
// habilitada y si esta es la máquina donde se activó.
//
// La llave es de la PERSONA que lo baja, con su sesión abierta. Quien no esté
// autorizado no obtiene ninguna: el panel se lo dice y no le entrega el script.
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

// Los tres marcadores traen dos huecos que se rellenan acá, en el momento de
// generarlos: a dónde preguntar y con qué llave.
export const conPermiso = (raw, llave) =>
  String(raw || '').trim()
    .replace('JOMAP_API', API_URL)
    .replace('JOMAP_LLAVE', llave || '')
    // El enviador de devoluciones necesita además saber dónde vive la app, para
    // poder entregarle el listado de comprobantes que trae del portal.
    .replace('JOMAP_APP_ORIGEN', window.location.origin)

// A dónde pregunta el marcador por su permiso. La extensión también lo necesita:
// su enviador es un archivo igual para todos y no lleva nada incrustado.
export const API_BAJADORES = API_URL

// La app le pasa la llave a la extensión (si esta persona está autorizada). Sin
// esto, el enviador que inyecta la extensión no tendría con qué pedir permiso.
export const publicarLlave = (llave) => {
  if (!llave) return
  try {
    window.postMessage(
      { tipo: 'jomap-bajadores-llave', llave, api: API_URL }, window.location.origin)
  } catch { /* nadie escuchando: sin extensión, el marcador la trae incrustada */ }
}

export const sinPrefijo = (href) => String(href || '').replace(/^javascript:/, '')
