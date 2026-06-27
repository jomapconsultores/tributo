import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import './WorkflowGuide.css'

export default function WorkflowGuide({ steps }) {
  const navigate = useNavigate()
  // Arranca contraído; se expande al hacer clic en la cabecera.
  const [open, setOpen] = useState(false)

  return (
    <div className="wg-panel">
      <button className="wg-header" onClick={() => setOpen((v) => !v)}>
        <span>📋 Flujo de trabajo</span>
        <span className="wg-caret">{open ? '▾' : '▸'}</span>
      </button>
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
