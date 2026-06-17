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
  const [prodText, setProdText] = useState({})      // { "ruc|concepto": nombre de producto tecleado }
  const [emisorPorGrupo, setEmisorPorGrupo] = useState({})  // { ruc: companyId } — emisor individual
  const [verProductos, setVerProductos] = useState(false)
  const [bancos, setBancos] = useState([])                  // diarios de banco/efectivo
  const [cuentas, setCuentas] = useState({})                // { ruc: {existe, cuenta_id, cuenta_nombre, asignada} }
  const [destino, setDestino] = useState({})                // { ruc: 'cobrar' | journalId } — por cobrar o banco
  const [creandoCta, setCreandoCta] = useState('')

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
      // Precio oficial (base) y descuento %, para que Odoo muestre el descuento.
      const oficialBase = f.precio_oficial > 0
        ? (f.iva_incluido ? Math.round((f.precio_oficial / (1 + IVA)) * 100) / 100 : f.precio_oficial)
        : null
      m[f.identificacion].lineas.push({ concepto: f.concepto, valor: base, iva_incluido: f.iva_incluido, precio_oficial: oficialBase, descuento: f.descuento || 0 })
      m[f.identificacion].total = +(m[f.identificacion].total + bruto).toFixed(2)
    }
    return Object.values(m).sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''))
  }, [filas])

  // Cuentas por cobrar individuales (Odoo) y diarios de banco, para el registro contable
  const rucsKey = grupos.map((g) => g.ruc).join(',')
  useEffect(() => {
    if (!grupos.length) return
    odooAPI.cuentas().then((r) => setBancos(r.data?.bancos || [])).catch(() => {})
    odooAPI.cuentasCobrar(grupos.map((g) => ({ ruc: g.ruc, nombre: g.nombre })))
      .then((r) => setCuentas(r.data?.data || {})).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rucsKey])

  const crearCuenta = async (g) => {
    setCreandoCta(g.ruc)
    try {
      const r = await odooAPI.crearCuentaCobrar(g.ruc, g.nombre)
      setCuentas((prev) => ({ ...prev, [g.ruc]: { ...(prev[g.ruc] || {}), existe: true, cuenta_id: r.data.cuenta_id, cuenta_nombre: r.data.cuenta_nombre, asignada: true } }))
    } catch (e) {
      alert('No se pudo crear la cuenta: ' + (e.response?.data?.detail || e.message))
    } finally { setCreandoCta('') }
  }

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
        company_id: companyId ? Number(companyId) : null,   // emisor por defecto
        facturas: facturasSeleccionadas.map((g) => ({
          ruc: g.ruc,            // receptor = el contribuyente del honorario
          nombre: g.nombre,
          company_id: Number(emisorPorGrupo[g.ruc] || companyId) || null,  // emisor INDIVIDUAL de esta factura
          cuenta_cobrar_id: cuentas[g.ruc]?.cuenta_id || null,             // cuenta por cobrar del cliente
          banco_journal_id: (destino[g.ruc] && destino[g.ruc] !== 'cobrar') ? Number(destino[g.ruc]) : null,  // si va directo a banco
          lineas: g.lineas.map((l) => ({
            concepto: l.concepto,
            valor: l.valor,       // base neta; Odoo agrega el IVA 15%
            precio_oficial: l.precio_oficial,   // price_unit en Odoo (si hay)
            descuento: l.descuento || 0,        // discount % en Odoo
            // nombre del producto a buscar/crear en Odoo (lo tecleado, o el concepto)
            producto_nombre: (prodText[`${g.ruc}|${l.concepto}`] ?? l.concepto),
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
              <span>🏢 Emisor por defecto (aplica a todos):</span>
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
                      {r.cobro_banco === 'registrado'
                        ? <span className="of-res-pago paid" title="Cobro registrado en el banco">💵 cobrada en banco</span>
                        : (r.payment_state === 'not_paid' || r.payment_state === 'partial')
                          ? <span className="of-res-pago pend" title="Queda en cuentas por cobrar">⏳ por cobrar</span>
                          : null}
                      {typeof r.cobro_banco === 'string' && r.cobro_banco.startsWith('error') &&
                        <span className="of-res-pago err" title={r.cobro_banco}>⚠ no se registró el cobro</span>}
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

          {/* Lista de productos de Odoo para autocompletar al teclear */}
          <datalist id="of-odoo-prods">
            {productos.map((p) => <option key={p.id} value={p.name} />)}
          </datalist>

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

                  {/* Emisor INDIVIDUAL de esta factura */}
                  <div className="of-receptor">
                    <label htmlFor={`emi-${g.ruc}`}>🏢 Factura desde:</label>
                    <select
                      id={`emi-${g.ruc}`}
                      value={emisorPorGrupo[g.ruc] ?? companyId}
                      onChange={(e) => setEmisorPorGrupo((p) => ({ ...p, [g.ruc]: e.target.value }))}
                    >
                      {companias.map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
                    </select>
                  </div>

                  {/* Registro contable: cuenta por cobrar del cliente + destino (por cobrar / banco) */}
                  <div className="of-contable">
                    <div className="of-cuenta">
                      <span className="of-cuenta-lbl">📒 Registro contable:</span>
                      {cuentas[g.ruc]?.existe ? (
                        <span className="of-cuenta-ok" title={cuentas[g.ruc].asignada ? 'Ya asignada al cliente' : 'Se asignará al cliente al facturar'}>
                          {cuentas[g.ruc].cuenta_codigo ? `${cuentas[g.ruc].cuenta_codigo} · ` : ''}{cuentas[g.ruc].cuenta_nombre}
                        </span>
                      ) : (
                        <span className="of-cuenta-falta">
                          ⚠ No tiene cuenta por cobrar propia
                          <button type="button" className="of-cuenta-crear" disabled={creandoCta === g.ruc}
                            onClick={() => crearCuenta(g)}>
                            {creandoCta === g.ruc ? 'creando…' : `Crear "Cuentas por cobrar ${g.nombre}"`}
                          </button>
                        </span>
                      )}
                    </div>
                    <div className="of-destino">
                      <label htmlFor={`dest-${g.ruc}`}>Destino:</label>
                      <select id={`dest-${g.ruc}`}
                        value={destino[g.ruc] || 'cobrar'}
                        onChange={(e) => setDestino((p) => ({ ...p, [g.ruc]: e.target.value }))}>
                        <option value="cobrar">Cuentas por cobrar (pendiente)</option>
                        {bancos.map((b) => <option key={b.id} value={String(b.id)}>Cobrado en banco: {b.name}</option>)}
                      </select>
                    </div>
                  </div>

                  <div className="of-lineas">
                    {g.lineas.map((l, li) => {
                      const pkey = `${g.ruc}|${l.concepto}`
                      const txt = prodText[pkey] ?? l.concepto
                      const existe = productos.some((p) => (p.name || '').trim().toLowerCase() === txt.trim().toLowerCase())
                      return (
                      <div key={li} className="of-linea">
                        <span className="of-linea-concepto">
                          {l.concepto}
                          <span className="of-linea-iva">{l.iva_incluido ? 'IVA incl.' : '+IVA'}</span>
                        </span>
                        <span className="of-linea-prodwrap">
                          <input
                            className="of-linea-prod"
                            list="of-odoo-prods"
                            value={txt}
                            onChange={(e) => setProdText((p) => ({ ...p, [pkey]: e.target.value }))}
                            placeholder="Producto en Odoo…"
                            title="Teclea para buscar el producto en Odoo. Si no existe, se crea con ese nombre."
                          />
                          <span className={`of-prod-tag ${existe ? 'ok' : 'new'}`}>{existe ? '✓ existe' : '➕ nuevo'}</span>
                        </span>
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
