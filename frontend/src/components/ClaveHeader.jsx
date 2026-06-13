import { useState, useEffect } from 'react'
import { declaracionesAPI, credentialsAPI } from '../services/api'

export default function ClaveHeader({ clientId }) {
  const [info, setInfo] = useState(null) // { username, clave }

  useEffect(() => {
    if (!clientId) { setInfo(null); return }
    let cancelled = false
    declaracionesAPI.credenciales(clientId)
      .then(async (r) => {
        const d = r.data
        if (cancelled || !d?.es_admin || !d?.credencial?.id) return
        const username = d.credencial.username || ''
        try {
          const rev = await credentialsAPI.reveal(d.credencial.id)
          if (!cancelled) setInfo({ username, clave: rev.data?.password || '' })
        } catch {
          if (!cancelled) setInfo({ username, clave: '' })
        }
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
