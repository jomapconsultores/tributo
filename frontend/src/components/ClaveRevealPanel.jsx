import { useState, useEffect } from 'react'
import { declaracionesAPI, credentialsAPI } from '../services/api'

export default function ClaveRevealPanel({ clientId }) {
  const [creds, setCreds] = useState(null)
  const [clave, setClave] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setCreds(null); setClave('')
    if (!clientId) return
    setLoading(true)
    declaracionesAPI.credenciales(clientId)
      .then((r) => setCreds(r.data))
      .catch(() => setCreds(null))
      .finally(() => setLoading(false))
  }, [clientId])

  const revelar = async () => {
    if (!creds?.credencial?.id) return
    try {
      const r = await credentialsAPI.reveal(creds.credencial.id)
      setClave(r.data?.password || '')
    } catch (e) {
      alert('No se pudo revelar la clave: ' + (e.response?.data?.detail || e.message))
    }
  }

  // Solo visible para admins; si aún carga no mostrar nada
  if (loading || !creds || !creds.es_admin) return null

  const boxStyle = {
    background: '#f0f4f8', border: '1px solid #cdd8e6', borderRadius: 8,
    padding: '7px 14px', marginBottom: 12, fontSize: 13,
    display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
  }

  // Admin logueado pero sin credencial registrada para este cliente
  if (!creds.credencial) {
    return (
      <div style={{ ...boxStyle, color: '#6b7888' }}>
        🔐 Portal SRI — sin credencial registrada para este contribuyente.{' '}
        <a href="/admin/credenciales" style={{ color: '#1a5276', fontWeight: 600 }}>Agregar en Admin</a>
      </div>
    )
  }

  return (
    <div style={boxStyle}>
      <span>🔐 Portal SRI · usuario: <strong>{creds.credencial.username || '—'}</strong></span>
      {clave ? (
        <>
          <span>· clave:</span>
          <code style={{
            background: '#fff', border: '1px solid #cdd8e6', borderRadius: 4,
            padding: '2px 10px', fontFamily: 'monospace', letterSpacing: 1,
          }}>{clave}</code>
          <button
            onClick={() => setClave('')}
            title="Ocultar"
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 15 }}
          >🙈</button>
        </>
      ) : (
        <button
          onClick={revelar}
          title="Revelar clave (auditado)"
          style={{
            border: '1px solid #1a5276', borderRadius: 6, background: '#d6eaf8',
            color: '#1a5276', padding: '2px 10px', cursor: 'pointer',
            fontSize: 12, fontWeight: 600,
          }}
        >👁 Revelar clave</button>
      )}
    </div>
  )
}
