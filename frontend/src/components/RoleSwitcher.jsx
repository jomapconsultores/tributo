import { useState, useRef, useEffect } from 'react'
import { useAccess } from '../context/AccessContext'
import './RoleSwitcher.css'

const ROL_LBL = { admin: '👑 Administrador', socio: '🤝 Socio', trabajador: '👷 Funcionario', cliente: '👤 Cliente' }

// Selector de rol (arriba a la derecha). Solo aparece como MENÚ si el usuario
// tiene más de un rol otorgado por el administrador; con un solo rol muestra
// una etiqueta estática con su rol.
export default function RoleSwitcher() {
  const { roles, role, switchRole, loading } = useAccess()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    const fn = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', fn)
    return () => document.removeEventListener('mousedown', fn)
  }, [])

  if (loading) return null

  const varios = Array.isArray(roles) && roles.length > 1
  if (!varios) {
    return <span className="role-badge" title="Tu rol en el sistema">{ROL_LBL[role] || role}</span>
  }

  const elegir = async (r) => {
    setOpen(false)
    if (r === role) return
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
      <button className="role-switcher-btn" onClick={() => setOpen((o) => !o)} disabled={busy} title="Cambiar de rol">
        <span>{ROL_LBL[role] || role}</span>
        <span className="role-caret">{busy ? '…' : '▾'}</span>
      </button>
      {open && (
        <div className="role-switcher-menu">
          <div className="role-switcher-title">Ver como…</div>
          {roles.map((r) => (
            <button
              key={r}
              className={`role-switcher-item ${r === role ? 'active' : ''}`}
              onClick={() => elegir(r)}
            >
              <span>{ROL_LBL[r] || r}</span>
              {r === role && <span className="role-check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
