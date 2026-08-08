import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

type Profile = {
  id: string
  email: string
  full_name: string | null
  role: 'admin' | 'operator' | 'seller' | 'client'
  organization_id: string | null
  // Superadmin de la plataforma (dueño de GestPlayer). Ortogonal a `role`, que
  // es el permiso DENTRO de una organización.
  is_superadmin: boolean
}

type AuthContextType = {
  session: Session | null
  profile: Profile | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
  // Motivo por el que se cerró la sesión sola (organización suspendida). Login
  // lo muestra: al limpiarse la sesión, el motivo se perdería de otro modo.
  suspendedNotice: string | null
  clearSuspendedNotice: () => void
}

const SUSPENDED_MSG = 'Tu cuenta está suspendida, contacta a tu proveedor.'

// Vigilancia de fondo. El corte real ocurre al iniciar sesión y al volver el
// foco a la pestaña; este intervalo solo cubre el caso de una pestaña que
// queda visible indefinidamente, así que no hace falta que sea agresivo.
const STATUS_CHECK_MS = 10 * 60 * 60 * 1000  // 10 horas

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [suspendedNotice, setSuspendedNotice] = useState<string | null>(null)

  const BASE_COLS = 'id, email, full_name, role, organization_id'

  // ¿Hay que echar al usuario? Fail-open a propósito: ante cualquier error
  // (red caída, migración sin correr, RPC ausente) devuelve false. Un fallo de
  // infraestructura no debe dejar a los clientes fuera de su propio panel.
  async function isOrgBlocked(): Promise<boolean> {
    const { data, error } = await supabase.rpc('my_org_status')
    if (error || !data) return false
    return data === 'suspended' || data === 'cancelled'
  }

  async function blockAndSignOut() {
    await supabase.auth.signOut()
    setProfile(null)
    setSuspendedNotice(SUSPENDED_MSG)
  }

  async function loadProfile(userId: string) {
    let { data, error } = await supabase
      .from('profiles')
      .select(`${BASE_COLS}, is_superadmin`)
      .eq('id', userId)
      .single()

    // Si el frontend se despliega antes que la migración del superadmin, la
    // columna todavía no existe y el select entero falla. Reintenta sin ella
    // para no dejar a todo el mundo sin perfil por un despliegue desordenado.
    if (error?.message?.includes('is_superadmin')) {
      ;({ data, error } = await supabase
        .from('profiles').select(BASE_COLS).eq('id', userId).single())
    }

    if (error) {
      console.error('Error cargando perfil:', error.message)
      setProfile(null)
      return
    }

    const p = { is_superadmin: false, ...(data as object) } as Profile

    // El superadmin queda exento: si su propia organización se marcara como
    // suspendida, quedaría fuera del panel sin forma de revertirlo.
    if (!p.is_superadmin && await isOrgBlocked()) {
      await blockAndSignOut()
      return
    }

    setProfile(p)
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      if (session?.user) {
        loadProfile(session.user.id).finally(() => setLoading(false))
      } else {
        setLoading(false)
      }
    })

    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session)
      if (!session?.user) { setProfile(null); return }
      // En SIGNED_IN se vuelve a "cargando" hasta resolver el perfil y el
      // estado de la organización: si no, el dashboard alcanza a pintarse un
      // instante antes de que el chequeo eche al usuario suspendido. En
      // TOKEN_REFRESHED no, que si no la pantalla de carga parpadearía sola
      // cada vez que se renueva el token.
      if (event === 'SIGNED_IN') {
        setLoading(true)
        loadProfile(session.user.id).finally(() => setLoading(false))
      } else {
        loadProfile(session.user.id)
      }
    })

    return () => listener.subscription.unsubscribe()
  }, [])

  // Re-chequeo del estado de la organización mientras la sesión sigue abierta:
  // al volver el foco a la pestaña (reacción inmediata) y cada 10 h de reserva.
  // Depende de valores primitivos, no del objeto `profile`: ese se re-crea en
  // cada TOKEN_REFRESHED y reiniciaría el intervalo antes de que llegue a
  // dispararse.
  const userId = session?.user?.id ?? null
  const isSuper = profile?.is_superadmin ?? false
  useEffect(() => {
    if (!userId || isSuper) return

    const check = async () => { if (await isOrgBlocked()) await blockAndSignOut() }
    const onVisible = () => { if (document.visibilityState === 'visible') check() }

    const iv = setInterval(check, STATUS_CHECK_MS)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(iv)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [userId, isSuper])

  async function signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error: error ? error.message : null }
  }

  async function signOut() {
    await supabase.auth.signOut()
  }

  return (
    <AuthContext.Provider value={{
      session, profile, loading, signIn, signOut,
      suspendedNotice, clearSuspendedNotice: () => setSuspendedNotice(null),
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth debe usarse dentro de <AuthProvider>')
  return ctx
}
