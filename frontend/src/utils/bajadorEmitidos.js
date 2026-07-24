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
import raw from './bajador-emitidos.bookmarklet.txt?raw'

export const BAJADOR_EMITIDOS_HREF = raw.trim()

export const AVISO_BAJADOR_EMITIDOS =
  '📅 Bajar facturas EMITIDAS por FECHA\n\n' +
  'INSTALAR (una sola vez): ARRÁSTRA este botón a la barra de marcadores (favoritos).\n\n' +
  'CÓMO SE USA:\n' +
  '1. Entrá al SRI → Facturación Electrónica → Comprobantes electrónicos EMITIDOS.\n' +
  '2. Tocá el marcador: te PREGUNTA qué fecha querés bajar\n' +
  '   (M = un mes, S1 = ene-jun, S2 = jul-dic, y el año).\n' +
  '3. Recorre el período día por día y descarga un TXT con las claves de acceso.\n' +
  '4. Ese TXT subilo en Ingresos IVA → "Subir reporte (TXT)": el sistema baja\n' +
  '   los XML del SRI y carga las facturas solo.\n\n' +
  'Solo trae fechas ANTERIORES a hoy (el SRI no admite el día en curso).'

// El href "javascript:" se fija con un callback ref que se reaplica en CADA
// render (React sanitiza/restaura un href puesto en el JSX).
export const setBajadorEmitidosHref = (el) => {
  if (el) el.setAttribute('href', BAJADOR_EMITIDOS_HREF)
}

export const SRI_EMITIDOS_URL =
  'https://srienlinea.sri.gob.ec/tu-portal-internet/accederAplicacion.jspa?redireccion=SI&idGrupo=55&idServicio=328'
