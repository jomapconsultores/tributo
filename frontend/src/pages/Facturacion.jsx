import { lazy, Suspense, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAccess } from '../context/AccessContext'
import { odooAPI } from '../services/api'
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
    nota: 'Facturas del mes en curso y de los meses que quedaron sin facturar', admin: true },
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
  const { isAdmin } = useAccess()   // administrador o socio de la empresa activa
  const puedeFacturar = isAdmin

  const visibles = TABS.filter((t) => puedeFacturar || !t.admin)
  const actual = visibles.find((t) => t.ruta === (tab || '')) || visibles[0]
  const [estadoOdoo, setEstadoOdoo] = useState(null)

  useEffect(() => {
    odooAPI.estado().then((r) => setEstadoOdoo(r.data)).catch(() => setEstadoOdoo({ ok: false }))
  }, [])

  // Una pestaña que este rol no puede ver (o una URL vieja mal escrita) lleva a
  // la primera permitida, no a una pantalla vacía.
  useEffect(() => {
    if (!visibles.length) return
    if (!visibles.some((t) => t.ruta === (tab || ''))) {
      navigate(`/facturacion${visibles[0].ruta ? `/${visibles[0].ruta}` : ''}`, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, puedeFacturar])

  if (!visibles.length) return <div className="fc-vacio">Sin acceso a facturación.</div>

  return (
    <div className="fc-page">
      <header className="fc-head">
        <div>
          <h1 className="fc-titulo">🧾 Facturación</h1>
          <p className="fc-nota">{actual.nota}</p>
        </div>
        {estadoOdoo && (
          <span className={`fc-odoo ${estadoOdoo.ok ? 'ok' : 'fail'}`}>
            {estadoOdoo.ok ? `Odoo conectado · ${estadoOdoo.db}` : 'Odoo no disponible'}
          </span>
        )}
      </header>

      <nav className="fc-tabs">
        {visibles.map((t) => (
          <button
            key={t.key}
            className={`fc-tab ${t.key === actual.key ? 'act' : ''}`}
            onClick={() => navigate(`/facturacion${t.ruta ? `/${t.ruta}` : ''}`)}
          >
            <span className="fc-tab-ico">{t.ico}</span>{t.label}
          </button>
        ))}
      </nav>

      <div className="fc-cuerpo">
        <Suspense fallback={<div className="fc-cargando">Cargando…</div>}>
          {actual.key === 'emitir' && <OdooFacturacion embebido />}
          {actual.key === 'reporte' && <ReporteFacturacion embebido />}
          {actual.key === 'procesadas' && <FacturasProcesadas embebido />}
          {actual.key === 'cruce' && <CruceOdoo embebido />}
        </Suspense>
      </div>
    </div>
  )
}
