import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { hasRole, type Role } from '../lib/roles'
import { fetchStorageUsage, onStorageChanged, formatBytes, type StorageUsage } from '../lib/storage'
import logoNegro from '../assets/logo/logo-negro.png'
import logoIcon from '../assets/logo/icon.png'

type Props = {
  current: string
  onChange: (p: string) => void
  collapsed: boolean
  onToggle: () => void
  isMobile: boolean
  mobileOpen: boolean
  onSignOut: () => void
}

const nav: { id: string; label: string; icon: React.ReactNode; roles: Role[] }[] = [
  { id: 'home', label: 'Inicio', roles: ['admin', 'operator', 'seller'], icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg> },
  { id: 'programs', label: 'Programas', roles: ['admin'], icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg> },
  { id: 'screens', label: 'Pantallas', roles: ['admin', 'operator', 'seller'], icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/><path d="M1 7l3-3m19 3l-3-3"/></svg> },
  { id: 'content', label: 'Contenido', roles: ['admin', 'operator'], icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> },
  { id: 'campaigns', label: 'Campañas', roles: ['admin', 'operator', 'seller'], icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11l18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg> },
  { id: 'stats', label: 'Estadísticas', roles: ['admin', 'operator', 'seller'], icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg> },
  { id: 'settings', label: 'Configuración', roles: ['admin'], icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg> },
]

