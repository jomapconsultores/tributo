import { useState, useEffect } from 'react'
import { declaracionesAPI, credentialsAPI } from '../services/api'

export default function ClaveHeader({ clientId }) {
  const [cred, setCred] = useState(null) // { id, username } — sin password
  const [clave, setClave] = useState('') // password, ya descifrada

  // La clave se muestra directamente: quien está parado en un contribuyente
  // para declarar necesita entrar al portal, y un botón "revelar" en el medio
  // solo agrega un click. El acceso queda igual de auditado.
  useEffect(() => {
    setCred(null); setClave('')
    if (!clientId) return
    let cancelled = false
    declaracionesAPI.credenciales(clientId, false)
      .then(async (r) => {
        if (cancelled) return
        const d = r.data
        // `puede_ver_clave` incluye al funcionario, que es quien declara;
        // `es_admin` se mantiene por compatibilidad con respuestas viejas.
        if (!(d?.puede_ver_clave ?? d?.es_admin) || !d?.credencial?.id) return
        setCred({ id: d.credencial.id, username: d.credencial.username || '' })
        try {
          const c = await credentialsAPI.reveal(d.credencial.id)
          if (!cancelled && c.data?.password) setClave(c.data.password)
        } catch { /* cifrada con otra llave: se muestra el usuario igual */ }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [clientId])

  if (!cred) return null

  return (
    <span className="clave-header-tag">
      🔐 {cred.username && <strong>{cred.username} </strong>}
      {clave
        ? <code className="clave-header-code">{clave}</code>
        : <span className="clave-header-reveal">(no se pudo descifrar)</span>}
    </span>
  )
}
