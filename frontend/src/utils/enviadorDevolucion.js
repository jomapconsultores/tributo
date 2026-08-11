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

export const ENVIADOR_DEVOLUCION_HREF = raw.trim()

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

// El href "javascript:" se fija con un callback ref que se reaplica en CADA
// render (React sanitiza/restaura un href puesto en el JSX).
export const setEnviadorDevolucionHref = (el) => {
  if (el) el.setAttribute('href', ENVIADOR_DEVOLUCION_HREF)
}

export const SRI_DEVOLUCION_URL =
  'https://srienlinea.sri.gob.ec/sri-en-linea/inicio/NAT'
