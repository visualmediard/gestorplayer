-- Corrige el constraint de rol en profiles.
--
-- La columna profiles.role ya existía desde el esquema original con un
-- constraint profiles_role_check que solo permitía los valores antiguos
-- ('admin', 'editor'). La migración 20260726_settings_roles.sql intentó
-- crear el constraint nuevo con una guarda "IF NOT EXISTS", que lo saltó
-- porque el nombre ya existía — dejando en vigor el constraint viejo.
--
-- Aquí se reemplaza a la fuerza por el conjunto de roles correcto, de modo
-- que aceptar invitaciones (operator/seller/client) y cambiar roles funcione.

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('admin', 'operator', 'seller', 'client'));
