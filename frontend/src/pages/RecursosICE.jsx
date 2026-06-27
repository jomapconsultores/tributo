import { useState, useEffect, useRef } from 'react'
import { resourcesAPI, productsAPI, downloadBlob } from '../services/api'
import './RecursosICE.css'

const PDF_URL = '/recursos/ICE-presentacion.pdf'
const kb = (n) => `${(n / 1024).toFixed(0)} KB`

export default function RecursosICE() {
  const [info, setInfo] = useState(null)
  const [busy, setBusy] = useState('')
  const [total, setTotal] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef(null)

  const loadInfo = () => resourcesAPI.codigosInfo().then((r) => setInfo(r.data)).catch(() => setInfo({ exists: false }))
  const loadTotal = () => productsAPI.countCodigos().then((r) => setTotal(r.data?.total ?? 0)).catch(() => setTotal(null))
  useEffect(() => { loadInfo(); loadTotal() }, [])

  const importar = async () => {
    if (!window.confirm('Esto reemplazará TODOS los códigos en la base con los del archivo actual (borra los que ya no estén y agrega los nuevos). ¿Continuar?')) return
    setBusy('Importando códigos a la base (puede tardar)…')
    try {
      const res = await productsAPI.importCodigos()
      await loadTotal()
      alert(`✔ ${res.data.total} códigos ICE importados/actualizados en la base.`)
    } catch (e) {
      alert('Error al importar: ' + (e.response?.data?.detail || e.message))
    } finally { setBusy('') }
  }

  const descargarCodigos = async () => {
    try {
      const res = await resourcesAPI.getCodigos()
      downloadBlob(res.data, 'Códigos ICE.xls', 'application/vnd.ms-excel')
    } catch (e) {
      alert('No se pudo descargar: ' + (e.response?.data?.detail || e.message))
    }
  }

  const aceptarArchivo = (file) => {
    if (!file) return
    if (!/\.(xls|xlsx)$/i.test(file.name)) { alert('Solo se permite un archivo Excel (.xls o .xlsx).'); return }
    reemplazar(file)
  }
  const onDrop = (e) => {
    e.preventDefault(); setDragOver(false)
    aceptarArchivo(e.dataTransfer.files?.[0])
  }

  const reemplazar = async (file) => {
    setBusy('Subiendo nuevo archivo…')
    try {
      const res = await resourcesAPI.replaceCodigos(file)
      alert(`✔ Códigos ICE actualizado (${kb(res.data.size)})`)
      await loadInfo()
    } catch (e) {
      alert('Error al reemplazar: ' + (e.response?.data?.detail || e.message))
    } finally {
      setBusy(''); if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="rec-page">
      <header className="rec-header">
        <h1>📚 Información útil — ICE</h1>
        <p className="rec-sub">Material de referencia para el módulo de ICE.</p>
      </header>

      <div className="rec-card">
        <div className="rec-icon">📕</div>
        <div className="rec-body">
          <h2>Presentación ICE</h2>
          <p>Impuesto a los Consumos Especiales — material de capacitación (PDF).</p>
          <div className="rec-actions">
            <a className="rec-btn primary" href={PDF_URL} target="_blank" rel="noreferrer">Abrir</a>
            <a className="rec-btn ghost" href={PDF_URL} download="Impuesto a los Consumos Especiales - ICE.pdf">Descargar</a>
          </div>
        </div>
      </div>

      <div className="rec-card">
        <div className="rec-icon">📊</div>
        <div className="rec-body">
          <h2>Códigos ICE</h2>
          <p>
            Codificación de productos ICE (Excel).{' '}
            {info?.exists ? <span className="rec-meta">Actual: {kb(info.size)}</span> : <span className="rec-meta warn">Sin archivo cargado</span>}
          </p>
          <p className="rec-note">
            Este archivo es <strong>reemplazable</strong>: sube una versión nueva y luego pulsa
            <strong> Actualizar en la base</strong> para sincronizar (borra los que ya no estén y agrega los nuevos).
          </p>
          <p className="rec-meta">En la base: <strong>{total === null ? '…' : total.toLocaleString()}</strong> códigos importados.</p>
          <input ref={fileRef} type="file" accept=".xls,.xlsx" style={{ display: 'none' }}
            onChange={(e) => { aceptarArchivo(e.target.files?.[0]); e.target.value = '' }} />
          <div
            className={`rec-drop${dragOver ? ' over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragEnter={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => fileRef.current?.click()}
            title="Arrastra el archivo de códigos ICE o haz clic para elegirlo"
          >
            <span className="rec-drop-ico">📥</span>
            <span className="rec-drop-txt">
              {dragOver ? 'Suelta el archivo para reemplazarlo' : 'Arrastra aquí el archivo .xls/.xlsx, o haz clic para elegirlo'}
            </span>
          </div>
          <div className="rec-actions">
            <button className="rec-btn primary" onClick={descargarCodigos} disabled={!info?.exists}>⬇ Descargar</button>
            <button className="rec-btn replace" onClick={() => fileRef.current?.click()}>🔁 Reemplazar archivo</button>
            <button className="rec-btn primary" onClick={importar} disabled={!info?.exists}>🔄 Actualizar en la base</button>
          </div>
          {busy && <div className="rec-busy">⏳ {busy}</div>}
        </div>
      </div>
    </div>
  )
}
