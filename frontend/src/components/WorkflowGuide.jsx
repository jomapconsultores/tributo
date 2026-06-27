import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import './WorkflowGuide.css'

// Claves de sesión: posición, abierto/cerrado y oculto. sessionStorage = se
// conserva mientras dure la sesión (pestaña) y se limpia al cerrarla.
const POS_KEY = 'wg:pos'
const OPEN_KEY = 'wg:open'
const HIDDEN_KEY = 'wg:hidden'

const readJSON = (k) => { try { return JSON.parse(sessionStorage.getItem(k)) } catch { return null } }

export default function WorkflowGuide({ steps }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(() => sessionStorage.getItem(OPEN_KEY) === '1')
  const [hidden, setHidden] = useState(() => sessionStorage.getItem(HIDDEN_KEY) === '1')
  const [pos, setPos] = useState(() => {
    const p = readJSON(POS_KEY)
    return (p && typeof p.x === 'number' && typeof p.y === 'number') ? p : null
  })
  const panelRef = useRef(null)
  const drag = useRef(null)

  useEffect(() => { sessionStorage.setItem(OPEN_KEY, open ? '1' : '0') }, [open])
  useEffect(() => { sessionStorage.setItem(HIDDEN_KEY, hidden ? '1' : '0') }, [hidden])
  useEffect(() => { if (pos) sessionStorage.setItem(POS_KEY, JSON.stringify(pos)) }, [pos])

  // Mantener el panel dentro de la pantalla si cambia el tamaño de la ventana
  useEffect(() => {
    if (!pos) return
    const onResize = () => {
      const el = panelRef.current; if (!el) return
      const w = el.offsetWidth, h = el.offsetHeight
      setPos((p) => p && ({
        x: Math.max(4, Math.min(p.x, window.innerWidth - w - 4)),
        y: Math.max(4, Math.min(p.y, window.innerHeight - h - 4)),
      }))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [pos])

  const onMove = useCallback((e) => {
    if (!drag.current) return
    const el = panelRef.current
    const w = el?.offsetWidth || 180
    const h = el?.offsetHeight || 32
    const x = Math.max(4, Math.min(e.clientX - drag.current.dx, window.innerWidth - w - 4))
    const y = Math.max(4, Math.min(e.clientY - drag.current.dy, window.innerHeight - h - 4))
    setPos({ x, y })
  }, [])

  const endDrag = useCallback(() => {
    drag.current = null
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', endDrag)
  }, [onMove])

  const startDrag = (e) => {
    const el = panelRef.current; if (!el) return
    const rect = el.getBoundingClientRect()
    drag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', endDrag)
    e.preventDefault()
  }

  // Oculto para esta sesión: queda un botón mínimo para volver a mostrarlo
  if (hidden) {
    return (
      <button className="wg-reopen" title="Mostrar flujo de trabajo" onClick={() => setHidden(false)}>📋</button>
    )
  }

  const style = pos ? { top: pos.y, left: pos.x, right: 'auto', bottom: 'auto' } : undefined

  return (
    <div className={`wg-panel${open ? ' wg-open' : ''}`} ref={panelRef} style={style}>
      <div className="wg-bar">
        <span className="wg-grip" onPointerDown={startDrag} title="Arrastrar">⠿</span>
        <button className="wg-title" onClick={() => setOpen((v) => !v)} title={open ? 'Contraer' : 'Ver pasos'}>
          <span className="wg-title-ico">📋</span>
          <span className="wg-title-txt">Flujo de trabajo</span>
          <span className="wg-caret">{open ? '▾' : '▸'}</span>
        </button>
        <button className="wg-close" onClick={() => setHidden(true)} title="Ocultar (solo esta sesión)">✕</button>
      </div>
      {open && (
        <ol className="wg-list">
          {steps.map((s, i) => (
            <li
              key={i}
              className={`wg-step${s.current ? ' wg-current' : ''}${s.path && !s.current ? ' wg-link' : ''}`}
              onClick={s.path && !s.current ? () => navigate(s.path) : undefined}
            >
              <span className="wg-num">{i + 1}</span>
              <span className="wg-ico">{s.icon}</span>
              <span className="wg-label">{s.label}</span>
              {s.path && !s.current && <span className="wg-arrow">→</span>}
              {s.current && <span className="wg-here">● aquí</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
