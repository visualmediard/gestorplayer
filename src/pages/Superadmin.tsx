import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { useDialog } from '../components/Dialog'
import { formatBytes } from '../lib/storage'

// Panel del dueño de la plataforma: todas las organizaciones registradas.
// Los datos llegan agregados en una sola RPC (superadmin_orgs_overview), que es
// SECURITY DEFINER y se auto-verifica con is_superadmin() en el servidor. El
// guard de esta página solo evita mostrar la pantalla — no es la barrera real.

type OrgRow = {
  id: string
  name: string
  slug: string | null
  status: 'active' | 'suspended' | 'cancelled'
  created_at: string
  storage_limit_mb: number
  used_bytes: number | string
  screen_count: number
  user_count: number
  // NULL = sin límite. El conteo va al lado en la tabla: un límite sin el
  // consumo delante no dice nada.
  screen_limit: number | null
  zone_limit: number | null
  zone_count: number
}

const STATUS_LABEL: Record<OrgRow['status'], string> = {
  active: 'Activa', suspended: 'Suspendida', cancelled: 'Cancelada',
}

// verde / ámbar / rojo — mismos tonos que el resto del dashboard.
const STATUS_COLOR: Record<OrgRow['status'], { bg: string; fg: string; border: string; dot: string }> = {
  active:    { bg: '#F0FDF4', fg: '#15803D', border: '#BBF7D0', dot: '#22C55E' },
  suspended: { bg: '#FFFBEB', fg: '#B45309', border: '#FDE68A', dot: '#F59E0B' },
  cancelled: { bg: '#FEF2F2', fg: '#B91C1C', border: '#FECACA', dot: '#EF4444' },
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('es-DO', { day: '2-digit', month: 'short', year: 'numeric' })
}

