import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { declaracionesAPI } from '../services/api'
import { useAccess, homeFor } from '../context/AccessContext'
import { refrescarPresentadas } from '../hooks/useDeclPresentadas'
import { MESES_CORTO } from '../utils/periodo'
import { filterBySearch } from '../utils/search'
import './MatrizDeclaraciones.css'

// El cuadro que faltaba: mes a mes, quién presentó y quién no.
// «Clientes pendientes» solo mira el período MÁS RECIENTE de cada contribuyente,
// así que un mes viejo sin marcar no se ve en ninguna pantalla —y lo que no se
// ve no se puede marcar—. Los meses atrasados había que reconstruirlos a mano,
// contribuyente por contribuyente. Acá están todos juntos y cada celda se marca
// con un clic.

const ICONO_TIPO = { IVA: '🧾', ICE: '🥃', 103: '🧷' }

const ESTADO = {
  presentada: { txt: '✓', cls: 'ok', ayuda: 'Presentada al SRI. Tócala para volver a dejarla pendiente.' },
  guardada: { txt: '◐', cls: 'media', ayuda: 'Declaración calculada y guardada, pero sin confirmar que se subió al SRI. Tócala para marcarla presentada.' },
  falta: { txt: '○', cls: 'falta', ayuda: 'Sin declaración en este período. Si ya la hiciste en el portal, tócala para marcarla presentada.' },
  na: { txt: '·', cls: 'na', ayuda: 'Sin período abierto en este mes: no hay nada que declarar.' },
}

