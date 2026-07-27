// Enviador de la solicitud de DEVOLUCIÓN DE IVA (adultos mayores / discapacidad)
// al portal del SRI — bookmarklet.
//
// El portal fuerza login (SSO tuportal) en cada navegación, así que el envío no se
// puede hacer desde el servidor: ocurre en la sesión del contribuyente. La app
// copia el paquete de la solicitud al portapapeles y este marcador, ya dentro del
// portal, lo carga y guía el ingreso (claves de acceso, tipo de gasto, montos por
// mes, TXT/CSV para el anexo).
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
  '   claves de acceso, tipo de gasto y montos por mes) queda copiado.\n' +
  '2. Entrá al SRI → Devoluciones → Devolución de IVA, hasta la pantalla de la\n' +
  '   solicitud del período.\n' +
  '3. Tocá el marcador: se abre un panel con la solicitud cargada. Desde ahí\n' +
  '   copiás la clave de cada comprobante (o todas juntas), bajás el TXT/CSV si el\n' +
  '   portal pide el detalle en archivo, y vas marcando lo ya ingresado (el avance\n' +
  '   se guarda aunque cierres el panel).\n' +
  '4. Cuando el SRI confirme el envío, volvé a la app y marcá la solicitud como\n' +
  '   PRESENTADA.'

// El href "javascript:" se fija con un callback ref que se reaplica en CADA
// render (React sanitiza/restaura un href puesto en el JSX).
export const setEnviadorDevolucionHref = (el) => {
  if (el) el.setAttribute('href', ENVIADOR_DEVOLUCION_HREF)
}

export const SRI_DEVOLUCION_URL =
  'https://srienlinea.sri.gob.ec/sri-en-linea/inicio/NAT'
