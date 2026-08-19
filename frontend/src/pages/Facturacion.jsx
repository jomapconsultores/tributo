import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAccess } from '../context/AccessContext'
import { odooAPI } from '../services/api'
import {
  MESES, clavePeriodo, etiquetaPeriodo, parsePeriodo, periodoHoy, esPeriodoActual,
} from '../utils/periodo'
import './Facturacion.css'

// Todo el módulo en UNA pantalla: emitir, el reporte del mes, lo que Odoo tiene
// emitido y el cruce histórico. Antes eran cuatro entradas de menú que se
// parecían entre sí y obligaban a saltar de una a otra para entender el mes.
const OdooFacturacion    = lazy(() => import('./OdooFacturacion'))
const ReporteFacturacion = lazy(() => import('./ReporteFacturacion'))
const FacturasProcesadas = lazy(() => import('./FacturasProcesadas'))
const CruceOdoo          = lazy(() => import('./CruceOdoo'))

// `admin: true` = solo administrador o socio. "Facturas de Odoo" es de solo
// lectura y el backend ya filtra por RUC autorizado, así que un cliente la ve.
const TABS = [
  { key: 'emitir',     ruta: '',           ico: '📤', label: 'Emitir',
    nota: 'Facturas del mes elegido y de los meses que quedaron sin facturar', admin: true },
  { key: 'reporte',    ruta: 'reporte',    ico: '📊', label: 'Reporte del mes',
    nota: 'Quién declaró, a quién falta facturarle y el comparativo con Odoo', admin: true },
  { key: 'procesadas', ruta: 'procesadas', ico: '🧾', label: 'Facturas de Odoo',
    nota: 'Las facturas ya emitidas, con su autorización del SRI', admin: false },
  { key: 'cruce',      ruta: 'cruce',      ico: '🔍', label: 'Cruce mensual',
    nota: 'Mes a mes, hasta 24 meses atrás', admin: true },
]

export default function Facturacion() {
  const { tab } = useParams()
  const navigate = useNavigate()
  const [sp, setSp] = useSearchParams()
  const { isAdmin } = useAccess()   // administrador o socio de la empresa activa
  const puedeFacturar = isAdmin

  const visibles = TABS.filter((t) => puedeFacturar || !t.admin)
  const actual = visibles.find((t) => t.ruta === (tab || '')) || visibles[0]
  const [estadoOdoo, setEstadoOdoo] = useState(null)

  // UN SOLO período para todo el módulo. Vive en la URL (?p=AAAA-MM) para que
  // sobreviva al cambio de pestaña, al recargar y al enlace que se comparte:
  // antes cada pestaña llevaba su propio mes y al saltar de una a otra se volvía
  // al actual sin avisar.
  const periodo = useMemo(() => {
    const p = parsePeriodo(sp.get('p')) || periodoHoy()
    return {
      ...p,
      clave: clavePeriodo(p.mes, p.anio),
      etiqueta: etiquetaPeriodo(p.mes, p.anio),
      actual: esPeriodoActual(p.mes, p.anio),
    }
  }, [sp])

  const setPeriodo = useCallback((mes, anio) => {
    // Un mes que todavía no llegó no se factura: al saltar de año, el período
    // se recorta al mes en curso en vez de quedar en uno imposible.
    const h = periodoHoy()
    let m = mes
    if (anio * 100 + m > h.anio * 100 + h.mes) m = h.mes
    const s = new URLSearchParams(sp)
    s.set('p', clavePeriodo(m, anio))
    setSp(s, { replace: true })
  }, [sp, setSp])

  useEffect(() => {
    odooAPI.estado().then((r) => setEstadoOdoo(r.data)).catch(() => setEstadoOdoo({ ok: false }))
  }, [])

  // Una pestaña que este rol no puede ver (o una URL vieja mal escrita) lleva a
  // la primera permitida, no a una pantalla vacía. El período se conserva.
  useEffect(() => {
    if (!visibles.length) return
    if (!visibles.some((t) => t.ruta === (tab || ''))) {
      navigate(irA(visibles[0].ruta, periodo.clave), { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, puedeFacturar])

  if (!visibles.length) return <div className="fc-vacio">Sin acceso a facturación.</div>

  const hoy = periodoHoy()
  const anios = [hoy.anio, hoy.anio - 1, hoy.anio - 2]
  // No se factura un mes que todavía no llegó.
  const mesFuturo = (m) => periodo.anio > hoy.anio || (periodo.anio === hoy.anio && m > hoy.mes)

  return (
    <div className="fc-page">
      <header className="fc-head">
        <div>
          <h1 className="fc-titulo">🧾 Facturación</h1>
          <p className="fc-nota">{actual.nota}</p>
        </div>
        <div className="fc-head-der">
          {/* El mes que manda en las cuatro pestañas */}
          <div className="fc-periodo">
            <span className="fc-periodo-lbl">🗓️ Período</span>
            <select
              value={periodo.mes}
              onChange={(e) => setPeriodo(Number(e.target.value), periodo.anio)}
            >
              {MESES.map((m, i) => (
                <option key={m} value={i + 1} disabled={mesFuturo(i + 1)}>{m}</option>
              ))}
            </select>
            <select
              value={periodo.anio}
              onChange={(e) => setPeriodo(periodo.mes, Number(e.target.value))}
            >
              {anios.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            {!periodo.actual && (
              <button
                type="button"
                className="fc-periodo-hoy"
                onClick={() => setPeriodo(hoy.mes, hoy.anio)}
                title="Volver al mes en curso"
              >
                ↩ mes actual
              </button>
            )}
          </div>
          {estadoOdoo && (
            <span className={`fc-odoo ${estadoOdoo.ok ? 'ok' : 'fail'}`}>
              {estadoOdoo.ok ? `Odoo conectado · ${estadoOdoo.db}` : 'Odoo no disponible'}
            </span>
          )}
        </div>
      </header>

      {!periodo.actual && (
        <div className="fc-aviso-periodo">
          Estás trabajando sobre <strong>{periodo.etiqueta.toUpperCase()}</strong>, no sobre el mes en
          curso. Todo lo que veas y emitas acá corresponde a ese período.
        </div>
      )}

      <nav className="fc-tabs">
        {visibles.map((t) => (
          <button
            key={t.key}
            className={`fc-tab ${t.key === actual.key ? 'act' : ''}`}
            onClick={() => navigate(irA(t.ruta, periodo.clave))}
          >
            <span className="fc-tab-ico">{t.ico}</span>{t.label}
          </button>
        ))}
      </nav>

      <div className="fc-cuerpo">
        <Suspense fallback={<div className="fc-cargando">Cargando…</div>}>
          {actual.key === 'emitir' && <OdooFacturacion embebido periodo={periodo} />}
          {actual.key === 'reporte' && (
            <ReporteFacturacion
              embebido
              periodo={periodo}
              onFacturarMes={() => navigate(irA('', periodo.clave))}
            />
          )}
          {actual.key === 'procesadas' && <FacturasProcesadas embebido periodo={periodo} />}
          {actual.key === 'cruce' && <CruceOdoo embebido periodo={periodo} />}
        </Suspense>
      </div>
    </div>
  )
}

// Dirección de una pestaña conservando el período elegido.
function irA(ruta, clave) {
  return `/facturacion${ruta ? `/${ruta}` : ''}?p=${clave}`
}
