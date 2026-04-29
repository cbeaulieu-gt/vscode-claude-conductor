/**
 * Canonical path key for case/separator-insensitive lookups across the
 * favorites and existence-cache systems.
 *
 * Pipeline: separator normalize (\ → /) → trim trailing separators → lowercase.
 * Does NOT consult realpathSync (symlink resolution is a deliberate Non-Goal
 * per the Favorites design spec).
 */
export function canonicalKey(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
