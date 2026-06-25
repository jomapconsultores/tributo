import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { authAPI } from '../services/api'
import './Login.css'

function EyeToggle({ visible, onClick }) {
  return (
    <button
      type="button"
      className="password-toggle"
      onClick={onClick}
      aria-label={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
      title={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
    >
      {visible ? (
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </svg>
      ) : (
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      )}
    </button>
  )
}

export default function ResetPassword() {
  const navigate = useNavigate()
  const [token, setToken] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [showPw2, setShowPw2] = useState(false)
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
              <div className="password-wrapper">
                <input type={showPw ? 'text' : 'password'} value={pw} onChange={(e) => setPw(e.target.value)} placeholder="••••••••" required />
                <EyeToggle visible={showPw} onClick={() => setShowPw((v) => !v)} />
              </div>
            </div>
            <div className="form-group">
              <label>Repetir contraseña:</label>
              <div className="password-wrapper">
                <input type={showPw2 ? 'text' : 'password'} value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="••••••••" required />
                <EyeToggle visible={showPw2} onClick={() => setShowPw2((v) => !v)} />
              </div>
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