export default function MatrizDeclaraciones() {
  const navigate = useNavigate()
  const { has, hasSub } = useAccess()
  const [meses, setMeses] = useState(6)
  const [data, setData] = useState({ periodos: [], filas: [] })
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [soloFaltantes, setSoloFaltantes] = useState(false)
  const [marcando, setMarcando] = useState('')   // 'ident|tipo|clave' en curso

  const cargar = useCallback(async () => {
    setCargando(true); setError('')
    try {
      const r = await declaracionesAPI.matriz(meses)
      setData(r.data || { periodos: [], filas: [] })
    } catch (e) {
      setError(e.response?.data?.detail || e.message)
    } finally { setCargando(false) }
  }, [meses])
  useEffect(() => { cargar() }, [cargar])

  const filas = useMemo(() => {
    let f = filterBySearch(data.filas, search, (r) => [r.nombre, r.identificacion])
    if (soloFaltantes) {
      f = f.filter((x) => Object.values(x.celdas).some(
        (c) => c.estado === 'falta' || c.estado === 'guardada'))
    }
    return f
  }, [data.filas, search, soloFaltantes])

  // Cuántas celdas faltan (sin contar los meses sin período abierto).
  const totales = useMemo(() => {
    let falta = 0, guardada = 0, presentada = 0, dup = 0
    for (const f of data.filas) {
      for (const c of Object.values(f.celdas)) {
        if (c.estado === 'falta') falta++
        else if (c.estado === 'guardada') guardada++
        else if (c.estado === 'presentada') presentada++
        if (c.duplicado) dup++
      }
    }
    return { falta, guardada, presentada, dup }
  }, [data.filas])

  // Un clic invierte el estado de la celda. El backend crea el registro-marcador
  // si la declaración se hizo directo en el portal y nunca pasó por el sistema.
  const alternarCelda = async (fila, clave, celda) => {
    if (celda.estado === 'na' || !celda.client_id) return
    const key = `${fila.identificacion}|${fila.tipo}|${clave}`
    const presentar = celda.estado !== 'presentada'
    setMarcando(key)
    // Se ve en el acto: esperar al servidor para pintar el ✓ hace que marcar
    // veinte celdas se sienta lento aunque cada llamada tarde poco.
    setData((prev) => ({
      ...prev,
      filas: prev.filas.map((f) => (
        f.identificacion === fila.identificacion && f.tipo === fila.tipo
          ? { ...f, celdas: { ...f.celdas, [clave]: { ...celda, estado: presentar ? 'presentada' : 'falta' } } }
          : f),
      ),
    }))
    try {
      await declaracionesAPI.marcarPresentadaDirecta(celda.client_id, fila.tipo, presentar)
      refrescarPresentadas()
    } catch (e) {
      setError(e.response?.data?.detail || 'No se pudo cambiar el estado de la declaración.')
      cargar()
    } finally { setMarcando('') }
  }

  const etiqueta = (p) => `${MESES_CORTO[p.mes - 1]} ${String(p.anio).slice(2)}`

  return (
    <div className="mz-page">
      <header className="mz-header">
        <div>
          <h1>🗓️ Estado de declaraciones</h1>
          <p className="mz-sub">
            Todos los meses de una vez, no solo el último. Cada celda es el estado de una
            declaración: tócala para marcarla <strong>presentada al SRI</strong> o para volver a
            dejarla pendiente. Solo aparecen los contribuyentes que puedes ver según tus permisos.
          </p>
        </div>
        <button className="mz-btn mz-btn-back" onClick={() => navigate(homeFor(has, hasSub))}>
          ← Volver al inicio
        </button>
      </header>

      <div className="mz-toolbar">
        <input
          className="mz-search"
          placeholder="🔍 Buscar contribuyente o RUC…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="mz-sel">
          Meses
          <select value={meses} onChange={(e) => setMeses(Number(e.target.value))}>
            {[3, 6, 12, 24].map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="mz-chk">
          <input type="checkbox" checked={soloFaltantes} onChange={(e) => setSoloFaltantes(e.target.checked)} />
          Solo con algo pendiente
        </label>
        <span className="mz-count">
          <b className="ok">{totales.presentada}</b> presentadas ·{' '}
          <b className="media">{totales.guardada}</b> sin confirmar ·{' '}
          <b className="falta">{totales.falta}</b> sin declaración
        </span>
        <button className="mz-btn" onClick={cargar}>↻ Actualizar</button>
      </div>

      {error && <div className="mz-error">⚠ {error}</div>}

      {/* El mismo mes abierto dos veces por dos personas distintas parte el
          trabajo en dos filas y la facturación puede contarlo doble. No se
          arregla solo: hay que elegir cuál queda. */}
      {totales.dup > 0 && (
        <div className="mz-aviso">
          ⚠ Hay <strong>{totales.dup}</strong> celda(s) con el período abierto más de una vez.
          Se marca sobre la fila que ya tiene la declaración (o la más antigua), pero conviene
          depurar el duplicado antes de facturar. Están señaladas con <span className="mz-dup-marca">▚</span>.
        </div>
      )}

      {cargando ? (
        <div className="mz-empty">Cargando…</div>
      ) : data.filas.length === 0 ? (
        <div className="mz-empty">No hay declaraciones que mostrar en este rango.</div>
      ) : filas.length === 0 ? (
        <div className="mz-empty">Ninguno coincide con el filtro.</div>
      ) : (
        <div className="mz-tabla-wrap">
          <table className="mz-tabla">
            <thead>
              <tr>
                <th className="mz-th-nombre">Contribuyente</th>
                <th className="mz-th-tipo">Tipo</th>
                {data.periodos.map((p) => (
                  <th key={p.clave} className="mz-th-mes">{etiqueta(p)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filas.map((f) => (
                <tr key={f.identificacion + '|' + f.tipo}>
                  <td className="mz-nombre">
                    <strong>{f.nombre || '—'}</strong>
                    <span className="mz-ruc">{f.identificacion}</span>
                    {f.periodicidad === 'semestral' && (
                      <span className="mz-sem" title="Contribuyente semestral: solo declara en junio y diciembre">
                        semestral
                      </span>
                    )}
                  </td>
                  <td className="mz-tipo">
                    <span className={`mz-chip mz-chip-${String(f.tipo).toLowerCase()}`}>
                      {ICONO_TIPO[f.tipo] || '📄'} {f.tipo}
                    </span>
                  </td>
                  {data.periodos.map((p) => {
                    const celda = f.celdas[p.clave] || { estado: 'na' }
                    const est = ESTADO[celda.estado] || ESTADO.na
                    const key = `${f.identificacion}|${f.tipo}|${p.clave}`
                    return (
                      <td key={p.clave} className="mz-celda">
                        <button
                          className={`mz-marca ${est.cls}${celda.duplicado ? ' dup' : ''}`}
                          disabled={celda.estado === 'na' || marcando === key}
                          onClick={() => alternarCelda(f, p.clave, celda)}
                          title={celda.duplicado
                            ? `${est.ayuda}\n\n⚠ Este mes está abierto ${celda.duplicado} veces para este contribuyente.`
                            : est.ayuda}
                        >
                          {marcando === key ? '…' : est.txt}
                        </button>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mz-leyenda">
        <span className="mz-marca ok">✓</span> presentada al SRI ·{' '}
        <span className="mz-marca media">◐</span> guardada, sin confirmar la subida ·{' '}
        <span className="mz-marca falta">○</span> sin declaración ·{' '}
        <span className="mz-marca na">·</span> sin período abierto ese mes
      </p>
    </div>
  )
}
