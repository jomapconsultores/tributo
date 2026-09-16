// ------------------------------------------------------------
// Desarrollado por Marco Antonio Posligua San Martín
// ------------------------------------------------------------
//
// «Cargar en el SRI»: lleva al portal una declaración o un anexo ya armado.
//
// El servidor no puede entrar al portal —la sesión es del contribuyente, en este
// navegador—, así que el trámite lo hace la extensión de Chrome (extension/):
// la app le publica la carga, abre el formulario del SRI y la extensión lo llena
// allá. Lo deja LLENO, no presentado: eso lo hace una persona después de mirar.
//
// Sin la extensión se descarga el mismo archivo que ella usaría, para subirlo a
// mano con la carga por archivo del propio portal.

// Versión de la extensión si está instalada y ya sabe cargar (1.1.0 en adelante).
export const extensionCargaSri = () => document.documentElement.dataset.jomapCargaSri || null

const TITULO_ANEXO = {
  ICE: 'Anexo%20a%20los%20Consumos%20Especiales%20',
  PVP: 'Anexo%20Reporte%20de%20Precios%20de%20Venta%20',
}

// La recepción de anexos del SRI, en la sección del anexo. Con los parámetros
// MPT, como las demás aplicaciones del portal: así resuelve sola si la sesión
// está viva.
export const urlAnexoSri = (tipo) =>
  'https://srienlinea.sri.gob.ec/rig/pages/menuInicial.xhtml?codOperativo=' + tipo +
  '&contextoMPT=https://srienlinea.sri.gob.ec/tuportal-internet&pathMPT=&actualMPT=' + TITULO_ANEXO[tipo] +
  '&linkMPT=%2Frig%2Fpages%2FmenuInicial.xhtml%3FcodOperativo%3D' + tipo + '&esFavorito=S'

function descargar(carga) {
  const blob = carga.clase === 'anexo'
    ? new Blob([Uint8Array.from(atob(carga.archivo.base64), (ch) => ch.charCodeAt(0))], { type: 'application/zip' })
    : new Blob([JSON.stringify(carga.archivo.contenido)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = carga.archivo.nombre
  document.body.appendChild(a); a.click(); document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// Espera el acuse de la extensión: si no pudo guardar la carga (un ZIP que no
// entra en su almacenamiento), abrir el portal sin más dejaría a la persona
// mirando un formulario vacío.
function publicar(carga) {
  return new Promise((resolve) => {
    const fin = (r) => { window.removeEventListener('message', oir); clearTimeout(t); resolve(r) }
    const oir = (ev) => {
      if (ev.source !== window || !ev.data || ev.data.tipo !== 'jomap-sri-carga-recibida') return
      fin({ ok: !!ev.data.ok, error: ev.data.error || '' })
    }
    const t = setTimeout(() => fin({ ok: false, error: 'la extensión no respondió' }), 2000)
    window.addEventListener('message', oir)
    window.postMessage({ tipo: 'jomap-sri-carga', carga }, window.location.origin)
  })
}

// Devuelve cómo se hizo: 'extension' (el portal se llena solo) o 'descarga'
// (quedó el archivo para subirlo a mano), con el motivo si no hubo extensión.
export async function cargarEnSri(carga) {
  if (extensionCargaSri()) {
    const r = await publicar(carga)
    if (r.ok) {
      window.open(carga.url, '_blank', 'noopener')
      return { modo: 'extension' }
    }
    descargar(carga)
    window.open(carga.url, '_blank', 'noopener')
    return { modo: 'descarga', motivo: r.error }
  }
  descargar(carga)
  window.open(carga.url, '_blank', 'noopener')
  return { modo: 'descarga', motivo: 'la extensión «Enviador SRI» no está instalada' }
}
