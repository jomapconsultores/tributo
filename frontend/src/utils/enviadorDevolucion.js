// Enviador de la solicitud de DEVOLUCIÓN DE IVA (adultos mayores / discapacidad)
// al portal del SRI — bookmarklet.
//
// El portal fuerza login (SSO tuportal) en cada navegación, así que el envío no se
// puede hacer desde el servidor: ocurre en la sesión del contribuyente. La app
// copia el paquete de la solicitud al portapapeles y este marcador, ya dentro del
// portal, hace el trámite: consulta el período, marca los comprobantes de la
// solicitud, les pone el tipo de gasto, ajusta los montos contra el tope, guarda
// la selección y presenta la solicitud (el envío final, detrás de confirmación).
//
// Fuente legible/comentada: sri_downloader/bookmarklet_devolucion.js
// El .txt de acá se GENERA desde esa fuente: node scripts/build_bookmarklets.mjs
import raw from './enviador-devolucion.bookmarklet.txt?raw'

// De dónde salió el marcador es de dónde vive el sistema: el enviador necesita
// saberlo para ENTREGARLE el listado del portal —abre esta app en una pestaña y
// se lo pasa—, y así el usuario no tiene que copiar y pegar nada. Se incrusta al
// generar el href, que es el único momento en que se conoce el origen (local o
// producción, según desde dónde se instale el marcador).
export const ENVIADOR_DEVOLUCION_HREF =
  raw.trim().replace('JOMAP_APP_ORIGEN', window.location.origin)

// El mismo script SIN el prefijo "javascript:", para PEGARLO en la consola del
// SRI (Chrome borra ese prefijo al pegar en la barra de direcciones).
export const ENVIADOR_DEVOLUCION_CODIGO = ENVIADOR_DEVOLUCION_HREF.replace(/^javascript:/, '')

export const AVISO_ENVIADOR_DEVOLUCION =
  '📤 Enviador-DEVOLUCIÓN (solicitud de devolución de IVA en el SRI)\n\n' +
  'INSTALAR (una sola vez): ARRASTRÁ este botón a la barra de marcadores (favoritos).\n\n' +
  'CÓMO SE USA:\n' +
  '1. Guardá la solicitud acá y tocá "📤 Enviar al SRI": el paquete (comprobantes,\n' +
  '   series, tipo de gasto y montos por mes) queda copiado.\n' +
  '2. Entrá al SRI → Devoluciones → Devolución de IVA → "Ingresar facturas\n' +
  '   electrónicas", hasta ver los combos Año y Período con el botón Buscar.\n' +
  '3. Tocá el marcador y después "Llenar y presentar en el portal": consulta el\n' +
  '   período, marca cada comprobante de la solicitud, le pone el tipo de gasto,\n' +
  '   ajusta el IVA solicitado contra el tope del mes y guarda la selección.\n' +
  '4. El envío definitivo queda para el final, con un botón aparte: el portal\n' +
  '   advierte el art. 298 del COIP y una vez cargado no se deshace.\n' +
  '5. Al terminar, "Copiar constancia para la app" y pegala acá con "Pegar\n' +
  '   constancia del enviador": ahí queda PRESENTADA con lo que aceptó el SRI.'


export const SRI_DEVOLUCION_URL =
  'https://srienlinea.sri.gob.ec/sri-en-linea/inicio/NAT'

// La aplicación de devolución tiene dos entradas —adultos mayores y personas
// con discapacidad— bajo el mismo contexto. Abrir la portada del SRI dejaba al
// usuario navegando el menú a mano hasta la sección, y entrando a la que no era
// el enviador no tiene nada que hacer.
//
// Se abre con los parámetros MPT completos a propósito: la URL "pelada" rebota a
// Keycloak, y con estos el SSO del cliente de devolución resuelve solo si la
// sesión del portal está viva (ver `sri_downloader/core/devoluciones.py`). Esto
// vale para una pestaña NUEVA; recargar una que ya está adentro sigue siendo lo
// que tira la sesión.
const BASE_MPT = 'https://srienlinea.sri.gob.ec/devolucionTerceraEdad-internet/pages/'
const CONTEXTO_MPT = '?&contextoMPT=https://srienlinea.sri.gob.ec/tuportal-internet' +
  '&pathMPT=Devoluciones%20(TAX%20refund)'

const SECCIONES = {
  tercera_edad: {
    ruta: 'terceraEdad/procesarDTE.jsf',
    titulo: 'Devoluci%F3n%20de%20IVA%20-%20Adultos%20mayores%20',
  },
  discapacidad: {
    ruta: 'personasDiscapacidad/procesarPersonasDiscapacidad.jsf',
    titulo: 'Devoluci%F3n%20de%20IVA%20-%20Personas%20con%20discapacidad%20',
  },
}

// La URL del portal para el beneficiario de la solicitud. Sin beneficiario
// conocido se abre la portada, que es de donde se puede llegar a mano a las dos.
export const urlDevolucion = (beneficiario) => {
  const s = SECCIONES[beneficiario]
  if (!s) return SRI_DEVOLUCION_URL
  return BASE_MPT + s.ruta + CONTEXTO_MPT +
    '&actualMPT=' + s.titulo +
    '&linkMPT=%2FdevolucionTerceraEdad-internet%2Fpages%2F' +
    encodeURIComponent(s.ruta) + '%3F' +
    '&esFavorito=S'
}
