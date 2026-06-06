import { useNavigate } from 'react-router-dom'
import './Landing.css'

const IVA = 0.15

const MODULOS = [
  {
    icon: '💸', titulo: 'Gastos',
    desc: 'Clasificación automática de facturas de compra (XML), bajador de facturas del SRI, reportes y datos guardados por contribuyente.',
  },
  {
    icon: '🧾', titulo: 'Retenciones',
    desc: 'Carga de comprobantes de retención (XML), reporte consolidado por contribuyente, base imponible, % e importes, y exportación a Excel.',
  },
  {
    icon: '📈', titulo: 'Ingresos + ICE',
    desc: 'Cálculo de ICE por botella y por caja, Anexo PVP+ICE, ICE-XML con auditoría (factura vs cálculo) y análisis de diferencias, catálogo de productos con los códigos oficiales del SRI, y rebajas/exenciones con verificación de proveedores en el Ministerio de Producción y el SRI.',
  },
  {
    icon: '📋', titulo: 'Declaraciones',
    desc: 'Cálculo y generación de la Declaración de IVA y la Declaración de ICE, con los formularios oficiales listos para presentar.',
  },
]

const PLANES = [
  {
    nombre: 'Básico', neto: 25, destacado: false,
    incluye: ['Gastos', 'Retenciones', 'Hasta 3 contribuyentes'],
  },
  {
    nombre: 'Profesional', neto: 45, destacado: false,
    incluye: ['Gastos', 'Retenciones', 'Declaraciones IVA/ICE', 'Hasta 10 contribuyentes'],
  },
  {
    nombre: 'Premium / ICE', neto: 75, destacado: true,
    incluye: ['Todo lo anterior', 'Ingresos + ICE completo', 'Catálogo y rebajas ICE', 'Hasta 25 contribuyentes'],
  },
  {
    nombre: 'Estudio', neto: 130, destacado: false,
    incluye: ['Todos los módulos', 'Multiusuario (varios contadores)', 'Contribuyentes ilimitados', 'Soporte prioritario'],
  },
]

const money = (n) => n.toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function Landing() {
  const navigate = useNavigate()

  return (
    <div className="lp">
      {/* Barra superior */}
      <header className="lp-nav">
        <div className="lp-brand"><span>📑</span> Gestor SRI</div>
        <nav className="lp-nav-links">
          <a href="#modulos">Módulos</a>
          <a href="#precios">Precios</a>
          <button className="lp-btn lp-btn-login" onClick={() => navigate('/login')}>Ingresar</button>
        </nav>
      </header>

      {/* Hero */}
      <section className="lp-hero">
        <h1>Gestión tributaria del SRI, automatizada</h1>
        <p>Clasifica gastos, controla retenciones, calcula el ICE y genera tus declaraciones —
          todo por contribuyente (RUC) y por período, en un solo lugar.</p>
        <div className="lp-hero-cta">
          <button className="lp-btn lp-btn-primary" onClick={() => navigate('/login')}>Ingresar al sistema</button>
          <a className="lp-btn lp-btn-ghost" href="#precios">Ver planes y precios</a>
        </div>
        <p className="lp-hero-note">Especializado en <strong>ICE de bebidas alcohólicas</strong> — cálculo, anexos y auditoría que casi nadie automatiza.</p>
      </section>

      {/* Módulos */}
      <section id="modulos" className="lp-section">
        <h2>Todo lo que incluye el sistema</h2>
        <div className="lp-grid">
          {MODULOS.map((m) => (
            <div key={m.titulo} className="lp-card">
              <div className="lp-card-icon">{m.icon}</div>
              <h3>{m.titulo}</h3>
              <p>{m.desc}</p>
            </div>
          ))}
        </div>
        <p className="lp-section-note">Además: manejo <strong>multi-contribuyente</strong> (varios RUC) y <strong>multi-período</strong> (mes/año), con acceso seguro y aislado por usuario.</p>
      </section>

      {/* Precios */}
      <section id="precios" className="lp-section lp-precios">
        <h2>Planes y precios</h2>
        <p className="lp-section-sub">Valores mensuales en USD. Incluyen <strong>IVA {Math.round(IVA * 100)}%</strong>.</p>
        <div className="lp-planes">
          {PLANES.map((p) => {
            const iva = p.neto * IVA
            const total = p.neto + iva
            return (
              <div key={p.nombre} className={`lp-plan ${p.destacado ? 'destacado' : ''}`}>
                {p.destacado && <div className="lp-plan-tag">Más elegido</div>}
                <h3>{p.nombre}</h3>
                <div className="lp-precio">
                  <span className="lp-precio-total">${money(total)}</span>
                  <span className="lp-precio-mes">/mes</span>
                </div>
                <div className="lp-precio-desg">${money(p.neto)} + IVA ${money(iva)}</div>
                <ul>
                  {p.incluye.map((f) => <li key={f}>✓ {f}</li>)}
                </ul>
                <button className="lp-btn lp-btn-primary lp-plan-btn" onClick={() => navigate('/login')}>Contratar</button>
              </div>
            )
          })}
        </div>
        <div className="lp-extras">
          <h4>Complementos</h4>
          <ul>
            <li>Contribuyente (RUC) adicional: <strong>$2,50 + IVA</strong> /mes</li>
            <li>Usuario adicional (estudio contable): <strong>$12,00 + IVA</strong> /mes</li>
            <li>Plan anual: <strong>2 meses gratis</strong></li>
            <li>Prueba gratis: <strong>14 días</strong></li>
          </ul>
        </div>
      </section>

      <footer className="lp-footer">
        <div className="lp-brand"><span>📑</span> Gestor SRI</div>
        <p>Gastos · Retenciones · ICE · Declaraciones — Ecuador</p>
        <button className="lp-btn lp-btn-login" onClick={() => navigate('/login')}>Ingresar</button>
      </footer>
    </div>
  )
}
