import { useState, useEffect, useCallback, useMemo } from 'react'
import { useOutletContext } from 'react-router-dom'
import { rebajasAPI, productsAPI } from '../services/api'
import { useClients } from '../context/ClientContext'
import ClientSwitcher from '../components/ClientSwitcher'
import './RebajasExenciones.css'

const EMPTY = { ingrediente: '', ruc_proveedor: '', cantidad: '', unidad: 'ml', origen: 'NACIONAL', calificado: false }
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
    const noAgua = ings.filter((i) => !esAgua(i.ingrediente))
    const sum = (arr) => arr.reduce((s, i) => s + (parseFloat(i.cantidad) || 0), 0)
    const total = sum(noAgua)
    const nacional = sum(noAgua.filter((i) => i.origen === 'NACIONAL'))
    const nacCalif = sum(noAgua.filter((i) => i.origen === 'NACIONAL' && i.calificado))
    const externo = sum(noAgua.filter((i) => i.origen === 'EXTERNO'))
    const pctNacCalif = total ? (nacCalif / total) * 100 : 0
    return {
      total, nacional, nacCalif, externo,
      pctNac: total ? (nacional / total) * 100 : 0,
      pctNacCalif,
      cumple: pctNacCalif >= UMBRAL,
    }
  }, [ings])

  const nacionales = ings.filter((i) => i.origen === 'NACIONAL')
  const externos = ings.filter((i) => i.origen === 'EXTERNO')

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
        <label>Producto (del catálogo)</label>
        <select value={producto} onChange={(e) => setProducto(e.target.value)}>
          <option value="">{productos.length ? 'Elige un producto…' : 'Sin productos en el catálogo'}</option>
          {productos.map((p) => <option key={p.id} value={p.nombre}>{p.nombre}</option>)}
        </select>
        {productos.length === 0 && <span className="re-hint">Agrega productos en "Catálogo de productos" primero.</span>}
      </div>

      {producto && (
        <>
          <p className="re-note">Ingresa los ingredientes <strong>por botella/envase</strong> con su origen. El <strong>agua no se considera</strong> en el cálculo (escribe "AGUA" para excluirla).</p>

          <div className="re-form">
            <label className="re-f wide"><span>Ingrediente</span>
              <input value={form.ingrediente} onChange={(e) => setForm({ ...form, ingrediente: e.target.value.toUpperCase() })} placeholder="Ej. ALCOHOL, JUGO…" /></label>
            <label className="re-f"><span>RUC proveedor</span>
              <input value={form.ruc_proveedor} onChange={(e) => setForm({ ...form, ruc_proveedor: e.target.value })} placeholder="RUC del proveedor" /></label>
            <a className="re-verif" href={MINPROD} target="_blank" rel="noreferrer" title="Verificar categorización en el Ministerio de Producción">🔎 Verificar</a>
            <label className="re-f s"><span>Cantidad</span>
              <input type="number" step="0.01" value={form.cantidad} onChange={(e) => setForm({ ...form, cantidad: e.target.value })} /></label>
            <label className="re-f s"><span>Unidad</span>
              <input value={form.unidad} onChange={(e) => setForm({ ...form, unidad: e.target.value })} /></label>
            <label className="re-f"><span>Origen</span>
              <select value={form.origen} onChange={(e) => setForm({ ...form, origen: e.target.value })}>
                <option value="NACIONAL">Nacional</option>
                <option value="EXTERNO">Externo</option>
              </select></label>
            {form.origen === 'NACIONAL' && (
              <label className="re-f"><span>¿Calificado?</span>
                <span className="re-check"><input type="checkbox" checked={form.calificado} onChange={(e) => setForm({ ...form, calificado: e.target.checked })} /> {form.calificado ? 'Sí' : 'No'}</span></label>
            )}
            <button className="re-btn primary" onClick={agregar}>＋ Agregar</button>
          </div>

          {/* Dos columnas: nacionales / externos */}
          <div className="re-cols">
            <div className="re-col nac">
              <h3>🟢 Productos nacionales</h3>
              {nacionales.length === 0 ? <div className="re-empty">—</div> : nacionales.map((i) => (
                <div key={i.id} className={`re-ing ${esAgua(i.ingrediente) ? 'agua' : ''}`}>
                  <span className="re-ing-name">{i.ingrediente}{esAgua(i.ingrediente) && <em> (no cuenta)</em>}
                    {i.ruc_proveedor && <span className="re-ruc">RUC {i.ruc_proveedor} <a href={MINPROD} target="_blank" rel="noreferrer" title="Verificar en Min. Producción">🔎</a></span>}
                  </span>
                  <span className="re-ing-cant">{(parseFloat(i.cantidad) || 0).toFixed(2)} {i.unidad}</span>
                  <span className={`re-badge ${i.calificado ? 'ok' : 'no'}`}>{i.calificado ? 'Calificado' : 'No calificado'}</span>
                  <button className="re-del" onClick={() => borrar(i.id)}>✕</button>
                </div>
              ))}
            </div>
            <div className="re-col ext">
              <h3>🔴 Productos externos</h3>
              {externos.length === 0 ? <div className="re-empty">—</div> : externos.map((i) => (
                <div key={i.id} className={`re-ing ${esAgua(i.ingrediente) ? 'agua' : ''}`}>
                  <span className="re-ing-name">{i.ingrediente}{esAgua(i.ingrediente) && <em> (no cuenta)</em>}
                    {i.ruc_proveedor && <span className="re-ruc">RUC {i.ruc_proveedor} <a href={MINPROD} target="_blank" rel="noreferrer" title="Verificar en Min. Producción">🔎</a></span>}
                  </span>
                  <span className="re-ing-cant">{(parseFloat(i.cantidad) || 0).toFixed(2)} {i.unidad}</span>
                  <button className="re-del" onClick={() => borrar(i.id)}>✕</button>
                </div>
              ))}
            </div>
          </div>

          {/* Resultado */}
          <div className="re-result">
            <div className="re-res-box"><span className="re-res-lbl">% Nacional</span><span className="re-res-val">{resumen.pctNac.toFixed(2)}%</span></div>
            <div className="re-res-box hi"><span className="re-res-lbl">% Nacional calificado</span><span className="re-res-val">{resumen.pctNacCalif.toFixed(2)}%</span></div>
            <div className={`re-cumple ${resumen.cumple ? 'ok' : 'no'}`}>
              {resumen.cumple ? `✔ Cumple la norma (≥ ${UMBRAL}%)` : `✗ No cumple (mínimo ${UMBRAL}%)`}
            </div>
            <div className="re-res-sub">
              Total (sin agua): {resumen.total.toFixed(2)} · Nacional: {resumen.nacional.toFixed(2)} · Nacional calificado: {resumen.nacCalif.toFixed(2)} · Externo: {resumen.externo.toFixed(2)}
            </div>
          </div>
        </>
      )}

      {/* Normas de aplicación */}
      <details className="re-normas">
        <summary>📖 Normas de aplicación y tablas</summary>
        <div className="re-normas-body">
          <p><strong>Rebaja / exención de ICE por componente nacional.</strong> Para acceder al beneficio, el producto debe elaborarse con al menos <strong>{UMBRAL}%</strong> de materia prima nacional proveniente de <strong>proveedores categorizados (calificados)</strong> por el Ministerio de Producción.</p>
          <ul>
            <li>Los ingredientes se ingresan <strong>por botella/envase</strong> con su cantidad.</li>
            <li>El <strong>agua no se contabiliza</strong> en el cálculo.</li>
            <li>Un ingrediente nacional <strong>no calificado</strong> no suma como nacional calificado.</li>
            <li>El <strong>% nacional calificado</strong> = (nacional y calificado, sin agua) ÷ (total sin agua).</li>
          </ul>
          <p>La categorización del proveedor (empresa o persona natural) se verifica por RUC en el Ministerio de Producción:
            {' '}<a href={MINPROD} target="_blank" rel="noreferrer">Consulta de categorización ↗</a></p>
          <p className="re-normas-nota">Nota: los porcentajes y la regla son configurables; verifica la normativa vigente del SRI/Ministerio antes de aplicar el beneficio.</p>
        </div>
      </details>
    </div>
  )
}
