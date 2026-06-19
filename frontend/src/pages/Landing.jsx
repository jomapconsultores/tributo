import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { contactoAPI } from '../services/api'
import './Landing.css'

const IVA = 0.15

const MODULOS = [
  { icon: '💸', titulo: 'Gastos', desc: 'Clasificación automática de facturas de compra (XML), bajador de facturas del SRI, reportes y datos guardados.' },
  { icon: '🧾', titulo: 'Retenciones', desc: 'Carga de comprobantes de retención (XML), reporte consolidado por contribuyente y exportación a Excel.' },
  { icon: '📈', titulo: 'Ingresos + ICE', desc: 'Cálculo de ICE por botella y caja, Anexo PVP+ICE, ICE-XML con auditoría y análisis de diferencias, catálogo con códigos del SRI y rebajas/exenciones con verificación de proveedores.' },
  { icon: '📋', titulo: 'Declaraciones', desc: 'Cálculo y generación de la Declaración de IVA y de ICE con los formularios oficiales listos para presentar.' },
  { icon: '📑', titulo: 'Reportes de honorarios', desc: 'Controla cuánto te debe cada cliente y por qué servicio, con arrastre mes a mes y desglose por período. Ordena tu cobranza.' },
  { icon: '🧾', titulo: 'Facturación Odoo', desc: 'Emite y concilia facturas directamente en Odoo, con verificación bidireccional para no duplicar y aviso automático al equipo.' },
]

// 3 paquetes (contribuyentes ilimitados)
const PAQUETES = [
  {
    nombre: 'Esencial', icon: '💸', neto: 69, destacado: false,
    incluye: ['Gastos y clasificador automático', 'Bajador de facturas del SRI', 'Retenciones (XML) y reportes', 'Declaración de IVA', 'Reportes de honorarios', 'Contribuyentes ilimitados'],
  },
  {
    nombre: 'ICE Pro', icon: '📈', neto: 109, destacado: true,
    incluye: ['Todo lo del plan Esencial', 'Cálculo de ICE (botella y caja)', 'Anexo PVP+ICE e ICE-XML con auditoría', 'Catálogo SRI y rebajas/exenciones', 'Declaración de ICE', 'Contribuyentes ilimitados'],
  },
  {
    nombre: 'Estudio Completo', icon: '⭐', neto: 179, destacado: false,
    incluye: ['TODOS los módulos', 'Multiusuario y permisos por equipo', 'Acceso y credenciales por cliente', 'Soporte prioritario', 'Contribuyentes ilimitados'],
  },
]

// Add-ons (se suman a cualquier plan)
const ADDONS = [
  {
    icon: '🧾', nombre: 'Facturación Odoo', neto: 42, porUsuario: true, setupNeto: 99,
    desc: 'Emite y concilia facturas en Odoo. Se cobra por usuario que emite, más una configuración inicial única.',
  },
]

const STATS = [
  { target: 6, suffix: '', label: 'Módulos integrados' },
  { target: 100, suffix: '%', label: 'Apegado a la normativa SRI' },
  { target: 0, text: '∞', label: 'Contribuyentes (RUC) por cuenta' },
  { target: 90, suffix: '%', label: 'Menos tiempo en cada declaración' },
]

const money = (n) => n.toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const conIva = (neto) => ({ iva: neto * IVA, total: neto * (1 + IVA) })

// WhatsApp directo (formato internacional: 0963511411 → 593963511411)
const WHATSAPP_NUM = '593963511411'
const WHATSAPP_URL = `https://wa.me/${WHATSAPP_NUM}?text=${encodeURIComponent('Hola, me interesa el Gestor SRI. Quisiera más información.')}`

function WaIcon({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.885-9.885 9.885M20.52 3.449C18.24 1.245 15.24 0 12.045 0 5.463 0 .104 5.359.101 11.892c0 2.096.547 4.142 1.588 5.945L0 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.581 0 11.94-5.359 11.943-11.893a11.821 11.821 0 00-3.416-8.452z" />
    </svg>
  )
}

// Contador animado al entrar en viewport
function Counter({ target, suffix = '', text }) {
  const ref = useRef(null)
  const [val, setVal] = useState(0)
  useEffect(() => {
    if (text) return
    const el = ref.current
    if (!el || !('IntersectionObserver' in window)) { setVal(target); return }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) {
          const dur = 1400; let start = null
          const step = (ts) => {
            if (!start) start = ts
            const p = Math.min((ts - start) / dur, 1)
            const eased = 1 - Math.pow(1 - p, 3)
            setVal(Math.round(eased * target))
            if (p < 1) requestAnimationFrame(step)
          }
          requestAnimationFrame(step)
          io.unobserve(el)
        }
      })
    }, { threshold: 0.6 })
    io.observe(el)
    return () => io.disconnect()
  }, [target, text])
  return <span ref={ref}>{text || val}{!text && suffix}</span>
}