export default function Superadmin() {
  const { profile } = useAuth()
  const { confirm } = useDialog()
  const [rows, setRows] = useState<OrgRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // Edición del límite de almacenamiento, en la propia celda.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [limitInput, setLimitInput] = useState('')
  const [savingLimit, setSavingLimit] = useState(false)
  const [limitError, setLimitError] = useState<string | null>(null)
  const [editingLimitsId, setEditingLimitsId] = useState<string | null>(null)
  const [screenLimitInput, setScreenLimitInput] = useState('')
  const [zoneLimitInput, setZoneLimitInput] = useState('')
  const [savingLimits, setSavingLimits] = useState(false)
  const [limitsError, setLimitsError] = useState<string | null>(null)

  // Eliminación definitiva: `target` es la organización abierta en el modal.
  const [target, setTarget] = useState<OrgRow | null>(null)
  const [confirmText, setConfirmText] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Comparación estricta, sin trim ni minúsculas (igual que GitHub al borrar un
  // repo): pegar el nombre con un espacio de más no debe habilitar el botón.
  const nameMatches = !!target && confirmText === target.name

  async function load() {
    setLoading(true)
    const { data, error } = await supabase.rpc('superadmin_orgs_overview')
    if (error) { setError(error.message); setRows([]) }
    else { setError(null); setRows((data ?? []) as OrgRow[]) }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  // Alterna activa ↔ suspendida. 'cancelled' es un estado terminal: desde aquí
  // se reactiva, pero no se cancela (eso sería una baja de cliente).
  async function toggleStatus(row: OrgRow) {
    const next = row.status === 'active' ? 'suspended' : 'active'
    const ok = await confirm({
      title: next === 'suspended' ? `¿Suspender "${row.name}"?` : `¿Reactivar "${row.name}"?`,
      message: next === 'suspended'
        ? 'La organización quedará marcada como suspendida.'
        : 'La organización volverá a estado activo.',
      confirmLabel: next === 'suspended' ? 'Suspender' : 'Reactivar',
      danger: next === 'suspended',
    })
    if (!ok) return

    setBusyId(row.id)
    const { error } = await supabase.rpc('set_org_status', { p_org_id: row.id, p_status: next })
    setBusyId(null)
    if (error) { setError(error.message); return }
    setRows(rs => rs.map(r => (r.id === row.id ? { ...r, status: next } : r)))
  }

  async function copyFolder(id: string) {
    try {
      await navigator.clipboard.writeText(id)
      setCopiedId(id)
      setTimeout(() => setCopiedId(c => (c === id ? null : c)), 1500)
    } catch { /* sin portapapeles: el UUID igual está visible */ }
  }

  function startEditLimit(r: OrgRow) {
    setEditingId(r.id)
    setLimitInput(String((r.storage_limit_mb || 2048) / 1024))
    setLimitError(null)
  }

  async function saveLimit(r: OrgRow) {
    // Se acepta coma decimal: el panel está en es-DO y "2,5" es lo natural aquí.
    const gb = parseFloat(limitInput.replace(',', '.'))
    if (!isFinite(gb) || gb <= 0) { setLimitError('Valor inválido'); return }

    const mb = Math.round(gb * 1024)
    setSavingLimit(true); setLimitError(null)
    const { error } = await supabase.rpc('set_org_storage_limit', { p_org_id: r.id, p_limit_mb: mb })
    setSavingLimit(false)
    if (error) { setLimitError(error.message); return }

    setRows(rs => rs.map(x => (x.id === r.id ? { ...x, storage_limit_mb: mb } : x)))
    setEditingId(null)
  }

  // ── Límites de pantallas y zonas ──────────────────────────────────────
  // Se editan juntos porque viven en la misma RPC y en la misma fila. Vacío
  // significa "sin límite", que es distinto de cero: cero no dejaría crear
  // nada, y no hay forma de expresarlo con un número.
  function startEditLimits(r: OrgRow) {
    setEditingLimitsId(r.id)
    setScreenLimitInput(r.screen_limit == null ? '' : String(r.screen_limit))
    setZoneLimitInput(r.zone_limit == null ? '' : String(r.zone_limit))
    setLimitsError(null)
  }

  async function saveLimits(r: OrgRow) {
    const parse = (v: string): number | null | 'bad' => {
      const t = v.trim()
      if (t === '') return null                       // sin límite
      const n = Number(t)
      if (!Number.isInteger(n) || n < 1 || n > 10000) return 'bad'
      return n
    }
    const sc = parse(screenLimitInput)
    const zn = parse(zoneLimitInput)
    if (sc === 'bad' || zn === 'bad') {
      setLimitsError('Cada límite debe ser un entero entre 1 y 10000, o vacío para sin límite')
      return
    }

    setSavingLimits(true); setLimitsError(null)
    const { error } = await supabase.rpc('set_org_limits', {
      p_org_id: r.id, p_screen_limit: sc, p_zone_limit: zn,
    })
    setSavingLimits(false)
    if (error) { setLimitsError(error.message); return }

    setRows(rs => rs.map(x => (x.id === r.id ? { ...x, screen_limit: sc, zone_limit: zn } : x)))
    setEditingLimitsId(null)
  }

  function downloadBackup(name: string, backup: unknown) {
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `respaldo-${name.replace(/[^\w-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function handleDelete() {
    if (!target || !nameMatches) return
    setDeleting(true); setDeleteError(null)

    const { data, error } = await supabase.functions.invoke('superadmin-delete-org', {
      body: { orgId: target.id, confirmName: confirmText },
    })

    // functions.invoke devuelve un error genérico ("non-2xx status code") y deja
    // data en null: el motivo real viene en el cuerpo, dentro de error.context.
    if (error) {
      let msg = error.message
      try {
        const j = await (error as any).context?.json()
        if (j?.error) msg = j.error
        // Si los archivos ya se borraron pero la base de datos falló, el
        // respaldo viaja en la respuesta de error: es justo cuando más falta
        // hace, porque los archivos ya no están.
        if (j?.backup) downloadBackup(target.name, j.backup)
      } catch { /* se queda el genérico */ }
      setDeleting(false); setDeleteError(msg); return
    }

    // Se descarga solo: es la única copia y no hay segunda oportunidad.
    if ((data as any)?.backup) downloadBackup(target.name, (data as any).backup)

    setDeleting(false)
    setTarget(null); setConfirmText('')
    load()
  }

  if (!profile?.is_superadmin) {
    return (
      <div style={s.emptyBox}>
        <div style={{ fontSize: '1.05rem', fontWeight: 600, color: '#0F172A' }}>No autorizado</div>
        <div style={{ color: '#64748B', fontSize: '0.875rem', marginTop: '0.4rem' }}>
          Esta sección es exclusiva del administrador de la plataforma.
        </div>
      </div>
    )
  }

  const q = search.trim().toLowerCase()
  const visible = q
    ? rows.filter(r => r.name.toLowerCase().includes(q) || (r.slug ?? '').toLowerCase().includes(q))
    : rows

  const totalScreens = rows.reduce((a, r) => a + r.screen_count, 0)
  const totalUsers = rows.reduce((a, r) => a + r.user_count, 0)
  const totalBytes = rows.reduce((a, r) => a + (Number(r.used_bytes) || 0), 0)

  return (
    <div>
      <div style={s.topbar}>
        <div>
          <h1 style={s.title}>Superadmin</h1>
          <div style={s.sub}>Todas las organizaciones registradas en la plataforma</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <div style={s.searchWrap}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Buscar organización..." style={s.searchInput} />
          </div>
          <button onClick={load} style={s.btnOutline} disabled={loading}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            Actualizar
          </button>
        </div>
      </div>

      {/* Totales de la plataforma */}
      {!loading && rows.length > 0 && (
        <div style={s.statRow}>
          <Stat label="Organizaciones" value={String(rows.length)} />
          <Stat label="Pantallas" value={String(totalScreens)} />
          <Stat label="Usuarios" value={String(totalUsers)} />
          <Stat label="Almacenamiento" value={formatBytes(totalBytes)} />
        </div>
      )}

      {error && <div style={s.errorBox}>{error}</div>}

      {loading ? (
        <div style={s.emptyBox}><span style={{ color: '#94A3B8' }}>Cargando organizaciones...</span></div>
      ) : visible.length === 0 ? (
        <div style={s.emptyBox}>
          <span style={{ color: '#94A3B8' }}>
            {q ? `Ninguna organización coincide con "${search}"` : 'No hay organizaciones registradas'}
          </span>
        </div>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Organización</th>
                <th style={s.th}>Estado</th>
                <th style={s.th}>Alta</th>
                <th style={s.th}>Almacenamiento</th>
                <th style={{ ...s.th, textAlign: 'center' }}>Pantallas</th>
                <th style={{ ...s.th, textAlign: 'center' }}>Zonas</th>
                <th style={{ ...s.th, textAlign: 'center' }}>Usuarios</th>
                <th style={s.th}>Carpeta R2</th>
                <th style={{ ...s.th, textAlign: 'right' }}>Acción</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(r => {
                const used = Number(r.used_bytes) || 0
                const limit = (r.storage_limit_mb || 2048) * 1024 * 1024
                const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0
                const barColor = pct > 95 ? '#EF4444' : pct > 80 ? '#F59E0B' : '#3B82F6'
                const c = STATUS_COLOR[r.status]
                return (
                  <tr key={r.id} style={s.tr}>
                    <td style={s.td}>
                      <div style={{ fontWeight: 600 }}>{r.name}</div>
                      {r.slug && <div style={{ color: '#94A3B8', fontSize: '0.75rem' }}>{r.slug}</div>}
                    </td>

                    <td style={s.td}>
                      <span style={{ ...s.badge, background: c.bg, color: c.fg, borderColor: c.border }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: c.dot }} />
                        {STATUS_LABEL[r.status]}
                      </span>
                    </td>

                    <td style={{ ...s.td, color: '#64748B', whiteSpace: 'nowrap' }}>{fmtDate(r.created_at)}</td>

                    <td style={{ ...s.td, minWidth: 190 }}>
                      {editingId === r.id ? (
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                            <input autoFocus type="number" step={0.5} min={0.1}
                              value={limitInput} disabled={savingLimit}
                              onChange={e => setLimitInput(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') saveLimit(r)
                                if (e.key === 'Escape') setEditingId(null)
                              }}
                              style={s.limitInput} />
                            <span style={{ fontSize: '0.75rem', color: '#64748B' }}>GB</span>
                            <button onClick={() => saveLimit(r)} disabled={savingLimit}
                              title="Guardar" style={{ ...s.iconBtn, color: '#15803D' }}>✓</button>
                            <button onClick={() => setEditingId(null)} disabled={savingLimit}
                              title="Cancelar" style={{ ...s.iconBtn, color: '#94A3B8' }}>✕</button>
                          </div>

                          <div style={{ display: 'flex', gap: '0.25rem', marginTop: '0.35rem' }}>
                            {[2, 5, 10, 20].map(g => (
                              <button key={g} onClick={() => setLimitInput(String(g))}
                                disabled={savingLimit} style={s.chip}>{g} GB</button>
                            ))}
                          </div>

                          <div style={{ fontSize: '0.7rem', color: '#94A3B8', marginTop: '0.35rem' }}>
                            Usa {formatBytes(used)}
                          </div>

                          {/* Bajar por debajo del consumo se permite (degradar de
                              plan es legítimo); solo se avisa de la consecuencia. */}
                          {(() => {
                            const gb = parseFloat(limitInput.replace(',', '.'))
                            return isFinite(gb) && gb * 1024 * 1024 * 1024 < used ? (
                              <div style={{ fontSize: '0.7rem', color: '#B45309', marginTop: '0.2rem' }}>
                                Quedará por encima del límite
                              </div>
                            ) : null
                          })()}

                          {limitError && (
                            <div style={{ fontSize: '0.7rem', color: '#B91C1C', marginTop: '0.25rem' }}>
                              {limitError}
                            </div>
                          )}
                        </div>
                      ) : (
                        <>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', marginBottom: '0.3rem' }}>
                            <span style={{ fontSize: '0.78rem', color: '#64748B' }}>
                              {formatBytes(used)} de {formatBytes(limit)}
                            </span>
                            <button onClick={() => startEditLimit(r)} title="Editar límite"
                              style={s.iconBtn}>
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>
                              </svg>
                            </button>
                          </div>
                          <div style={{ height: 5, background: '#E2E8F0', borderRadius: 999, overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${pct}%`, background: barColor, borderRadius: 999 }} />
                          </div>
                        </>
                      )}
                    </td>

                    {/* Uso / límite. Se editan los dos a la vez porque van en
                        la misma RPC. Vacío = sin límite. */}
                    <td style={{ ...s.td, textAlign: 'center' }} colSpan={editingLimitsId === r.id ? 2 : 1}>
                      {editingLimitsId === r.id ? (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
                          <input autoFocus value={screenLimitInput} placeholder="∞"
                            onChange={e => setScreenLimitInput(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') saveLimits(r); if (e.key === 'Escape') setEditingLimitsId(null) }}
                            title="Límite de pantallas"
                            style={{ width: '52px', padding: '0.25rem 0.35rem', borderRadius: '6px', border: '1px solid #CBD5E1', fontSize: '0.78rem', textAlign: 'center' }} />
                          <span style={{ color: '#CBD5E1' }}>/</span>
                          <input value={zoneLimitInput} placeholder="∞"
                            onChange={e => setZoneLimitInput(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') saveLimits(r); if (e.key === 'Escape') setEditingLimitsId(null) }}
                            title="Límite de zonas"
                            style={{ width: '52px', padding: '0.25rem 0.35rem', borderRadius: '6px', border: '1px solid #CBD5E1', fontSize: '0.78rem', textAlign: 'center' }} />
                          <button onClick={() => saveLimits(r)} disabled={savingLimits}
                            style={{ border: 'none', background: '#3B82F6', color: '#fff', borderRadius: '6px', padding: '0.25rem 0.5rem', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer' }}>
                            {savingLimits ? '…' : 'OK'}
                          </button>
                          <button onClick={() => setEditingLimitsId(null)}
                            style={{ border: '1px solid #E2E8F0', background: '#fff', color: '#64748B', borderRadius: '6px', padding: '0.25rem 0.5rem', fontSize: '0.72rem', cursor: 'pointer' }}>
                            ✕
                          </button>
                          {limitsError && (
                            <div style={{ width: '100%', color: '#EF4444', fontSize: '0.68rem', marginTop: '0.2rem' }}>{limitsError}</div>
                          )}
                        </div>
                      ) : (
                        <button onClick={() => startEditLimits(r)}
                          title="Editar los límites de pantallas y zonas"
                          style={{ border: 'none', background: 'none', cursor: 'pointer', fontWeight: 600, color: '#0F172A', fontSize: '0.82rem' }}>
                          {r.screen_count}
                          <span style={{ color: '#94A3B8', fontWeight: 500 }}>
                            {' / '}{r.screen_limit == null ? '∞' : r.screen_limit}
                          </span>
                        </button>
                      )}
                    </td>
                    {editingLimitsId !== r.id && (
                      <td style={{ ...s.td, textAlign: 'center' }}>
                        <button onClick={() => startEditLimits(r)}
                          title="Editar los límites de pantallas y zonas"
                          style={{ border: 'none', background: 'none', cursor: 'pointer', fontWeight: 600, color: '#0F172A', fontSize: '0.82rem' }}>
                          {r.zone_count}
                          <span style={{ color: '#94A3B8', fontWeight: 500 }}>
                            {' / '}{r.zone_limit == null ? '∞' : r.zone_limit}
                          </span>
                        </button>
                      </td>
                    )}
                    <td style={{ ...s.td, textAlign: 'center', fontWeight: 600 }}>{r.user_count}</td>

                    <td style={s.td}>
                      <button onClick={() => copyFolder(r.id)} style={s.folderBtn}
                        title="Copiar la carpeta de R2 de esta organización">
                        <code style={{ fontSize: '0.72rem', color: '#475569' }}>
                          {copiedId === r.id ? '¡Copiado!' : r.id}
                        </code>
                      </button>
                    </td>

                    <td style={{ ...s.td, textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: '0.4rem' }}>
                        <button onClick={() => toggleStatus(r)} disabled={busyId === r.id}
                          style={{
                            ...s.btnOutline,
                            display: 'inline-flex',
                            color: r.status === 'active' ? '#B45309' : '#15803D',
                            borderColor: r.status === 'active' ? '#FDE68A' : '#BBF7D0',
                            opacity: busyId === r.id ? 0.6 : 1,
                            whiteSpace: 'nowrap',
                          }}>
                          {busyId === r.id ? '...' : r.status === 'active' ? 'Suspender' : 'Reactivar'}
                        </button>

                        {/* Solo sobre organizaciones ya dadas de baja: refleja
                            en la UI la misma protección que valida el servidor. */}
                        {r.status !== 'active' && (
                          <button
                            onClick={() => { setTarget(r); setConfirmText(''); setDeleteError(null) }}
                            style={{ ...s.btnOutline, display: 'inline-flex', color: '#B91C1C', borderColor: '#FECACA' }}>
                            Eliminar
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal de eliminación definitiva. No usa el confirm() del DialogProvider
          porque necesita el input de confirmación por nombre. */}
      {target && (
        <div style={s.modalBackdrop} onClick={() => { if (!deleting) setTarget(null) }}>
          <div style={s.modalCard} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: '1.05rem', fontWeight: 700, color: '#B91C1C' }}>
              Eliminar "{target.name}" definitivamente
            </div>

            <p style={{ fontSize: '0.85rem', color: '#475569', lineHeight: 1.55, marginTop: '0.6rem' }}>
              Se borrarán <strong>{target.screen_count} pantalla(s)</strong>,{' '}
              <strong>{target.user_count} usuario(s)</strong> y{' '}
              <strong>{formatBytes(Number(target.used_bytes) || 0)}</strong> de archivos en R2,
              junto con sus programas, campañas y estadísticas. Las cuentas de acceso
              dejarán de existir. <strong>Esta acción no se puede deshacer.</strong>
            </p>
            <p style={{ fontSize: '0.8rem', color: '#64748B', marginTop: '0.5rem' }}>
              Se descargará un respaldo en JSON antes de borrar.
            </p>

            <label style={{ ...s.modalLabel, marginTop: '1rem' }}>
              Escribe <code style={{ color: '#0F172A', fontWeight: 700 }}>{target.name}</code> para confirmar
            </label>
            <input autoFocus value={confirmText} onChange={e => setConfirmText(e.target.value)}
              disabled={deleting} placeholder={target.name} style={s.confirmInput} />

            {deleteError && <div style={{ ...s.errorBox, marginTop: '0.75rem', marginBottom: 0 }}>{deleteError}</div>}

            <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end', marginTop: '1.1rem' }}>
              <button onClick={() => setTarget(null)} disabled={deleting} style={s.btnOutline}>
                Cancelar
              </button>
              <button onClick={handleDelete} disabled={!nameMatches || deleting}
                style={{
                  ...s.btnOutline,
                  background: nameMatches ? '#DC2626' : '#FCA5A5',
                  color: '#fff', border: 'none',
                  cursor: nameMatches && !deleting ? 'pointer' : 'not-allowed',
                }}>
                {deleting ? 'Eliminando...' : 'Eliminar definitivamente'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={s.statCard}>
      <div style={{ fontSize: '0.72rem', color: '#94A3B8', fontWeight: 600, letterSpacing: '0.03em' }}>{label}</div>
      <div style={{ fontSize: '1.35rem', fontWeight: 700, color: '#0F172A', marginTop: '0.15rem' }}>{value}</div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  topbar: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.75rem', flexWrap: 'wrap', gap: '1rem' },
  title: { fontSize: '1.6rem', fontWeight: 700, color: '#0F172A' },
  sub: { color: '#64748B', fontSize: '0.875rem' },
  searchWrap: { display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#fff', border: '1px solid #E2E8F0', borderRadius: '8px', padding: '0.5rem 0.875rem', width: '220px' },
  searchInput: { border: 'none', outline: 'none', fontSize: '0.875rem', color: '#0F172A', width: '100%', background: 'transparent' },
  btnOutline: { display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.6rem 1rem', borderRadius: '8px', border: '1px solid #E2E8F0', background: '#fff', color: '#64748B', fontWeight: 500, fontSize: '0.875rem', cursor: 'pointer' },
  statRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.875rem', marginBottom: '1.25rem' },
  statCard: { background: '#fff', border: '1px solid #E2E8F0', borderRadius: '12px', padding: '0.875rem 1.1rem', boxShadow: '0 1px 6px rgba(0,0,0,0.04)' },
  emptyBox: { background: '#fff', border: '1px dashed #E2E8F0', borderRadius: '12px', padding: '4rem', textAlign: 'center' },
  errorBox: { background: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C', borderRadius: '10px', padding: '0.75rem 1rem', fontSize: '0.85rem', marginBottom: '1rem' },
  tableWrap: { background: '#fff', border: '1px solid #E2E8F0', borderRadius: '12px', overflow: 'auto', boxShadow: '0 1px 6px rgba(0,0,0,0.04)' },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: { padding: '0.875rem 1.25rem', textAlign: 'left', color: '#94A3B8', fontSize: '0.75rem', fontWeight: 600, borderBottom: '1px solid #F1F5F9', background: '#FAFBFC', whiteSpace: 'nowrap', letterSpacing: '0.03em' },
  tr: { borderBottom: '1px solid #F8FAFC' },
  td: { padding: '0.875rem 1.25rem', color: '#0F172A', fontSize: '0.875rem', verticalAlign: 'middle' },
  badge: { display: 'inline-flex', alignItems: 'center', gap: '0.35rem', padding: '0.2rem 0.55rem', borderRadius: '999px', border: '1px solid', fontSize: '0.72rem', fontWeight: 600, whiteSpace: 'nowrap' },
  folderBtn: { background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: '6px', padding: '0.3rem 0.5rem', cursor: 'pointer', maxWidth: 230, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  limitInput: { width: 62, padding: '0.25rem 0.4rem', borderRadius: '6px', border: '1px solid #CBD5E1', background: '#fff', color: '#0F172A', fontSize: '0.78rem', outline: 'none' },
  iconBtn: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', padding: '2px 3px', cursor: 'pointer', color: '#94A3B8', fontSize: '0.8rem', lineHeight: 1 },
  chip: { padding: '0.15rem 0.4rem', borderRadius: '999px', border: '1px solid #E2E8F0', background: '#F8FAFC', color: '#64748B', fontSize: '0.68rem', fontWeight: 600, cursor: 'pointer' },
  // Mismo velo que el resto de modales de la app (Content.tsx).
  modalBackdrop: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, padding: '1rem' },
  modalCard: { background: '#fff', borderRadius: '14px', padding: '1.5rem', width: '100%', maxWidth: '460px', boxShadow: '0 12px 40px rgba(0,0,0,0.2)', border: '1px solid #E2E8F0' },
  modalLabel: { display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#374151', marginBottom: '0.35rem' },
  confirmInput: { width: '100%', padding: '0.6rem 0.8rem', borderRadius: '8px', border: '1px solid #E2E8F0', background: '#F8FAFC', color: '#0F172A', fontSize: '0.9rem', outline: 'none', boxSizing: 'border-box' },
}
