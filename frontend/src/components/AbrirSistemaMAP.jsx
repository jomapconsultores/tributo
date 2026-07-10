// Botón de enlace cruzado hacia el Sistema MAP (contabilidad), con login único:
// hace un POST a {MAP}/auth/sso enviando el token de sesión actual (en el cuerpo,
// no en la URL) para que MAP valide contra tributos-web y abra sesión sin re-login.
// Se oculta si VITE_MAP_URL no está configurada.
const MAP_URL = import.meta.env.VITE_MAP_URL

export default function AbrirSistemaMAP() {
  if (!MAP_URL) return null

  const abrir = () => {
    const token = localStorage.getItem('token')
    if (!token) return
    const form = document.createElement('form')
    form.method = 'POST'
    form.action = `${String(MAP_URL).replace(/\/$/, '')}/auth/sso`
    form.target = '_blank'
    const add = (name, value) => {
      const i = document.createElement('input')
      i.type = 'hidden'; i.name = name; i.value = value
      form.appendChild(i)
    }
    add('token', token)
    add('next', '/dashboard')
    document.body.appendChild(form)
    form.submit()
    document.body.removeChild(form)
  }

  return (
    <button type="button" className="map-link-btn" onClick={abrir}
            title="Abrir el Sistema MAP (contabilidad) con tu misma sesión">
      🔗 Sistema MAP
    </button>
  )
}
