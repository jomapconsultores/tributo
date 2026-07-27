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
// El .txt de acá se GENERA desde esa fuente: node scripts/build_bookmarklets.mjs
import raw from './bajador-emitidos.bookmarklet.txt?raw'

export const BAJADOR_EMITIDOS_HREF = raw.trim()

// El mismo script SIN el prefijo "javascript:", para PEGARLO en la consola del
// SRI (Chrome borra ese prefijo al pegar en la barra de direcciones).
export const BAJADOR_EMITIDOS_CODIGO = BAJADOR_EMITIDOS_HREF.replace(/^javascript:/, '')

export const AVISO_BAJADOR_EMITIDOS =
  '📥 Bajador-INGRESOS (facturas EMITIDAS del SRI)\n\n' +
  'INSTALAR (una sola vez): ARRÁSTRA este botón a la barra de marcadores (favoritos).\n\n' +
  'CÓMO SE USA:\n' +
  '1. Entrá al SRI → Facturación Electrónica → Comprobantes electrónicos EMITIDOS\n' +
  '   (hasta ver el formulario con Fecha emisión y Consultar).\n' +
  '2. Tocá el marcador: se abre un panel con BOTONES.\n' +
  '   Elegís el año (< 2026 >), dejás marcada la casilla "bajar también el archivo\n' +
  '   de cada factura" y después "Por MES" (Ene…Dic) o "Por SEMESTRE".\n' +
  '3. Recorre el período día por día mostrando el avance, y baja DOS cosas:\n' +
  '   • el archivo de cada factura: el XML, y si esa fila no lo ofrece, el PDF\n' +
  '     (RIDE) — lo que el portal tenga a mano. Van a tu carpeta de Descargas;\n' +
  '   • un TXT con todas las claves de acceso.\n' +
  '4. Los XML y PDF arrastralos a Ingresos IVA (acepta los dos: el PDF se lee\n' +
  '   automáticamente y podés corregir cualquier valor con ✎).\n' +
  '   El TXT subilo en Ingresos IVA → "Subir reporte (TXT)": sirve para completar\n' +
  '   las que no hayan bajado (el sistema las trae del SRI por la clave).\n\n' +
  'Si Chrome pregunta si permitir "descargar varios archivos", dale PERMITIR.\n' +
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
