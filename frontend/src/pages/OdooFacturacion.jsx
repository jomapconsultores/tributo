import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { reportesAPI, odooAPI } from '../services/api'
import { useClients } from '../context/ClientContext'
import WorkflowGuide from '../components/WorkflowGuide'
import useDraft from '../hooks/useDraft'
import './OdooFacturacion.css'

const IVA = 0.15

function fmtMoney(v) {
  return `$${Number(v || 0).toFixed(2)}`
}

const OF_STEPS = [
  { icon: '📑', label: 'Reportes y cobros', path: '/reportes' },
  { icon: '🧾', label: 'Facturar en Odoo', current: true },
  { icon: '✅', label: 'Facturas procesadas', path: '/facturacion/procesadas' },
  { icon: '🔍', label: 'Cruce mensual', path: '/facturacion/cruce' },
]

export default function OdooFacturacion({ embebido = false }) {
  const navigate = useNavigate()
  const { identsForSvc } = useClients()
  const idents_svc = identsForSvc('declaracion_iva,declaracion_ice,declaracion_renta,devolucion_iva')
  const [filas, setFilas] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [seleccionados, setSeleccionados] = useState(new Set())
  const [enviando, setEnviando] = useState(false)
  const [resultados, setResultados] = useState(null)
  const [estadoOdoo, setEstadoOdoo] = useState(null)
  const [companias, setCompanias] = useState([])   // empresas EMISORAS (compañías Odoo)
  // Opciones del usuario: se autoguardan en el navegador (sobreviven recargas)
  const [companyId, setCompanyId] = useDraft('draft:odoofac:companyId', '')   // emisor elegido
  const [productos, setProductos] = useState([])    // productos/servicios existentes en Odoo
  const [prodText, setProdText] = useDraft('draft:odoofac:prodText', {})       // { "ruc|concepto": nombre de producto tecleado }
  const [emisorPorGrupo, setEmisorPorGrupo] = useDraft('draft:odoofac:emisor', {})  // { ruc: companyId } — emisor individual
  const [verProductos, setVerProductos] = useState(false)
  const [bancosPorEmpresa, setBancosPorEmpresa] = useState({})  // { companyId: [bancos] }
  const [impuestoPorEmpresa, setImpuestoPorEmpresa] = useState({})  // { companyId: bool } — tiene IVA 15% (411,S)
  const [cuentas, setCuentas] = useState({})                // { ruc: {existe, cuenta_id, cuenta_nombre, asignada, siguiente_codigo} }
  const [periodo, setPeriodo] = useState(null)              // período que se está facturando (mes/año)
  const [atrasos, setAtrasos] = useState({})                // { ruc: {total, meses:[...]} } — meses anteriores sin facturar
  const [atrasosOk, setAtrasosOk] = useState(false)         // ¿el cruce con Odoo respondió?
  // Meses ANTERIORES pendientes, cada uno con sus contribuyentes y sus líneas:
  // se emiten por separado, no mezclados con el mes en curso.
  const [mesesPend, setMesesPend] = useState([])
  const [selPend, setSelPend] = useState(new Set())         // "AAAA-MM|ruc" marcados
  const [enviandoMes, setEnviandoMes] = useState('')
  const [resultadosPend, setResultadosPend] = useState({})  // { "AAAA-MM": [resultados] }
  const [destino, setDestino] = useDraft('draft:odoofac:destino', {})           // { ruc: 'cobrar' | journalId } — por cobrar o banco
  const [creandoCta, setCreandoCta] = useState('')

  useEffect(() => {
    // Cargamos cobros y estado Odoo por separado para que un fallo
    // en Odoo no bloquee la visualización de los honorarios.
    reportesAPI.cobros()
      .then((r) => {
        const data = r.data.data || []
        setFilas(data)
        setPeriodo(r.data.periodo || null)   // mes/año que se está facturando
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

    // Meses ANTERIORES que quedaron sin facturar (cruce con Odoo). Es lo que
    // evita que se mezclen períodos: acá se ve qué arrastra cada contribuyente.
    odooAPI.pendientesPorMes(12)
      .then((r) => { setAtrasos(r.data?.data || {}); setAtrasosOk(!!r.data?.odoo_ok) })
      .catch(() => { setAtrasos({}); setAtrasosOk(false) })

    cargarMesesPendientes()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Cada mes anterior sin facturar, con sus líneas, para emitirlo aparte.
  const cargarMesesPendientes = () => {
    odooAPI.porFacturar(12)
      .then((r) => {
        const ms = r.data?.meses || []
        setMesesPend(ms)
        // Vienen todos marcados: lo normal es emitir el mes completo.
        setSelPend(new Set(ms.flatMap((m) => m.contribuyentes.map((c) => `${m.clave}|${c.ruc}`))))
      })
      .catch(() => setMesesPend([]))
  }

  // Agrupar filas por contribuyente — solo cobrar=true, valor>0 y sin factura ya emitida
  const grupos = useMemo(() => {
    const m = {}
    for (const f of filas) {
      if (idents_svc && !idents_svc.has(f.identificacion)) continue
      if (!f.cobrar || !(f.valor > 0) || f.procesado) continue
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
  }, [filas, idents_svc])

  // Empresa emisora de cada grupo (la elegida individualmente, o la global)
  const grupoEmisor = (g) => Number(emisorPorGrupo[g.ruc] || companyId) || null

  // Cuenta por cobrar de cada cliente, en el plan de SU empresa emisora
  const recargarCuentas = () => {
    if (!grupos.length) return
    odooAPI.cuentasCobrar(grupos.map((g) => ({ ruc: g.ruc, nombre: g.nombre, company_id: grupoEmisor(g) })))
      .then((r) => setCuentas(r.data?.data || {})).catch(() => {})
  }

  // Se recarga si cambia el emisor de algún grupo.
  const cuentasKey = grupos.map((g) => `${g.ruc}:${emisorPorGrupo[g.ruc] || companyId}`).join(',')
  useEffect(() => {
    if (!grupos.length) return
    // Bancos por cada empresa emisora distinta
    const empresas = [...new Set(grupos.map((g) => grupoEmisor(g)).filter(Boolean))]
    empresas.forEach((cid) => {
      odooAPI.cuentas(cid).then((r) => {
        setBancosPorEmpresa((p) => ({ ...p, [cid]: r.data?.bancos || [] }))
        setImpuestoPorEmpresa((p) => ({ ...p, [cid]: r.data?.iva_15_s !== false }))
      }).catch(() => {})
    })
    recargarCuentas()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cuentasKey])

  // Código a crear por grupo: si varios clientes de la MISMA empresa no tienen cuenta,
  // se les asigna un número distinto y consecutivo (no el mismo a todos).
  const codigosSugeridos = useMemo(() => {
    const cont = {}   // companyId -> cuántas creaciones pendientes ya se asignaron
    const out = {}
    for (const g of grupos) {
      const info = cuentas[g.ruc]
      if (!info || info.existe || !info.siguiente_codigo) continue
      const cid = grupoEmisor(g)
      const n = cont[cid] || 0
      out[g.ruc] = String(Number(info.siguiente_codigo) + n)
      cont[cid] = n + 1
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grupos, cuentas, emisorPorGrupo, companyId])

  const [creandoCli, setCreandoCli] = useState('')
  const crearCliente = async (g) => {
    setCreandoCli(g.ruc)
    try {
      const r = await odooAPI.crearCliente(g.ruc, g.nombre)
      setCuentas((prev) => ({ ...prev, [g.ruc]: { ...(prev[g.ruc] || {}), partner_id: r.data.partner_id } }))
      recargarCuentas()  // refresca también la cuenta por cobrar ahora que existe el cliente
    } catch (e) {
      alert('No se pudo crear el cliente: ' + (e.response?.data?.detail || e.message))
    } finally { setCreandoCli('') }
  }

  const crearCuenta = async (g) => {
    setCreandoCta(g.ruc)
    try {
      const codigo = codigosSugeridos[g.ruc]
      const r = await odooAPI.crearCuentaCobrar(g.ruc, g.nombre, grupoEmisor(g), codigo || null)
      // marcar como creada y RECARGAR, para que los demás clientes tomen el siguiente número
      setCuentas((prev) => ({ ...prev, [g.ruc]: { ...(prev[g.ruc] || {}), existe: true, cuenta_id: r.data.cuenta_id, cuenta_codigo: r.data.cuenta_codigo, cuenta_nombre: r.data.cuenta_nombre, asignada: true, siguiente_codigo: null } }))
      recargarCuentas()
    } catch (e) {
      alert('No se pudo crear la cuenta: ' + (e.response?.data?.detail || e.message))
    } finally { setCreandoCta('') }
  }

  const toggleTodos = () => {
    if (seleccionados.size >= gruposPorProcesar.length && gruposPorProcesar.length > 0) {
      setSeleccionados(new Set())
    } else {
      setSeleccionados(new Set(gruposPorProcesar.map((g) => g.ruc)))
    }
  }

  const toggle = (ruc) => {
    const s = new Set(seleccionados)
    if (s.has(ruc)) s.delete(ruc)
    else s.add(ruc)
    setSeleccionados(s)
  }

  // Verificación BIDIRECCIONAL con Odoo: los que YA tienen factura de este mes en
  // Odoo se consideran "procesados" y NO se pueden volver a procesar/duplicar.
  const mesActualISO = (new Date()).toISOString().slice(0, 7)
  const esProcesadoEsteMes = (g) => {
    const uf = cuentas[g.ruc]?.ultima_factura
    return !!uf && (uf.fecha || '').slice(0, 7) === mesActualISO
  }
  const verificando = grupos.some((g) => !cuentas[g.ruc])  // aún consultando a Odoo
  const gruposPorProcesar = useMemo(() => grupos.filter((g) => !esProcesadoEsteMes(g)), [grupos, cuentas])
  const gruposProcesados = useMemo(() => grupos.filter((g) => esProcesadoEsteMes(g)), [grupos, cuentas])

  // Sacar de la selección cualquiera que ya esté procesado este mes (no duplicar).
  useEffect(() => {
    const proc = new Set(gruposProcesados.map((g) => g.ruc))
    if (!proc.size) return
    setSeleccionados((prev) => {
      const f = [...prev].filter((r) => !proc.has(r))
      return f.length === prev.size ? prev : new Set(f)
    })
  }, [gruposProcesados])

  const facturasSeleccionadas = gruposPorProcesar.filter((g) => seleccionados.has(g.ruc))
  const totalSeleccionado = facturasSeleccionadas.reduce((acc, g) => acc + g.total, 0)

  const enviar = async () => {
    if (!facturasSeleccionadas.length) return
    setEnviando(true)
    setResultados(null)
    try {
      // 1) Asegurar que cada cliente exista en Odoo ANTES de emitir (antes del SRI).
      const faltantes = facturasSeleccionadas.filter((g) => !cuentas[g.ruc]?.partner_id)
      if (faltantes.length) {
        for (const g of faltantes) {
          try { await odooAPI.crearCliente(g.ruc, g.nombre) } catch { /* el backend igual lo crea al emitir */ }
        }
        await recargarCuentas()
      }
      // 2) Emitir las facturas (se postean y el SRI autoriza).
      const r = await odooAPI.facturar({
        company_id: companyId ? Number(companyId) : null,   // emisor por defecto
        facturas: facturasSeleccionadas.map((g) => ({
          ruc: g.ruc,            // receptor = el contribuyente del honorario
          nombre: g.nombre,
          // Mes de honorarios que cubre (va en la referencia y en el concepto)
          mes: periodo?.mes || null,
          anio: periodo?.anio || null,
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
      const res = r.data.resultados || []
      setResultados(res)
      // Verificar el envío al SRI de las facturas creadas
      verificarSri(res.filter((x) => x.ok && x.odoo_id).map((x) => x.odoo_id))
    } catch (e) {
      setResultados([{ ok: false, error: e.response?.data?.detail || e.message }])
    } finally {
      setEnviando(false)
    }
  }

  // Emisión de un MES ANTERIOR. La factura sale con fecha de hoy —el SRI no
  // autoriza comprobantes fechados hacia atrás— pero declara el mes que cubre en
  // el concepto de cada línea y en su referencia, así el cruce mensual la
  // atribuye a ese mes y no al de emisión.
  const togglePend = (clave, ruc) => {
    setSelPend((prev) => {
      const s = new Set(prev)
      const k = `${clave}|${ruc}`
      if (s.has(k)) s.delete(k)
      else s.add(k)
      return s
    })
  }

  const elegidosDelMes = (m) => m.contribuyentes.filter((c) => selPend.has(`${m.clave}|${c.ruc}`))

  const enviarMes = async (m) => {
    const elegidos = elegidosDelMes(m)
    if (!elegidos.length) return
    if (!window.confirm(
      `Se emitirán ${elegidos.length} factura(s) por los honorarios de ${m.etiqueta}.

` +
      'Salen con fecha de HOY y cada concepto dice el mes que cubre. ¿Continuar?')) return
    setEnviandoMes(m.clave)
    try {
      const r = await odooAPI.facturar({
        company_id: companyId ? Number(companyId) : null,
        facturas: elegidos.map((c) => ({
          ruc: c.ruc,
          nombre: c.nombre,
          mes: m.mes,
          anio: m.anio,
          company_id: Number(emisorPorGrupo[c.ruc] || companyId) || null,
          lineas: c.lineas.map((l) => ({
            concepto: l.concepto,
            // Base neta: si el valor guardado ya trae IVA, se le quita (Odoo lo agrega).
            valor: l.iva_incluido ? Math.round((l.valor / (1 + IVA)) * 100) / 100 : l.valor,
            precio_oficial: l.precio_oficial
              ? (l.iva_incluido ? Math.round((l.precio_oficial / (1 + IVA)) * 100) / 100 : l.precio_oficial)
              : null,
            descuento: l.descuento || 0,
            producto_nombre: l.concepto,
          })),
          iva_incluido: false,
        })),
      })
      const res = r.data.resultados || []
      setResultadosPend((p) => ({ ...p, [m.clave]: res }))
      verificarSri(res.filter((x) => x.ok && x.odoo_id).map((x) => x.odoo_id))
      cargarMesesPendientes()   // lo emitido deja de ofrecerse
    } catch (e) {
      setResultadosPend((p) => ({
        ...p, [m.clave]: [{ ok: false, error: e.response?.data?.detail || e.message }],
      }))
    } finally {
      setEnviandoMes('')
    }
  }

  const [sriEstado, setSriEstado] = useState({})  // { odoo_id: {edi_state, autorizacion, numero} }
  const [verificandoSri, setVerificandoSri] = useState(false)
  const verificarSri = async (ids) => {
    if (!ids || !ids.length) return
    setVerificandoSri(true)
    try {
      const r = await odooAPI.estadoSri(ids)
      const m = {}
      for (const x of (r.data?.data || [])) m[x.id] = x
      setSriEstado((prev) => ({ ...prev, ...m }))
    } catch { /* noop */ } finally { setVerificandoSri(false) }
  }

  if (loading) return <div className="of-loading">Cargando honorarios…</div>
  if (error) return <div className="of-error">Error: {error}</div>

  const okCount = resultados?.filter((r) => r.ok).length ?? 0
  const errCount = resultados?.filter((r) => !r.ok).length ?? 0

  return (
    <div className="of-wrap">
      {!embebido && <WorkflowGuide steps={OF_STEPS} />}
      {!embebido && <div className="of-header">
        <div>
          <h1 className="of-title">Facturación Odoo</h1>
          <p className="of-sub">Crea y confirma facturas de honorarios directamente en Odoo.</p>
        </div>
        <div className={`of-badge-odoo ${estadoOdoo?.ok ? 'ok' : 'fail'}`}>
          {estadoOdoo?.ok
            ? `Odoo conectado · ${estadoOdoo.db}`
            : 'Odoo no disponible'}
        </div>
      </div>}

      {/* Período que se está facturando: sin esto no se sabía a qué mes
          correspondían las facturas que se iban a emitir. */}
      <div className="of-periodo">
        <span className="of-periodo-ico">🗓️</span>
        <span className="of-periodo-txt">
          Se emitirán las facturas del período <strong>{(periodo?.etiqueta || '').toUpperCase()}</strong>
        </span>
        <span className="of-periodo-nota">
          Un contribuyente = una factura de este mes.{mesesPend.length > 0
            ? ` Los ${mesesPend.length} mes(es) anteriores sin facturar se emiten abajo, cada uno por separado.`
            : ' Los meses anteriores se revisan en «Cruce mensual».'}
        </span>
      </div>

      {/* Arrastres: meses anteriores con honorario registrado y sin factura en Odoo */}
      {Object.keys(atrasos).length > 0 && (
        <button type="button" className="of-atrasos-banner" onClick={() => navigate('/facturacion/cruce')}>
          ⚠ {Object.keys(atrasos).length} contribuyente(s) arrastran meses anteriores sin facturar
          {' · '}
          {fmtMoney(Object.values(atrasos).reduce((a, x) => a + (x.total || 0), 0))}
          {mesesPend.length > 0 ? ' — se emiten abajo, mes por mes · ver el cruce ›' : ' — ver el cruce mes a mes ›'}
        </button>
      )}
      {!atrasosOk && (
        <div className="of-atrasos-nota">
          ℹ El cruce con la facturación de Odoo no respondió: los meses anteriores no pudieron verificarse.
        </div>
      )}

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

      {/* MESES ANTERIORES sin facturar: uno por sección, con su propia emisión.
          Antes todo caía en el mismo paquete del mes en curso y no había forma
          de emitir la factura de julio estando en agosto. */}
      {mesesPend.map((m) => {
        const elegidos = elegidosDelMes(m)
        const totalMes = elegidos.reduce((a, c) => a + (c.total || 0), 0)
        const res = resultadosPend[m.clave]
        return (
          <section key={m.clave} className="of-mes">
            <header className="of-mes-head">
              <div>
                <h2 className="of-mes-titulo">🗓️ {m.etiqueta} — sin facturar</h2>
                <p className="of-mes-sub">
                  {m.contribuyentes.length} contribuyente(s) · {fmtMoney(m.total)}.
                  {' '}La factura se emite <strong>hoy</strong> y dice en cada concepto que cubre {m.etiqueta}.
                </p>
              </div>
              <button
                type="button"
                className="of-btn-emitir"
                disabled={!elegidos.length || enviandoMes === m.clave}
                onClick={() => enviarMes(m)}
              >
                {enviandoMes === m.clave
                  ? 'Emitiendo…'
                  : `Crear en Odoo (${elegidos.length}) · ${m.etiqueta}`}
              </button>
            </header>

            <table className="of-mes-tabla">
              <tbody>
                {m.contribuyentes.map((c) => (
                  <tr key={c.ruc} className={selPend.has(`${m.clave}|${c.ruc}`) ? 'sel' : ''}>
                    <td className="of-mes-check">
                      <input
                        type="checkbox"
                        checked={selPend.has(`${m.clave}|${c.ruc}`)}
                        onChange={() => togglePend(m.clave, c.ruc)}
                      />
                    </td>
                    <td>
                      <div className="of-mes-nombre">{c.nombre}</div>
                      <div className="of-mes-ruc">RUC {c.ruc}</div>
                    </td>
                    <td className="of-mes-conceptos">
                      {c.lineas.map((l, i) => (
                        <span key={i} className="of-mes-concepto">{l.concepto}</span>
                      ))}
                    </td>
                    <td className="of-mes-total">{fmtMoney(c.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {totalMes > 0 && (
              <p className="of-mes-pie">Marcados: {elegidos.length} · {fmtMoney(totalMes)}</p>
            )}

            {res && (
              <ul className="of-mes-res">
                {res.map((r, i) => (
                  <li key={i} className={r.ok ? 'ok' : 'err'}>
                    {r.ok
                      ? `✔ ${r.nombre || r.ruc}: ${r.numero || 'emitida'}${r.ya_existia ? ' (ya existía)' : ''}`
                      : `✖ ${r.nombre || r.ruc || ''}: ${r.error}`}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )
      })}

      {grupos.length === 0 ? (
        <div className="of-empty">
          <span className="of-empty-ico">📋</span>
          <p>No hay honorarios marcados para cobrar.</p>
          <p className="of-empty-hint">Activa "Cobrar" y establece valores en el módulo Reportes.</p>
        </div>
      ) : (
        <>
          {/* Barra de acciones */}
          <div className="of-toolbar">
            <label className="of-check-all">
              <input
                type="checkbox"
                checked={seleccionados.size >= gruposPorProcesar.length && gruposPorProcesar.length > 0}
                onChange={toggleTodos}
              />
              Seleccionar todos por procesar ({gruposPorProcesar.length})
              {verificando && <span className="of-verif"> · 🔄 verificando con Odoo…</span>}
            </label>
            <div className="of-toolbar-right">
              {facturasSeleccionadas.length > 0 && (
                <span className="of-sel-info">
                  {facturasSeleccionadas.length} factura{facturasSeleccionadas.length !== 1 ? 's' : ''} de {periodo?.etiqueta || 'este mes'} · {fmtMoney(totalSeleccionado)}
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
                {okCount > 0 && (
                  <button className="of-btn-sri" disabled={verificandoSri}
                    onClick={() => verificarSri(resultados.filter((x) => x.ok && x.odoo_id).map((x) => x.odoo_id))}
                    title="Verifica/reintenta el envío al SRI de las facturas creadas">
                    {verificandoSri ? 'verificando…' : '🧾 Verificar envío al SRI'}
                  </button>
                )}
              </div>
              {resultados.map((r, i) => (
                <div key={i} className={`of-res-row ${r.ok ? 'ok' : 'err'}`}>
                  {r.ok ? (
                    <>
                      <span className="of-res-ico">✓</span>
                      <span className="of-res-nombre">{r.nombre}</span>
                      <span className="of-res-num">{r.numero}</span>
                      <span className="of-res-total">{fmtMoney(r.total)}</span>
                      {r.ya_existia && <span className="of-res-pago pend" title="Ya tenía factura este mes — no se duplicó; pasa al SRI">↩ ya emitida (no se duplicó)</span>}
                      {r.cobro_banco === 'registrado'
                        ? <span className="of-res-pago paid" title="Cobro registrado en el banco">💵 cobrada en banco</span>
                        : (r.payment_state === 'not_paid' || r.payment_state === 'partial')
                          ? <span className="of-res-pago pend" title="Queda en cuentas por cobrar">⏳ por cobrar</span>
                          : null}
                      {typeof r.cobro_banco === 'string' && r.cobro_banco.startsWith('error') &&
                        <span className="of-res-pago err" title={r.cobro_banco}>⚠ no se registró el cobro</span>}
                      {r.impuesto_ok === false &&
                        <span className="of-res-pago err" title="La empresa no tiene IVA 15% (411,S)">⚠ sin IVA 15%</span>}
                      {sriEstado[r.odoo_id] && (
                        sriEstado[r.odoo_id].autorizacion
                          ? <span className="of-res-sri ok" title={`Autorización SRI: ${sriEstado[r.odoo_id].autorizacion}`}>🧾 SRI autorizada</span>
                          : sriEstado[r.odoo_id].edi_state === 'sent'
                            ? <span className="of-res-sri ok">🧾 SRI enviada</span>
                            : <span className="of-res-sri pend" title={`edi_state: ${sriEstado[r.odoo_id].edi_state || '-'}`}>🧾 SRI pendiente</span>
                      )}
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
              {/* Paso de envío al SRI (comunicación con Odoo) */}
              {okCount > 0 && (
                <div className="of-sri-paso">
                  {verificandoSri
                    ? '🔄 Verificando el envío al SRI…'
                    : (() => {
                        const ids = resultados.filter((x) => x.ok && x.odoo_id).map((x) => x.odoo_id)
                        const aut = ids.filter((id) => sriEstado[id] && (sriEstado[id].autorizacion || sriEstado[id].edi_state === 'sent')).length
                        const pend = ids.length - aut
                        return `🧾 Envío al SRI — ${aut} autorizada(s)${pend ? ` · ${pend} pendiente(s)` : ''}`
                      })()}
                </div>
              )}
            </div>
          )}

          {/* Lista de productos de Odoo para autocompletar al teclear */}
          <datalist id="of-odoo-prods">
            {productos.map((p) => <option key={p.id} value={p.name} />)}
          </datalist>

          {/* Aviso: ya procesados este mes → viven en el submenú "Facturas procesadas" */}
          {gruposProcesados.length > 0 && (
            <div className="of-procesados">
              <button type="button" className="of-procesados-head" onClick={() => navigate('/facturacion/procesadas')}>
                ✅ {gruposProcesados.length} contribuyente(s) ya procesado(s) este mes — no se vuelven a facturar · ver en «Facturas procesadas» ›
              </button>
            </div>
          )}

          {/* Tabla de contribuyentes POR PROCESAR */}
          <div className="of-grupos">
            {gruposPorProcesar.length === 0 && !verificando && (
              <div className="of-dim" style={{ padding: '12px' }}>Todos los contribuyentes ya tienen su factura de este mes en Odoo. No hay nada por procesar.</div>
            )}
            {gruposPorProcesar.map((g) => {
              const sel = seleccionados.has(g.ruc)
              const base = +(g.total / (1 + IVA)).toFixed(2)
              const iva = +(g.total - base).toFixed(2)
              return (
                <div key={g.ruc} className={`of-grupo ${sel ? 'selected' : ''}`}>
                  <div className="of-grupo-header">
                    <div className="of-grupo-info">
                      <span className="of-grupo-nombre">Honorarios de: {g.nombre || '(sin nombre)'}</span>
                      <span className="of-grupo-ruc">
                        Contribuyente · RUC {g.ruc}
                        {periodo?.etiqueta && <span className="of-grupo-mes">🗓️ {periodo.etiqueta}</span>}
                      </span>
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

                  {/* Estado en Odoo: qué ya está y qué falta (cliente · factura · SRI) */}
                  {!cuentas[g.ruc]
                    ? <div className="of-cliente-chk">⏳ verificando estado en Odoo…</div>
                    : (() => {
                        const info = cuentas[g.ruc]
                        const uf = info.ultima_factura
                        const mesActual = (new Date()).toISOString().slice(0, 7)
                        const emitidaEsteMes = uf && (uf.fecha || '').slice(0, 7) === mesActual
                        return (
                          <div className="of-estado">
                            {info.partner_id
                              ? <span className="of-est-ok">👤 Cliente en Odoo ✓</span>
                              : <span className="of-est-falta">👤 Cliente NO existe
                                  <button type="button" className="of-cuenta-crear" disabled={creandoCli === g.ruc}
                                    onClick={() => crearCliente(g)} title={`Se creará: ${g.nombre} · RUC ${g.ruc}`}>
                                    {creandoCli === g.ruc ? 'creando…' : `Crear: ${g.nombre} · ${g.ruc}`}
                                  </button>
                                </span>}
                            {emitidaEsteMes
                              ? <span className="of-est-warn" title="Ya hay una factura de este mes — evitá duplicar">🧾 Ya emitida este mes: {uf.numero}{uf.autorizada ? ' · SRI autorizada ✓' : ' · SRI pendiente'}</span>
                              : uf
                                ? <span className="of-est-info">🧾 Última: {uf.numero} ({uf.fecha}){uf.autorizada ? ' · SRI ✓' : ''} — falta emitir la de este mes</span>
                                : <span className="of-est-pend">🧾 Sin factura emitida — falta emitir</span>}
                          </div>
                        )
                      })()}

                  {/* Meses anteriores de ESTE contribuyente que quedaron sin facturar.
                      Se enumeran uno por uno para no mezclarlos con el mes en curso. */}
                  {atrasos[g.ruc] && (
                    <div className="of-atraso">
                      <span className="of-atraso-tit">
                        ⚠ Arrastra {atrasos[g.ruc].meses.length} mes(es) sin facturar · {fmtMoney(atrasos[g.ruc].total)}
                      </span>
                      <span className="of-atraso-meses">
                        {atrasos[g.ruc].meses.map((m) => (
                          <span key={m.clave} className="of-atraso-chip" title={m.conceptos.map((c) => c.concepto).join(', ')}>
                            {m.etiqueta}: {fmtMoney(m.registrado)}
                          </span>
                        ))}
                      </span>
                      <span className="of-atraso-nota">
                        Esta emisión cubre solo {periodo?.etiqueta || 'el mes en curso'}; los meses de arriba
                        siguen pendientes.
                      </span>
                    </div>
                  )}

                  {/* Registro contable: cuenta por cobrar del cliente + destino (por cobrar / banco) */}
                  <div className="of-contable">
                    <div className="of-cuenta">
                      <span className="of-cuenta-lbl">📒 Registro contable:</span>
                      {cuentas[g.ruc]?.existe ? (
                        <span className="of-cuenta-ok" title={cuentas[g.ruc].asignada ? 'Ya asignada al cliente' : 'Se asignará al cliente al facturar'}>
                          {cuentas[g.ruc].cuenta_codigo ? `${cuentas[g.ruc].cuenta_codigo} · ` : ''}{cuentas[g.ruc].cuenta_nombre}
                        </span>
                      ) : codigosSugeridos[g.ruc] ? (
                        <span className="of-cuenta-falta">
                          ⚠ No tiene cuenta propia en este plan
                          <button type="button" className="of-cuenta-crear" disabled={creandoCta === g.ruc}
                            onClick={() => crearCuenta(g)}
                            title={`Se creará con el código ${codigosSugeridos[g.ruc]}`}>
                            {creandoCta === g.ruc ? 'creando…' : `Crear ${codigosSugeridos[g.ruc]} · Cuentas por cobrar ${g.nombre}`}
                          </button>
                        </span>
                      ) : (
                        <span className="of-cuenta-falta">⚠ La empresa emisora no tiene plan de cuentas por cobrar en Odoo</span>
                      )}
                    </div>
                    {impuestoPorEmpresa[grupoEmisor(g)] === false && (
                      <div className="of-impuesto-falta" title="Créalo en Odoo: Contabilidad → Impuestos">
                        ⚠ Esta empresa no tiene el impuesto <strong>IVA 15% (411, S)</strong>. Créalo en Odoo: Contabilidad → Impuestos → nuevo «IVA 15%», tipo <em>Venta</em>, importe <em>15%</em>, etiqueta SRI <em>411</em> (S — servicios). Sin él, la factura saldría sin IVA.
                      </div>
                    )}
                    <div className="of-destino">
                      <label htmlFor={`dest-${g.ruc}`}>Destino:</label>
                      <select id={`dest-${g.ruc}`}
                        value={destino[g.ruc] || 'cobrar'}
                        onChange={(e) => setDestino((p) => ({ ...p, [g.ruc]: e.target.value }))}>
                        <option value="cobrar">Cuentas por cobrar (pendiente)</option>
                        {(bancosPorEmpresa[grupoEmisor(g)] || []).map((b) => <option key={b.id} value={String(b.id)}>Cobrado en banco: {b.name}</option>)}
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
