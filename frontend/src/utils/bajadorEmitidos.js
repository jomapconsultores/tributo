// Bajador de comprobantes EMITIDOS por fecha (bookmarklet).
//
// El portal del SRI fuerza el login (SSO tuportal) en cada navegación nueva, así
// que NO se puede automatizar desde el servidor. Pero una vez DENTRO del formulario
// de "Comprobantes electrónicos emitidos", el botón Consultar es un ajax de
// PrimeFaces que no recarga la página: un bookmarklet recorre las fechas sin
// romperse. Por eso el "botón" de la app es un marcador que el usuario instala
// una vez y ejecuta en su propia sesión del SRI.
//
// Fuente legible/comentada: sri_downloader/bookmarklet_emitidos.js
// El .txt de acá se GENERA desde esa fuente: node scripts/build_bookmarklet_emitidos.mjs
import raw from './bajador-emitidos.bookmarklet.txt?raw'

export const BAJADOR_EMITIDOS_HREF = raw.trim()

export const AVISO_BAJADOR_EMITIDOS =
  '📅 Bajar facturas EMITIDAS por FECHA\n\n' +
  'INSTALAR (una sola vez): ARRÁSTRA este botón a la barra de marcadores (favoritos).\n\n' +
  'CÓMO SE USA:\n' +
  '1. Entrá al SRI → Facturación Electrónica → Comprobantes electrónicos EMITIDOS\n' +
  '   (hasta ver el formulario con Fecha emisión y Consultar).\n' +
  '2. Tocá el marcador: se abre un panel con BOTONES.\n' +
  '   Elegís el año (< 2026 >) y después "Por MES" (Ene…Dic) o "Por SEMESTRE"\n' +
  '   (1ro Ene-Jun / 2do Jul-Dic).\n' +
  '3. Recorre el período día por día mostrando el avance y descarga un TXT\n' +
  '   con las claves de acceso. Un mes tarda menos de 2 minutos.\n' +
  '4. Ese TXT subilo en Ingresos IVA → "Subir reporte (TXT)": el sistema baja\n' +
  '   los XML del SRI y carga las facturas solo.\n\n' +
  'Podés seguir trabajando en otras pestañas mientras corre — pero NO cierres la\n' +
  'del SRI. Respeta el Tipo de comprobante y el Estado que hayas dejado elegidos.\n' +
  'Solo trae fechas ANTERIORES a hoy (el SRI no admite el día en curso).'

// El href "javascript:" se fija con un callback ref que se reaplica en CADA
// render (React sanitiza/restaura un href puesto en el JSX).
export const setBajadorEmitidosHref = (el) => {
  if (el) el.setAttribute('href', BAJADOR_EMITIDOS_HREF)
}

export const SRI_EMITIDOS_URL =
  'https://srienlinea.sri.gob.ec/tu-portal-internet/accederAplicacion.jspa?redireccion=SI&idGrupo=55&idServicio=328'
