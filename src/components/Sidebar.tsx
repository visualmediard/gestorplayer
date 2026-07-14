import { useAuth } from '../auth/AuthContext'

type Props = {
  current: string
  onChange: (p: string) => void
  collapsed: boolean
  onToggle: () => void
  isMobile: boolean
  mobileOpen: boolean
  onSignOut: () => void
}

const nav = [
  { id: 'home', label: 'Inicio', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg> },
  { id: 'programs', label: 'Programas', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> },
  { id: 'screens', label: 'Pantallas', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/></svg> },
  { id: 'content', label: 'Contenido', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> },
  { id: 'stats', label: 'Estadísticas', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg> },
  { id: 'campaigns', label: 'Campañas', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg> },
]

export default function Sidebar({ current, onChange, collapsed, onToggle, isMobile, mobileOpen, onSignOut }: Props) {
  const { profile } = useAuth()
  const w = collapsed ? 64 : 260

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
        padding: (!isMobile && collapsed) ? '1rem 0' : '0 1rem',
        display: 'flex',
        alignItems: 'center',
        justifyContent: (!isMobile && collapsed) ? 'center' : 'space-between',
        borderBottom: '1px solid #F1F5F9',
        height: '56px',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <div style={s.logoIcon}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21" /></svg>
          </div>
          {(isMobile || !collapsed) && (
            <>
              <span style={{ fontWeight: 800, fontSize: '0.95rem', color: '#0F172A', letterSpacing: '-0.01em' }}>GestorPlayer</span>
              <span style={s.betaBadge}>BETA</span>
            </>
          )}
        </div>

        <button onClick={onToggle} style={s.toggleBtn} aria-label={isMobile ? 'Cerrar menú' : (collapsed ? 'Expandir' : 'Colapsar')}>
          {isMobile ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          ) : collapsed ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
          )}
        </button>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: '0.75rem 0.5rem', display: 'flex', flexDirection: 'column', gap: '2px', overflowY: 'auto' }}>
        {(isMobile || !collapsed) && (
          <div style={{ fontSize: '0.65rem', fontWeight: 700, color: '#CBD5E1', letterSpacing: '0.1em', padding: '0.25rem 0.875rem 0.5rem', textTransform: 'uppercase' }}>
            Menú
          </div>
        )}
        {nav.map(item => {
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
      </nav>

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
