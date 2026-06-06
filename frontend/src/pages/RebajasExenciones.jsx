import { useState, useEffect, useCallback, useMemo } from 'react'
import { useOutletContext } from 'react-router-dom'
import { rebajasAPI, productsAPI } from '../services/api'
import { useClients } from '../context/ClientContext'
import ClientSwitcher from '../components/ClientSwitcher'
import './RebajasExenciones.css'

const EMPTY = { ingrediente: '', ruc_proveedor: '', proveedor_nombre: '', cantidad: '', unidad: 'ml', origen: 'NACIONAL', calificado: false }
const esAgua = (nombre) => (nombre || '').trim().toUpperCase() === 'AGUA'
const MINPROD = 'https://servicios.produccion.gob.ec/rum/publico/consultaCategorizacion.jsf'
const UMBRAL = 70 // % mínimo de materia prima nacional calificada

export default function RebajasExenciones() {
  const { openNewClient } = useOutletContext()
  const { clients, selectedClient, selectClient } = useClients()
  const ident = selectedClient?.identificacion

  const [productos, setProductos] = useState([])
  const [producto, setProducto] = useState('')
  const [ings, setIngs] = useState([])
  const [form, setForm] = useState(EMPTY)

  // Productos del catálogo del cliente
  useEffect(() => {
    if (!ident) { setProductos([]); return }
    productsAPI.list(ident).then((r) => setProductos(r.data?.data || [])).catch(() => setProductos([]))
  }, [ident])

  const loadIngs = useCallback(async () => {
    if (!ident || !producto) { setIngs([]); return }
    const res = await rebajasAPI.list(ident, producto)
    setIngs(res.data?.data || [])
  }, [ident, producto])
  useEffect(() => { loadIngs() }, [loadIngs])

  const agregar = async () => {
    if (!producto) { alert('Elige un producto del catálogo.'); return }
    if (!form.ingrediente.trim()) { alert('Ingresa el ingrediente.'); return }
    try {
      await rebajasAPI.create({ identificacion: ident, producto, ...form, cantidad: parseFloat(form.cantidad) || 0 })
      setForm(EMPTY)
      await loadIngs()
    } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
  }
  const borrar = async (id) => {
    try { await rebajasAPI.delete(id); await loadIngs() }
    catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
  }

  const resumen = useMemo(() => {
    const sum = (arr) => arr.reduce((s, i) => s + (parseFloat(i.cantidad) || 0), 0)
    const noAgua = ings.filter((i) => !esAgua(i.ingrediente))
    const total = sum(noAgua)
    const calif = sum(noAgua.filter((i) => i.calificado))
    const pct = total ? (calif / total) * 100 : 0
    return { total, calif, pct, cumple: pct >= UMBRAL }
  }, [ings])

  // Incidencia (%) de cada fila: agua = 0, no calificado = 0, resto = cantidad/total
  const incidencia = (i) => {
    if (esAgua(i.ingrediente) || !i.calificado || !resumen.total) return 0
    return (parseFloat(i.cantidad) || 0) / resumen.total * 100
  }

  if (!selectedClient) {
    return (
      <div className="re-page">
        <div className="re-welcome">
          <h1>⚖️ Rebajas y exenciones</h1>
          <p>Selecciona un contribuyente para calcular el porcentaje de materia prima nacional de sus productos.</p>
          <button className="re-btn primary" onClick={openNewClient}>＋ Nuevo cliente</button>
        </div>
        {clients.length > 0 && (
          <div className="re-grid">
            {clients.map((c) => (
              <button key={c.id} className="re-card" onClick={() => selectClient(c.id)}>
                <div className="re-card-id">{c.identificacion}</div>
                <div className="re-card-name">{c.nombre}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="re-page">
      <header className="re-header">
        <div>
          <h1>⚖️ Rebajas y exenciones</h1>
          <p className="re-sub"><strong>{selectedClient.identificacion}</strong> — {selectedClient.nombre}</p>
        </div>
      </header>

      <ClientSwitcher onNewClient={openNewClient} />

      <div className="re-prodsel">
        <label>Producto</label>
        <input
          list="re-prod-list"
          value={producto}
          onChange={(e) => setProducto(e.target.value.toUpperCase())}
          placeholder="Escribe el producto o elígelo del catálogo…"
        />
        <datalist id="re-prod-list">
          {productos.map((p) => <option key={p.id} value={p.nombre} />)}
        </datalist>
        <span className="re-hint">Puedes elegir uno del catálogo del cliente o escribir el nombre.</span>
      </div>

      {/* Normas de aplicación (arriba) */}
      <details className="re-normas" open>
        <summary>📖 Normas de aplicación</summary>
        <div className="re-normas-body">
          <p><strong>Rebaja / exención de ICE por componente nacional.</strong> Para acceder al beneficio, el producto debe elaborarse con al menos <strong>{UMBRAL}%</strong> de materia prima nacional proveniente de <strong>proveedores categorizados (calificados)</strong> por el Ministerio de Producción.</p>
          <ul>
            <li>Los ingredientes se ingresan <strong>por botella/envase</strong> con su cantidad.</li>
            <li>El <strong>agua no se contabiliza</strong> (incidencia 0%).</li>
            <li>Un ingrediente <strong>no calificado</strong> tiene incidencia <strong>0%</strong>.</li>
            <li>El <strong>%</strong> de cada fila = cantidad ÷ total (sin agua); la suma es el <strong>% nacional calificado</strong>.</li>
          </ul>
          <p>La categorización del proveedor (empresa o persona natural) se verifica por RUC en el Ministerio de Producción:
            {' '}<a href={MINPROD} target="_blank" rel="noreferrer">Consulta de categorización ↗</a></p>
          <p className="re-normas-nota">Nota: los porcentajes y la regla son configurables; verifica la normativa vigente del SRI/Ministerio antes de aplicar el beneficio.</p>
        </div>
      </details>

      {selectedClient && (
        <>
          <div className="re-form">
            <label className="re-f"><span>RUC proveedor</span>
              <input value={form.ruc_proveedor} onChange={(e) => setForm({ ...form, ruc_proveedor: e.target.value })} placeholder="RUC" /></label>
            <a className="re-verif" href={MINPROD} target="_blank" rel="noreferrer" title="Verificar categorización en el Ministerio de Producción">🔎 Verificar</a>
            <label className="re-f"><span>¿Calificado?</span>
              <span className="re-check"><input type="checkbox" checked={form.calificado} onChange={(e) => setForm({ ...form, calificado: e.target.checked })} /> {form.calificado ? 'Sí' : 'No'}</span></label>
            <label className="re-f wide"><span>Empresa / Persona</span>
              <input value={form.proveedor_nombre} onChange={(e) => setForm({ ...form, proveedor_nombre: e.target.value.toUpperCase() })} placeholder="Nombre del proveedor" /></label>
            <label className="re-f wide"><span>Producto / Ingrediente</span>
              <input value={form.ingrediente} onChange={(e) => setForm({ ...form, ingrediente: e.target.value.toUpperCase() })} placeholder="Ej. ALCOHOL, JUGO, AGUA…" /></label>
            <label className="re-f s"><span>Cantidad</span>
              <input type="number" step="0.01" value={form.cantidad} onChange={(e) => setForm({ ...form, cantidad: e.target.value })} /></label>
            <label className="re-f s"><span>Unidad</span>
              <input value={form.unidad} onChange={(e) => setForm({ ...form, unidad: e.target.value })} /></label>
            <button className="re-btn primary" onClick={agregar}>＋ Agregar</button>
          </div>

          <div className="re-table-wrap">
            <table className="re-table">
              <thead><tr>
                <th>RUC</th><th>Calificado</th><th>Empresa / Persona</th><th>Producto</th>
                <th className="r">Cantidad</th><th className="r">%</th><th></th>
              </tr></thead>
              <tbody>
                {ings.length === 0 ? (
                  <tr><td colSpan={7} className="re-empty">Sin ingredientes. Agrega el primero con el formulario.</td></tr>
                ) : ings.map((i) => {
                  const agua = esAgua(i.ingrediente)
                  return (
                    <tr key={i.id} className={agua ? 'agua' : ''}>
                      <td>{i.ruc_proveedor || '—'}</td>
                      <td>
                        <span className={`re-badge ${i.calificado ? 'ok' : 'no'}`}>{i.calificado ? 'Calificado' : 'No calificado'}</span>
                        {i.ruc_proveedor && <a className="re-vlink" href={MINPROD} target="_blank" rel="noreferrer" title="Verificar en Min. Producción">🔎</a>}
                      </td>
                      <td>{i.proveedor_nombre || '—'}</td>
                      <td>{i.ingrediente}{agua && <em> (no cuenta)</em>}</td>
                      <td className="r">{(parseFloat(i.cantidad) || 0).toFixed(2)} {i.unidad}</td>
                      <td className="r strong">{incidencia(i).toFixed(2)}%</td>
                      <td><button className="re-del" onClick={() => borrar(i.id)}>✕</button></td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="re-foot">
                  <td colSpan={4}>
                    TOTAL · <span className={`re-cumple ${resumen.cumple ? 'ok' : 'no'}`}>{resumen.cumple ? `✔ Cumple (≥ ${UMBRAL}%)` : `✗ No cumple (mín. ${UMBRAL}%)`}</span>
                  </td>
                  <td className="r">{resumen.total.toFixed(2)}</td>
                  <td className="r">{resumen.pct.toFixed(2)}%</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
