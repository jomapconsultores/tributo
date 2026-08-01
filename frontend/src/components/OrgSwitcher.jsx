import { useState, useRef, useEffect } from 'react'
import { useAccess } from '../context/AccessContext'
import './OrgSwitcher.css'

const ROL_LBL = { admin: 'Administrador', socio: 'Socio', trabajador: 'Funcionario', cliente: 'Cliente' }

// Selector de EMPRESA (arriba a la derecha, junto al de rol). Solo aparece como
// menú si el usuario pertenece a más de una; con una sola muestra una etiqueta
// estática, y si el sistema todavía no tiene empresas creadas no muestra nada.
//
// Cambiar de empresa recarga la app entera (switchOrg): el rol, los módulos y la
// cartera de contribuyentes son distintos en cada una.
export default function OrgSwitcher() {
  const { orgs, org, switchOrg, loading, multiempresa } = useAccess()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    const fn = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', fn)
    return () => document.removeEventListener('mousedown', fn)
  }, [])

  if (loading || !multiempresa) return null
  const lista = orgs || []
  if (lista.length === 0) return null

  const nombreActual = org?.nombre || lista[0]?.nombre || 'Empresa'

  if (lista.length === 1) {
    return (
      <span className="org-badge" title={`Empresa: ${nombreActual}`}>
        🏢 {nombreActual}
      </span>
    )
  }

  const elegir = (id) => {
    setOpen(false)
    if (id === org?.org_id) return
    setBusy(true)
    try {
      switchOrg(id)   // recarga la app; si algo falla, se libera el botón
    } catch (e) {
      alert('No se pudo cambiar de empresa: ' + (e.response?.data?.detail || e.message))
      setBusy(false)
    }
  }

  return (
    <div className="org-switcher" ref={ref}>
      <button
        className="org-switcher-btn"
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        title="Cambiar de empresa"
      >
        <span className="org-switcher-nombre">🏢 {nombreActual}</span>
        <span className="org-caret">{busy ? '…' : '▾'}</span>
      </button>
      {open && (
        <div className="org-switcher-menu">
          <div className="org-switcher-title">Trabajar en…</div>
          {lista.map((e) => (
            <button
              key={e.org_id}
              className={`org-switcher-item ${e.org_id === org?.org_id ? 'active' : ''}`}
              onClick={() => elegir(e.org_id)}
            >
              <span className="org-item-texto">
                <span className="org-item-nombre">{e.nombre}</span>
                <span className="org-item-rol">{ROL_LBL[e.role] || e.role}</span>
              </span>
              {e.org_id === org?.org_id && <span className="org-check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
