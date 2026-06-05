import { useState, useEffect } from 'react'
import { useClients } from '../context/ClientContext'
import { MESES } from '../utils/periodo'
import './NewClientModal.css'

const ANIO_ACTUAL = 2026
const ANIOS = Array.from({ length: 12 }, (_, i) => ANIO_ACTUAL - i)

const EMPTY = {
  identificacion: '', nombre: '', tipo_identificacion: 'RUC',
  periodo_mes: '', periodo_anio: '',
}

export default function NewClientModal({ open, onClose, editClient = null, selectAfter = true, onCreated }) {
  const { createClient, updateClient } = useClients()
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (editClient) {
      setForm({
        identificacion: editClient.identificacion || '',
        nombre: editClient.nombre || '',
        tipo_identificacion: editClient.tipo_identificacion || 'RUC',
        periodo_mes: editClient.periodo_mes || '',
        periodo_anio: editClient.periodo_anio || '',
      })
    } else {
      setForm(EMPTY)
    }
    setError('')
  }, [editClient, open])

  if (!open) return null

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!form.identificacion.trim() || !form.nombre.trim()) {
      setError('Identificación y Nombre son obligatorios')
      return
    }
    if (!form.periodo_mes || !form.periodo_anio) {
      setError('El período (mes y año) es obligatorio')
      return
    }
    setSaving(true)
    setError('')
    try {
      const payload = {
        ...form,
        periodo_mes: parseInt(form.periodo_mes, 10),
        periodo_anio: parseInt(form.periodo_anio, 10),
      }
      if (editClient) {
        await updateClient(editClient.id, payload)
        onClose()
      } else {
        const created = await createClient(payload, { select: selectAfter })
        onClose()
        if (created) onCreated?.(created)
      }
    } catch (err) {
      setError(err.response?.data?.detail || err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <h2>{editClient ? '✏️ Editar cliente' : '👤 Nuevo cliente'}</h2>
        <p className="modal-sub">Datos del contribuyente que se está trabajando</p>

        <form onSubmit={handleSubmit}>
          <label>Tipo de identificación</label>
          <select
            value={form.tipo_identificacion}
            onChange={(e) => setForm({ ...form, tipo_identificacion: e.target.value })}
          >
            <option value="RUC">RUC</option>
            <option value="CEDULA">Cédula</option>
            <option value="PASAPORTE">Pasaporte</option>
          </select>

          <label>Identificación *</label>
          <input
            autoFocus
            value={form.identificacion}
            onChange={(e) => setForm({ ...form, identificacion: e.target.value })}
            placeholder="Ej. 1790012345001"
            maxLength="20"
          />

          <label>Nombre / Razón social *</label>
          <input
            value={form.nombre}
            onChange={(e) => setForm({ ...form, nombre: e.target.value })}
            placeholder="Nombre del contribuyente"
          />

          <label>Período *</label>
          <div className="periodo-row">
            <select
              value={form.periodo_mes}
              onChange={(e) => setForm({ ...form, periodo_mes: e.target.value })}
            >
              <option value="">Mes…</option>
              {MESES.map((m, i) => (
                <option key={m} value={i + 1}>{m}</option>
              ))}
            </select>
            <select
              value={form.periodo_anio}
              onChange={(e) => setForm({ ...form, periodo_anio: e.target.value })}
            >
              <option value="">Año…</option>
              {ANIOS.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>

          {error && <div className="modal-error">⚠ {error}</div>}

          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? 'Guardando…' : editClient ? 'Guardar' : 'Crear cliente'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
