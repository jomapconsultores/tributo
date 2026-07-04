import { useState, useEffect } from 'react'
import { declaracionesAPI, credentialsAPI } from '../services/api'

export default function ClaveHeader({ clientId }) {
  const [cred, setCred] = useState(null) // { id, username } — sin password
  const [clave, setClave] = useState('') // password, solo tras click en revelar
  const [revealing, setRevealing] = useState(false)

  useEffect(() => {
    setCred(null); setClave(''); setRevealing(false)
    if (!clientId) return
    let cancelled = false
    declaracionesAPI.credenciales(clientId, false)
      .then((r) => {
        if (cancelled) return
        const d = r.data
        if (!d?.es_admin || !d?.credencial?.id) return
        setCred({ id: d.credencial.id, username: d.credencial.username || '' })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [clientId])

  const revelar = async () => {
    if (!cred || revealing) return
    setRevealing(true)
    try {
      const r = await credentialsAPI.reveal(cred.id)
      if (r.data?.password) setClave(r.data.password)
    } finally {
      setRevealing(false)
    }
  }

  if (!cred) return null

  return (
    <span className="clave-header-tag">
      🔐 {cred.username && <strong>{cred.username} </strong>}
      {clave ? (
        <code className="clave-header-code">{clave}</code>
      ) : (
        <button type="button" className="clave-header-reveal" onClick={revelar} disabled={revealing}>
          {revealing ? '…' : 'revelar clave'}
        </button>
      )}
    </span>
  )
}
