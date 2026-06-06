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
]

// 3 paquetes (contribuyentes ilimitados)
const PAQUETES = [
  {
    nombre: 'Cálculo del ICE', icon: '📈', neto: 50, destacado: false,
    incluye: ['Cálculo de ICE (botella y caja)', 'Anexo PVP+ICE', 'ICE-XML con auditoría', 'Catálogo con códigos del SRI', 'Rebajas y exenciones', 'Información útil (Códigos ICE)', 'Contribuyentes ilimitados'],
  },
  {
    nombre: 'Gastos y Retenciones', icon: '💸', neto: 50, destacado: false,
    incluye: ['Bajador de facturas del SRI', 'Clasificación automática de gastos', 'Retenciones (XML) y reportes', 'Datos guardados y exportes', 'Contribuyentes ilimitados'],
  },
  {
    nombre: 'Sistema Completo', icon: '⭐', neto: 150, destacado: true,
    incluye: ['TODOS los módulos', 'Gastos + Retenciones', 'Ingresos + ICE completo', 'Declaraciones IVA e ICE', 'Multiusuario y soporte prioritario', 'Contribuyentes ilimitados'],
  },
]

const STATS = [
  { target: 4, suffix: '', label: 'Módulos integrados' },
  { target: 100, suffix: '%', label: 'Apegado a la normativa SRI' },
  { target: 0, text: '∞', label: 'Contribuyentes (RUC) por cuenta' },
  { target: 90, suffix: '%', label: 'Menos tiempo en cada declaración' },
]

const money = (n) => n.toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const conIva = (neto) => ({ iva: neto * IVA, total: neto * (1 + IVA) })

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
        <div className="lp-brand"><span className="lp-brand-badge">📑</span> Gestor SRI</div>
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
          <div className="lp-badge"><span className="lp-dot" /> Plataforma tributaria para Ecuador · Actualizada 2026</div>
          <h1>Tu gestión tributaria del <span className="lp-grad">SRI</span>, automatizada de punta a punta</h1>
          <p>Clasifica gastos, controla retenciones, calcula el ICE y genera tus declaraciones —
            contribuyentes (RUC) <strong>ilimitados</strong>, en un solo lugar.</p>
          <div className="lp-hero-cta">
            <button className="lp-btn lp-btn-primary lp-btn-lg" onClick={() => navigate('/login')}>Ingresar al sistema</button>
            <a className="lp-btn lp-btn-ghost lp-btn-lg" href="#precios">Ver servicios y precios</a>
          </div>
          <p className="lp-hero-note">Especializado en <strong>ICE de bebidas alcohólicas</strong> — cálculo, anexos y auditoría que casi nadie automatiza.</p>

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
        <p className="lp-section-sub reveal d2">¿Dudas o quieres contratar? Déjanos tus datos y te escribimos.</p>
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
        <div className="lp-brand"><span className="lp-brand-badge">📑</span> Gestor SRI</div>
        <p>Gastos · Retenciones · ICE · Declaraciones — Hecho en Ecuador 🇪🇨</p>
        <button className="lp-btn lp-btn-login" onClick={() => navigate('/login')}>Ingresar</button>
      </footer>
    </div>
  )
}
