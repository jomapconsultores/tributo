import { Component } from 'react'

/**
 * Evita la pantalla en blanco.
 *
 * Cada pantalla viaja en su propio archivo y se descarga cuando se entra a ella.
 * Al desplegar una versión nueva, esos archivos cambian de nombre: una pestaña
 * que quedó abierta con la versión anterior pide un archivo que ya no existe, la
 * carga falla y React desmonta todo. El resultado es una página en blanco, sin
 * ningún mensaje, justo en la pantalla que se abre después de un despliegue.
 *
 * Cuando el error es ese, la salida correcta es recargar: la recarga trae el
 * índice nuevo con los nombres nuevos. Se recarga UNA sola vez —con una marca en
 * sessionStorage— porque si el problema fuera otro, recargar en bucle dejaría la
 * aplicación inutilizable en vez de mostrar el error.
 *
 * Cualquier otro error se muestra en pantalla, con su detalle: en blanco no se
 * puede reportar nada.
 */
const ES_CHUNK = /dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk|error loading dynamically imported module/i

export default class ErrorPantalla extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    const mensaje = String(error?.message || error)
    if (!ES_CHUNK.test(mensaje)) return
    if (sessionStorage.getItem('recargaPorVersion')) return   // ya se intentó
    sessionStorage.setItem('recargaPorVersion', '1')
    window.location.reload()
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    const mensaje = String(error?.message || error)
    if (ES_CHUNK.test(mensaje)) {
      return <div className="loading">Actualizando a la versión nueva…</div>
    }
    return (
      <div style={{ padding: 24, maxWidth: 720, margin: '0 auto', lineHeight: 1.6 }}>
        <h2 style={{ color: '#b91c1c' }}>Se rompió esta pantalla</h2>
        <p>El resto del sistema sigue funcionando: probá volver al menú o recargar.</p>
        <pre style={{
          background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8,
          padding: 12, fontSize: 12, whiteSpace: 'pre-wrap', overflowX: 'auto',
        }}>{mensaje}</pre>
        <button onClick={() => window.location.reload()}
          style={{
            padding: '8px 16px', borderRadius: 6, border: '1px solid #0e7c4a',
            background: '#0e7c4a', color: '#fff', fontWeight: 600, cursor: 'pointer',
          }}>Recargar</button>
      </div>
    )
  }
}
