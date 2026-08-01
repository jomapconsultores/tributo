/* ------------------------------------------------------------
 * Desarrollado por Marco Antonio Posligua San Martín
 * ------------------------------------------------------------ */

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { authAPI } from '../services/api'
import './MiCuenta.css'

const MIN_CLAVE = 8

export default function MiCuenta() {
  const navigate = useNavigate()
  const [cargando, setCargando] = useState(true)
  const [perfil, setPerfil] = useState({ nombre: '', telefono: '', cargo: '', email: '' })
  const [claveActualPerfil, setClaveActualPerfil] = useState('')
  const [obligatorio, setObligatorio] = useState(false)
  const [avisoPerfil, setAvisoPerfil] = useState(null)

  const [actual, setActual] = useState('')
  const [nueva, setNueva] = useState('')
  const [repetir, setRepetir] = useState('')
  const [avisoClave, setAvisoClave] = useState(null)
  const [guardando, setGuardando] = useState(false)

  useEffect(() => {
    authAPI.perfil()
      .then(({ data }) => {
        setPerfil({
          nombre: data.nombre || '', telefono: data.telefono || '',
          cargo: data.cargo || '', email: data.email || '',
        })
        setObligatorio(Boolean(data.debe_cambiar_clave))
      })
      .catch((e) => setAvisoPerfil({ ok: false, texto: e?.response?.data?.detail || 'No se pudo cargar tu cuenta' }))
      .finally(() => setCargando(false))
  }, [])

  const guardarPerfil = async (e) => {
    e.preventDefault()
    setAvisoPerfil(null); setGuardando(true)
    try {
      await authAPI.guardarPerfil({ ...perfil, clave_actual: claveActualPerfil })
      setClaveActualPerfil('')
      setAvisoPerfil({ ok: true, texto: 'Datos actualizados.' })
    } catch (err) {
      setAvisoPerfil({ ok: false, texto: err?.response?.data?.detail || 'No se pudieron guardar los datos' })
    } finally { setGuardando(false) }
  }

  const guardarClave = async (e) => {
    e.preventDefault()
    setAvisoClave(null)
    if (nueva.length < MIN_CLAVE) {
      setAvisoClave({ ok: false, texto: `La nueva clave debe tener al menos ${MIN_CLAVE} caracteres.` }); return
    }
    if (nueva !== repetir) {
      setAvisoClave({ ok: false, texto: 'La nueva clave y su confirmación no coinciden.' }); return
    }
    setGuardando(true)
    try {
      await authAPI.cambiarClave(actual, nueva)
      setActual(''); setNueva(''); setRepetir(''); setObligatorio(false)
      setAvisoClave({ ok: true, texto: 'Clave actualizada correctamente.' })
      if (obligatorio) setTimeout(() => navigate('/'), 1200)
    } catch (err) {
      setAvisoClave({ ok: false, texto: err?.response?.data?.detail || 'No se pudo cambiar la clave' })
    } finally { setGuardando(false) }
  }

  if (cargando) return <div className="mc-wrap"><p>Cargando tu cuenta…</p></div>

  return (
    <div className="mc-wrap">
      <h1>Mi cuenta</h1>
      <p className="mc-sub">
        Actualiza tus datos y cambia tu clave. Si la olvidaste, puedes pedir el enlace de
        recuperación desde la pantalla de ingreso, o pedirle al administrador que la restablezca.
      </p>

      {obligatorio && (
        <div className="mc-alert mc-alert-warn">
          <strong>Cambio obligatorio.</strong> Estás usando una clave temporal entregada por el
          administrador. Define tu clave personal para poder seguir usando el sistema.
        </div>
      )}

      <section className="mc-card">
        <h2>Mis datos</h2>
        <form onSubmit={guardarPerfil}>
          <label>Nombre completo
            <input type="text" value={perfil.nombre}
                   onChange={(e) => setPerfil({ ...perfil, nombre: e.target.value })} />
          </label>
          <div className="mc-row">
            <label>Teléfono
              <input type="tel" value={perfil.telefono} placeholder="09XXXXXXXX"
                     onChange={(e) => setPerfil({ ...perfil, telefono: e.target.value })} />
            </label>
            <label>Cargo
              <input type="text" value={perfil.cargo} placeholder="Contador, asistente…"
                     onChange={(e) => setPerfil({ ...perfil, cargo: e.target.value })} />
            </label>
          </div>
          <label>Email de acceso
            <input type="email" value={perfil.email} required
                   onChange={(e) => setPerfil({ ...perfil, email: e.target.value })} />
          </label>
          <p className="mc-hint">Es tu usuario para entrar. Si lo cambias, confirma tu clave actual abajo.</p>
          <label>Clave actual (solo si cambias el email)
            <input type="password" value={claveActualPerfil} autoComplete="current-password"
                   onChange={(e) => setClaveActualPerfil(e.target.value)} />
          </label>
          <button type="submit" disabled={guardando}>{guardando ? 'Guardando…' : 'Guardar mis datos'}</button>
          {avisoPerfil && (
            <p className={`mc-aviso ${avisoPerfil.ok ? 'ok' : 'err'}`}>{avisoPerfil.texto}</p>
          )}
        </form>
      </section>

      <section className="mc-card">
        <h2>Mi clave</h2>
        <form onSubmit={guardarClave} autoComplete="off">
          <label>{obligatorio ? 'Clave temporal' : 'Clave actual'}
            <input type="password" value={actual} required autoComplete="current-password"
                   onChange={(e) => setActual(e.target.value)} />
          </label>
          <label>Nueva clave
            <input type="password" value={nueva} required minLength={MIN_CLAVE} autoComplete="new-password"
                   onChange={(e) => setNueva(e.target.value)} />
          </label>
          <p className="mc-hint">
            Mínimo {MIN_CLAVE} caracteres. Usa letras, números y algún símbolo.
          </p>
          <label>Repetir nueva clave
            <input type="password" value={repetir} required minLength={MIN_CLAVE} autoComplete="new-password"
                   onChange={(e) => setRepetir(e.target.value)} />
          </label>
          <button type="submit" disabled={guardando}>{guardando ? 'Guardando…' : 'Guardar nueva clave'}</button>
          {avisoClave && (
            <p className={`mc-aviso ${avisoClave.ok ? 'ok' : 'err'}`}>{avisoClave.texto}</p>
          )}
        </form>
      </section>
    </div>
  )
}
