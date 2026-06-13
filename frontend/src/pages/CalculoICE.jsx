import { useState, useEffect, useCallback, useMemo } from 'react'
import { useOutletContext } from 'react-router-dom'
import { iceCalcAPI, productsAPI, downloadBlob } from '../services/api'
import { useClients } from '../context/ClientContext'
import { periodoLargo, MESES } from '../utils/periodo'
import { calcRow, ivaRate, CATEGORIAS, CAT_LABEL } from '../utils/iceCalc'
import ClientSwitcher from '../components/ClientSwitcher'
import './CalculoICE.css'

import { fmtMoney as money } from '../utils/format'

const ANIOS = ['2021', '2022', '2023', '2024', '2025', '2026']

const EMPTY = {
  producto: '', categoria: 'ALCOHOLICA', por_cajas: true,
  cajas: 1, botellas_por_caja: 12, unidades: 0, grado: 15, capacidad: 750, precio: 0,
  anio: 2026, mes: 1,
}

export default function CalculoICE() {
  const { openNewClient } = useOutletContext()
  const { clients, selectedClient, selectedClientId, selectClient } = useClients()

  const [rows, setRows] = useState([])
  const [form, setForm] = useState(EMPTY)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [catalogo, setCatalogo] = useState([])
  const [editId, setEditId] = useState(null)

  // Catálogo de productos del cliente
  useEffect(() => {
    const id = selectedClient?.identificacion
    if (!id) { setCatalogo([]); return }
    productsAPI.list(id).then((r) => setCatalogo(r.data?.data || [])).catch(() => setCatalogo([]))
  }, [selectedClient])

  const anio = selectedClient?.periodo_anio || 2026
  const mes = selectedClient?.periodo_mes || 1
  const iva = ivaRate(form.anio, form.mes)

  const load = useCallback(async () => {
    if (!selectedClientId) { setRows([]); return }
    setLoading(true)
    try {
      const res = await iceCalcAPI.list(selectedClientId)
      setRows(res.data?.data || [])
    } finally { setLoading(false) }
  }, [selectedClientId])

  useEffect(() => { load() }, [load])

  // El período del formulario arranca con el del cliente, pero se puede cambiar
  useEffect(() => {
    if (selectedClient) setForm((f) => ({ ...f, anio: selectedClient.periodo_anio || 2026, mes: selectedClient.periodo_mes || 1 }))
  }, [selectedClientId, selectedClient])

  const agregar = async () => {
    setSaving(true)
    try {
      if (editId) await iceCalcAPI.update(editId, form)
      else await iceCalcAPI.create({ client_id: selectedClientId, ...form })
      setForm((f) => ({ ...EMPTY, categoria: f.categoria, por_cajas: f.por_cajas, anio: f.anio, mes: f.mes }))
      setEditId(null)
      await load()
    } catch (e) {
      alert('Error: ' + (e.response?.data?.detail || e.message))
    } finally { setSaving(false) }
  }
  const editar = (r) => {
    setEditId(r.id)
    setForm({
      producto: r.producto || '', categoria: r.categoria || 'ALCOHOLICA', por_cajas: r.por_cajas !== false,
      cajas: r.cajas ?? 0, botellas_por_caja: r.botellas_por_caja ?? 12, unidades: r.unidades ?? 0,
      grado: r.grado ?? 15, capacidad: r.capacidad ?? 750, precio: r.precio ?? 0,
      anio: r.anio || anio, mes: r.mes || mes,
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const cancelarEdicion = () => { setEditId(null); setForm((f) => ({ ...EMPTY, anio: f.anio, mes: f.mes })) }

  const elegirDelCatalogo = (nombre) => {
    const p = catalogo.find((c) => c.nombre === nombre)
    if (!p) return
    setForm((f) => ({
      ...f, producto: p.nombre,
      grado: p.grado || f.grado, capacidad: p.capacidad || f.capacidad,
      botellas_por_caja: p.botellas_por_caja || f.botellas_por_caja,
    }))
  }

  const borrar = async (id) => {
    try { await iceCalcAPI.delete(id); await load() }
    catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
  }
  const limpiar = async () => {
    if (!window.confirm('¿Eliminar todos los cálculos de este cliente?')) return
    try { await iceCalcAPI.clear(selectedClientId); await load() }
    catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
  }
  const exportar = async (kind) => {
    try {
      const res = kind === 'pdf' ? await iceCalcAPI.exportPdf(selectedClientId) : await iceCalcAPI.exportExcel(selectedClientId)
      downloadBlob(res.data, `${selectedClient?.nombre || 'CalculoICE'}.${kind === 'pdf' ? 'pdf' : 'xlsx'}`, kind === 'pdf' ? 'application/pdf' : undefined)
    } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
  }

  const calc = useMemo(() => rows.map((r) => ({ r, c: calcRow(r, r.anio || anio, r.mes || mes) })), [rows, anio, mes])
  const preview = useMemo(() => calcRow(form, form.anio, form.mes), [form])

  const porCategoria = useMemo(() => {
    const ag = {}
    CATEGORIAS.forEach((c) => { ag[c.key] = { num: 0, subtotal: 0, iceEsp: 0, iceAdv: 0, totalIce: 0, baseIva: 0, iva: 0, pvp: 0 } })
    calc.forEach(({ c }) => {
      const a = ag[c.cat]; a.num++; a.subtotal += c.subtotal; a.iceEsp += c.iceEsp; a.iceAdv += c.iceAdv
      a.totalIce += c.totalIce; a.baseIva += c.baseIva; a.iva += c.iva; a.pvp += c.pvp
    })
    return CATEGORIAS.map((c) => ({ ...c, ...ag[c.key] })).filter((c) => c.num > 0)
  }, [calc])

  const general = useMemo(() => calc.reduce((t, { c }) => ({
    subtotal: t.subtotal + c.subtotal, totalIce: t.totalIce + c.totalIce,
    baseIva: t.baseIva + c.baseIva, iva: t.iva + c.iva, pvp: t.pvp + c.pvp,
  }), { subtotal: 0, totalIce: 0, baseIva: 0, iva: 0, pvp: 0 }), [calc])

  const porProducto = useMemo(() => {
    const ag = {}
    calc.forEach(({ r, c }) => {
      const key = `${(r.producto || '(sin nombre)').toUpperCase()}||${c.cat}`
      const a = ag[key] || (ag[key] = { producto: (r.producto || '(sin nombre)').toUpperCase(), cat: c.cat, bot: 0, subtotal: 0, totalIce: 0, baseIva: 0, iva: 0, pvp: 0 })
      a.bot += c.totalBot; a.subtotal += c.subtotal; a.totalIce += c.totalIce; a.baseIva += c.baseIva; a.iva += c.iva; a.pvp += c.pvp
    })
    return Object.values(ag).sort((x, y) => x.producto.localeCompare(y.producto))
  }, [calc])

  // ----- Sin cliente -----
  if (!selectedClient) {
    return (
      <div className="ci-page">
        <div className="ci-welcome">
          <h1>🧮 Cálculo ICE</h1>
          <p>Selecciona un cliente para calcular y guardar su ICE (por mes y año).</p>
          <button className="ci-btn primary" onClick={openNewClient}>＋ Nuevo cliente</button>
        </div>
        {clients.length > 0 && (
          <div className="ci-client-grid">
            {clients.map((c) => (
              <button key={c.id} className="ci-client-card" onClick={() => selectClient(c.id)}>
                <div className="cc-id">{c.identificacion}</div>
                <div className="cc-name">{c.nombre}</div>
                <div className="cc-per">{periodoLargo(c)}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="ci-page">
      <header className="ci-header">
        <div>
          <h1>🧮 Cálculo ICE</h1>
          <p className="ci-sub">{selectedClient.identificacion} — {selectedClient.nombre} · {periodoLargo(selectedClient)}</p>
        </div>
        <span className="ci-iva">IVA {Math.round(iva * 100)}%</span>
      </header>

      <ClientSwitcher onNewClient={openNewClient} />

      {/* Formulario de producto (con títulos) */}
      <div className="ci-form">
        <label className="ci-field"><span>Año</span>
          <select className="ci-in" value={form.anio} onChange={(e) => setForm({ ...form, anio: parseInt(e.target.value, 10) })}>
            {ANIOS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select></label>
        <label className="ci-field"><span>Mes</span>
          <select className="ci-in" value={form.mes} onChange={(e) => setForm({ ...form, mes: parseInt(e.target.value, 10) })}>
            {MESES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select></label>
        {catalogo.length > 0 && (
          <label className="ci-field"><span>Desde catálogo</span>
            <select className="ci-in" value="" onChange={(e) => { if (e.target.value) elegirDelCatalogo(e.target.value) }}>
              <option value="">Elegir producto…</option>
              {catalogo.map((p) => <option key={p.id} value={p.nombre}>{p.nombre}</option>)}
            </select></label>
        )}
        <label className="ci-field wide"><span>Producto (opcional)</span>
          <input className="ci-in" placeholder="Nombre del producto" value={form.producto}
            onChange={(e) => setForm({ ...form, producto: e.target.value.toUpperCase() })} /></label>
        <label className="ci-field"><span>Categoría</span>
          <select className="ci-in" value={form.categoria} onChange={(e) => setForm({ ...form, categoria: e.target.value })}>
            {CATEGORIAS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select></label>
        <label className="ci-field"><span>¿Vende por cajas?</span>
          <span className="ci-check"><input type="checkbox" checked={form.por_cajas} onChange={(e) => setForm({ ...form, por_cajas: e.target.checked })} /> {form.por_cajas ? 'Sí' : 'No'}</span></label>
        {form.por_cajas ? (
          <>
            <label className="ci-field"><span>Cajas</span><input className="ci-in s" type="number" value={form.cajas} onChange={(e) => setForm({ ...form, cajas: e.target.value })} /></label>
            <label className="ci-field"><span>Botellas por caja</span><input className="ci-in s" type="number" value={form.botellas_por_caja} onChange={(e) => setForm({ ...form, botellas_por_caja: e.target.value })} /></label>
            <label className="ci-field"><span>Precio por caja ($)</span><input className="ci-in s" type="number" step="0.01" value={form.precio} onChange={(e) => setForm({ ...form, precio: e.target.value })} /></label>
          </>
        ) : (
          <>
            <label className="ci-field"><span>Botellas</span><input className="ci-in s" type="number" value={form.unidades} onChange={(e) => setForm({ ...form, unidades: e.target.value })} /></label>
            <label className="ci-field"><span>Precio por botella ($)</span><input className="ci-in s" type="number" step="0.01" value={form.precio} onChange={(e) => setForm({ ...form, precio: e.target.value })} /></label>
          </>
        )}
        <label className="ci-field"><span>Grado alcohólico (%)</span><input className="ci-in s" type="number" value={form.grado} onChange={(e) => setForm({ ...form, grado: e.target.value })} /></label>
        <label className="ci-field"><span>Capacidad (ml)</span><input className="ci-in s" type="number" value={form.capacidad} onChange={(e) => setForm({ ...form, capacidad: e.target.value })} /></label>
        <button className="ci-btn primary ci-add" onClick={agregar} disabled={saving}>{editId ? '💾 Guardar' : '＋ Agregar'}</button>
        {editId && <button className="ci-btn small ci-add" onClick={cancelarEdicion}>Cancelar</button>}
      </div>

      {/* Cálculo en vivo del producto que se está ingresando */}
      <div className="ci-preview">
        <span className="ci-preview-lbl">Cálculo en vivo:</span>
        <span>ICE / Botella <b>{money(preview.icePorBotella)}</b></span>
        {form.por_cajas && <span>ICE / Caja <b>{money(preview.icePorCaja)}</b></span>}
        <span>Botellas <b>{preview.totalBot.toFixed(0)}</b></span>
        <span>ICE Esp. <b>{money(preview.iceEsp)}</b></span>
        <span>ICE AdV <b>{money(preview.iceAdv)}</b>{preview.aplicaAdv ? ' ▲' : ''}</span>
        <span>Total ICE <b className="ci-preview-hi">{money(preview.totalIce)}</b></span>
        <span>IVA <b>{money(preview.iva)}</b></span>
        <span>PVP <b>{money(preview.pvp)}</b></span>
      </div>

      <div className="ci-toolbar">
        <button className="ci-btn small" onClick={() => exportar('excel')}>⬇ Excel</button>
        <button className="ci-btn small" onClick={() => exportar('pdf')}>⬇ PDF</button>
        <button className="ci-btn small danger" onClick={limpiar}>🗑 Limpiar</button>
      </div>

      {/* Resumen por categoría + final */}
      <div className="ci-cats">
        {porCategoria.map((c) => (
          <div key={c.key} className={`ci-cat ${c.key.toLowerCase()}`}>
            <div className="ci-cat-label">{c.label}</div>
            <div className="ci-cat-ice">{money(c.totalIce)}</div>
            <div className="ci-cat-sub">ICE · {c.num} prod · PVP {money(c.pvp)}</div>
          </div>
        ))}
        <div className="ci-cat final">
          <div className="ci-cat-label">VALOR FINAL (Total ICE)</div>
          <div className="ci-cat-ice">{money(general.totalIce)}</div>
          <div className="ci-cat-sub">Base IVA {money(general.baseIva)} · IVA {money(general.iva)} · PVP {money(general.pvp)}</div>
        </div>
      </div>

      {/* Individual */}
      <div className="ci-section">
        <h2 className="ci-h2">Cálculo individual</h2>
        {loading ? <div className="ci-empty">Cargando…</div> : calc.length === 0 ? (
          <div className="ci-empty">Sin productos. Agrega uno con el formulario.</div>
        ) : (
          <div className="ci-scroll">
            <table className="ci-table">
              <thead><tr>
                <th>Período</th><th>Producto</th><th>Categoría</th><th className="r">Botellas</th><th className="r">$/Bot</th>
                <th className="r">ICE/Botella</th><th className="r">ICE/Caja</th>
                <th className="r">ICE Esp.</th><th className="r">ICE AdV</th><th className="r">Total ICE</th>
                <th className="r">Base IVA</th><th className="r">IVA</th><th className="r">PVP</th><th></th>
              </tr></thead>
              <tbody>
                {calc.map(({ r, c }) => (
                  <tr key={r.id}>
                    <td>{(MESES[(r.mes || mes) - 1] || '').slice(0, 3)} {r.anio || anio}</td>
                    <td>{r.producto || '—'}</td>
                    <td>{CAT_LABEL[c.cat]}</td>
                    <td className="r">{c.totalBot.toFixed(0)}</td>
                    <td className="r">{c.precioBot.toFixed(4)}</td>
                    <td className="r">{money(c.icePorBotella)}</td>
                    <td className="r">{r.por_cajas ? money(c.icePorCaja) : '—'}</td>
                    <td className="r">{money(c.iceEsp)}</td>
                    <td className="r">{money(c.iceAdv)}</td>
                    <td className="r strong">{money(c.totalIce)}</td>
                    <td className="r">{money(c.baseIva)}</td>
                    <td className="r">{money(c.iva)}</td>
                    <td className="r">{money(c.pvp)}</td>
                    <td className="ci-acts">
                      <button className="ci-edit" onClick={() => editar(r)} title="Editar">✏️</button>
                      <button className="ci-del" onClick={() => borrar(r.id)} title="Eliminar">✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Por caja */}
      {calc.some(({ r }) => r.por_cajas) && (
        <div className="ci-section">
          <h2 className="ci-h2">Por caja</h2>
          <p className="ci-percaja-note">El ICE se calcula por botella individual y se multiplica por las botellas de la caja.</p>
          <div className="ci-scroll">
            <table className="ci-table">
              <thead><tr>
                <th>Producto</th><th>Categoría</th><th className="r">Bot/Caja</th><th className="r">ICE / Botella</th>
                <th className="r">ICE / Caja</th><th className="r">Cajas</th><th className="r">Total ICE</th>
              </tr></thead>
              <tbody>
                {calc.filter(({ r }) => r.por_cajas).map(({ r, c }) => (
                  <tr key={r.id}>
                    <td>{r.producto || '—'}</td><td>{CAT_LABEL[c.cat]}</td>
                    <td className="r">{(parseFloat(r.botellas_por_caja) || 0).toFixed(0)}</td>
                    <td className="r">{money(c.icePorBotella)}</td>
                    <td className="r">{money(c.icePorCaja)}</td>
                    <td className="r">{(parseFloat(r.cajas) || 0).toFixed(0)}</td>
                    <td className="r strong">{money(c.totalIce)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Por producto */}
      <div className="ci-section">
        <h2 className="ci-h2">Por producto</h2>
        <div className="ci-scroll">
          <table className="ci-table">
            <thead><tr><th>Producto</th><th>Categoría</th><th className="r">Botellas</th><th className="r">Subtotal</th><th className="r">Total ICE</th><th className="r">Base IVA</th><th className="r">IVA</th><th className="r">PVP</th></tr></thead>
            <tbody>
              {porProducto.map((p) => (
                <tr key={`${p.producto}-${p.cat}`}>
                  <td>{p.producto}</td><td>{CAT_LABEL[p.cat]}</td>
                  <td className="r">{p.bot.toFixed(0)}</td><td className="r">{money(p.subtotal)}</td>
                  <td className="r strong">{money(p.totalIce)}</td><td className="r">{money(p.baseIva)}</td>
                  <td className="r">{money(p.iva)}</td><td className="r">{money(p.pvp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
