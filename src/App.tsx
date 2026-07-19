import { useState, useEffect } from 'react'
import { AuthProvider, useAuth } from './auth/AuthContext'
import Login from './pages/Login'
import Register from './pages/Register'
import DashboardHome from './pages/DashboardHome'
import Programs from './pages/Programs'
import Screens from './pages/Screens'
import Content from './pages/Content'
import Stats from './pages/Stats'
import Campaigns from './pages/Campaigns'
import Sidebar from './components/Sidebar'
import Pair from './pages/Pair'
import Player from './pages/Player'

type Page = 'home' | 'programs' | 'screens' | 'content' | 'stats' | 'campaigns'

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768)
  useEffect(() => {
    const fn = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', fn)
    return () => window.removeEventListener('resize', fn)
  }, [])
  return isMobile
}

function useIsTablet() {
  const [isTablet, setIsTablet] = useState(() => window.innerWidth >= 768 && window.innerWidth < 1024)
  useEffect(() => {
    const fn = () => setIsTablet(window.innerWidth >= 768 && window.innerWidth < 1024)
    window.addEventListener('resize', fn)
    return () => window.removeEventListener('resize', fn)
  }, [])
  return isTablet
}

function Gate() {
  const { session, profile, loading, signOut } = useAuth()
  const [page, setPage] = useState<Page>('home')
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [pageKey, setPageKey] = useState(0)
  const [editProgramId, setEditProgramId] = useState<string | null>(null)
  const [campaignReportId, setCampaignReportId] = useState<string | null>(null)
  const isMobile = useIsMobile()
  const isTablet = useIsTablet()

  // Tras autenticarse, si venía de un enlace /pair (u otra ruta protegida)
  // que guardó un destino de retorno, lo enviamos allí.
  useEffect(() => {
    if (session) {
      const back = localStorage.getItem('post_login_redirect')
      if (back) { localStorage.removeItem('post_login_redirect'); window.location.replace(back) }
    }
  }, [session])

  useEffect(() => {
    if (isTablet) setCollapsed(true)
    else if (!isMobile) setCollapsed(false)
  }, [isTablet, isMobile])

  useEffect(() => {
    if (!isMobile) setMobileOpen(false)
  }, [isMobile])

  function navigate(p: string) {
    setEditProgramId(null)
    setCampaignReportId(null)
    setPage(p as Page)
    setPageKey(k => k + 1)
    setMobileOpen(false)
  }

  function openCampaignReport(id: string) {
    setEditProgramId(null)
    setCampaignReportId(id)
    setPage('campaigns')
    setPageKey(k => k + 1)
    setMobileOpen(false)
  }

  function openZoneEditor(programId: string) {
    setEditProgramId(programId)
    setPage('programs')
    setPageKey(k => k + 1)
  }

  if (loading) return (
    <div style={{ minHeight: '100vh', background: '#F0F4F8', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ width: '36px', height: '36px', background: 'linear-gradient(135deg, #3B82F6, #2563EB)', borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21" /></svg>
      </div>
      <div style={{ color: '#94A3B8', fontSize: '0.875rem' }}>Cargando GestorPlayer...</div>
    </div>
  )

  if (!session) {
    const path = window.location.pathname
    if (path === '/register') return <Register />
    return <Login />
  }

  const sidebarW = isMobile ? 0 : (collapsed ? 64 : 260)

  const pageLabel: Record<Page, string> = {
    home: 'Inicio', programs: 'Programas', screens: 'Pantallas',
    content: 'Contenido', stats: 'Estadísticas', campaigns: 'Campañas',
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#F0F4F8' }}>

      {/* Mobile backdrop */}
      {isMobile && mobileOpen && (
        <div
          onClick={() => setMobileOpen(false)}
          className="backdrop"
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 150 }}
        />
      )}

      <Sidebar
        current={page}
        onChange={navigate}
        collapsed={isMobile ? false : collapsed}
        onToggle={() => isMobile ? setMobileOpen(false) : setCollapsed(c => !c)}
        isMobile={isMobile}
        mobileOpen={mobileOpen}
        onSignOut={signOut}
      />

      <div style={{
        marginLeft: sidebarW,
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        transition: 'margin-left 0.25s cubic-bezier(0.4,0,0.2,1)',
        minWidth: 0,
      }}>

        {/* Header */}
        <header style={headerStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
            {isMobile && (
              <button onClick={() => setMobileOpen(true)} style={hamburgerStyle} aria-label="Abrir menú">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#64748B" strokeWidth="2.2">
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </svg>
              </button>
            )}
            <span style={{ color: '#94A3B8', fontSize: '0.8rem', fontWeight: 500 }}>
              {pageLabel[page]}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
            {!isMobile && (
              <span style={{ color: '#64748B', fontSize: '0.85rem', fontWeight: 500 }}>
                {profile?.full_name}
                <span style={{ color: '#CBD5E1', margin: '0 0.3rem' }}>·</span>
                <span style={{ color: '#94A3B8' }}>{profile?.role}</span>
              </span>
            )}

            <div style={{ position: 'relative' }}>
              <div style={bellStyle}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#64748B" strokeWidth="2">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                  <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                </svg>
              </div>
              <div style={{ position: 'absolute', top: '2px', right: '2px', width: '6px', height: '6px', background: '#3B82F6', borderRadius: '50%', border: '1.5px solid #fff' }} />
            </div>

            {!isMobile && (
              <>
                <div style={{ width: '1px', height: '18px', background: '#E2E8F0' }} />
                <button onClick={signOut} style={signOutBtn}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                    <polyline points="16 17 21 12 16 7" />
                    <line x1="21" y1="12" x2="9" y2="12" />
                  </svg>
                  Salir
                </button>
              </>
            )}

            <div style={avatarStyle}>{profile?.full_name?.[0]?.toUpperCase() ?? 'U'}</div>
          </div>
        </header>

        {/* Main content */}
        <main style={{ flex: 1, padding: isMobile ? '1rem' : '1.75rem 2rem', overflowY: 'auto', minWidth: 0 }}>
          <div key={pageKey} className="page-enter">
            {page === 'home'      && <DashboardHome onNavigate={navigate} onEditProgram={openZoneEditor} />}
            {page === 'programs'  && <Programs initialEditId={editProgramId} />}
            {page === 'screens'   && <Screens />}
            {page === 'content'   && <Content />}
            {page === 'stats'     && <Stats onGoToCampaign={openCampaignReport} />}
            {page === 'campaigns' && <Campaigns initialReportId={campaignReportId} />}
          </div>
        </main>
      </div>
    </div>
  )
}

const headerStyle: React.CSSProperties = {
  height: '56px', background: '#fff', borderBottom: '1px solid #E2E8F0',
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '0 1rem', position: 'sticky', top: 0, zIndex: 100,
  boxShadow: '0 1px 4px rgba(0,0,0,0.04)', flexShrink: 0,
}
const hamburgerStyle: React.CSSProperties = {
  width: '34px', height: '34px', borderRadius: '8px',
  border: '1px solid #E2E8F0', background: '#F8FAFC',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer', flexShrink: 0,
}
const bellStyle: React.CSSProperties = {
  width: '34px', height: '34px', borderRadius: '8px',
  border: '1px solid #E2E8F0', background: '#F8FAFC',
  display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
}
const signOutBtn: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '0.4rem',
  padding: '0.4rem 0.75rem', borderRadius: '7px',
  border: '1px solid #E2E8F0', background: '#fff',
  color: '#64748B', fontSize: '0.8rem', fontWeight: 500, cursor: 'pointer',
}
const avatarStyle: React.CSSProperties = {
  width: '32px', height: '32px', borderRadius: '50%',
  background: 'linear-gradient(135deg, #3B82F6, #2563EB)',
  color: '#fff', display: 'flex', alignItems: 'center',
  justifyContent: 'center', fontWeight: 700, fontSize: '0.8rem',
  boxShadow: '0 2px 6px rgba(59,130,246,0.3)', flexShrink: 0,
}

export default function App() {
  // Rutas públicas — no requieren auth
  const path = window.location.pathname
  if (path === '/play' || path === '/player') return <Player />
  if (path === '/pair') return <AuthProvider><Pair /></AuthProvider>
  return <AuthProvider><Gate /></AuthProvider>
}
