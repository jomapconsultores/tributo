import { useState, useEffect, useMemo } from 'react'
import { reportesAPI, odooAPI } from '../services/api'
import './OdooFacturacion.css'

const IVA = 0.15

function fmtMoney(v) {
  return `$${Number(v || 0).toFixed(2)}`
}

export default function OdooFacturacion() {
  const [filas, setFilas] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [seleccionados, setSeleccionados] = useState(new Set())
  const [enviando, setEnviando] = useState(false)
  const [resultados, setResultados] = useState(null)
  const [estadoOdoo, setEstadoOdoo] = useState(null)
  const [companias, setCompanias] = useState([])   // empresas EMISORAS (compañías Odoo)
  const [companyId, setCompanyId] = useState('')    // emisor elegido
  const [productos, setProductos] = useState([])    // productos/servicios existentes en Odoo
  const [prodSel, setProdSel] = useState({})        // { "ruc|concepto": product_id }  (mapeo manual)
  const [verProductos, setVerProductos] = useState(false)

  useEffect(() => {
    // Cargamos cobros y estado Odoo por separado para que un fallo
    // en Odoo no bloquee la visualización de los honorarios.
    reportesAPI.cobros()
      .then((r) => {
        const data = r.data.data || []
        setFilas(data)
        // Pre-marcar TODAS las empresas que tienen valor a facturar
        setSeleccionados(new Set(data.filter((f) => f.cobrar && f.valor > 0).map((f) => f.identificacion)))
      })
      .catch((e) => setError(e.response?.data?.detail || e.message))
      .finally(() => setLoading(false))

    odooAPI.estado()
      .then((r) => setEstadoOdoo(r.data))
      .catch(() => setEstadoOdoo({ ok: false, error: 'No disponible' }))

    // Empresas emisoras (compañías Odoo) y productos existentes en Odoo
    odooAPI.empresas()
      .then((r) => {
        const list = r.data?.data || []
        setCompanias(list)
        // Emisor por defecto: la primera que tenga "ASOCIADOS", o la primera de la lista
        const def = list.find((c) => /asociad/i.test(c.name)) || list[0]
        if (def) setCompanyId((prev) => prev || String(def.id))
      })
      .catch(() => setCompanias([]))
    odooAPI.productos()
      .then((r) => setProductos(r.data?.data || []))
      .catch(() => setProductos([]))
  }, [])

  // Agrupar filas por contribuyente — solo cobrar=true y valor>0
  const grupos = useMemo(() => {
    const m = {}
    for (const f of filas) {
      if (!f.cobrar || !(f.valor > 0)) continue
      if (!m[f.identificacion]) {
        m[f.identificacion] = { ruc: f.identificacion, nombre: f.contribuyente, lineas: [], total: 0 }
      }
      // IVA por ítem: 'bruto' = total con IVA; 'base' = neto (Odoo agrega el 15% sobre la base).
      const bruto = f.iva_incluido ? f.valor : Math.round(f.valor * (1 + IVA) * 100) / 100
      const base = Math.round((bruto / (1 + IVA)) * 100) / 100
      m[f.identificacion].lineas.push({ concepto: f.concepto, valor: base, iva_incluido: f.iva_incluido })
      m[f.identificacion].total = +(m[f.identificacion].total + bruto).toFixed(2)
    }
    return Object.values(m).sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''))
  }, [filas])

  const toggleTodos = () => {
    if (seleccionados.size === grupos.length) {
      setSeleccionados(new Set())
    } else {
      setSeleccionados(new Set(grupos.map((g) => g.ruc)))
    }
  }

  const toggle = (ruc) => {
    const s = new Set(seleccionados)
    if (s.has(ruc)) s.delete(ruc)
    else s.add(ruc)
    setSeleccionados(s)
  }

  const facturasSeleccionadas = grupos.filter((g) => seleccionados.has(g.ruc))
  const totalSeleccionado = facturasSeleccionadas.reduce((acc, g) => acc + g.total, 0)

  const enviar = async () => {
    if (!facturasSeleccionadas.length) return
    setEnviando(true)
    setResultados(null)
    try {
      const r = await odooAPI.facturar({
        company_id: companyId ? Number(companyId) : null,   // empresa EMISORA
        facturas: facturasSeleccionadas.map((g) => ({
          ruc: g.ruc,            // receptor = el contribuyente del honorario
          nombre: g.nombre,
          lineas: g.lineas.map((l) => ({
            concepto: l.concepto,
            valor: l.valor,       // base neta; Odoo agrega el IVA 15%
            product_id: prodSel[`${g.ruc}|${l.concepto}`] || null,  // producto Odoo (o se crea)
          })),
          iva_incluido: false,
        })),
      })
      setResultados(r.data.resultados || [])
    } catch (e) {
      setResultados([{ ok: false, error: e.response?.data?.detail || e.message }])
    } finally {
      setEnviando(false)
    }
  }

  if (loading) return <div className="of-loading">Cargando honorarios…</div>
  if (error) return <div className="of-error">Error: {error}</div>

  const okCount = resultados?.filter((r) => r.ok).length ?? 0
  const errCount = resultados?.filter((r) => !r.ok).length ?? 0

  return (
    <div className="of-wrap">
      <div className="of-header">
        <div>
          <h1 className="of-title">Facturación Odoo</h1>
          <p className="of-sub">Crea y confirma facturas de honorarios directamente en Odoo.</p>
        </div>
        <div className={`of-badge-odoo ${estadoOdoo?.ok ? 'ok' : 'fail'}`}>
          {estadoOdoo?.ok
            ? `Odoo conectado · ${estadoOdoo.db}`
            : 'Odoo no disponible'}
        </div>
      </div>

      {grupos.length === 0 ? (
        <div className="of-empty">
          <span className="of-empty-ico">📋</span>
          <p>No hay honorarios marcados para cobrar.</p>
          <p className="of-empty-hint">Activa "Cobrar" y establece valores en el módulo Reportes.</p>
        </div>
      ) : (
        <>
          {/* Empresa EMISORA (compañía Odoo) + ver productos existentes */}
          <div className="of-emisor-bar">
            <label className="of-emisor">
              <span>🏢 Empresa que factura (emisor):</span>
              <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
                {companias.length === 0 && <option value="">(cargando…)</option>}
                {companias.map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
              </select>
            </label>
            <button type="button" className="of-ver-prod" onClick={() => setVerProductos((v) => !v)}>
              {verProductos ? 'Ocultar' : 'Ver'} productos de Odoo ({productos.length})
            </button>
          </div>
          {verProductos && (
            <div className="of-prod-panel">
              <div className="of-prod-panel-head">Productos / servicios que ya existen en Odoo ({productos.length})</div>
              <div className="of-prod-list">
                {productos.map((p) => <span key={p.id} className="of-prod-chip">{p.name}</span>)}
                {productos.length === 0 && <span className="of-dim">No se pudieron cargar productos de Odoo.</span>}
              </div>
            </div>
          )}

          {/* Barra de acciones */}
          <div className="of-toolbar">
            <label className="of-check-all">
              <input
                type="checkbox"
                checked={seleccionados.size === grupos.length && grupos.length > 0}
                onChange={toggleTodos}
              />
              Seleccionar todos ({grupos.length})
            </label>
            <div className="of-toolbar-right">
              {facturasSeleccionadas.length > 0 && (
                <span className="of-sel-info">
                  {facturasSeleccionadas.length} factura{facturasSeleccionadas.length !== 1 ? 's' : ''} · {fmtMoney(totalSeleccionado)}
                </span>
              )}
              <button
                className="of-btn-enviar"
                onClick={enviar}
                disabled={enviando || !facturasSeleccionadas.length || !estadoOdoo?.ok}
                title={!estadoOdoo?.ok ? 'Odoo no disponible' : ''}
              >
                {enviando ? 'Enviando…' : `Crear en Odoo (${facturasSeleccionadas.length})`}
              </button>
            </div>
          </div>

          {/* Resultado del envío */}
          {resultados && (
            <div className="of-resultados">
              <div className="of-res-summary">
                {okCount > 0 && <span className="of-res-ok">✓ {okCount} factura{okCount !== 1 ? 's' : ''} creada{okCount !== 1 ? 's' : ''}</span>}
                {errCount > 0 && <span className="of-res-err">✗ {errCount} error{errCount !== 1 ? 'es' : ''}</span>}
              </div>
              {resultados.map((r, i) => (
                <div key={i} className={`of-res-row ${r.ok ? 'ok' : 'err'}`}>
                  {r.ok ? (
                    <>
                      <span className="of-res-ico">✓</span>
                      <span className="of-res-nombre">{r.nombre}</span>
                      <span className="of-res-num">{r.numero}</span>
                      <span className="of-res-total">{fmtMoney(r.total)}</span>
                    </>
                  ) : (
                    <>
                      <span className="of-res-ico">✗</span>
                      <span className="of-res-nombre">{r.nombre || r.ruc}</span>
                      <span className="of-res-error">{r.error}</span>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Tabla de contribuyentes */}
          <div className="of-grupos">
            {grupos.map((g) => {
              const sel = seleccionados.has(g.ruc)
              const base = +(g.total / (1 + IVA)).toFixed(2)
              const iva = +(g.total - base).toFixed(2)
              return (
                <div key={g.ruc} className={`of-grupo ${sel ? 'selected' : ''}`}>
                  <div className="of-grupo-header">
                    <div className="of-grupo-info">
                      <span className="of-grupo-nombre">Honorarios de: {g.nombre || '(sin nombre)'}</span>
                      <span className="of-grupo-ruc">Contribuyente · RUC {g.ruc}</span>
                    </div>
                    <div className="of-grupo-total">
                      <span className="of-grupo-monto">{fmtMoney(g.total)}</span>
                      <span className="of-iva-tag" title="El total ya incluye el IVA 15%">con IVA</span>
                    </div>
                    <button
                      type="button"
                      className={`of-marcar ${sel ? 'on' : ''}`}
                      onClick={() => toggle(g.ruc)}
                      title={sel ? 'Se incluirá en la facturación — clic para quitar' : 'Clic para incluir en la facturación'}
                    >
                      {sel ? '✔ Marcada para facturar' : '○ Marcar para facturar'}
                    </button>
                  </div>

                  <div className="of-lineas">
                    {g.lineas.map((l, li) => {
                      const pkey = `${g.ruc}|${l.concepto}`
                      return (
                      <div key={li} className="of-linea">
                        <span className="of-linea-concepto">
                          {l.concepto}
                          <span className="of-linea-iva">{l.iva_incluido ? 'IVA incl.' : '+IVA'}</span>
                        </span>
                        <select
                          className="of-linea-prod"
                          value={prodSel[pkey] || ''}
                          onChange={(e) => setProdSel((p) => ({ ...p, [pkey]: e.target.value }))}
                          title="Producto de Odoo para este concepto. Si lo dejas en 'Crear nuevo', Odoo lo crea con el nombre del concepto."
                        >
                          <option value="">➕ Crear nuevo: «{l.concepto}»</option>
                          {productos.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                        <span className="of-linea-valor" title="Base imponible (Odoo agrega el IVA)">{fmtMoney(l.valor)}</span>
                      </div>
                      )
                    })}
                    <div className="of-desglose">
                      <span>Base imponible</span><span>{fmtMoney(base)}</span>
                      <span>IVA 15%</span><span>{fmtMoney(iva)}</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
