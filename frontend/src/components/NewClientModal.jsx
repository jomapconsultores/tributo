import { useState, useEffect } from 'react'
import { useClients } from '../context/ClientContext'
import { clientsAPI } from '../services/api'
import { MESES } from '../utils/periodo'
import { periodoADeclarar } from '../utils/declaracionSRI'
import './NewClientModal.css'

const ANIO_ACTUAL = 2026
const ANIOS = Array.from({ length: 12 }, (_, i) => ANIO_ACTUAL - i)

// Por defecto, el período a declarar (mes anterior) — lo que normalmente se carga
const _per = periodoADeclarar()
const EMPTY = {
  identificacion: '', nombre: '', tipo_identificacion: 'RUC',
  periodo_mes: _per.mes, periodo_anio: _per.anio,
}

export default function NewClientModal({ open, onClose, editClient = null, selectAfter = true, onCreated }) {
  const { createClient, updateClient } = useClients()
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [sri, setSri] = useState(null)        // datos básicos del SRI
  const [consultando, setConsultando] = useState(false)

  const consultarSri = async () => {
    const ruc = (form.identificacion || '').trim()
    if (!ruc) { setError('Escribe primero el RUC/cédula'); return }
    setConsultando(true); setError(''); setSri(null)
    try {
      const r = await clientsAPI.consultaRuc(ruc)
      const d = r.data
      if (!d.ok) { setError(d.error || 'No se encontraron datos'); return }
      setSri(d)
      // Precarga el nombre con la razón social del SRI
      setForm((f) => ({ ...f, nombre: d.razon_social || f.nombre }))
    } catch (e) {
      setError('No se pudo consultar el SRI: ' + (e.response?.data?.detail || e.message))
    } finally { setConsultando(false) }
  }

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
      const p = periodoADeclarar()
      setForm({ ...EMPTY, periodo_mes: p.mes, periodo_anio: p.anio })
    }
    setError('')
    setSri(null)
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
          <div className="ruc-row">
            <input
              autoFocus
              value={form.identificacion}
              onChange={(e) => setForm({ ...form, identificacion: e.target.value })}
              placeholder="Ej. 1790012345001"
              maxLength="20"
            />
            <button type="button" className="btn-ghost ruc-consultar" onClick={consultarSri} disabled={consultando}>
              {consultando ? 'Consultando…' : '🔎 Consultar SRI'}
            </button>
          </div>
          {sri && (
            <div className="ruc-sri">
              <div className="ruc-sri-row"><b>{sri.razon_social}</b> <span className={`ruc-estado ${sri.estado === 'ACTIVO' ? 'ok' : 'no'}`}>{sri.estado}</span></div>
              {sri.tipo && <div className="ruc-sri-line">{sri.tipo} · Régimen {sri.regimen}</div>}
              {sri.actividad && <div className="ruc-sri-line">🏷 {sri.actividad}</div>}
              {sri.obligaciones?.length > 0 && (
                <div className="ruc-sri-obl">{sri.obligaciones.map((o) => <span key={o} className="ruc-chip">{o}</span>)}</div>
              )}
              {sri.fecha_inicio && <div className="ruc-sri-line dim">Inicio de actividades: {sri.fecha_inicio}{sri.fecha_cese ? ` · Cese: ${sri.fecha_cese}` : ''}</div>}
              <div className="ruc-sri-line dim">Dirección/teléfono no son públicos en el SRI; agrégalos en Notas si los tienes.</div>
            </div>
          )}

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