export default function Landing() {
  const navigate = useNavigate()
  const [form, setForm] = useState({ nombre: '', email: '', telefono: '', mensaje: '' })
  const [enviando, setEnviando] = useState(false)
  const [enviado, setEnviado] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const [waitEmail, setWaitEmail] = useState('')
  const [waitOk, setWaitOk] = useState(false)
  const [waitEnviando, setWaitEnviando] = useState(false)

  // Sombra del nav al hacer scroll
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12)
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // Animación de aparición al hacer scroll
  useEffect(() => {
    const els = document.querySelectorAll('.reveal')
    if (!('IntersectionObserver' in window)) { els.forEach((e) => e.classList.add('in')); return }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target) } })
    }, { threshold: 0.12 })
    els.forEach((e) => io.observe(e))
    return () => io.disconnect()
  }, [])

  const anotarEnLista = async (e) => {
    e.preventDefault()
    if (!waitEmail.includes('@')) { alert('Ingresa un email válido.'); return }
    setWaitEnviando(true)
    try {
      await contactoAPI.enviar({
        nombre: 'Lista de espera',
        email: waitEmail,
        telefono: '',
        mensaje: 'LISTA DE ESPERA — Devoluciones IVA Tercera Edad. Avisar cuando esté disponible.',
      })
      setWaitOk(true)
      setWaitEmail('')
    } catch (err) { alert('No se pudo registrar: ' + (err.response?.data?.detail || err.message)) }
    finally { setWaitEnviando(false) }
  }

  const enviar = async (e) => {
    e.preventDefault()
    if (!form.nombre.trim() || !form.email.includes('@')) { alert('Ingresa tu nombre y un email válido.'); return }
    setEnviando(true)
    try {
      await contactoAPI.enviar(form)
      setEnviado(true)
      setForm({ nombre: '', email: '', telefono: '', mensaje: '' })
    } catch (err) { alert('No se pudo enviar: ' + (err.response?.data?.detail || err.message)) }
    finally { setEnviando(false) }
  }

  return (
    <div className="lp">
      <div className="lp-ec-bar" />

      <header className={`lp-nav ${scrolled ? 'scrolled' : ''}`}>
        <div className="lp-brand">
          <span className="lp-brand-badge">📑</span>
          <span className="lp-brand-name">Gestor SRI</span>
          <span className="lp-brand-div" />
          <img src="/capsa-horizontal.png" className="lp-nav-logo" alt="CAPSA" />
        </div>
        <nav className="lp-nav-links">
          <a href="#modulos">Módulos</a>
          <a href="#precios">Precios</a>
          <a href="#contacto">Contacto</a>
          <button className="lp-btn lp-btn-login" onClick={() => navigate('/login')}>Ingresar</button>
        </nav>
      </header>

      <section className="lp-hero">
        <span className="lp-orb a" /><span className="lp-orb b" /><span className="lp-orb c" />
        <div className="lp-hero-inner">
          <div className="lp-hero-logo">
            <img src="/capsa-emblema.png" alt="CAPSA" />
          </div>
          <div className="lp-hero-legend"><span className="lp-dot" /> Soluciones tributarias inteligentes para el Ecuador · SRI 2026</div>
          <h1>Tu gestión tributaria del <span className="lp-grad">SRI</span>, automatizada de punta a punta</h1>
          <p>Clasifica gastos, controla retenciones, calcula el ICE y genera tus declaraciones —
            contribuyentes (RUC) <strong>ilimitados</strong>, en un solo lugar.</p>
          <div className="lp-hero-cta">
            <button className="lp-btn lp-btn-primary lp-btn-lg" onClick={() => navigate('/login')}>Ingresar al sistema</button>
            <a className="lp-btn lp-btn-ghost lp-btn-lg" href="#precios">Ver servicios y precios</a>
          </div>
          <p className="lp-hero-note">Especializado en <strong>ICE de bebidas alcohólicas</strong> — cálculo, anexos y auditoría que casi nadie automatiza.</p>

          <div className="lp-sri-chip" title="Trabaja con los formatos y comprobantes oficiales del SRI">
            <span className="lp-sri-ico">🏛️</span>
            <span className="lp-sri-txt"><strong>Integrado con el SRI</strong>Formatos y comprobantes del Servicio de Rentas Internas</span>
          </div>

          <div className="lp-hero-visual">
            <div className="lp-fcard fc-1">
              <div className="lp-fcard-label">📊 ICE por botella</div>
              <div className="lp-fcard-value">$12.45</div>
              <div className="lp-fcard-sub">específico + ad-valorem</div>
              <div className="lp-fbar"><span style={{ width: '72%' }} /></div>
            </div>
            <div className="lp-fcard fc-2">
              <div className="lp-fcard-label">🧾 Anexo PVP + ICE</div>
              <div className="lp-fcard-value">ICE-XML 2026-06</div>
              <div className="lp-fcard-sub">Auditado y sin diferencias</div>
              <span className="lp-fchip">✓ Listo para el SRI</span>
            </div>
            <div className="lp-fcard fc-3">
              <div className="lp-fcard-label">📈 Total declaración</div>
              <div className="lp-fcard-value">$3,847.20</div>
              <div className="lp-fcard-sub">IVA + ICE del período</div>
              <div className="lp-fbar"><span style={{ width: '88%', background: 'linear-gradient(90deg,#7c3aed,#a78bfa)' }} /></div>
            </div>
            <div className="lp-fcard fc-4">
              <div className="lp-fcard-label">💸 Gastos clasificados</div>
              <div className="lp-fcard-value">1.240 XML</div>
              <div className="lp-fcard-sub">automático por catálogo</div>
              <div className="lp-fbar"><span style={{ width: '64%', background: 'linear-gradient(90deg,#0ea5e9,#38bdf8)' }} /></div>
            </div>
          </div>
        </div>
      </section>

      <section className="lp-stats">
        <div className="lp-stats-inner">
          {STATS.map((s, i) => (
            <div key={s.label} className={`lp-stat reveal d${i}`}>
              <div className="lp-stat-num"><Counter target={s.target} suffix={s.suffix} text={s.text} /></div>
              <div className="lp-stat-lbl">{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      <section id="modulos" className="lp-section">
        <div className="lp-eyebrow reveal">Todo en una sola plataforma</div>
        <h2 className="reveal d1">Todo lo que incluye el sistema</h2>
        <div className="lp-grid">
          {MODULOS.map((m, i) => (
            <div key={m.titulo} className={`lp-card reveal d${i}`}>
              <div className="lp-card-icon">{m.icon}</div>
              <h3>{m.titulo}</h3>
              <p>{m.desc}</p>
            </div>
          ))}
        </div>
        <p className="lp-section-note reveal">Manejo <strong>multi-contribuyente</strong> y <strong>multi-período</strong> (mes/año), con acceso seguro y aislado por usuario.</p>
      </section>

      {/* Precios — 3 paquetes */}
      <section id="precios" className="lp-section lp-precios">
        <div className="lp-eyebrow reveal">Precios transparentes</div>
        <h2 className="reveal d1">Planes</h2>
        <p className="lp-section-sub reveal d2">Elige el paquete que necesitas. <strong>Contribuyentes ilimitados</strong>. Valores mensuales en USD, incluyen <strong>IVA {Math.round(IVA * 100)}%</strong>.</p>
        <div className="lp-planes lp-planes-3">
          {PAQUETES.map((p, i) => {
            const { iva, total } = conIva(p.neto)
            return (
              <div key={p.nombre} className={`lp-plan reveal d${i} ${p.destacado ? 'destacado' : ''}`}>
                {p.destacado && <div className="lp-plan-tag">Todo incluido</div>}
                <div className="lp-card-icon">{p.icon}</div>
                <h3>{p.nombre}</h3>
                <div className="lp-precio"><span className="lp-precio-total">${money(total)}</span><span className="lp-precio-mes">/mes</span></div>
                <div className="lp-precio-desg">${money(p.neto)} + IVA ${money(iva)}</div>
                <ul>{p.incluye.map((f) => <li key={f}>✓ {f}</li>)}</ul>
                <button className="lp-btn lp-btn-primary lp-plan-btn" onClick={() => navigate('/login')}>Contratar</button>
              </div>
            )
          })}
        </div>
        {/* Add-ons (se suman a cualquier plan) */}
        <div className="lp-addons reveal">
          <h4>Complementos (se suman a cualquier plan)</h4>
          <div className="lp-addons-grid">
            {ADDONS.map((a) => {
              const { total } = conIva(a.neto)
              const setupTotal = a.setupNeto ? conIva(a.setupNeto).total : 0
              return (
                <div key={a.nombre} className="lp-addon">
                  <div className="lp-addon-head">
                    <span className="lp-card-icon sm">{a.icon}</span>
                    <h5>{a.nombre}</h5>
                  </div>
                  <div className="lp-addon-precio">
                    <span className="lp-precio-total">${money(total)}</span>
                    <span className="lp-precio-mes">/mes {a.porUsuario ? 'por usuario' : ''}</span>
                  </div>
                  {a.setupNeto > 0 && (
                    <div className="lp-precio-desg">+ ${money(setupTotal)} de configuración inicial (única)</div>
                  )}
                  <p className="lp-addon-desc">{a.desc}</p>
                </div>
              )
            })}
          </div>
        </div>

        {/* Próximamente: Devoluciones IVA — captura de lista de espera */}
        <div className="lp-proximo reveal">
          <span className="lp-proximo-tag">Próximamente</span>
          <div className="lp-proximo-body">
            <span className="lp-card-icon sm">👵</span>
            <div className="lp-proximo-txt">
              <h5>Devoluciones IVA · Tercera Edad</h5>
              <p>Automatiza la devolución de IVA para adultos mayores. Lo estamos afinando — déjanos tu correo y serás el primero en saber cuándo esté disponible.</p>
            </div>
          </div>
          {waitOk ? (
            <div className="lp-ok lp-proximo-ok">✅ ¡Listo! Te avisaremos apenas esté disponible.</div>
          ) : (
            <form className="lp-proximo-form" onSubmit={anotarEnLista}>
              <input
                placeholder="Tu correo electrónico"
                value={waitEmail}
                onChange={(e) => setWaitEmail(e.target.value)}
              />
              <button className="lp-btn lp-btn-primary" type="submit" disabled={waitEnviando}>
                {waitEnviando ? 'Enviando…' : 'Avísame'}
              </button>
            </form>
          )}
        </div>

        <div className="lp-extras reveal">
          <h4>Pago mensual y descuentos por anticipo</h4>
          <p className="lp-extras-p">El cobro es <strong>mensual</strong>: cada pago habilita el sistema por <strong>30 días exactos</strong>. Paga por adelantado y ahorra:</p>
          <ul>
            <li><strong>3 meses</strong> — 5% de descuento</li>
            <li><strong>6 meses</strong> — 10% de descuento</li>
            <li><strong>12 meses</strong> — 25% de descuento</li>
            <li><strong>Contribuyentes (RUC) ilimitados</strong> en todos los paquetes</li>
          </ul>
        </div>
      </section>

      {/* Contacto */}
      <section id="contacto" className="lp-section lp-contacto">
        <div className="lp-eyebrow reveal">Hablemos</div>
        <h2 className="reveal d1">Contáctanos</h2>
        <p className="lp-section-sub reveal d2">¿Dudas o quieres contratar? Escríbenos por WhatsApp o déjanos tus datos.</p>
        <div className="lp-wa-direct reveal">
          <a className="lp-wa-cta" href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer">
            <WaIcon size={22} /> Escríbenos por WhatsApp · 096 351 1411
          </a>
          <span className="lp-wa-or">o déjanos tus datos y te contactamos</span>
        </div>
        {enviado ? (
          <div className="lp-ok">✅ ¡Gracias! Recibimos tu mensaje y te contactaremos pronto.</div>
        ) : (
          <form className="lp-form reveal" onSubmit={enviar}>
            <input placeholder="Nombre *" value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value })} />
            <input placeholder="Correo electrónico *" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <input placeholder="Teléfono / WhatsApp" value={form.telefono} onChange={(e) => setForm({ ...form, telefono: e.target.value })} />
            <textarea placeholder="Mensaje" rows={4} value={form.mensaje} onChange={(e) => setForm({ ...form, mensaje: e.target.value })} />
            <button className="lp-btn lp-btn-primary" type="submit" disabled={enviando}>{enviando ? 'Enviando…' : 'Enviar mensaje'}</button>
          </form>
        )}
      </section>

      <footer className="lp-footer">
        <div className="lp-footer-main">
          <div className="lp-brand"><span className="lp-brand-badge">📑</span> Gestor SRI</div>
          <p>Gastos · Retenciones · ICE · Declaraciones — Hecho en Ecuador 🇪🇨</p>
          <button className="lp-btn lp-btn-login" onClick={() => navigate('/login')}>Ingresar</button>
        </div>
        <div className="lp-footer-dev">
          <div className="lp-dev-text">
            <span>Desarrollado por</span>
            <strong>Marco Antonio Posligua San Martín</strong>
          </div>
          <div className="lp-dev-logo">
            <img src="/capsa-horizontal.png" alt="CAPSA" />
          </div>
        </div>
      </footer>

      <a className="lp-wa-fab" href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer" aria-label="Contactar por WhatsApp">
        <WaIcon size={30} />
        <span className="lp-wa-fab-txt">¿Hablamos?</span>
      </a>
    </div>
  )
}
