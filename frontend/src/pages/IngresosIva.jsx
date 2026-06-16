import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useOutletContext } from 'react-router-dom'
import { salesIvaAPI, xmlOriginalesAPI, downloadBlob } from '../services/api'

const descargarXmlsOriginales = async (cliente, clientId, tipo, modulo) => {
  try {
    const nom = (cliente?.nombre || '').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 20)
    const nombre = `${tipo}_${cliente?.identificacion || ''}_${nom}_${String(cliente?.periodo_mes || '').padStart(2, '0')}_${cliente?.periodo_anio || ''}.zip`
    const res = await xmlOriginalesAPI.descargar(clientId, modulo)
    downloadBlob(res.data, nombre, 'application/zip')
  } catch (err) {
    if (err.response?.status === 404) alert('Aún no hay XML guardados para este período. Se guardan automáticamente al subir nuevos XML.')
    else alert('Error: ' + (err.response?.data?.detail || err.message))
  }
}
import { useClients } from '../context/ClientContext'
import ClientSwitcher from '../components/ClientSwitcher'
import ClaveHeader from '../components/ClaveHeader'
import './IngresosIva.css'

import { fmtMoney as money, msgFueraPeriodo } from '../utils/format'

export default function IngresosIva() {
  const { openNewClient } = useOutletContext()
  const { selectedClient, selectedClientId } = useClients()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [dragActive, setDragActive] = useState(false)
  const [editId, setEditId] = useState(null)
  const [editData, setEditData] = useState({})
  const [savingEdit, setSavingEdit] = useState(false)
  const xmlInputRef = useRef(null)
  const txtInputRef = useRef(null)

  const NUM_FIELDS = ['no_objeto_iva', 'exento_iva', 'base_0', 'base_15', 'iva_15', 'base_5', 'iva_5']

  const startEdit = (r) => {
    setEditId(r.id)
    setEditData({
      fecha: r.fecha || '', factura_numero: r.factura_numero || '',
      razon_social_cliente: r.razon_social_cliente || '', id_cliente: r.id_cliente || '',
      no_objeto_iva: r.no_objeto_iva ?? 0, exento_iva: r.exento_iva ?? 0, base_0: r.base_0 ?? 0,
      base_15: r.base_15 ?? 0, iva_15: r.iva_15 ?? 0, base_5: r.base_5 ?? 0, iva_5: r.iva_5 ?? 0,
    })
  }
  const cancelEdit = () => { setEditId(null); setEditData({}) }
  const setEf = (k, v) => setEditData((d) => ({ ...d, [k]: v }))
  const editTotal = useMemo(
    () => NUM_FIELDS.reduce((s, k) => s + (parseFloat(editData[k]) || 0), 0),
    [editData]
  )
  const saveEdit = async () => {
    setSavingEdit(true)
    try {
      const payload = {
        fecha: editData.fecha, factura_numero: editData.factura_numero,
        razon_social_cliente: editData.razon_social_cliente, id_cliente: editData.id_cliente,
      }
      // importe_total se omite: el backend lo recalcula como suma de bases+IVA
      for (const k of NUM_FIELDS) payload[k] = parseFloat(editData[k]) || 0
      await salesIvaAPI.update(editId, payload)
      cancelEdit()
      await load()
    } catch (err) {
      alert('Error: ' + (err.response?.data?.detail || err.message))
    } finally { setSavingEdit(false) }
  }

  const load = useCallback(async () => {
    if (!selectedClientId) { setRows([]); return }
    setLoading(true); setError('')
    try {
      const res = await salesIvaAPI.list(selectedClientId)
      setRows(res.data?.data || [])
    } catch (err) {
      setError('Error al cargar ventas IVA: ' + (err.response?.data?.detail || err.message))
    } finally { setLoading(false) }
  }, [selectedClientId])

  useEffect(() => { load() }, [load])

  const handleUploadXml = async (files) => {
    if (!selectedClientId || !files.length) return
    setBusy(`Procesando ${files.length} factura(s) XML/PDF…`)
    try {
      const res = await salesIvaAPI.processXml(selectedClientId, files)
      const { nuevas, duplicadas, errores, rechazadas_por_ice, rechazadas } = res.data
      let msg = `✅ Nuevas: ${nuevas} · Duplicadas: ${duplicadas} · Errores: ${errores}`
      if (rechazadas_por_ice > 0) {
        msg += `\n\n⚠️ ${rechazadas_por_ice} factura(s) rechazadas por contener ICE:\n`
        msg += rechazadas.slice(0, 5).map((r) => `  • ${r.archivo} (${r.factura})`).join('\n')
        if (rechazadas.length > 5) msg += `\n  …y ${rechazadas.length - 5} más`
        msg += `\n\nSubilas en el módulo "ICE - XML".`
      }
      msg += msgFueraPeriodo(res.data)
      alert(msg)
      await load()
    } catch (err) {
      alert('Error: ' + (err.response?.data?.detail || err.message))
    } finally {
      setBusy(''); if (xmlInputRef.current) xmlInputRef.current.value = ''
    }
  }

  const handleUploadTxt = async (file) => {
    if (!selectedClientId || !file) return
    setBusy('Bajando los XML desde el SRI con las claves del reporte…')
    try {
      const res = await salesIvaAPI.processTxt(selectedClientId, file)
      const d = res.data
      const faltan = d.no_descargadas ?? 0
      let msg = `Claves en el reporte: ${d.total_claves}\n` +
                `Descargadas del SRI: ${d.descargadas} de ${d.total_claves}\n` +
                `Nuevas: ${d.nuevas} · Duplicadas: ${d.duplicadas}`
      if (d.rechazadas_por_ice > 0) msg += `\n⚠ ${d.rechazadas_por_ice} con ICE (van en "ICE - XML")`
      if (faltan > 0) msg += `\n\n⚠ ${faltan} no se bajaron (SRI saturado). Vuelve a subir el mismo TXT: reintenta solo las que faltan.`
      else msg += `\n\n✔ Se bajaron todas.`
      msg += msgFueraPeriodo(d)
      alert(msg)
      await load()
    } catch (err) {
      alert('Error: ' + (err.response?.data?.detail || err.message))
    } finally {
      setBusy(''); if (txtInputRef.current) txtInputRef.current.value = ''
    }
  }

  const handleDrag = (e) => {
    e.preventDefault(); e.stopPropagation()
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true)
    else if (e.type === 'dragleave') setDragActive(false)
  }
  const handleDrop = (e) => {
    e.preventDefault(); e.stopPropagation(); setDragActive(false)
    const files = Array.from(e.dataTransfer.files || []).filter((f) => {
      const n = f.name.toLowerCase(); return n.endsWith('.xml') || n.endsWith('.pdf')
    })
    if (!files.length) { alert('Arrastra facturas de venta en XML o PDF (RIDE del SRI).'); return }
    handleUploadXml(files)
  }

  const handleDelete = async (id) => {
    if (!window.confirm('¿Eliminar esta factura?')) return
    try { await salesIvaAPI.delete(id); await load() }
    catch (err) { alert('Error: ' + (err.response?.data?.detail || err.message)) }
  }
  const handleClear = async () => {
    if (!window.confirm(`¿Eliminar TODAS las ventas IVA de ${selectedClient?.nombre}?`)) return
    try { await salesIvaAPI.clear(selectedClientId); await load() }
    catch (err) { alert('Error: ' + (err.response?.data?.detail || err.message)) }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) =>
      [r.fecha, r.factura_numero, r.id_cliente, r.razon_social_cliente]
        .some((f) => String(f || '').toLowerCase().includes(q))
    )
  }, [rows, search])

  const totales = useMemo(() => {
    const acc = {
      no_objeto_iva: 0, exento_iva: 0, base_0: 0,
      base_15: 0, iva_15: 0, base_5: 0, iva_5: 0,
      importe_total: 0,
    }
    for (const r of filtered) {
      for (const k of Object.keys(acc)) acc[k] += parseFloat(r[k]) || 0
    }
    return acc
  }, [filtered])

  if (!selectedClientId) {
    return (
      <div className="ing-iva">
        <ClientSwitcher onNewClient={openNewClient} />
        <div className="ing-iva-empty">
          <h2>📈 Ingresos IVA</h2>
          <p>Seleccioná un contribuyente del menú para subir sus facturas de venta sin ICE.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="ing-iva">
      <ClientSwitcher onNewClient={openNewClient} />
      <header className="ing-iva-head">
        <div>
          <h2>📈 Ingresos IVA — <span className="ing-iva-ruc">{selectedClient?.identificacion}</span> {selectedClient?.nombre}<ClaveHeader clientId={selectedClientId} /></h2>
          <p className="ing-iva-sub">
            Facturas de venta SIN ICE. Sus totales se suman a los códigos 411–415 / 421–422 del
            formulario 104 (declaración IVA). Si una factura tiene ICE, subila en "ICE - XML".
          </p>
        </div>
      </header>

      <div
        className={`ing-iva-drop ${dragActive ? 'drag-active' : ''}`}
        onDragEnter={handleDrag} onDragOver={handleDrag}
        onDragLeave={handleDrag} onDrop={handleDrop}
      >
        <span className="drop-icon">📤</span>
        <div>
          <strong>Arrastrá XML o PDF acá</strong> o
          <input
            ref={xmlInputRef}
            type="file"
            multiple
            accept=".xml,.pdf"
            onChange={(e) => handleUploadXml(Array.from(e.target.files || []))}
            style={{ display: 'none' }}
            id="ing-iva-upload"
          />
          <label htmlFor="ing-iva-upload" className="ing-iva-pick">elegilos</label>
          <div className="ing-iva-hint">El PDF (RIDE del SRI) se lee automáticamente; podés corregir cualquier valor con ✎.</div>
        </div>
        {busy && <div className="ing-iva-busy">{busy}</div>}
      </div>

      {error && <div className="ing-iva-error">{error}</div>}

      <div className="ing-iva-toolbar">
        <input
          className="ing-iva-search"
          placeholder="🔍 Buscar fecha, factura, RUC cliente, nombre…"
          value={search} onChange={(e) => setSearch(e.target.value)}
        />
        <span className="ing-iva-count">{filtered.length} de {rows.length}</span>
        <input ref={txtInputRef} type="file" accept=".txt" style={{ display: 'none' }} id="ing-iva-txt"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUploadTxt(f) }} />
        <button className="ing-iva-clear" onClick={() => txtInputRef.current?.click()}
          title="Sube el reporte TXT del SRI (Descargar reporte de Comprobantes Emitidos): baja los XML por las claves">📄 Subir reporte (TXT)</button>
        <button className="ing-iva-clear" onClick={() => descargarXmlsOriginales(selectedClient, selectedClientId, 'IngresosIVA', 'ingreso_iva')} title="Descargar los XML originales subidos">⬇ XML originales</button>
        {rows.length > 0 && (
          <button className="ing-iva-clear" onClick={handleClear}>Vaciar todo</button>
        )}
      </div>

      {rows.length > 0 && (
        <div className="ing-iva-resumen">
          <div className="ing-card"><span className="ing-card-num">{filtered.length}</span><span className="ing-card-lbl">Facturas</span></div>
          <div className="ing-card"><span className="ing-card-num">{money(totales.base_15)}</span><span className="ing-card-lbl">Base 15%</span></div>
          <div className="ing-card"><span className="ing-card-num">{money(totales.iva_15)}</span><span className="ing-card-lbl">IVA 15%</span></div>
          <div className="ing-card"><span className="ing-card-num">{money(totales.base_5 + totales.iva_5)}</span><span className="ing-card-lbl">5% (base+IVA)</span></div>
          <div className="ing-card"><span className="ing-card-num">{money(totales.base_0)}</span><span className="ing-card-lbl">Base 0%</span></div>
          <div className="ing-card"><span className="ing-card-num">{money(totales.exento_iva + totales.no_objeto_iva)}</span><span className="ing-card-lbl">Exento / No obj.</span></div>
          <div className="ing-card total"><span className="ing-card-num">{money(totales.importe_total)}</span><span className="ing-card-lbl">Total facturado</span></div>
        </div>
      )}

      {loading ? (
        <div className="ing-iva-loading">Cargando…</div>
      ) : rows.length === 0 ? (
        <div className="ing-iva-empty-tab">
          Aún no hay ingresos IVA cargados. Arrastrá XMLs para empezar.
        </div>
      ) : (
        <div className="ing-iva-tablewrap">
          <table className="ing-iva-table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Factura</th>
                <th>Cliente</th>
                <th className="r">No Obj.</th>
                <th className="r">Exento</th>
                <th className="r">Base 0%</th>
                <th className="r">Base 15%</th>
                <th className="r">IVA 15%</th>
                <th className="r">Base 5%</th>
                <th className="r">IVA 5%</th>
                <th className="r">Total</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                editId === r.id ? (
                  <tr key={r.id} className="editing">
                    <td><input className="ed-in" value={editData.fecha} onChange={(e) => setEf('fecha', e.target.value)} placeholder="dd/mm/aaaa" /></td>
                    <td><input className="ed-in mono" value={editData.factura_numero} onChange={(e) => setEf('factura_numero', e.target.value)} placeholder="001-001-000…" /></td>
                    <td>
                      <input className="ed-in" value={editData.razon_social_cliente} onChange={(e) => setEf('razon_social_cliente', e.target.value)} placeholder="Nombre cliente" />
                      <input className="ed-in" value={editData.id_cliente} onChange={(e) => setEf('id_cliente', e.target.value)} placeholder="RUC / cédula" />
                    </td>
                    {NUM_FIELDS.map((k) => (
                      <td className="r" key={k}>
                        <input className="ed-num" type="number" step="0.01" value={editData[k]}
                          onChange={(e) => setEf(k, e.target.value)} />
                      </td>
                    ))}
                    <td className="r total">{money(editTotal)}</td>
                    <td className="ed-actions">
                      <button className="ed-save" onClick={saveEdit} disabled={savingEdit} title="Guardar">✔</button>
                      <button className="ed-cancel" onClick={cancelEdit} title="Cancelar">✕</button>
                    </td>
                  </tr>
                ) : (
                  <tr key={r.id}>
                    <td>{r.fecha || '-'}</td>
                    <td className="mono">{r.factura_numero || '-'}</td>
                    <td title={r.razon_social_cliente}>
                      <span className="cliente-name">{(r.razon_social_cliente || '').slice(0, 32)}</span>
                      <span className="cliente-id">{r.id_cliente}</span>
                    </td>
                    <td className="r">{money(r.no_objeto_iva)}</td>
                    <td className="r">{money(r.exento_iva)}</td>
                    <td className="r">{money(r.base_0)}</td>
                    <td className="r">{money(r.base_15)}</td>
                    <td className="r">{money(r.iva_15)}</td>
                    <td className="r">{money(r.base_5)}</td>
                    <td className="r">{money(r.iva_5)}</td>
                    <td className="r total">{money(r.importe_total)}</td>
                    <td className="acciones">
                      <button className="ed-btn" onClick={() => startEdit(r)} title="Editar">✎</button>
                      <button className="del-btn" onClick={() => handleDelete(r.id)} title="Eliminar">✕</button>
                    </td>
                  </tr>
                )
              ))}
            </tbody>
            <tfoot>
              <tr className="totales">
                <td colSpan={3}>TOTALES ({filtered.length})</td>
                <td className="r">{money(totales.no_objeto_iva)}</td>
                <td className="r">{money(totales.exento_iva)}</td>
                <td className="r">{money(totales.base_0)}</td>
                <td className="r">{money(totales.base_15)}</td>
                <td className="r">{money(totales.iva_15)}</td>
                <td className="r">{money(totales.base_5)}</td>
                <td className="r">{money(totales.iva_5)}</td>
                <td className="r total">{money(totales.importe_total)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
