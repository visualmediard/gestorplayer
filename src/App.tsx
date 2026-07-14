import { useState } from 'react'
import { AuthProvider, useAuth } from './auth/AuthContext'
import Login from './pages/Login'
import Register from './pages/Register'
import DashboardHome from './pages/DashboardHome'
import Programs from './pages/Programs'
import Screens from './pages/Screens'
import Content from './pages/Content'
import Stats from './pages/Stats'
import Sidebar from './components/Sidebar'

type Page = 'home' | 'programs' | 'screens' | 'content' | 'stats'

function Gate() {
  const { session, profile, loading, signOut } = useAuth()
  const [page, setPage] = useState<Page>('home')
  const [collapsed, setCollapsed] = useState(false)
  const [pageKey, setPageKey] = useState(0)
  const [editProgramId, setEditProgramId] = useState<string | null>(null)

  function navigate(p: string) {
    setEditProgramId(null)
    setPage(p as Page)
    setPageKey(k => k + 1)
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

  const sidebarW = collapsed ? 64 : 260

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#F0F4F8' }}>
      <Sidebar current={page} onChange={navigate} collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />

      <div style={{ marginLeft: sidebarW, flex: 1, display: 'flex', flexDirection: 'column', transition: 'margin-left 0.22s cubic-bezier(0.4,0,0.2,1)', minWidth: 0 }}>

        {/* Header */}
        <header style={headerStyle}>
          <div style={{ color: '#94A3B8', fontSize: '0.8rem', fontWeight: 500 }}>
            {page === 'home' && 'Inicio'}
            {page === 'programs' && 'Programas'}
            {page === 'screens' && 'Pantallas'}
            {page === 'content' && 'Contenido'}
            {page === 'stats' && 'Estadísticas'}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem' }}>
            <span style={{ color: '#64748B', fontSize: '0.85rem', fontWeight: 500 }}>
              {profile?.full_name}
              <span style={{ color: '#CBD5E1', margin: '0 0.35rem' }}>·</span>
              <span style={{ color: '#94A3B8' }}>{profile?.role}</span>
            </span>

            <div style={{ position: 'relative' }}>
              <div style={bellStyle}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#64748B" strokeWidth="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
              </div>
              <div style={{ position: 'absolute', top: '1px', right: '1px', width: '7px', height: '7px', background: '#3B82F6', borderRadius: '50%', border: '1.5px solid #fff' }} />
            </div>

            <div style={{ width: '1px', height: '18px', background: '#E2E8F0' }} />

            <button onClick={signOut} style={signOutBtn}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
              Salir
            </button>

            <div style={avatarStyle}>{profile?.full_name?.[0]?.toUpperCase() ?? 'U'}</div>
          </div>
        </header>

        {/* Content */}
        <main style={{ flex: 1, padding: '1.75rem 2rem', overflowY: 'auto' }}>
          <div key={pageKey} className="page-enter">
            {page === 'home'     && <DashboardHome onNavigate={navigate} onEditProgram={openZoneEditor} />}
            {page === 'programs' && <Programs initialEditId={editProgramId} />}
            {page === 'screens'  && <Screens />}
            {page === 'content'  && <Content />}
            {page === 'stats'    && <Stats />}
          </div>
        </main>
      </div>
    </div>
  )
}

const headerStyle: React.CSSProperties = {
  height: '56px', background: '#fff', borderBottom: '1px solid #E2E8F0',
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '0 1.75rem', position: 'sticky', top: 0, zIndex: 100,
  boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
}
const bellStyle: React.CSSProperties = {
  width: '34px', height: '34px', borderRadius: '8px',
  border: '1px solid #E2E8F0', background: '#F8FAFC',
  display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
}
const signOutBtn: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '0.4rem',
  padding: '0.4rem 0.8rem', borderRadius: '7px',
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
  return <AuthProvider><Gate /></AuthProvider>
}