import { useState, useEffect } from 'react'
import { declaracionesAPI, credentialsAPI } from '../services/api'

export default function ClaveHeader({ clientId }) {
  const [info, setInfo] = useState(null) // { username, clave }

  useEffect(() => {
    setInfo(null)
    if (!clientId) return
    declaracionesAPI.credenciales(clientId)
      .then(async (r) => {
        const d = r.data
        if (!d?.es_admin || !d?.credencial?.id) return
        const username = d.credencial.username || ''
        try {
          const rev = await credentialsAPI.reveal(d.credencial.id)
          setInfo({ username, clave: rev.data?.password || '' })
        } catch {
          setInfo({ username, clave: '' })
        }
      })
      .catch(() => {})
  }, [clientId])

  if (!info) return null

  return (
    <span className="clave-header-tag">
      🔐 <strong>{info.username}</strong>
      {info.clave && <code className="clave-header-code">{info.clave}</code>}
    </span>
  )
}
