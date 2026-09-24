import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { declaracionesAPI, facturarAPI } from '../services/api'
import { useClients } from '../context/ClientContext'
import { useAccess, homeFor } from '../context/AccessContext'
import { estadoDeclaracionCliente } from '../utils/declaracionSRI'
import { refrescarPresentadas } from '../hooks/useDeclPresentadas'
import { periodoLargo } from '../utils/periodo'
import { filterBySearch } from '../utils/search'
import './ClientesPendientes.css'

// Ruta de la pantalla de declaración según el tipo pendiente.
const RUTA_TIPO = { IVA: '/declaracion-iva', ICE: '/declaracion-ice', '103': '/declaracion-103' }
const LABEL_TIPO = { IVA: 'Declaración IVA', ICE: 'Declaración ICE', '103': 'Declaración 103 (Renta)' }
const ICONO_TIPO = { IVA: '🧾', ICE: '🥃', '103': '🧷' }

export default function ClientesPendientes() {
  const navigate = useNavigate()
  const { selectClient, setFocusIdent } = useClients()
  const { has, hasSub } = useAccess()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [marcando, setMarcando] = useState('')  // 'client_id|tipo' que se está marcando
  // Selección para el cierre de mes en lote: claves 'client_id|tipo'.
  const [sel, setSel] = useState(() => new Set())
  const [lote, setLote] = useState('')          // texto de lo que está corriendo
  const [resultado, setResultado] = useState(null)

  const cargar = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const r = await declaracionesAPI.pendientes()
      setRows(r.data?.data || [])
    } catch (e) {
      setError(e.response?.data?.detail || e.message)
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { cargar() }, [cargar])

  // ── Cierre de mes en lote ───────────────────────────────────────────────
  // El mes sin movimiento igual se declara y igual se cobra. Hacerlo de a uno
  // —abrir, calcular, guardar, marcar, facturar— era el trabajo más repetitivo
  // del cierre; acá se seleccionan y se resuelven de una pasada.
  const alternar = (clave) => setSel((prev) => {
    const s = new Set(prev)
    s.has(clave) ? s.delete(clave) : s.add(clave)
    return s
  })

  const seleccionados = useMemo(
    () => [...sel].map((k) => {
      const [client_id, tipo] = k.split('|')
      const row = rows.find((r) => r.client_id === client_id)
      return { client_id, tipo, nombre: row?.nombre, identificacion: row?.identificacion }
    }),
    [sel, rows],
  )

  const declararEnCero = async () => {
    if (!seleccionados.length) return
    if (!window.confirm(
      `Vas a declarar EN CERO ${seleccionados.length} declaración(es) y marcarlas como ` +
      'PRESENTADAS en el SRI.\n\n' +
      'Hazlo solo si ya las presentaste en el portal. Las que tengan comprobantes ' +
      'cargados no se tocan: se te avisará cuáles.',
    )) return
    setLote('Declarando en cero…'); setResultado(null)
    try {
      const { data } = await declaracionesAPI.declararEnCeroLote(
        seleccionados.map(({ client_id, tipo }) => ({ client_id, tipo })),
      )
      setResultado({ tipo: 'cero', ...data })
      setSel(new Set())
      refrescarPresentadas()
      await cargar()
    } catch (e) {
      alert('Error: ' + (e.response?.data?.detail || e.message))
    } finally { setLote('') }
  }

  const facturarSeleccionados = async () => {
    // Una factura por contribuyente, aunque tenga dos declaraciones marcadas.
    const rucs = [...new Set(seleccionados.map((s) => s.identificacion).filter(Boolean))]
    if (!rucs.length) return
    if (!window.confirm(
      `Se emitirán las facturas de honorarios del mes de ${rucs.length} contribuyente(s), ` +
      'cada uno en su sistema (Odoo o Contabilidad MAP).\n\n' +
      'Son documentos reales. Los que ya estén facturados este mes no se duplican.',
    )) return
    setLote('Emitiendo facturas…'); setResultado(null)
    try {
      const { data } = await facturarAPI.emitirLote(rucs)
      setResultado({ tipo: 'factura', ...data })
      setSel(new Set())
    } catch (e) {
      alert('Error: ' + (e.response?.data?.detail || e.message))
    } finally { setLote('') }
  }

  // Ya vienen en orden alfabético del backend; el filtro conserva ese orden.
  const filtradas = useMemo(
    () => filterBySearch(rows, search, (r) => [r.nombre, r.identificacion]),
    [rows, search],
  )
  const totalPendientes = useMemo(
    () => rows.reduce((s, r) => s + (r.pendientes?.length || 0), 0),
    [rows],
  )

  // Abrir una declaración concreta del contribuyente: selecciona su período y
  // navega a la pantalla del tipo elegido.
  const abrirDeclaracion = (row, tipo) => {
    selectClient(row.client_id)
    navigate(RUTA_TIPO[tipo] || '/declaracion-iva')
  }
  // Marcar directo, sin abrir la declaración, que ya está grabada/subida al SRI.
  // La quita de pendientes (crea el registro si no existía).
  const marcarSubidaSri = async (row, tipo) => {
    if (!window.confirm(
      `¿Marcar la declaración ${tipo} de ${row.nombre} como grabada / subida al SRI?\n\n` +
      'Se quitará de Clientes pendientes.'
    )) return
    const key = row.client_id + '|' + tipo
    setMarcando(key)
    try {
      await declaracionesAPI.marcarPresentadaDirecta(row.client_id, tipo, true)
      refrescarPresentadas()   // que los badges de vencimiento dejen de marcar plazo
      await cargar()
    } catch (e) {
      alert('No se pudo marcar: ' + (e.response?.data?.detail || e.message))
    } finally { setMarcando('') }
  }

  // Acceder a los datos del cliente: si tiene el módulo de Gastos, abre su base
  // de datos (datos completos del contribuyente); si no, lo lleva a la primera
  // declaración pendiente —siempre accesible según sus permisos—.
  const abrirCliente = (row) => {
    if (has('gastos') && hasSub('gastos_facturas')) {
      setFocusIdent(row.identificacion)
      selectClient(null)
      navigate('/')
    } else {
      abrirDeclaracion(row, row.pendientes[0])
    }
  }

  return (
    <div className="cp-page">
      <header className="cp-header">
        <div>
          <h1>⏳ Clientes pendientes</h1>
          <p className="cp-sub">
            Contribuyentes que aún tienen alguna declaración <strong>por presentar</strong> en su
            período más reciente. Solo aparecen los que puedes ver según tus permisos. Toca un
            contribuyente para abrir sus datos, o una insignia para ir directo a esa declaración.
          </p>
        </div>
        <button className="cp-btn cp-btn-back" onClick={() => navigate(homeFor(has, hasSub))}>
          ← Volver al inicio
        </button>
      </header>

      <div className="cp-toolbar">
        <input
          className="cp-search"
          placeholder="🔍 Buscar contribuyente o RUC…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="cp-count">
          {rows.length} contribuyente(s) · {totalPendientes} declaración(es) pendiente(s)
        </span>
        <button className="cp-btn" onClick={cargar}>↻ Actualizar</button>
      </div>

      {error && <div className="cp-error">⚠ {error}</div>}

      {/* Barra del cierre en lote. Solo aparece con algo seleccionado: mientras
          no hay nada que resolver, no estorba. */}
      {sel.size > 0 && (
        <div className="cp-lote">
          <span className="cp-lote-txt">
            <strong>{sel.size}</strong> declaración(es) seleccionada(s)
          </span>
          <span className="cp-lote-acts">
            <button className="cp-btn" onClick={() => setSel(new Set())} disabled={!!lote}>
              Quitar selección
            </button>
            <button className="cp-btn cp-btn-cero" onClick={declararEnCero} disabled={!!lote}>
              {lote === 'Declarando en cero…' ? '⏳ Declarando…' : '0️⃣ Declarar en cero y marcar presentadas'}
            </button>
            <button className="cp-btn cp-btn-fact" onClick={facturarSeleccionados} disabled={!!lote}>
              {lote === 'Emitiendo facturas…' ? '⏳ Emitiendo…' : '🧾 Facturar seleccionados'}
            </button>
          </span>
        </div>
      )}

      {/* Resultado del lote: qué se hizo y qué no, con el motivo. Un lote que
          solo dice «listo» obliga a revisar a mano si algo quedó fuera. */}
      {resultado && (
        <div className="cp-resultado">
          <button className="cp-res-cerrar" onClick={() => setResultado(null)} title="Cerrar">✕</button>
          {resultado.tipo === 'cero' ? (
            <>
              <strong>✅ {resultado.hechas?.length || 0} declaración(es) en cero, presentadas.</strong>
              {resultado.hechas?.length > 0 && (
                <p className="cp-res-lista">{resultado.hechas.map((h) => `${h.nombre} (${h.tipo})`).join(' · ')}</p>
              )}
              {resultado.omitidas?.length > 0 && (
                <>
                  <strong className="cp-res-warn">⚠ {resultado.omitidas.length} sin tocar:</strong>
                  <ul className="cp-res-omitidas">
                    {resultado.omitidas.map((o, i) => (
                      <li key={i}><b>{o.nombre}</b> ({o.tipo}): {o.motivo}</li>
                    ))}
                  </ul>
                </>
              )}
            </>
          ) : (
            <>
              <strong>🧾 {resultado.emitidas?.length || 0} factura(s) emitida(s).</strong>
              {resultado.ya_estaban?.length > 0 && (
                <p className="cp-res-lista">
                  {resultado.ya_estaban.length} ya estaban facturadas este mes (no se duplicaron).
                </p>
              )}
              {resultado.emitidas?.length > 0 && (
                <p className="cp-res-lista">
                  {resultado.emitidas.map((f) => `${f.identificacion}${f.numero ? ` → ${f.numero}` : ''}`).join(' · ')}
                </p>
              )}
              {resultado.fallidas?.length > 0 && (
                <>
                  <strong className="cp-res-warn">⚠ {resultado.fallidas.length} sin facturar:</strong>
                  <ul className="cp-res-omitidas">
                    {resultado.fallidas.map((f, i) => (
                      <li key={i}><b>{f.identificacion}</b>: {f.motivo}</li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      )}

      {loading ? (
        <div className="cp-empty">Cargando…</div>
      ) : rows.length === 0 ? (
        <div className="cp-empty">🎉 No hay clientes con declaraciones pendientes.</div>
      ) : filtradas.length === 0 ? (
        <div className="cp-empty">Ninguno coincide con la búsqueda.</div>
      ) : (
        <ul className="cp-list">
          {filtradas.map((row) => {
            const e = estadoDeclaracionCliente(row)
            const nivel = e.valido ? e.nivel : 'ok'
            return (
              <li key={row.client_id} className={`cp-card nivel-${nivel}`}>
                <button
                  className="cp-card-main"
                  onClick={() => abrirCliente(row)}
                  title="Abrir los datos de este contribuyente"
                >
                  <span className="cp-card-nombre">{row.nombre || '—'}</span>
                  <span className="cp-card-meta">
                    <span className="cp-card-ruc">{row.identificacion}</span>
                    <span className="cp-card-periodo">
                      · {periodoLargo(row)}
                    </span>
                    {e.valido && (
                      <span className={`cp-plazo nivel-${e.nivel}`}>
                        · hasta {e.limiteTexto} ({e.mensaje})
                      </span>
                    )}
                  </span>
                </button>
                <div className="cp-card-tipos">
                  {row.pendientes.map((tipo) => {
                    const key = row.client_id + '|' + tipo
                    return (
                      <span key={tipo} className={`cp-tipo-group ${sel.has(key) ? 'sel' : ''}`}>
                        {/* Marcar para el cierre en lote: declarar en cero y,
                            después, facturar sin ir de a uno. */}
                        <label className="cp-chk" title="Seleccionar para declarar en cero / facturar en lote">
                          <input type="checkbox" checked={sel.has(key)} onChange={() => alternar(key)} />
                        </label>
                        <button
                          className={`cp-tipo cp-tipo-${tipo.toLowerCase()}`}
                          onClick={() => abrirDeclaracion(row, tipo)}
                          title={`Abrir ${LABEL_TIPO[tipo] || tipo}`}
                        >
                          {ICONO_TIPO[tipo] || '📄'} {tipo}
                        </button>
                        <button
                          className="cp-marcar"
                          disabled={marcando === key}
                          onClick={() => marcarSubidaSri(row, tipo)}
                          title={`Marcar ${tipo} como grabada / subida al SRI (la quita de pendientes)`}
                        >
                          {marcando === key ? '…' : '☁️ ✓'}
                        </button>
                      </span>
                    )
                  })}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
