import { startRegistration, startAuthentication } from '@simplewebauthn/browser'

const BIO_EMAIL_KEY = 'bio_email'
const BIO_PROMPTED_PREFIX = 'bio_prompted_'

// ── Detección de soporte ─────────────────────────────────────────────────────

export async function isBiometricSupported() {
  try {
    if (!window.PublicKeyCredential) return false
    if (!window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) return false
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
  } catch {
    return false
  }
}

// ── Estado local (localStorage) ──────────────────────────────────────────────

export const getBioEmail = () => localStorage.getItem(BIO_EMAIL_KEY)
export const hasBiometric = () => !!localStorage.getItem(BIO_EMAIL_KEY)
export const clearBiometric = () => localStorage.removeItem(BIO_EMAIL_KEY)

export const wasPrompted = (userId) => !!localStorage.getItem(BIO_PROMPTED_PREFIX + userId)
export const markPrompted = (userId) => localStorage.setItem(BIO_PROMPTED_PREFIX + userId, '1')

// ── Registro (mientras el usuario YA tiene una sesión activa) ────────────────

export async function registerBiometric(token) {
  // 1. Pedir opciones al backend (requiere JWT activo)
  const optRes = await fetch('/api/webauthn/register/begin', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({}),
  })
  if (!optRes.ok) throw new Error((await optRes.json()).detail || 'Error al iniciar registro')
  const options = await optRes.json()

  // 2. El dispositivo muestra el prompt biométrico
  const credential = await startRegistration({ optionsJSON: options })

  // 3. Verificar y guardar en el servidor
  const verRes = await fetch('/api/webauthn/register/complete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(credential),
  })
  if (!verRes.ok) throw new Error((await verRes.json()).detail || 'Error al verificar registro')
  const data = await verRes.json()

  // 4. Guardar el email para futuros logins sin contraseña
  localStorage.setItem(BIO_EMAIL_KEY, data.email)
  return data
}

// ── Autenticación biométrica (sin sesión previa) ──────────────────────────────

export async function loginWithBiometric(email) {
  // 1. Pedir opciones (solo necesita el email)
  const optRes = await fetch('/api/webauthn/login/begin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  if (!optRes.ok) throw new Error((await optRes.json()).detail || 'Error al iniciar autenticación')
  const options = await optRes.json()

  // 2. El dispositivo muestra el prompt biométrico
  const credential = await startAuthentication({ optionsJSON: options })

  // 3. Verificar en el servidor → recibe JWT
  const verRes = await fetch('/api/webauthn/login/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, credential }),
  })
  if (!verRes.ok) throw new Error((await verRes.json()).detail || 'Autenticación biométrica fallida')
  return await verRes.json() // { access_token, user_id, email }
}
