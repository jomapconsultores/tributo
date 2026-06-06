import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { authAPI } from '../services/api'
import './Login.css'

export default function ResetPassword() {
  const navigate = useNavigate()
  const [token, setToken] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [error, setError] = useState('')
  const [ok, setOk] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const raw = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash
    const params = new URLSearchParams(raw || window.location.search)
    setToken(params.get('access_token') || '')
  }, [])

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (pw.length < 6) { setError('La contraseña debe tener al menos 6 caracteres.'); return }
    if (pw !== pw2) { setError('Las contraseñas no coinciden.'); return }
    if (!token) { setError('Enlace inválido o expirado. Solicita uno nuevo.'); return }
    setLoading(true)
    try {
      await authAPI.reset(token, pw)
      setOk(true)
    } catch (err) {
      setError(err.response?.data?.detail || 'No se pudo cambiar la contraseña.')
    } finally { setLoading(false) }
  }

  return (
    <div className="login-container">
      <div className="login-box">
        <h1>Nueva contraseña</h1>
        {ok ? (
          <>
            <div className="info-message">✅ Contraseña actualizada. Ya puedes iniciar sesión.</div>
            <button className="login-btn" onClick={() => navigate('/login')}>Ir a iniciar sesión</button>
          </>
        ) : (
          <form onSubmit={submit}>
            <p className="subtitle">Ingresa tu nueva contraseña.</p>
            <div className="form-group">
              <label>Nueva contraseña:</label>
              <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="••••••••" required />
            </div>
            <div className="form-group">
              <label>Repetir contraseña:</label>
              <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="••••••••" required />
            </div>
            {error && <div className="error-message">{error}</div>}
            {!token && <div className="error-message">Abre esta página desde el enlace que te enviamos por correo.</div>}
            <button type="submit" className="login-btn" disabled={loading}>{loading ? 'Guardando…' : 'Guardar contraseña'}</button>
          </form>
        )}
      </div>
    </div>
  )
}
