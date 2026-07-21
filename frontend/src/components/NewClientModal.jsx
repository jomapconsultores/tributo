import { useState, useEffect } from 'react'
import { useClients } from '../context/ClientContext'
import { clientsAPI } from '../services/api'
import { MESES } from '../utils/periodo'
import { periodoADeclarar } from '../utils/declaracionSRI'
import './NewClientModal.css'

const ANIOS = Array.from({ length: 12 }, (_, i) => new Date().getFullYear() - i)

// Semestre "a declarar ahora" por defecto para contribuyentes semestrales: en
// ene–jun el último semestre cerrado es el 2do del año anterior; en jul–dic es el
// 1er semestre del año en curso.
function _semestreDefault(hoy = new Date()) {
  const m = hoy.getMonth() + 1
  if (m <= 6) return { semestre: 2, anio: hoy.getFullYear() - 1 }
  return { semestre: 1, anio: hoy.getFullYear() }
}

// Por defecto, el período a declarar (mes anterior) — lo que normalmente se carga
const _per = periodoADeclarar()
const EMPTY = {
  identificacion: '', nombre: '', tipo_identificacion: 'RUC',
  periodicidad: 'mensual',
  periodo_mes: _per.mes, periodo_anio: _per.anio,
  periodo_semestre: '',
  es_agente_retencion: false,
}

