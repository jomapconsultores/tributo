import { useState, useEffect } from 'react'
import { declaracionesAPI, credentialsAPI } from '../services/api'

export default function ClaveRevealPanel({ clientId }) {
  const [creds, setCreds] = useState(null)
  const [clave, setClave] = useState('')

  useEffect(() => {
    setCreds(null); setClave('')
    if (!clientId) return
    declaracionesAPI.credenciales(clientId)
      .then(async (r) => {
        const data = r.data
        setCreds(data)
        // Auto-revelar si hay credencial
        if (data?.es_admin && data?.credencial?.id) {
          try {
            const rev = await credentialsAPI.reveal(data.credencial.id)
            setClave(rev.data?.password || '')
          } catch { /* silencioso */ }
        }
      })
      .catch(() => setCreds(null))
  }, [clientId])

  if (!creds || !creds.es_admin) return null

  const box = {
    background: '#eef4fb', border: '1px solid #c3d8ef', borderRadius: 8,
    padding: '6px 14px', marginBottom: 12, fontSize: 13,
    display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
  }

  if (!creds.credencial) {
    return (
      <div style={{ ...box, color: '#6b7888' }}>
        🔐 Portal SRI — sin credencial registrada.{' '}
        <a href="/admin/credenciales" style={{ color: '#1a5276', fontWeight: 600 }}>Agregar en Admin</a>
      </div>
    )
  }

  return (
    <div style={box}>
      <span>🔐 <strong>{creds.credencial.username || '—'}</strong></span>
      {clave
        ? <code style={{ background: '#fff', border: '1px solid #b9d3e8', borderRadius: 4, padding: '2px 10px', fontFamily: 'monospace', letterSpacing: 1 }}>{clave}</code>
        : <span style={{ color: '#94a3b8', fontSize: 12 }}>cargando…</span>
      }
    </div>
  )
}
