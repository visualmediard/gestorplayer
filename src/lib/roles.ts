// Roles de usuario y helper de autorización para el frontend.
//
// La fuente de verdad de permisos es la RLS en la base de datos; este helper
// solo controla qué se MUESTRA en la UI (ocultar botones/secciones según rol).

// No existe un rol de cliente: el acceso de solo lectura para clientes finales
// se diseñará (en RLS, no solo en el menú) cuando haya uno real que lo pida.
export type Role = 'admin' | 'operator' | 'seller'

// Devuelve true si `role` está entre los roles permitidos.
// Uso: hasRole(profile?.role, 'admin', 'operator')
export function hasRole(role: Role | null | undefined, ...allowed: Role[]): boolean {
  return !!role && allowed.includes(role)
}
