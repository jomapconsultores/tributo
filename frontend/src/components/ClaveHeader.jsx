import { useState, useEffect } from 'react'
import { getRevealedCredentials } from '../services/credentialsCache'

export default function ClaveHeader({ clientId }) {
  const [info, setInfo] = useState(null) // { username, password } | null

  useEffect(() => {
    setInfo(null)
    if (!clientId) return
    getRevealedCredentials()
      .then((map) => {
        const cred = map.get(clientId)
        if (cred && cred.password) setInfo(cred)
      })
      .catch(() => {})
  }, [clientId])

  if (!info) return null

  return (
    <span className="clave-header-tag">
      🔐 {info.username && <strong>{info.username} </strong>}
      <code className="clave-header-code">{info.password}</code>
    </span>
  )
}
