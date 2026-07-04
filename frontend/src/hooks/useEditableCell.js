import { useState, useRef } from 'react'

const COPY_FEEDBACK_MS = 1100

// Copia texto al portapapeles. Usa la Clipboard API cuando está disponible
// (contexto seguro, https) y cae a un <textarea> + execCommand('copy') como
// respaldo (necesario en http:// o navegadores viejos). No lanza si el
// portapapeles está bloqueado por el usuario/navegador; solo omite el feedback.
export async function copyToClipboard(text) {
  const t = String(text ?? '').trim()
  if (!t) return false
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(t)
    } else {
      const ta = document.createElement('textarea')
      ta.value = t
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    return true
  } catch {
    return false
  }
}

// Estado de "recién copiado" para resaltar la celda un momento tras el clic.
export function useCopyFeedback() {
  const [copiedKey, setCopiedKey] = useState('')

  const copy = async (text, key) => {
    const ok = await copyToClipboard(text)
    if (!ok) return
    setCopiedKey(key)
    setTimeout(() => setCopiedKey((k) => (k === key ? '' : k)), COPY_FEEDBACK_MS)
  }

  return { copiedKey, copy }
}

// Estado y handlers para celdas de tabla editables in-line: clic para
// empezar a editar, Enter o blur para guardar, Escape para cancelar sin
// guardar.
//
// El guard con `escRef` evita un bug: al presionar Escape se sale del modo
// edición y React desmonta el <input>, pero el navegador puede disparar un
// evento blur "fantasma" sobre ese input justo al desmontarlo; sin este
// guard, ese blur volvería a llamar a onSave con el valor que el usuario
// quiso descartar.
//
// Quien usa el hook decide cuándo llamar a `cancel()` dentro de su propio
// onSave (normalmente solo si el guardado en el backend tuvo éxito), para no
// perder el valor escrito si el guardado falla y el usuario necesita
// reintentar.
export function useEditableCell() {
  const [edit, setEdit] = useState({ id: null, field: null })
  const [value, setValue] = useState('')
  const escRef = useRef(false)

  const isEditing = (id, field) => edit.id === id && edit.field === field

  const startEdit = (id, field, current) => {
    escRef.current = false
    setEdit({ id, field })
    setValue(current ?? '')
  }

  const cancel = () => setEdit({ id: null, field: null })

  // onSave(value) se llama al confirmar (Enter o blur normal). Devuelve las
  // props para pasar directo a un <input> (value, onChange, onBlur, onKeyDown).
  const bind = (onSave) => ({
    value,
    onChange: (e) => setValue(e.target.value),
    onBlur: () => {
      if (escRef.current) { escRef.current = false; cancel(); return }
      onSave(value)
    },
    onKeyDown: (e) => {
      if (e.key === 'Enter') onSave(value)
      if (e.key === 'Escape') { escRef.current = true; cancel() }
    },
  })

  return { edit, value, setValue, isEditing, startEdit, cancel, bind }
}
