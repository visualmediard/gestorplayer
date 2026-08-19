import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { uploadToR2 } from '../lib/uploadToR2'
import { notifyStorageChanged } from '../lib/storage'
import { useDialog } from '../components/Dialog'

const ROLE_LABELS: Record<string, string> = {
  admin: 'Administrador', operator: 'Operador', seller: 'Vendedor',
}
const ROLES = ['admin', 'operator', 'seller']

type Tab = 'general' | 'users' | 'traffic'

export default function Settings() {
  const [tab, setTab] = useState<Tab>('general')

  return (
    <div>
      <div style={s.topbar}>
        <div>
          <h1 style={s.title}>Configuración</h1>
          <p style={s.sub}>Ajustes de tu organización</p>
        </div>
      </div>

      {/* Tabs */}
      <div style={s.tabBar}>
        <button
          onClick={() => setTab('general')}
          style={{ ...s.tab, ...(tab === 'general' ? s.tabActive : {}) }}>
          General
        </button>
        <button
          onClick={() => setTab('users')}
          style={{ ...s.tab, ...(tab === 'users' ? s.tabActive : {}) }}>
          Usuarios
        </button>
        <button
          onClick={() => setTab('traffic')}
          style={{ ...s.tab, ...(tab === 'traffic' ? s.tabActive : {}) }}>
          Conteo vehicular
        </button>
      </div>

      {tab === 'general' && <GeneralTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'traffic' && <TrafficTab />}
    </div>
  )
}