export default function Sidebar({ current, onChange, collapsed, onToggle, isMobile, mobileOpen, onSignOut }: Props) {
  const { profile } = useAuth()
  const w = collapsed ? 64 : 260

  // Consumo de almacenamiento: se carga al montar y se refresca cuando un
  // flujo de subida/borrado emite el evento (sin polling).
  const [usage, setUsage] = useState<StorageUsage | null>(null)
  useEffect(() => {
    let alive = true
    const refresh = () => { fetchStorageUsage().then(u => { if (alive) setUsage(u) }) }
    refresh()
    const off = onStorageChanged(refresh)
    return () => { alive = false; off() }
  }, [])


  const pct = usage && usage.limitBytes > 0
    ? Math.min(100, (usage.usedBytes / usage.limitBytes) * 100)
    : 0
  const barColor = pct > 95 ? '#EF4444' : pct > 80 ? '#F59E0B' : '#3B82F6'

  const sidebarStyle: React.CSSProperties = {
    height: '100vh',
    background: '#fff',
    borderRight: '1px solid #E2E8F0',
    display: 'flex',
    flexDirection: 'column',
    position: 'fixed',
    top: 0,
    left: 0,
    bottom: 0,
    width: isMobile ? 260 : w,
    transform: isMobile ? (mobileOpen ? 'translateX(0)' : 'translateX(-100%)') : 'translateX(0)',
    transition: isMobile
      ? 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)'
      : 'width 0.22s cubic-bezier(0.4, 0, 0.2, 1)',
    overflow: 'hidden',
    zIndex: 200,
    boxShadow: isMobile && mobileOpen
      ? '6px 0 32px rgba(0,0,0,0.15)'
      : '2px 0 12px rgba(0,0,0,0.04)',
  }

  return (
    <aside style={sidebarStyle}>
      {/* Logo + toggle */}
      <div style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderBottom: '1px solid #F1F5F9',
        height: '68px',
        flexShrink: 0,
      }}>
        {(!isMobile && collapsed) ? (
          // Colapsado: el logo (de la org o el ícono GestPlayer) es el botón
          // para expandir.
          <button onClick={onToggle} title="Expandir menú" aria-label="Expandir menú"
            style={{ border: 'none', padding: 0, background: 'transparent', cursor: 'pointer', display: 'flex' }}>
            <img src={logoIcon} alt="GestPlayer" style={{ width: '34px', height: '34px' }} />
          </button>
        ) : (
          <>
            <button onClick={() => onChange('home')} title="Ir al inicio"
              style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
              <img src={logoNegro} alt="GestPlayer" style={{ height: '46px', width: 'auto' }} />
              <span style={s.betaBadge}>BETA</span>
            </button>

            <button onClick={onToggle} style={{ ...s.toggleBtn, position: 'absolute', right: '0.75rem' }} aria-label={isMobile ? 'Cerrar menú' : 'Colapsar'}>
              {isMobile ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2.5">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
              )}
            </button>
          </>
        )}
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: '0.75rem 0.5rem', display: 'flex', flexDirection: 'column', gap: '2px', overflowY: 'auto' }}>
        {nav.filter(item => hasRole(profile?.role, ...item.roles)).map(item => {
          const isActive = current === item.id
          const showLabel = isMobile || !collapsed
          return (
            <button
              key={item.id}
              onClick={() => onChange(item.id)}
              title={(!isMobile && collapsed) ? item.label : undefined}
              className="nav-item"
              style={{
                display: 'flex', alignItems: 'center',
                gap: showLabel ? '0.75rem' : 0,
                justifyContent: showLabel ? 'flex-start' : 'center',
                padding: showLabel ? '0.6rem 0.875rem' : '0.65rem 0',
                borderRadius: '8px', border: 'none',
                background: isActive ? '#EFF6FF' : 'transparent',
                color: isActive ? '#2563EB' : '#64748B',
                fontSize: '0.875rem', fontWeight: isActive ? 600 : 500,
                width: '100%', position: 'relative',
                cursor: 'pointer',
              }}>
              {isActive && showLabel && (
                <div style={{ position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)', width: '3px', height: '60%', background: '#2563EB', borderRadius: '0 3px 3px 0' }} />
              )}
              <span style={{ color: isActive ? '#2563EB' : '#94A3B8', flexShrink: 0, display: 'flex' }}>
                {item.icon}
              </span>
              {showLabel && <span>{item.label}</span>}
            </button>
          )
        })}

        {/* Superadmin: no es un rol de organización (no entra en `nav`, que
            filtra por Role), sino una marca global del dueño de la plataforma.
            Va en su propio bloque, separado del menú normal. */}
        {profile?.is_superadmin && (() => {
          const isActive = current === 'superadmin'
          const showLabel = isMobile || !collapsed
          return (
            <>
              <div style={{ height: '1px', background: '#F1F5F9', margin: '0.5rem 0.5rem 0.4rem' }} />
              <button
                onClick={() => onChange('superadmin')}
                title={(!isMobile && collapsed) ? 'Superadmin' : undefined}
                className="nav-item"
                style={{
                  display: 'flex', alignItems: 'center',
                  gap: showLabel ? '0.75rem' : 0,
                  justifyContent: showLabel ? 'flex-start' : 'center',
                  padding: showLabel ? '0.6rem 0.875rem' : '0.65rem 0',
                  borderRadius: '8px', border: 'none',
                  background: isActive ? '#EFF6FF' : 'transparent',
                  color: isActive ? '#2563EB' : '#64748B',
                  fontSize: '0.875rem', fontWeight: isActive ? 600 : 500,
                  width: '100%', position: 'relative', cursor: 'pointer',
                }}>
                {isActive && showLabel && (
                  <div style={{ position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)', width: '3px', height: '60%', background: '#2563EB', borderRadius: '0 3px 3px 0' }} />
                )}
                <span style={{ color: isActive ? '#2563EB' : '#94A3B8', flexShrink: 0, display: 'flex' }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                    <path d="M9 12l2 2 4-4"/>
                  </svg>
                </span>
                {showLabel && <span>Superadmin</span>}
              </button>
            </>
          )
        })()}
      </nav>

      {/* Almacenamiento */}
      {usage && (
        (isMobile || !collapsed) ? (
          <div style={{ padding: '0.75rem 0.75rem 0', flexShrink: 0 }}>
            <div style={{ padding: '0.6rem 0.7rem', borderRadius: '10px', background: '#F8FAFC', border: '1px solid #F1F5F9' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.72rem', fontWeight: 600, color: '#64748B' }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
                  Almacenamiento
                </span>
                <span style={{ fontSize: '0.7rem', fontWeight: 700, color: barColor }}>{Math.round(pct)}%</span>
              </div>
              <div style={{ height: '6px', background: '#E2E8F0', borderRadius: '999px', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: barColor, borderRadius: '999px', transition: 'width 0.3s, background 0.3s' }} />
              </div>
              <div style={{ marginTop: '0.35rem', fontSize: '0.68rem', color: '#94A3B8' }}>
                {formatBytes(usage.usedBytes)} de {formatBytes(usage.limitBytes)}
              </div>
            </div>
          </div>
        ) : (
          <div style={{ padding: '0.75rem 0', display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
            <div title={`Almacenamiento: ${formatBytes(usage.usedBytes)} de ${formatBytes(usage.limitBytes)} (${Math.round(pct)}%)`}
              style={{ position: 'relative', width: '34px', height: '34px' }}>
              <svg width="34" height="34" viewBox="0 0 34 34" style={{ transform: 'rotate(-90deg)' }}>
                <circle cx="17" cy="17" r="14" fill="none" stroke="#E2E8F0" strokeWidth="4" />
                <circle cx="17" cy="17" r="14" fill="none" stroke={barColor} strokeWidth="4" strokeLinecap="round"
                  strokeDasharray={`${(pct / 100) * (2 * Math.PI * 14)} ${2 * Math.PI * 14}`} />
              </svg>
              <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.58rem', fontWeight: 700, color: barColor }}>
                {Math.round(pct)}%
              </span>
            </div>
          </div>
        )
      )}

      {/* User */}
      <div style={{ padding: (isMobile || !collapsed) ? '0.75rem' : '0.75rem 0', borderTop: '1px solid #F1F5F9', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {(isMobile || !collapsed) ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.6rem 0.75rem', borderRadius: '10px', background: '#F8FAFC', border: '1px solid #F1F5F9' }}>
            <div style={s.avatar}>{profile?.full_name?.[0]?.toUpperCase() ?? 'U'}</div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: '0.82rem', color: '#0F172A', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{profile?.full_name}</div>
              <div style={{ fontSize: '0.7rem', color: '#94A3B8' }}>{(profile as any)?.organization_name ?? profile?.role}</div>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <div style={s.avatar} title={profile?.full_name ?? ''}>{profile?.full_name?.[0]?.toUpperCase() ?? 'U'}</div>
          </div>
        )}

        {/* Sign out button — visible only on mobile inside drawer */}
        {isMobile && (
          <button onClick={onSignOut} style={s.signOutMobile}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
              <polyline points="16 17 21 12 16 7"/>
              <line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
            Cerrar sesión
          </button>
        )}
      </div>
    </aside>
  )
}

const s: Record<string, React.CSSProperties> = {
  logoIcon: {
    width: '28px', height: '28px',
    background: 'linear-gradient(135deg, #3B82F6, #2563EB)',
    borderRadius: '7px', display: 'flex', alignItems: 'center',
    justifyContent: 'center', flexShrink: 0,
    boxShadow: '0 2px 8px rgba(59,130,246,0.35)',
  },
  betaBadge: {
    fontSize: '0.55rem', fontWeight: 700, background: '#EFF6FF',
    color: '#3B82F6', border: '1px solid #BFDBFE',
    borderRadius: '4px', padding: '1px 5px', letterSpacing: '0.06em',
  },
  toggleBtn: {
    width: '26px', height: '26px', borderRadius: '6px',
    border: '1px solid #E2E8F0', background: '#F8FAFC',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer', flexShrink: 0, color: '#94A3B8',
  },
  avatar: {
    width: '32px', height: '32px', borderRadius: '50%',
    background: 'linear-gradient(135deg, #3B82F6, #2563EB)',
    color: '#fff', display: 'flex', alignItems: 'center',
    justifyContent: 'center', fontWeight: 700, fontSize: '0.8rem',
    flexShrink: 0, boxShadow: '0 2px 6px rgba(59,130,246,0.3)',
  },
  signOutMobile: {
    display: 'flex', alignItems: 'center', gap: '0.5rem',
    padding: '0.6rem 0.875rem', borderRadius: '8px',
    border: '1px solid #E2E8F0', background: '#fff',
    color: '#64748B', fontSize: '0.85rem', fontWeight: 500,
    cursor: 'pointer', width: '100%',
  },
}
