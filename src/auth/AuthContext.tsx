import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

type Profile = {
  id: string
  email: string
  full_name: string | null
  role: 'admin' | 'operator' | 'seller' | 'client'
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
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  const BASE_COLS = 'id, email, full_name, role'

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
    } else {
      setProfile({ is_superadmin: false, ...(data as object) } as Profile)
    }
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

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      if (session?.user) {
        loadProfile(session.user.id)
      } else {
        setProfile(null)
      }
    })

    return () => listener.subscription.unsubscribe()
  }, [])

  async function signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error: error ? error.message : null }
  }

  async function signOut() {
    await supabase.auth.signOut()
  }

  return (
    <AuthContext.Provider value={{ session, profile, loading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth debe usarse dentro de <AuthProvider>')
  return ctx
}