export default function NewClientModal({ open, onClose, editClient = null, selectAfter = true, onCreated }) {
  const { createClient, updateClient, clients, selectClient } = useClients()
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [dup, setDup] = useState(null)   // aviso de duplicado en el equipo (409)
  const [sri, setSri] = useState(null)        // datos básicos del SRI
  const [consultando, setConsultando] = useState(false)

  // El SRI devuelve nombres de personas naturales como: APELLIDO1 APELLIDO2 NOMBRE1 [NOMBRE2]
  // Los reordenamos a: NOMBRE1 [NOMBRE2] APELLIDO1 APELLIDO2
  const reordenarNombre = (nombre, tipo) => {
    if (!nombre || !tipo) return nombre
    const esPersonaNatural = /natural/i.test(tipo)
    if (!esPersonaNatural) return nombre
    const w = nombre.trim().split(/\s+/)
    if (w.length === 4) return `${w[2]} ${w[3]} ${w[0]} ${w[1]}`
    if (w.length === 3) return `${w[2]} ${w[0]} ${w[1]}`
    return nombre
  }

  const consultarSri = async () => {
    const ruc = (form.identificacion || '').trim()
    if (!ruc) { setError('Escribe primero el RUC/cédula'); return }
    setConsultando(true); setError(''); setSri(null)
    try {
      const r = await clientsAPI.consultaRuc(ruc)
      const d = r.data
      if (!d.ok) { setError(d.error || 'No se encontraron datos'); return }
      setSri(d)
      // Precarga el nombre reordenando Nombres antes de Apellidos para personas naturales
      const nombreOrdenado = reordenarNombre(d.razon_social, d.tipo)
      setForm((f) => ({ ...f, nombre: nombreOrdenado || f.nombre }))
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
        periodicidad: editClient.periodicidad || 'mensual',
        periodo_mes: editClient.periodo_mes || '',
        periodo_anio: editClient.periodo_anio || '',
        periodo_semestre: editClient.periodo_semestre || '',
        es_agente_retencion: !!editClient.es_agente_retencion,
      })
    } else {
      const p = periodoADeclarar()
      setForm({ ...EMPTY, periodo_mes: p.mes, periodo_anio: p.anio })
    }
    setError('')
    setSri(null)
    setDup(null)
  }, [editClient, open])

  if (!open) return null

  // Detecta si el nombre parece estar en formato SRI (APELLIDO APELLIDO NOMBRE):
  // todas las palabras en mayúsculas y al menos 3 palabras — posible orden invertido.
  const pareceFirmaSRI = (nombre) => {
    const w = (nombre || '').trim().split(/\s+/)
    return w.length >= 3 && w.every((p) => p === p.toUpperCase() && /^[A-ZÁÉÍÓÚÑ]+$/.test(p))
  }

  const esSemestral = form.periodicidad === 'semestral'

  const buildPayload = (extra = {}) => {
    const anio = parseInt(form.periodo_anio, 10)
    if (esSemestral) {
      const sem = parseInt(form.periodo_semestre, 10)
      return {
        ...form,
        periodicidad: 'semestral',
        periodo_semestre: sem,
        // El mes ancla (6 ó 12) lo fija también el backend; se envía por claridad.
        periodo_mes: sem === 1 ? 6 : 12,
        periodo_anio: anio,
        ...extra,
      }
    }
    return {
      ...form,
      periodicidad: 'mensual',
      periodo_semestre: null,
      periodo_mes: parseInt(form.periodo_mes, 10),
      periodo_anio: anio,
      ...extra,
    }
  }

  // Crea el cliente. Con forzar=true crea aunque OTRO usuario del equipo ya tenga
  // ese contribuyente+período (tras el aviso de duplicado).
  const submitCreate = async (forzar = false) => {
    setSaving(true); setError(''); setDup(null)
    try {
      const created = await createClient(buildPayload(forzar ? { forzar: true } : {}), { select: selectAfter })
      onClose()
      if (created) onCreated?.(created)
    } catch (err) {
      const st = err.response?.status
      const det = err.response?.data?.detail
      if (st === 409 && det && typeof det === 'object' && det.existe_en_equipo) {
        setDup(det)   // duplicado en el equipo → mostrar aviso con opciones
      } else {
        setError(typeof det === 'string' ? det : (err.message || 'No se pudo crear el cliente'))
      }
    } finally {
      setSaving(false)
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!form.identificacion.trim() || !form.nombre.trim()) {
      setError('Identificación y Nombre son obligatorios')
      return
    }
    if (esSemestral) {
      if (!form.periodo_semestre || !form.periodo_anio) {
        setError('El período (semestre y año) es obligatorio')
        return
      }
    } else if (!form.periodo_mes || !form.periodo_anio) {
      setError('El período (mes y año) es obligatorio')
      return
    }
    if (pareceFirmaSRI(form.nombre)) {
      const ok = window.confirm(
        `⚠ El nombre "${form.nombre}" parece estar en formato SRI (Apellidos primero).\n\n` +
        `El formato correcto es: NOMBRE(S) APELLIDO(S)\n\n` +
        `¿Deseas guardarlo igual? (Cancelar para corregirlo antes)`
      )
      if (!ok) return
    }
    if (editClient) {
      setSaving(true); setError('')
      try {
        await updateClient(editClient.id, buildPayload())
        onClose()
      } catch (err) {
        const det = err.response?.data?.detail
        setError(typeof det === 'string' ? det : (err.message || 'No se pudo guardar'))
      } finally {
        setSaving(false)
      }
      return
    }
    await submitCreate(false)
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

          <label className="modal-checkbox-row">
            <input
              type="checkbox"
              checked={!!form.es_agente_retencion}
              onChange={(e) => setForm({ ...form, es_agente_retencion: e.target.checked })}
            />
            {' '}Es agente de retención (retiene IVA/Renta a sus proveedores)
          </label>

          <label>Periodicidad de declaración de IVA</label>
          <select
            value={form.periodicidad}
            onChange={(e) => {
              const val = e.target.value
              if (val === 'semestral' && !form.periodo_semestre) {
                const d = _semestreDefault()
                setForm({ ...form, periodicidad: val, periodo_semestre: d.semestre, periodo_anio: d.anio })
              } else {
                setForm({ ...form, periodicidad: val })
              }
            }}
          >
            <option value="mensual">Mensual (todos los meses)</option>
            <option value="semestral">Semestral (ventas 0% / retención total)</option>
          </select>

          <label>Período *</label>
          <div className="periodo-row">
            {esSemestral ? (
              <select
                value={form.periodo_semestre}
                onChange={(e) => setForm({ ...form, periodo_semestre: e.target.value })}
              >
                <option value="">Semestre…</option>
                <option value={1}>1er semestre (ENE–JUN)</option>
                <option value={2}>2do semestre (JUL–DIC)</option>
              </select>
            ) : (
              <select
                value={form.periodo_mes}
                onChange={(e) => setForm({ ...form, periodo_mes: e.target.value })}
              >
                <option value="">Mes…</option>
                {MESES.map((m, i) => (
                  <option key={m} value={i + 1}>{m}</option>
                ))}
              </select>
            )}
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
          {esSemestral && (
            <p className="modal-sub" style={{ marginTop: 4 }}>
              Se declara una sola vez: el 1er semestre en julio y el 2do en enero del año siguiente
              (día según el 9no dígito del RUC). Se aceptan las facturas de los 6 meses del semestre.
            </p>
          )}

          {dup && (
            <div className="modal-error" role="alert">
              ⚠ Ya existe <b>{dup.nombre}</b> para <b>{dup.periodo}</b>
              {dup.creado_por ? ` (creado por ${dup.creado_por})` : ''}. Probablemente sea un duplicado.
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                {clients.some((c) => c.id === dup.client_id) && (
                  <button type="button" className="btn-primary" onClick={() => { selectClient(dup.client_id); onClose() }}>
                    Abrir el existente
                  </button>
                )}
                <button type="button" className="btn-ghost" onClick={() => submitCreate(true)} disabled={saving}>
                  Crear otro de todos modos
                </button>
              </div>
            </div>
          )}

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
