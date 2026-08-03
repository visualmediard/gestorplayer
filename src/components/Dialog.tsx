import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// Diálogos con el estilo de la app, en reemplazo de window.confirm/alert
// (que usan el look del navegador y no se pueden personalizar).
//
// Uso:
//   const { confirm, alert } = useDialog()
//   if (!await confirm({ title: '¿Eliminar?', danger: true })) return
//   await alert({ title: 'Error', message: e.message })

type ConfirmOpts = {
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean       // botón principal en rojo (acciones destructivas)
}
type AlertOpts = { title: string; message?: string; okLabel?: string }

type DialogState =
  | ({ kind: 'confirm' } & ConfirmOpts)
  | ({ kind: 'alert' } & AlertOpts)

type DialogApi = {
  confirm: (opts: ConfirmOpts) => Promise<boolean>
  alert: (opts: AlertOpts) => Promise<void>
}

const DialogContext = createContext<DialogApi | undefined>(undefined)

export function useDialog(): DialogApi {
  const ctx = useContext(DialogContext)
  if (!ctx) throw new Error('useDialog debe usarse dentro de <DialogProvider>')
  return ctx
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<DialogState | null>(null)
  // Resolver de la promesa en curso: se llama al cerrar con el resultado.
  const resolveRef = useRef<((v: boolean) => void) | null>(null)
  const mainBtnRef = useRef<HTMLButtonElement>(null)

  const close = useCallback((value: boolean) => {
    setDialog(null)
    const r = resolveRef.current
    resolveRef.current = null
    if (r) r(value)
  }, [])

  const confirm = useCallback((opts: ConfirmOpts) => new Promise<boolean>(resolve => {
    resolveRef.current = resolve
    setDialog({ kind: 'confirm', ...opts })
  }), [])

  const alert = useCallback((opts: AlertOpts) => new Promise<void>(resolve => {
    resolveRef.current = () => resolve()
    setDialog({ kind: 'alert', ...opts })
  }), [])

  // Esc cancela, Enter confirma, y el botón principal recibe el foco.
  useEffect(() => {
    if (!dialog) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false) }
      else if (e.key === 'Enter') { e.preventDefault(); close(true) }
    }
    document.addEventListener('keydown', onKey)
    const t = setTimeout(() => mainBtnRef.current?.focus(), 0)
    return () => { document.removeEventListener('keydown', onKey); clearTimeout(t) }
  }, [dialog, close])

  return (
    <DialogContext.Provider value={{ confirm, alert }}>
      {children}
      {dialog && createPortal(
        <div style={s.backdrop} role="dialog" aria-modal="true"
          onClick={e => { if (e.target === e.currentTarget) close(false) }}>
          <div style={s.card}>
            <h3 style={s.title}>{dialog.title}</h3>
            {dialog.message && <p style={s.message}>{dialog.message}</p>}
            <div style={s.actions}>
              {dialog.kind === 'confirm' && (
                <button style={s.btnOutline} onClick={() => close(false)}>
                  {dialog.cancelLabel ?? 'Cancelar'}
                </button>
              )}
              <button ref={mainBtnRef}
                style={dialog.kind === 'confirm' && dialog.danger ? s.btnDanger : s.btnPrimary}
                onClick={() => close(true)}>
                {dialog.kind === 'confirm' ? (dialog.confirmLabel ?? 'Confirmar') : (dialog.okLabel ?? 'Entendido')}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </DialogContext.Provider>
  )
}

const s: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', backdropFilter: 'blur(4px)',
    zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1.5rem',
    fontFamily: "'Inter', system-ui, sans-serif",
  },
  card: {
    background: '#fff', borderRadius: '14px', width: '100%', maxWidth: '420px',
    padding: '1.5rem', boxShadow: '0 24px 64px rgba(0,0,0,0.25)',
  },
  title: { fontSize: '1.02rem', fontWeight: 700, color: '#0F172A', margin: 0 },
  // pre-line conserva los saltos de línea de los mensajes largos.
  message: { color: '#64748B', fontSize: '0.85rem', lineHeight: 1.6, margin: '0.6rem 0 0', whiteSpace: 'pre-line' },
  actions: { display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1.4rem' },
  btnOutline: {
    padding: '0.55rem 1rem', borderRadius: '8px', border: '1px solid #E2E8F0',
    background: '#fff', color: '#64748B', fontWeight: 500, fontSize: '0.875rem', cursor: 'pointer',
  },
  btnPrimary: {
    padding: '0.55rem 1.1rem', borderRadius: '8px', border: 'none',
    background: '#2563EB', color: '#fff', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer',
  },
  btnDanger: {
    padding: '0.55rem 1.1rem', borderRadius: '8px', border: 'none',
    background: '#EF4444', color: '#fff', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer',
  },
}