// ── Tab General: logo de la organización ────────────────────────────────────
function GeneralTab() {
  const [orgId, setOrgId] = useState<string | null>(null)
  const [logoUrl, setLogoUrl] = useState<string | null>(null)   // guardado en BD
  const [file, setFile] = useState<File | null>(null)           // selección pendiente
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // Datos de la empresa (nombre + contacto), salen en los reportes PDF.
  const [orgName, setOrgName] = useState('')
  const [address, setAddress] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [savingInfo, setSavingInfo] = useState(false)
  const [infoError, setInfoError] = useState<string | null>(null)
  const [infoSaved, setInfoSaved] = useState(false)

  useEffect(() => {
    let alive = true
    async function load() {
      const uid = (await supabase.auth.getUser()).data.user?.id ?? ''
      const { data: prof } = await supabase.from('profiles').select('organization_id').eq('id', uid).single()
      const oid = prof?.organization_id ?? null
      if (!oid) { if (alive) setLoading(false); return }
      // select('*') para no fallar si las columnas de contacto aún no existen
      // (antes de correr la migración).
      const { data: org } = await supabase.from('organizations').select('*').eq('id', oid).single()
      if (!alive) return
      setOrgId(oid)
      setLogoUrl(org?.logo_url ?? null)
      setOrgName(org?.name ?? '')
      setAddress((org as any)?.address ?? '')
      setPhone((org as any)?.phone ?? '')
      setEmail((org as any)?.email ?? '')
      setLoading(false)
    }
    load()
    return () => { alive = false }
  }, [])

  // Libera el object URL local al cambiar de archivo o desmontar.
  useEffect(() => {
    return () => { if (previewUrl) URL.revokeObjectURL(previewUrl) }
  }, [previewUrl])

  function onSelectFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    setError(null); setSaved(false)
    if (!f.type.startsWith('image/')) { setError('El logo debe ser una imagen.'); return }
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setFile(f)
    setPreviewUrl(URL.createObjectURL(f))
  }

  function cancelSelection() {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setFile(null); setPreviewUrl(null); setError(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  async function handleSave() {
    if (!file || !orgId) return
    setUploading(true); setProgress(0); setError(null); setSaved(false)
    const { url, error: upErr } = await uploadToR2(file, setProgress, 'branding')
    if (upErr || !url) { setError(upErr?.message ?? 'Error al subir el logo.'); setUploading(false); return }
    // Vía RPC y no con un update directo: logo_url ya no es escribible desde el
    // cliente (la RPC valida la URL, porque get-org-logo hace fetch() de ella
    // en el servidor).
    const { error: dbErr } = await supabase.rpc('set_org_logo', { p_url: url })
    if (dbErr) { setError('Error al guardar: ' + dbErr.message); setUploading(false); return }
    setLogoUrl(url)
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setFile(null); setPreviewUrl(null)
    if (fileRef.current) fileRef.current.value = ''
    setUploading(false); setSaved(true)
    notifyStorageChanged()
  }

  async function handleSaveInfo() {
    if (!orgId) return
    if (!orgName.trim()) { setInfoError('El nombre de la empresa es obligatorio.'); return }
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setInfoError('El email no tiene un formato válido.'); return }
    setSavingInfo(true); setInfoError(null); setInfoSaved(false)
    const { error: dbErr } = await supabase.from('organizations').update({
      name: orgName.trim(),
      address: address.trim() || null,
      phone: phone.trim() || null,
      email: email.trim() || null,
    }).eq('id', orgId)
    setSavingInfo(false)
    if (dbErr) { setInfoError('Error al guardar: ' + dbErr.message); return }
    setInfoSaved(true)
  }

  if (loading) return <div style={s.formCard}><p style={{ color: '#94A3B8', fontSize: '0.875rem' }}>Cargando...</p></div>

  const shown = previewUrl ?? logoUrl

  return (
    <>
    <div style={s.formCard}>
      <div style={s.formTitle}>Logo de la organización</div>
      <p style={{ color: '#64748B', fontSize: '0.82rem', marginTop: '-0.5rem', marginBottom: '1.25rem' }}>
        Se muestra en el panel. Recomendado: PNG con fondo transparente.
      </p>

      <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* Preview */}
        <div style={s.logoBox}>
          {shown
            ? <img src={shown} alt="Logo" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
            : <span style={{ color: '#CBD5E1', fontSize: '0.78rem' }}>Sin logo</span>
          }
        </div>

        {/* Controles */}
        <div style={{ flex: 1, minWidth: '220px' }}>
          <input ref={fileRef} type="file" accept="image/*" onChange={onSelectFile} style={{ display: 'none' }} />

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button onClick={() => fileRef.current?.click()} style={s.btnOutline} disabled={uploading}>
              {shown ? 'Cambiar logo' : 'Subir logo'}
            </button>
            {file && !uploading && (
              <>
                <button onClick={handleSave} style={s.btnPrimary}>Guardar</button>
                <button onClick={cancelSelection} style={s.btnOutline}>Cancelar</button>
              </>
            )}
          </div>

          {uploading && (
            <div style={{ marginTop: '0.9rem' }}>
              <div style={{ height: '6px', background: '#E2E8F0', borderRadius: '999px', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${progress}%`, background: '#3B82F6', borderRadius: '999px', transition: 'width 0.2s' }} />
              </div>
              <div style={{ marginTop: '0.35rem', fontSize: '0.72rem', color: '#94A3B8' }}>Subiendo… {progress}%</div>
            </div>
          )}

          {file && !uploading && (
            <p style={{ marginTop: '0.75rem', fontSize: '0.78rem', color: '#64748B' }}>
              Seleccionado: {file.name} — pulsa <strong>Guardar</strong> para aplicarlo.
            </p>
          )}
          {error && <p style={{ marginTop: '0.75rem', fontSize: '0.8rem', color: '#EF4444' }}>{error}</p>}
          {saved && <p style={{ marginTop: '0.75rem', fontSize: '0.8rem', color: '#10B981' }}>✓ Logo actualizado.</p>}
        </div>
      </div>
    </div>

    <div style={{ ...s.formCard, marginTop: '1.25rem' }}>
      <div style={s.formTitle}>Datos de la empresa</div>
      <p style={{ color: '#64748B', fontSize: '0.82rem', marginTop: '-0.5rem', marginBottom: '1.25rem' }}>
        Aparecen en la cabecera de los reportes PDF que descargas.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '520px' }}>
        <div>
          <label style={s.fieldLabel}>Nombre de la empresa</label>
          <input style={s.field} value={orgName} onChange={e => { setOrgName(e.target.value); setInfoSaved(false) }} placeholder="Ej: Acme Media" />
        </div>
        <div>
          <label style={s.fieldLabel}>Dirección</label>
          <input style={s.field} value={address} onChange={e => { setAddress(e.target.value); setInfoSaved(false) }} placeholder="Av. Winston Churchill 45, Santo Domingo" />
        </div>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 180px' }}>
            <label style={s.fieldLabel}>Teléfono</label>
            <input style={s.field} value={phone} onChange={e => { setPhone(e.target.value); setInfoSaved(false) }} placeholder="(809) 555-1234" />
          </div>
          <div style={{ flex: '1 1 180px' }}>
            <label style={s.fieldLabel}>Email</label>
            <input style={s.field} value={email} onChange={e => { setEmail(e.target.value); setInfoSaved(false) }} placeholder="info@acme.com" />
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <button onClick={handleSaveInfo} style={s.btnPrimary} disabled={savingInfo}>
            {savingInfo ? 'Guardando…' : 'Guardar datos'}
          </button>
          {infoError && <span style={{ fontSize: '0.8rem', color: '#EF4444' }}>{infoError}</span>}
          {infoSaved && <span style={{ fontSize: '0.8rem', color: '#10B981' }}>✓ Datos guardados.</span>}
        </div>
      </div>
    </div>
    </>
  )
}

// ── Tab Usuarios: miembros de la organización e invitaciones ────────────────
function UsersTab() {
  const { confirm } = useDialog()
  const [orgId, setOrgId] = useState<string | null>(null)
  const [myId, setMyId] = useState<string | null>(null)
  const [members, setMembers] = useState<{ id: string; full_name: string | null; email: string; role: string }[]>([])
  const [invites, setInvites] = useState<{ id: string; email: string; role: string; token: string; expires_at: string | null }[]>([])
  const [loading, setLoading] = useState(true)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('operator')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [roleBusy, setRoleBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; full_name: string | null; email: string } | null>(null)
  const [editName, setEditName] = useState('')
  const [editEmail, setEditEmail] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState<string | null>(null)

  async function load() {
    const uid = (await supabase.auth.getUser()).data.user?.id ?? ''
    setMyId(uid)
    const { data: prof } = await supabase.from('profiles').select('organization_id').eq('id', uid).single()
    const oid = prof?.organization_id ?? null
    if (!oid) { setLoading(false); return }
    setOrgId(oid)
    const [{ data: mem }, { data: inv }] = await Promise.all([
      supabase.from('profiles').select('id, full_name, email, role').eq('organization_id', oid).order('full_name'),
      supabase.from('invitations').select('id, email, role, token, expires_at')
        .eq('organization_id', oid).is('accepted_at', null).order('created_at', { ascending: false }),
    ])
    setMembers((mem ?? []) as any)
    // Oculta invitaciones vencidas (siguen en BD pero no se muestran).
    const now = Date.now()
    setInvites(((inv ?? []) as any[]).filter(i => !i.expires_at || new Date(i.expires_at).getTime() > now))
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  function inviteLink(token: string) {
    return `${window.location.origin}/invite?token=${token}`
  }

  async function copyLink(token: string) {
    try {
      await navigator.clipboard.writeText(inviteLink(token))
      setCopied(token)
      setTimeout(() => setCopied(null), 2500)
    } catch { /* clipboard no disponible */ }
  }

  async function changeRole(userId: string, role: string) {
    setRoleBusy(userId); setError(null)
    const { error: rpcErr } = await supabase.rpc('set_member_role', { p_user_id: userId, p_role: role })
    if (rpcErr) { setError(rpcErr.message); setRoleBusy(null); return }
    setMembers(prev => prev.map(m => m.id === userId ? { ...m, role } : m))
    setRoleBusy(null)
  }

  async function createInvite() {
    const email = inviteEmail.trim().toLowerCase()
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { setError('Correo inválido.'); return }
    if (!orgId || !myId) return
    setCreating(true); setError(null)
    const token = crypto.randomUUID()
    const { data, error: insErr } = await supabase.from('invitations').insert({
      organization_id: orgId, email, role: inviteRole, token, created_by: myId,
    }).select('id, email, role, token, expires_at').single()
    if (insErr) { setError('Error al crear invitación: ' + insErr.message); setCreating(false); return }
    setInvites(prev => [data as any, ...prev])
    setInviteEmail('')
    setCreating(false)
    copyLink((data as any).token)   // deja el enlace listo en el portapapeles
  }

  async function revokeInvite(id: string) {
    const { error: delErr } = await supabase.from('invitations').delete().eq('id', id)
    if (delErr) { setError('Error al revocar: ' + delErr.message); return }
    setInvites(prev => prev.filter(i => i.id !== id))
  }

  // Llama la Edge Function admin-manage-user. Extrae el mensaje de error real
  // del cuerpo de la respuesta cuando el estado no es 2xx.
  async function callManageUser(payload: { action: string; userId: string; fullName?: string; email?: string }) {
    const { error: fnErr } = await supabase.functions.invoke('admin-manage-user', { body: payload })
    if (fnErr) {
      let msg = fnErr.message
      try { const j = await (fnErr as any).context?.json(); if (j?.error) msg = j.error } catch { /* ignore */ }
      return { ok: false, error: msg }
    }
    return { ok: true, error: null as string | null }
  }

  function openEdit(m: { id: string; full_name: string | null; email: string }) {
    setError(null)
    setEditing(m)
    setEditName(m.full_name ?? '')
    setEditEmail(m.email)
  }

  async function saveEdit() {
    if (!editing) return
    const email = editEmail.trim().toLowerCase()
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { setError('Correo inválido.'); return }
    setSavingEdit(true); setError(null)
    const res = await callManageUser({ action: 'update', userId: editing.id, fullName: editName, email })
    if (!res.ok) { setError(res.error!); setSavingEdit(false); return }
    setMembers(prev => prev.map(m => m.id === editing.id
      ? { ...m, full_name: editName.trim() || null, email: email || m.email } : m))
    setSavingEdit(false); setEditing(null)
  }

  async function deleteMember(m: { id: string; full_name: string | null; email: string }) {
    if (!await confirm({
      title: `¿Eliminar por completo a "${m.full_name || m.email}"?`,
      message: 'Se borrará su cuenta de acceso y su perfil. Esta acción no se puede deshacer.',
      confirmLabel: 'Eliminar', danger: true,
    })) return
    setDeleteBusy(m.id); setError(null)
    const res = await callManageUser({ action: 'delete', userId: m.id })
    if (!res.ok) { setError(res.error!); setDeleteBusy(null); return }
    setMembers(prev => prev.filter(x => x.id !== m.id))
    setDeleteBusy(null)
  }

  if (loading) return <div style={s.formCard}><p style={{ color: '#94A3B8', fontSize: '0.875rem' }}>Cargando...</p></div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {error && (
        <div style={{ background: '#FFF5F5', border: '1px solid #FECACA', borderRadius: '8px', padding: '0.6rem 0.875rem', color: '#EF4444', fontSize: '0.8rem' }}>
          {error}
        </div>
      )}

      {/* Miembros */}
      <div style={s.formCard}>
        <div style={s.formTitle}>Miembros ({members.length})</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {members.map(m => (
            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.6rem 0.75rem', borderRadius: '9px', border: '1px solid #F1F5F9', background: '#F8FAFC' }}>
              <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'linear-gradient(135deg, #3B82F6, #2563EB)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '0.8rem', flexShrink: 0 }}>
                {(m.full_name?.[0] ?? m.email[0]).toUpperCase()}
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: '0.85rem', color: '#0F172A', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {m.full_name || m.email}{m.id === myId && <span style={{ color: '#94A3B8', fontWeight: 500 }}> · tú</span>}
                </div>
                <div style={{ fontSize: '0.72rem', color: '#94A3B8' }}>{m.email}</div>
              </div>
              {m.id === myId ? (
                <span style={{ fontSize: '0.78rem', color: '#64748B', fontWeight: 600, padding: '0.35rem 0.6rem' }}>{ROLE_LABELS[m.role] ?? m.role}</span>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexShrink: 0 }}>
                  <select value={m.role} disabled={roleBusy === m.id}
                    onChange={e => changeRole(m.id, e.target.value)}
                    style={{ ...s.btnOutline, padding: '0.35rem 0.5rem', cursor: 'pointer' }}>
                    {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                  </select>
                  <button onClick={() => openEdit(m)} title="Editar usuario"
                    style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '30px', height: '30px', borderRadius: '7px', border: '1px solid #E2E8F0', background: '#fff', color: '#64748B', cursor: 'pointer' }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                  </button>
                  <button onClick={() => deleteMember(m)} disabled={deleteBusy === m.id} title="Eliminar usuario"
                    style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '30px', height: '30px', borderRadius: '7px', border: '1px solid #FECACA', background: '#FFF5F5', color: '#EF4444', cursor: 'pointer', opacity: deleteBusy === m.id ? 0.5 : 1 }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Invitaciones */}
      <div style={s.formCard}>
        <div style={s.formTitle}>Invitar a un nuevo usuario</div>
        <p style={{ color: '#64748B', fontSize: '0.82rem', marginTop: '-0.5rem', marginBottom: '1rem' }}>
          Se genera un enlace que puedes enviar por el medio que prefieras. Vence en 7 días.
        </p>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: 1, minWidth: '200px', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
            <label style={{ color: '#64748B', fontSize: '0.78rem', fontWeight: 500 }}>Correo</label>
            <input type="email" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)}
              placeholder="persona@empresa.com"
              style={{ padding: '0.5rem 0.75rem', borderRadius: '8px', border: '1px solid #E2E8F0', fontSize: '0.875rem', outline: 'none' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
            <label style={{ color: '#64748B', fontSize: '0.78rem', fontWeight: 500 }}>Rol</label>
            <select value={inviteRole} onChange={e => setInviteRole(e.target.value)}
              style={{ ...s.btnOutline, padding: '0.5rem', cursor: 'pointer' }}>
              {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
          </div>
          <button onClick={createInvite} disabled={creating} style={s.btnPrimary}>
            {creating ? 'Creando…' : 'Crear invitación'}
          </button>
        </div>

        {invites.length > 0 && (
          <div style={{ marginTop: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#64748B' }}>Pendientes</div>
            {invites.map(i => (
              <div key={i.id} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.55rem 0.75rem', borderRadius: '9px', border: '1px solid #F1F5F9', background: '#F8FAFC', flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: '0.82rem', color: '#0F172A', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{i.email}</div>
                  <div style={{ fontSize: '0.72rem', color: '#94A3B8' }}>{ROLE_LABELS[i.role] ?? i.role}{i.expires_at && ` · vence ${new Date(i.expires_at).toLocaleDateString('es-DO', { day: '2-digit', month: 'short' })}`}</div>
                </div>
                <button onClick={() => copyLink(i.token)} style={{ ...s.btnOutline, padding: '0.35rem 0.7rem', fontSize: '0.78rem' }}>
                  {copied === i.token ? '✓ Copiado' : 'Copiar enlace'}
                </button>
                <button onClick={() => revokeInvite(i.id)} style={{ padding: '0.35rem 0.7rem', borderRadius: '7px', border: '1px solid #FECACA', background: '#FFF5F5', color: '#EF4444', fontSize: '0.78rem', fontWeight: 500, cursor: 'pointer' }}>
                  Revocar
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Modal editar usuario */}
      {editing && (
        <div onClick={e => { if (e.target === e.currentTarget) setEditing(null) }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1.5rem' }}>
          <div style={{ background: '#fff', borderRadius: '14px', width: '100%', maxWidth: '400px', padding: '1.5rem', boxShadow: '0 24px 64px rgba(0,0,0,0.25)' }}>
            <div style={s.formTitle}>Editar usuario</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem', marginTop: '0.5rem' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                <label style={{ color: '#64748B', fontSize: '0.78rem', fontWeight: 500 }}>Nombre</label>
                <input value={editName} onChange={e => setEditName(e.target.value)} placeholder="Nombre para mostrar"
                  style={{ padding: '0.55rem 0.75rem', borderRadius: '8px', border: '1px solid #E2E8F0', fontSize: '0.875rem', outline: 'none' }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                <label style={{ color: '#64748B', fontSize: '0.78rem', fontWeight: 500 }}>Correo</label>
                <input type="email" value={editEmail} onChange={e => setEditEmail(e.target.value)} placeholder="correo@empresa.com"
                  style={{ padding: '0.55rem 0.75rem', borderRadius: '8px', border: '1px solid #E2E8F0', fontSize: '0.875rem', outline: 'none' }} />
                <span style={{ fontSize: '0.7rem', color: '#94A3B8' }}>Cambiar el correo también cambia su acceso (login).</span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
              <button onClick={() => setEditing(null)} style={s.btnOutline}>Cancelar</button>
              <button onClick={saveEdit} disabled={savingEdit} style={s.btnPrimary}>
                {savingEdit ? 'Guardando…' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Tab Conteo vehicular: credenciales de DataVisiooh ───────────────────────
// El token se escribe y no se vuelve a leer nunca: la RPC set_datavisiooh_token
// lo guarda en una tabla que el frontend no puede consultar, y ninguna función
// lo devuelve. Aquí solo se manejan los últimos 4 caracteres y la fecha, que sí
// son legibles desde traffic_providers.
type ProviderCfg = {
  hash: string | null
  token_last4: string | null
  token_set_at: string | null
  docs_url: string | null
}

type ProviderPanel = {
  id: number
  name: string
  description: string | null
  address: string | null
  sensor_status: number | null
  sensor_updated: string | null
  sensor_stale: boolean
  looks_inactive: boolean
}

function TrafficTab() {
  const { confirm } = useDialog()

  const [cfg, setCfg] = useState<ProviderCfg | null>(null)
  const [loading, setLoading] = useState(true)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState<null | 'saving' | 'validating' | 'panels' | 'clearing' | 'syncing'>(null)
  const [syncResult, setSyncResult] = useState<
    { rows: number; zones: number; from: string; to: string; note?: string; warnings: { zone: string; panel_id: number; reason: string }[] } | null
  >(null)
  const [error, setError] = useState<string | null>(null)
  const [clientName, setClientName] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [panels, setPanels] = useState<ProviderPanel[] | null>(null)
  // Enlace a la documentación del proveedor. Es solo de consulta: se abre en el
  // navegador del admin, el servidor no lo visita nunca.
  const [docsUrl, setDocsUrl] = useState('')
  const [docsSaved, setDocsSaved] = useState(false)

  // La RLS ya acota la fila a la organización del admin, así que no hace falta
  // filtrar por organization_id: si hay fila, es la suya.
  async function loadCfg() {
    const { data } = await supabase
      .from('traffic_providers').select('hash, token_last4, token_set_at, docs_url').maybeSingle()
    setCfg((data as ProviderCfg) ?? null)
    setDocsUrl((data as ProviderCfg)?.docs_url ?? '')
    setLoading(false)
  }

  useEffect(() => { loadCfg() }, [])

  // Extrae el mensaje real del cuerpo cuando la función responde con error,
  // igual que callManageUser en la pestaña de usuarios.
  async function invokeProvider(action: 'validate' | 'panels' | 'sync') {
    const { data, error: fnErr } = await supabase.functions.invoke('traffic-provider', { body: { action } })
    if (fnErr) {
      let msg = fnErr.message
      try { const j = await (fnErr as any).context?.json(); if (j?.error) msg = j.error } catch { /* ignore */ }
      return { ok: false as const, error: msg, data: null as any }
    }
    return { ok: true as const, error: null, data }
  }

  async function validate(): Promise<boolean> {
    setBusy('validating')
    const res = await invokeProvider('validate')
    setBusy(null)
    if (!res.ok) { setError(res.error); return false }
    setClientName(res.data?.client_name ?? null)
    // Varias cuentas bajo el mismo token: se conectó a la primera. Se avisa en
    // vez de dejar al admin creyendo que eligió.
    if (res.data?.needs_choice) {
      setNotice(`Este token da acceso a ${res.data.clients_total} cuentas; se conectó a la primera.`)
    }
    await loadCfg()
    return true
  }

  // Guardar y validar en un solo clic. Si la validación falla, el token queda
  // guardado igual: el fallo suele ser del proveedor, no del token, y obligar a
  // pegarlo otra vez sería castigar al admin por algo ajeno.
  async function saveToken() {
    setError(null); setNotice(null)
    const t = token.trim()
    if (t.length < 8) { setError('El token parece incompleto.'); return }

    setBusy('saving')
    const { error: rpcErr } = await supabase.rpc('set_datavisiooh_token', { p_token: t })
    setBusy(null)
    if (rpcErr) { setError(rpcErr.message); return }

    setToken('')          // no se conserva en memoria más de lo necesario
    setPanels(null)       // la lista anterior puede ser de otra cuenta
    setClientName(null)
    await loadCfg()
    await validate()
  }

  async function clearToken() {
    const ok = await confirm({
      title: 'Quitar el token',
      message: 'Se borrará el token de tu empresa de conteo vehicular y el conteo dejará de sincronizarse. ¿Continuar?',
      confirmLabel: 'Quitar token', danger: true,
    })
    if (!ok) return

    setError(null); setNotice(null)
    setBusy('clearing')
    const { error: rpcErr } = await supabase.rpc('clear_datavisiooh_token')
    setBusy(null)
    if (rpcErr) { setError(rpcErr.message); return }

    setClientName(null); setPanels(null)
    await loadCfg()
  }

  // Sincronización manual. El cron automático vendrá después; este botón es el
  // que permite comprobar el ciclo completo con datos reales.
  async function syncNow() {
    setError(null); setSyncResult(null)
    setBusy('syncing')
    const res = await invokeProvider('sync')
    setBusy(null)
    if (!res.ok) { setError(res.error); return }
    setSyncResult({
      rows: res.data?.rows ?? 0,
      zones: res.data?.zones ?? 0,
      from: res.data?.from ?? '',
      to: res.data?.to ?? '',
      note: res.data?.note,
      warnings: res.data?.warnings ?? [],
    })
  }

  async function saveDocsUrl() {
    setError(null); setDocsSaved(false)
    const { error: rpcErr } = await supabase.rpc('set_traffic_docs_url', { p_url: docsUrl.trim() || null })
    if (rpcErr) { setError(rpcErr.message); return }
    setDocsSaved(true)
    await loadCfg()
  }

  async function loadPanels() {
    setError(null)
    setBusy('panels')
    const res = await invokeProvider('panels')
    setBusy(null)
    if (!res.ok) { setError(res.error); return }
    setPanels((res.data?.panels ?? []) as ProviderPanel[])
  }

  if (loading) {
    return <div style={s.formCard}><span style={{ color: '#94A3B8', fontSize: '0.875rem' }}>Cargando…</span></div>
  }

  const hasToken = !!cfg?.token_set_at
  const validated = !!cfg?.hash
  const fecha = (iso: string) => new Date(iso).toLocaleDateString('es-DO', { day: '2-digit', month: 'short', year: 'numeric' })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={s.formCard}>
        <div style={s.formTitle}>Conteo vehicular</div>
        <p style={{ color: '#64748B', fontSize: '0.82rem', marginBottom: '1rem' }}>
          Pega el token que te entregó tu empresa de conteo vehicular. Se guarda del lado del
          servidor, fuera del alcance del panel: no vuelve a mostrarse ni se puede consultar desde aquí.
        </p>

        {hasToken ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0.4rem 0.7rem', borderRadius: '999px', background: '#ECFDF5', border: '1px solid #A7F3D0', color: '#047857', fontSize: '0.8rem', fontWeight: 600 }}>
              Token configurado ✓ · ••••{cfg?.token_last4 ?? '????'}
            </span>
            {cfg?.token_set_at && (
              <span style={{ color: '#94A3B8', fontSize: '0.78rem' }}>guardado el {fecha(cfg.token_set_at)}</span>
            )}
          </div>
        ) : (
          <div style={{ marginBottom: '1rem', color: '#94A3B8', fontSize: '0.82rem' }}>
            Todavía no hay ningún token configurado.
          </div>
        )}

        <label style={s.fieldLabel}>{hasToken ? 'Reemplazar el token' : 'Token de conteo vehicular'}</label>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <input
            type="password"
            style={{ ...s.field, flex: 1, minWidth: '220px' }}
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder="Pega aquí tu token"
            autoComplete="off"
          />
          <button onClick={saveToken} disabled={!!busy || token.trim().length === 0}
            style={{ ...s.btnPrimary, opacity: (busy || token.trim().length === 0) ? 0.6 : 1 }}>
            {busy === 'saving' ? 'Guardando…' : busy === 'validating' ? 'Validando…' : 'Guardar y validar'}
          </button>
          {hasToken && (
            <button onClick={clearToken} disabled={!!busy} style={{ ...s.btnOutline, opacity: busy ? 0.6 : 1 }}>
              {busy === 'clearing' ? 'Quitando…' : 'Quitar token'}
            </button>
          )}
        </div>

        {hasToken && (
          <div style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            {validated ? (
              <span style={{ color: '#047857', fontSize: '0.82rem', fontWeight: 600 }}>
                Conectado{clientName ? `: ${clientName}` : ' · conexión validada'}
              </span>
            ) : (
              <span style={{ color: '#B45309', fontSize: '0.82rem' }}>
                Sin validar. Valida la conexión para poder sincronizar el conteo.
              </span>
            )}
            <button onClick={validate} disabled={!!busy} style={{ ...s.btnOutline, opacity: busy ? 0.6 : 1 }}>
              {busy === 'validating' ? 'Validando…' : 'Validar conexión'}
            </button>
            {validated && (
              <button onClick={loadPanels} disabled={!!busy} style={{ ...s.btnOutline, opacity: busy ? 0.6 : 1 }}>
                {busy === 'panels' ? 'Consultando…' : 'Ver emplazamientos'}
              </button>
            )}
            {validated && (
              <button onClick={syncNow} disabled={!!busy}
                style={{ ...s.btnPrimary, opacity: busy ? 0.6 : 1 }}>
                {busy === 'syncing' ? 'Sincronizando…' : 'Sincronizar ahora'}
              </button>
            )}
          </div>
        )}

        {syncResult && (
          <div style={{ marginTop: '0.9rem', padding: '0.7rem 0.85rem', borderRadius: '8px', background: '#ECFDF5', border: '1px solid #A7F3D0', color: '#047857', fontSize: '0.8rem' }}>
            {syncResult.note
              ? syncResult.note
              : <>Sincronizado: <strong>{syncResult.zones}</strong> zona(s) · <strong>{syncResult.rows}</strong> día(s) escritos, del {syncResult.from} al {syncResult.to}.</>}
            {syncResult.warnings.length > 0 && (
              <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.1rem', color: '#B45309' }}>
                {syncResult.warnings.map(w => (
                  <li key={`${w.zone}-${w.panel_id}`} style={{ marginTop: '0.2rem' }}>
                    <strong>{w.zone}</strong> (panel {w.panel_id}): {w.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Documentación del proveedor. Va después del token porque es de
            consulta, no parte de la conexión: el servidor nunca abre esta URL. */}
        <div style={{ marginTop: '1.25rem', paddingTop: '1.25rem', borderTop: '1px solid #F1F5F9' }}>
          <label style={s.fieldLabel}>Documentación de la API (opcional)</label>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <input
              type="url"
              style={{ ...s.field, flex: 1, minWidth: '220px' }}
              value={docsUrl}
              onChange={e => { setDocsUrl(e.target.value); setDocsSaved(false) }}
              placeholder="https://ejemplo.com/docs"
            />
            <button onClick={saveDocsUrl} disabled={!!busy}
              style={{ ...s.btnOutline, opacity: busy ? 0.6 : 1 }}>
              Guardar enlace
            </button>
          </div>
          <div style={{ marginTop: '0.45rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            <span style={{ color: '#94A3B8', fontSize: '0.76rem' }}>
              Solo para consultarla: se guarda como enlace y se abre en tu navegador.
            </span>
            {cfg?.docs_url && (
              // rel="noopener noreferrer": la página destino no debe poder tocar
              // esta pestaña. El esquema https ya lo impuso la RPC al guardar.
              <a href={cfg.docs_url} target="_blank" rel="noopener noreferrer"
                style={{ color: '#2563EB', fontSize: '0.78rem', fontWeight: 600, textDecoration: 'none' }}>
                Abrir documentación ↗
              </a>
            )}
            {docsSaved && <span style={{ color: '#047857', fontSize: '0.78rem', fontWeight: 600 }}>Guardado ✓</span>}
          </div>
        </div>

        {notice && (
          <div style={{ marginTop: '0.9rem', padding: '0.6rem 0.85rem', borderRadius: '8px', background: '#FFFBEB', border: '1px solid #FDE68A', color: '#B45309', fontSize: '0.8rem' }}>
            {notice}
          </div>
        )}
        {error && (
          <div style={{ marginTop: '0.9rem', padding: '0.6rem 0.85rem', borderRadius: '8px', background: '#FFF5F5', border: '1px solid #FECACA', color: '#EF4444', fontSize: '0.8rem', fontWeight: 500 }}>
            {error}
          </div>
        )}
      </div>

      {/* Lista de emplazamientos: solo lectura. El mapeo con las zonas se hace
          en el editor de zonas, no aquí. */}
      {panels && (
        <div style={s.formCard}>
          <div style={s.formTitle}>
            Emplazamientos ({panels.length})
          </div>
          <p style={{ color: '#64748B', fontSize: '0.8rem', marginBottom: '1rem' }}>
            Los marcados como inactivos por el proveedor aparecen al final, atenuados. No se ocultan:
            la marca es una convención de texto suya y podría equivocarse.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', maxHeight: '420px', overflowY: 'auto' }}>
            {panels.map(p => (
              <div key={p.id} style={{
                display: 'flex', alignItems: 'center', gap: '0.75rem',
                padding: '0.6rem 0.75rem', borderRadius: '8px',
                border: '1px solid #F1F5F9', background: p.looks_inactive ? '#F8FAFC' : '#fff',
                opacity: p.looks_inactive ? 0.6 : 1,
              }}>
                <span style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: '#94A3B8', flexShrink: 0, width: '48px' }}>
                  {p.id}
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#0F172A' }}>{p.name}</div>
                  <div style={{ fontSize: '0.76rem', color: '#64748B', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.description ?? p.address ?? '—'}
                  </div>
                </div>
                {p.looks_inactive && (
                  <span style={{ fontSize: '0.7rem', color: '#94A3B8', border: '1px solid #E2E8F0', borderRadius: '999px', padding: '2px 8px', flexShrink: 0 }}>
                    Inactivo según el proveedor
                  </span>
                )}
                {p.sensor_stale && (
                  <span title={p.sensor_updated ? `Último reporte: ${fecha(p.sensor_updated)}` : 'Sin datos de sensor'}
                    style={{ fontSize: '0.7rem', color: '#B45309', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: '999px', padding: '2px 8px', flexShrink: 0 }}>
                    {p.sensor_updated ? `Sin reportar desde ${fecha(p.sensor_updated)}` : 'Sin sensor'}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  topbar: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem' },
  title: { fontSize: '1.6rem', fontWeight: 700, color: '#0F172A' },
  sub: { color: '#64748B', fontSize: '0.875rem', marginTop: '0.2rem' },
  tabBar: { display: 'flex', gap: '0.25rem', borderBottom: '1px solid #E2E8F0', marginBottom: '1.5rem' },
  tab: { padding: '0.6rem 1rem', border: 'none', background: 'transparent', color: '#64748B', fontSize: '0.875rem', fontWeight: 500, cursor: 'pointer', borderBottom: '2px solid transparent', marginBottom: '-1px' },
  tabActive: { color: '#2563EB', fontWeight: 600, borderBottom: '2px solid #2563EB' },
  formCard: { background: '#fff', border: '1px solid #E2E8F0', borderRadius: '12px', padding: '1.5rem', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' },
  formTitle: { fontWeight: 700, color: '#0F172A', marginBottom: '1rem', fontSize: '1rem' },
  btnPrimary: { display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.55rem 1.1rem', borderRadius: '8px', border: 'none', background: '#3B82F6', color: '#fff', fontWeight: 600, fontSize: '0.875rem', whiteSpace: 'nowrap', cursor: 'pointer' },
  btnOutline: { padding: '0.55rem 1rem', borderRadius: '8px', border: '1px solid #E2E8F0', background: '#fff', color: '#64748B', fontWeight: 500, fontSize: '0.875rem', cursor: 'pointer' },
  logoBox: { width: '180px', height: '120px', borderRadius: '10px', border: '1px dashed #CBD5E1', background: '#F8FAFC', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0.75rem', flexShrink: 0 },
  fieldLabel: { display: 'block', color: '#64748B', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.35rem' },
  field: { width: '100%', padding: '0.55rem 0.75rem', borderRadius: '8px', border: '1px solid #E2E8F0', background: '#fff', color: '#0F172A', fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box' },
}
