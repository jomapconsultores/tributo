import { useState, useRef, useEffect } from 'react'
import { useAccess } from '../context/AccessContext'
import './RoleSwitcher.css'

const ROL_LBL = { admin: '👑 Administrador', socio: '🤝 Socio', trabajador: '👷 Funcionario', cliente: '👤 Cliente' }

// Selector de rol (arriba a la derecha). Solo aparece como MENÚ si el usuario
// tiene más de un rol otorgado por el administrador; con un solo rol muestra
// una etiqueta estática con su rol.
export default function RoleSwitcher() {
  const { roles, role, platformRole, switchRole, loading } = useAccess()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    const fn = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', fn)
    return () => document.removeEventListener('mousedown', fn)
  }, [])

  if (loading) return null

  // El selector cambia el rol de PLATAFORMA, no el de la empresa activa. Se
  // muestra ése: dentro de un despacho se puede ser 'admin' por membresía sin
  // serlo del producto, y pintar el efectivo hacía creer que ya se tenía el
  // rol que el menú ofrece —con el clic sin efecto y el panel de empresas
  // fuera de alcance—. Sin el campo (backend anterior) se cae al efectivo.
  const activo = platformRole || role
  const difiere = platformRole && platformRole !== role

  const varios = Array.isArray(roles) && roles.length > 1
  if (!varios) {
    return <span className="role-badge" title="Tu rol en el sistema">{ROL_LBL[activo] || activo}</span>
  }

  const elegir = async (r) => {
    setOpen(false)
    if (r === activo) return
    setBusy(true)
    try {
      // switchRole recarga la app al terminar; si falla, liberamos el botón.
      await switchRole(r)
    } catch (e) {
      alert('No se pudo cambiar de rol: ' + (e.response?.data?.detail || e.message))
      setBusy(false)
    }
  }

  return (
    <div className="role-switcher" ref={ref}>
      <button
        className="role-switcher-btn" onClick={() => setOpen((o) => !o)} disabled={busy}
        title={difiere
          ? `Tu rol en el sistema: ${ROL_LBL[activo] || activo}. En la empresa activa actúas como ${ROL_LBL[role] || role}.`
          : 'Cambiar de rol'}
      >
        <span>{ROL_LBL[activo] || activo}</span>
        <span className="role-caret">{busy ? '…' : '▾'}</span>
      </button>
      {open && (
        <div className="role-switcher-menu">
          <div className="role-switcher-title">Ver como…</div>
          {difiere && (
            <div className="role-switcher-nota">
              En la empresa activa actúas como {ROL_LBL[role] || role}.
            </div>
          )}
          {roles.map((r) => (
            <button
              key={r}
              className={`role-switcher-item ${r === activo ? 'active' : ''}`}
              onClick={() => elegir(r)}
            >
              <span>{ROL_LBL[r] || r}</span>
              {r === activo && <span className="role-check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
