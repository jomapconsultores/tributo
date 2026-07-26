// Bajador de comprobantes RECIBIDOS (gastos y retenciones) por período — bookmarklet.
//
// El portal del SRI fuerza el login (SSO tuportal) en cada navegación nueva, así
// que NO se puede automatizar desde el servidor. Pero una vez DENTRO del formulario
// de "Comprobantes electrónicos recibidos", Consultar es un ajax de PrimeFaces que
// no recarga la página: un bookmarklet recorre los meses sin romperse. Por eso el
// "botón" de la app es un marcador que el usuario instala una vez y ejecuta en su
// propia sesión del SRI.
//
// Fuente legible/comentada: sri_downloader/bookmarklet_recibidos.js
// El .txt de acá se GENERA desde esa fuente: node scripts/build_bookmarklets.mjs
import raw from './bajador-gastos.bookmarklet.txt?raw'

export const BAJADOR_GASTOS_HREF = raw.trim()

export const AVISO_BAJADOR_GASTOS =
  '📥 Bajador-GASTOS (comprobantes RECIBIDOS del SRI)\n\n' +
  'INSTALAR (una sola vez): ARRÁSTRA este botón a la barra de marcadores (favoritos).\n\n' +
  'CÓMO SE USA:\n' +
  '1. Entrá al SRI → Facturación Electrónica → Comprobantes electrónicos RECIBIDOS\n' +
  '   (hasta ver el formulario con Año / Mes / Tipo de comprobante y Consultar).\n' +
  '2. Tocá el marcador: se abre un panel con BOTONES que te va preguntando:\n' +
  '   • el año (< 2026 >) y si querés bajar también el archivo de cada comprobante;\n' +
  '   • qué bajar: GASTOS (facturas de compra), RETENCIONES o AMBOS;\n' +
  '   • el período: por MES (Ene…Dic) o por SEMESTRE (1ro Ene-Jun / 2do Jul-Dic).\n' +
  '3. Recorre el período MES por MES mostrando el avance y baja:\n' +
  '   • un TXT de claves POR TIPO: gastos_….txt y retenciones_….txt;\n' +
  '   • si dejaste la casilla marcada, el XML de cada comprobante (o el PDF/RIDE\n' +
  '     cuando esa fila no ofrece XML), en tu carpeta de Descargas.\n' +
  '4. Subí cada TXT en SU módulo → "Subir reporte (TXT)": gastos_… en Gastos y\n' +
  '   retenciones_… en Retenciones. El sistema baja los XML del SRI con esas claves.\n\n' +
  'Si Chrome pregunta si permitir "descargar varios archivos", dale PERMITIR.\n' +
  'Podés seguir trabajando en otras pestañas mientras corre — pero NO cierres la\n' +
  'del SRI.'

// El href "javascript:" se fija con un callback ref que se reaplica en CADA
// render (React sanitiza/restaura un href puesto en el JSX).
export const setBajadorGastosHref = (el) => {
  if (el) el.setAttribute('href', BAJADOR_GASTOS_HREF)
}

export const SRI_RECIBIDOS_URL =
  'https://srienlinea.sri.gob.ec/comprobantes-electronicos-internet/pages/consultas/recibidos/comprobantesRecibidos.jsf'
