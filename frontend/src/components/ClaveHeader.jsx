import { useState, useEffect } from 'react'
import { declaracionesAPI } from '../services/api'

export default function ClaveHeader({ clientId }) {
  const [info, setInfo] = useState(null) // { username, clave }

  useEffect(() => {
    if (!clientId) { setInfo(null); return }
    let cancelled = false
    // reveal=true: el backend descifra en un solo viaje (no necesita segunda llamada /reveal)
    declaracionesAPI.credenciales(clientId, true)
      .then((r) => {
        if (cancelled) return
        const d = r.data
        if (!d?.es_admin || !d?.credencial?.password) return
        setInfo({ username: d.credencial.username || '', clave: d.credencial.password })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [clientId])

  if (!info || !info.clave) return null

  return (
    <span className="clave-header-tag">
      🔐 {info.username && <strong>{info.username} </strong>}
      <code className="clave-header-code">{info.clave}</code>
    </span>
  )
}
