import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { adminAPI } from '../services/api'
import './AdminPermisos.css'

const MOD_LABEL = {
  gastos: 'Gastos',
  retenciones: 'Retenciones',
  ingresos_ice: 'Ingresos / ICE',
  declaraciones: 'Declaraciones',
  agente_retencion: 'Agente de retención',
}
const MOD_CLASS = {
  gastos: 'ap-chip-gastos',
  retenciones: 'ap-chip-retenciones',
  ingresos_ice: 'ap-chip-ice',
  declaraciones: 'ap-chip-decl',
  agente_retencion: 'ap-chip-agente-ret',
}
const ROLE_LABEL = { admin: 'Admin', socio: 'Socio', trabajador: 'Funcionario', cliente: 'Cliente' }
const ROLE_CLASS = { admin: 'ap-role-admin', socio: 'ap-role-socio', trabajador: 'ap-role-trabajador', cliente: 'ap-role-cliente' }

function initials(email = '') {
  const parts = email.split('@')[0].split(/[._-]/)
  return parts.slice(0, 2).map((p) => (p[0] || '').toUpperCase()).join('') || '?'
}

function UserCard({ u, navigate }) {
  const [open, setOpen] = useState(false)
  const hasClients = u.clientes_autorizados.length > 0
  const sub = u.subscription

  return (
    <div className="ap-card">
      {/* Cabecera */}
      <div className="ap-card-head">
        <div className="ap-avatar">{initials(u.email)}</div>
        <div className="ap-user-info">
          <div className="ap-email">{u.email}</div>
          <span className={`ap-role-badge ${ROLE_CLASS[u.role] || 'ap-role-cliente'}`}>
            {ROLE_LABEL[u.role] || u.role}
          </span>
        </div>
        {sub && (
          <div className="ap-sub-info">
            <span className={`ap-plan-badge${sub.vencida ? ' vencida' : sub.estado === 'prueba' ? ' prueba' : ''}`}>
              {sub.plan || 'sin plan'}
            </span>
            {sub.estado === 'activo' && !sub.vencida && sub.proximo_pago && (
              <span>vence {sub.proximo_pago}</span>
            )}
            {sub.vencida && <span style={{ color: '#b91c1c' }}>vencida</span>}
            {sub.estado === 'prueba' && <span>prueba</span>}
          </div>
        )}
      </div>

      {/* Módulos + Clientes */}
      <div className="ap-card-body">
        {/* Módulos */}
        <div className="ap-section">
          <div className="ap-section-label">Módulos activos</div>
          {u.role === 'admin' ? (
            <div className="ap-mod-chips">
              {Object.keys(MOD_LABEL).map((m) => (
                <span key={m} className={`ap-chip ${MOD_CLASS[m]}`}>{MOD_LABEL[m]}</span>
              ))}
            </div>
          ) : u.modulos_activos.length > 0 ? (
            <div className="ap-mod-chips">
              {u.modulos_activos.map((m) => (
                <span key={m} className={`ap-chip ${MOD_CLASS[m] || ''}`}>{MOD_LABEL[m] || m}</span>
              ))}
            </div>
          ) : (
            <span className="ap-chip-none">Sin módulos activos</span>
          )}
        </div>

        {/* Clientes autorizados */}
        <div className="ap-section">
          <div className="ap-section-label">Contribuyentes autorizados</div>
          <div className="ap-clients-head" onClick={() => hasClients && setOpen((o) => !o)}>
            <span className="ap-clients-count">{u.clientes_autorizados.length}</span>
            <span className="ap-clients-label">
              {u.clientes_autorizados.length === 1 ? 'contribuyente' : 'contribuyentes'}
            </span>
            {hasClients && (
              <button className="ap-clients-toggle">{open ? 'Ocultar ▲' : 'Ver lista ▼'}</button>
            )}
          </div>
          {open && (
            <div className="ap-clients-list">
              {u.clientes_autorizados.map((c) => (
                <div key={c.identificacion} className="ap-client-row">
                  <span className="ap-client-ruc">{c.identificacion}</span>
                  <span className="ap-client-name">{c.nombre}</span>
                </div>
              ))}
            </div>
          )}
          {!hasClients && <span className="ap-chip-none">Sin acceso a contribuyentes</span>}
        </div>
      </div>

      {/* Acciones rápidas */}
      <div className="ap-card-footer">
        <button className="ap-action" onClick={() => navigate(`/admin?uid=${u.user_id}`)}>
          Gestionar módulos
        </button>
        <button className="ap-action" onClick={() => navigate(`/admin/acceso-clientes?uid=${u.user_id}`)}>
          Gestionar acceso
        </button>
      </div>
    </div>
  )
}

export default function AdminPermisos() {
  const navigate = useNavigate()
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('todos')

  useEffect(() => {
    adminAPI.permisos()
      .then((r) => setUsers(r.data || []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const filtered = useMemo(() => {
    if (filter === 'todos') return users
    return users.filter((u) => u.role === filter)
  }, [users, filter])

  const counts = useMemo(() => ({
    todos: users.length,
    admin: users.filter((u) => u.role === 'admin').length,
    socio: users.filter((u) => u.role === 'socio').length,
    cliente: users.filter((u) => u.role === 'cliente').length,
  }), [users])

  return (
    <div className="ap-wrap">
      <div className="ap-header">
        <h1 className="ap-title">Permisos del Equipo</h1>
        <p className="ap-sub">Módulos activos y contribuyentes autorizados por usuario.</p>
      </div>

      <div className="ap-filters">
        {[
          { key: 'todos', label: 'Todos' },
          { key: 'admin', label: 'Admins' },
          { key: 'socio', label: 'Socios' },
          { key: 'cliente', label: 'Clientes' },
        ].map(({ key, label }) => (
          <button
            key={key}
            className={`ap-filter-btn ${filter === key ? 'active' : ''}`}
            onClick={() => setFilter(key)}
          >
            {label} ({counts[key] ?? 0})
          </button>
        ))}
        <span className="ap-count-txt">{filtered.length} usuario{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      {loading && <div className="ap-loading">Cargando permisos…</div>}

      {!loading && filtered.length === 0 && (
        <div className="ap-empty">No hay usuarios para mostrar.</div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="ap-list">
          {filtered.map((u) => (
            <UserCard key={u.user_id} u={u} navigate={navigate} />
          ))}
        </div>
      )}
    </div>
  )
}
