import { useState } from 'react'
import { authAPI } from '../services/api'
import './Login.css'

export default function Login({ onLogin }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [isSignup, setIsSignup] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const endpoint = isSignup ? authAPI.signup : authAPI.login
      const response = await endpoint(email, password)
      const { access_token, user_id } = response.data

      onLogin(access_token, user_id, email)
    } catch (err) {
      setError(err.response?.data?.detail || 'Error en autenticación')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-container">
      <div className="login-box">
        <h1>Gestor SRI</h1>
        <p className="subtitle">Procesa y clasifica tus facturas</p>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="email">Email:</label>
            <input
              type="email"
              id="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="tu@email.com"
              required
            />
          </div>

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

          {error && <div className="error-message">{error}</div>}

          <button type="submit" disabled={loading} className="login-btn">
            {loading ? 'Cargando...' : isSignup ? 'Registrarse' : 'Iniciar Sesión'}
          </button>
        </form>

        <p className="toggle-signup">
          {isSignup ? '¿Ya tienes cuenta?' : '¿No tienes cuenta?'}{' '}
          <button
            type="button"
            onClick={() => setIsSignup(!isSignup)}
            className="link-btn"
          >
            {isSignup ? 'Inicia sesión' : 'Regístrate'}
          </button>
        </p>
      </div>
    </div>
  )
}
