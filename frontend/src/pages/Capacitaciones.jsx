import { useState, useEffect, useCallback } from 'react'
import { capacitacionesAPI } from '../services/api'
import { useAccess } from '../context/AccessContext'
import './Capacitaciones.css'

const IVA = 0.15
const PRECIO_NETO = 50
const money = (n) => Number(n || 0).toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const totalHora = PRECIO_NETO * (1 + IVA)

const ESTADO_LABEL = {
  pendiente: '⏳ Pendiente',
  autorizada: '✅ Autorizada',
  rechazada: '✖ Rechazada',
  realizada: '🎓 Realizada',
}

function Badge({ estado }) {
  return <span className={`cap-badge cap-${estado}`}>{ESTADO_LABEL[estado] || estado}</span>
}

export default function Capacitaciones() {
  const { isAdmin } = useAccess()
  return isAdmin ? <VistaAdmin /> : <VistaCliente />
}

// ───────────────────────────── Cliente: solicita y ve sus reservas ──────────
function VistaCliente() {
  const [form, setForm] = useState({ tema: '', modalidad: 'online', fecha_sugerida: '', hora_sugerida: '', horas: 1, mensaje: '' })
  const [enviando, setEnviando] = useState(false)
  const [ok, setOk] = useState(false)
  const [mias, setMias] = useState([])

  const cargar = useCallback(() => {
    capacitacionesAPI.mias().then((r) => setMias(r.data?.data || [])).catch(() => {})
  }, [])
  useEffect(() => { cargar() }, [cargar])

  const enviar = async (e) => {
    e.preventDefault()
    setEnviando(true); setOk(false)
    try {
      await capacitacionesAPI.crear(form)
      setOk(true)
      setForm({ tema: '', modalidad: 'online', fecha_sugerida: '', hora_sugerida: '', horas: 1, mensaje: '' })
      cargar()
    } catch (err) {
      alert('No se pudo enviar: ' + (err.response?.data?.detail || err.message))
    } finally { setEnviando(false) }
  }

  return (
    <div className="cap-page">
      <header className="cap-head">
        <h1>🎓 Capacitación y acompañamiento</h1>
        <p>Reserva una sesión personalizada. <strong>${money(totalHora)}/hora</strong> (${money(PRECIO_NETO)} + IVA).
          Tu solicitud queda <strong>pendiente</strong> hasta que el socio o administrador la confirme.</p>
      </header>

      {ok && <div className="cap-ok">✅ ¡Solicitud enviada! Te avisaremos por correo cuando se confirme.</div>}

      <form className="cap-form" onSubmit={enviar}>
        <div className="cap-grid">
          <label>Tema / motivo
            <input value={form.tema} onChange={(e) => setForm({ ...form, tema: e.target.value })} placeholder="Ej. Declaración de ICE, uso del sistema…" required />
          </label>
          <label>Modalidad
            <select value={form.modalidad} onChange={(e) => setForm({ ...form, modalidad: e.target.value })}>
              <option value="online">Online</option>
              <option value="presencial">Presencial</option>
            </select>
          </label>
          <label>Fecha sugerida
            <input type="date" value={form.fecha_sugerida} onChange={(e) => setForm({ ...form, fecha_sugerida: e.target.value })} />
          </label>
          <label>Hora sugerida
            <input value={form.hora_sugerida} onChange={(e) => setForm({ ...form, hora_sugerida: e.target.value })} placeholder="Ej. 15:00" />
          </label>
          <label>Horas
            <input type="number" min="1" step="0.5" value={form.horas} onChange={(e) => setForm({ ...form, horas: Number(e.target.value) })} />
          </label>
        </div>
        <label>Mensaje (opcional)
          <textarea rows={3} value={form.mensaje} onChange={(e) => setForm({ ...form, mensaje: e.target.value })} placeholder="Cuéntanos qué necesitas reforzar…" />
        </label>
        <button className="cap-btn primary" type="submit" disabled={enviando}>{enviando ? 'Enviando…' : 'Solicitar reserva'}</button>
      </form>

      <h2 className="cap-subtitle">Mis solicitudes</h2>
      {mias.length === 0 ? (
        <p className="cap-empty">Aún no tienes solicitudes.</p>
      ) : (
        <div className="cap-list">
          {mias.map((c) => (
            <div key={c.id} className="cap-card">
              <div className="cap-card-top">
                <strong>{c.tema || 'Capacitación'}</strong>
                <Badge estado={c.estado} />
              </div>
              <div className="cap-card-meta">
                <span>📅 {c.fecha_agendada ? new Date(c.fecha_agendada).toLocaleString('es-EC') : (c.fecha_sugerida || 'Por coordinar')} {c.hora_sugerida || ''}</span>
                <span>🕒 {c.horas}h · {c.modalidad}</span>
              </div>
              {c.nota_admin && <div className="cap-nota">📝 {c.nota_admin}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ───────────────────────── Socio/Admin: autoriza y agenda ───────────────────
function VistaAdmin() {
  const [items, setItems] = useState([])
  const [filtro, setFiltro] = useState('pendiente')
  const [edit, setEdit] = useState({}) // id -> { fecha_agendada, nota_admin }

  const cargar = useCallback(() => {
    capacitacionesAPI.listar(filtro || undefined).then((r) => setItems(r.data?.data || [])).catch(() => {})
  }, [filtro])
  useEffect(() => { cargar() }, [cargar])

  const setCampo = (id, campo, val) => setEdit((e) => ({ ...e, [id]: { ...e[id], [campo]: val } }))

  const decidir = async (c, estado) => {
    const e = edit[c.id] || {}
    try {
      await capacitacionesAPI.actualizar(c.id, {
        estado,
        fecha_agendada: e.fecha_agendada || null,
        nota_admin: e.nota_admin ?? null,
      })
      cargar()
    } catch (err) {
      alert('No se pudo actualizar: ' + (err.response?.data?.detail || err.message))
    }
  }

  return (
    <div className="cap-page">
      <header className="cap-head">
        <h1>🎓 Capacitaciones — gestión</h1>
        <p>Autoriza, agenda o rechaza las solicitudes de capacitación. <strong>${money(totalHora)}/hora</strong>.</p>
      </header>

      <div className="cap-filtros">
        {['pendiente', 'autorizada', 'realizada', 'rechazada', ''].map((f) => (
          <button key={f || 'todas'} className={`cap-chip ${filtro === f ? 'active' : ''}`} onClick={() => setFiltro(f)}>
            {f ? ESTADO_LABEL[f] : 'Todas'}
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <p className="cap-empty">Sin solicitudes {filtro ? `(${filtro})` : ''}.</p>
      ) : (
        <div className="cap-list">
          {items.map((c) => (
            <div key={c.id} className="cap-card admin">
              <div className="cap-card-top">
                <strong>{c.tema || 'Capacitación'}</strong>
                <Badge estado={c.estado} />
              </div>
              <div className="cap-card-meta">
                <span>👤 {c.solicitante_email || '—'}</span>
                <span>📅 sugerido: {c.fecha_sugerida || '—'} {c.hora_sugerida || ''}</span>
                <span>🕒 {c.horas}h · {c.modalidad}</span>
              </div>
              {c.mensaje && <div className="cap-nota">💬 {c.mensaje}</div>}

              {c.estado === 'pendiente' && (
                <div className="cap-acciones">
                  <label>Agendar para
                    <input type="datetime-local" value={(edit[c.id]?.fecha_agendada) || ''} onChange={(ev) => setCampo(c.id, 'fecha_agendada', ev.target.value)} />
                  </label>
                  <input className="cap-nota-input" placeholder="Nota para el cliente (opcional)" value={(edit[c.id]?.nota_admin) || ''} onChange={(ev) => setCampo(c.id, 'nota_admin', ev.target.value)} />
                  <div className="cap-acciones-btns">
                    <button className="cap-btn primary" onClick={() => decidir(c, 'autorizada')}>Autorizar</button>
                    <button className="cap-btn danger" onClick={() => decidir(c, 'rechazada')}>Rechazar</button>
                  </div>
                </div>
              )}
              {c.estado === 'autorizada' && (
                <div className="cap-acciones">
                  <span className="cap-agendada">📌 Agendada: {c.fecha_agendada ? new Date(c.fecha_agendada).toLocaleString('es-EC') : 'por coordinar'}</span>
                  <button className="cap-btn" onClick={() => decidir(c, 'realizada')}>Marcar como realizada</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
