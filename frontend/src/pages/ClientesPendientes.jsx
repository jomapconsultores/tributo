import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { declaracionesAPI } from '../services/api'
import { useClients } from '../context/ClientContext'
import { useAccess, homeFor } from '../context/AccessContext'
import { estadoDeclaracionCliente } from '../utils/declaracionSRI'
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
                      <span key={tipo} className="cp-tipo-group">
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
