import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { authAPI } from '../services/api'
import {
  isBiometricSupported,
  hasBiometric, getBioEmail, clearBiometric,
  registerBiometric, loginWithBiometric,
  wasPrompted, markPrompted,
} from '../services/webauthn'
import './Login.css'

// Fases de la pantalla de login
// 'login'        → formulario normal
// 'signup'       → registro nuevo usuario
// 'forgot'       → recuperar contraseña
// 'bio-prompt'   → proponer activar biometría (tras login normal exitoso)
// 'bio-activate' → activando biometría (spinner)
// 'bio-ok'       → biometría activada con éxito (breve confirmación)

export default function Login({ onLogin }) {
  const [searchParams] = useSearchParams()
  const quiereRegistro = searchParams.get('registro') === '1' || searchParams.get('signup') === '1'

  const [phase, setPhase] = useState(quiereRegistro ? 'signup' : 'login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [loading, setLoading] = useState(false)

  // Biometría
  const [bioSupported, setBioSupported] = useState(false)
  const [bioEmail] = useState(getBioEmail)          // email registrado en este dispositivo
  const [pendingAuth, setPendingAuth] = useState(null) // { access_token, user_id, email }

  useEffect(() => {
    isBiometricSupported().then(setBioSupported)
  }, [])

  // ── Login / signup / forgot normales ─────────────────────────────────────

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(''); setInfo('')
    setLoading(true)
    try {
      const endpoint = phase === 'signup' ? authAPI.signup : authAPI.login
      const response = await endpoint(email, password)
      const { access_token, user_id, email: userEmail } = response.data

      // ¿Hay que proponer la biometría?
      if (
        phase === 'login' &&
        bioSupported &&
        !hasBiometric() &&
        !wasPrompted(user_id)
      ) {
        markPrompted(user_id)
        setPendingAuth({ access_token, user_id, email: userEmail })
        setPhase('bio-prompt')
      } else {
        onLogin(access_token, user_id, userEmail)
      }
    } catch (err) {
      setError(err.response?.data?.detail || 'Error en autenticación')
    } finally {
      setLoading(false)
    }
  }

  const handleForgot = async (e) => {
    e.preventDefault()
    setError(''); setInfo('')
    if (!email.includes('@')) { setError('Ingresa tu correo.'); return }
    setLoading(true)
    try {
      const r = await authAPI.forgot(email)
      setInfo(r.data?.message || 'Te enviamos un enlace a tu correo.')
    } catch {
      setInfo('Si el correo está registrado, te enviamos un enlace.')
    } finally { setLoading(false) }
  }

  // ── Biometría: activar tras login normal ─────────────────────────────────

  const handleActivateBio = async () => {
    setPhase('bio-activate')
    try {
      await registerBiometric(pendingAuth.access_token)
      setPhase('bio-ok')
      setTimeout(() => onLogin(pendingAuth.access_token, pendingAuth.user_id, pendingAuth.email), 1400)
    } catch (err) {
      setError(err.message || 'No se pudo activar la biometría')
      setPhase('bio-prompt')
    }
  }

  const skipBio = () => {
    onLogin(pendingAuth.access_token, pendingAuth.user_id, pendingAuth.email)
  }

  // ── Login biométrico (desde pantalla principal) ───────────────────────────

  const handleBioLogin = async () => {
    setError('')
    setLoading(true)
    try {
      const data = await loginWithBiometric(bioEmail)
      onLogin(data.access_token, data.user_id, data.email)
    } catch (err) {
      setError(err.message || 'Autenticación biométrica fallida')
      setLoading(false)
    }
  }

  // ── Renders ──────────────────────────────────────────────────────────────

  if (phase === 'bio-prompt') {
    return (
      <div className="login-container">
        <div className="login-box">
          <div className="bio-icon-big">🔐</div>
          <h2 className="bio-title">Ingresa más rápido</h2>
          <p className="bio-desc">
            Activa el acceso con tu <strong>huella dactilar</strong> o <strong>reconocimiento facial</strong>.
            La próxima vez entrarás con un solo toque.
          </p>
          {error && <div className="error-message">{error}</div>}
          <button className="bio-activate-btn" onClick={handleActivateBio}>
            👆 Activar acceso biométrico
          </button>
          <button className="bio-skip-btn" onClick={skipBio}>
            Ahora no
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'bio-activate') {
    return (
      <div className="login-container">
        <div className="login-box bio-center">
          <div className="bio-spinner">⏳</div>
          <p>Leyendo biometría del dispositivo…</p>
          <p className="bio-hint">Apoya el dedo o mira la cámara cuando el dispositivo lo indique.</p>
        </div>
      </div>
    )
  }

  if (phase === 'bio-ok') {
    return (
      <div className="login-container">
        <div className="login-box bio-center">
          <div className="bio-icon-big">✅</div>
          <p className="bio-success">¡Biometría activada! Entrando…</p>
        </div>
      </div>
    )
  }

  // Pantalla principal de login
  return (
    <div className="login-container">
      <div className="login-box">
        <h1>Gestor SRI</h1>
        <p className="subtitle">Procesa y clasifica tus facturas</p>

        {/* Botón biométrico (si ya está registrado en este dispositivo) */}
        {bioEmail && bioSupported && phase === 'login' && (
          <div className="bio-login-section">
            <button
              className="bio-login-btn"
              onClick={handleBioLogin}
              disabled={loading}
            >
              <span className="bio-login-icon">👆</span>
              <span>
                <span className="bio-login-main">Entrar con huella o rostro</span>
                <span className="bio-login-email">{bioEmail}</span>
              </span>
            </button>
            <button className="bio-change-btn" onClick={() => { clearBiometric(); window.location.reload() }}>
              ¿No eres tú? Cambiar cuenta
            </button>
            <div className="bio-divider"><span>o ingresa con contraseña</span></div>
          </div>
        )}

        <form onSubmit={phase === 'forgot' ? handleForgot : handleSubmit}>
          <div className="form-group">
            <label htmlFor="email">Email:</label>
            <input
              type="email"
              id="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="tu@email.com"
              defaultValue={bioEmail || ''}
              required
            />
          </div>

          {phase !== 'forgot' && (
            <div className="form-group">
              <label htmlFor="password">Contraseña:</label>
              <input
                type="password"
                id="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
              />
            </div>
          )}

          {error && <div className="error-message">{error}</div>}
          {info && <div className="info-message">{info}</div>}

          <button type="submit" disabled={loading} className="login-btn">
            {loading ? 'Cargando…' :
              phase === 'forgot' ? 'Enviar enlace de recuperación' :
              phase === 'signup' ? 'Registrarse' : 'Iniciar Sesión'}
          </button>
        </form>

        {phase !== 'signup' && (
          <p className="toggle-signup">
            <button type="button"
              onClick={() => { setPhase(phase === 'forgot' ? 'login' : 'forgot'); setError(''); setInfo('') }}
              className="link-btn">
              {phase === 'forgot' ? '← Volver a iniciar sesión' : '¿Olvidaste tu contraseña?'}
            </button>
          </p>
        )}

        {phase !== 'forgot' && (
          <p className="toggle-signup">
            {phase === 'signup' ? '¿Ya tienes cuenta?' : '¿No tienes cuenta?'}{' '}
            <button type="button"
              onClick={() => setPhase(phase === 'signup' ? 'login' : 'signup')}
              className="link-btn">
              {phase === 'signup' ? 'Inicia sesión' : 'Regístrate'}
            </button>
          </p>
        )}
      </div>
    </div>
  )
}
