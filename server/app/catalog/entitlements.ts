/**
 * Entitlements (licence plan §4, §5.1).
 *
 * A product declares which entitlements exist and their types; a plan assigns
 * values; a license may override them. Everything here is pure so the whole
 * resolution — the part every validate response depends on — is unit tested
 * without a database.
 */

export const ENTITLEMENT_TYPES = ['boolean', 'integer', 'string'] as const
export type EntitlementType = (typeof ENTITLEMENT_TYPES)[number]
export type EntitlementValue = boolean | number | string

/**
 * The per-plan (and later per-license) map, keyed by entitlement key.
 */
export type EntitlementValues = Record<string, EntitlementValue>

export interface EntitlementDefinition {
  key: string
  type: EntitlementType
  defaultValue: EntitlementValue | null
}

/**
 * Lower snake case, starting with a letter. The key is sent to every SDK and
 * read in customers' code (`license.has('pdf_export')`), so it is as
 * permanent as an API field name.
 */
export const ENTITLEMENT_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

/**
 * What a definition resolves to when neither the plan nor the definition says
 * anything. Closed by default: an unconfigured flag grants nothing.
 */
export function zeroValue(type: EntitlementType): EntitlementValue {
  switch (type) {
    case 'boolean':
      return false
    case 'integer':
      return 0
    case 'string':
      return ''
  }
}

/**
 * Read a value typed into a form or stored in JSON as the given type.
 *
 * Returns `undefined` for anything that is not unambiguously that type, so a
 * caller can tell "not set" from "set to the zero value" — a plan that grants
 * `max_projects: 0` is different from one that says nothing.
 */
export function coerceEntitlementValue(
  type: EntitlementType,
  raw: unknown
): EntitlementValue | undefined {
  if (raw === null || raw === undefined) {
    return undefined
  }

  switch (type) {
    case 'boolean': {
      if (typeof raw === 'boolean') return raw
      if (raw === 1 || raw === '1' || raw === 'true' || raw === 'on') return true
      if (raw === 0 || raw === '0' || raw === 'false' || raw === 'off') return false
      return undefined
    }

    case 'integer': {
      if (typeof raw === 'number') return Number.isSafeInteger(raw) ? raw : undefined
      if (typeof raw === 'string' && /^-?\d{1,15}$/.test(raw.trim())) return Number(raw.trim())
      return undefined
    }

    case 'string': {
      if (typeof raw !== 'string') return undefined
      return raw.length <= 500 ? raw : undefined
    }
  }
}

/**
 * The entitlements a license actually carries.
 *
 * Precedence, most specific first: the license's own override, the plan's
 * value, the definition's default, the type's zero value. Only defined keys
 * are returned — a key left behind in a plan's map after its definition was
 * deleted is dropped here rather than sent to clients. A stored value of the
 * wrong type is treated as absent, for the same reason.
 */
export function resolveEntitlements(
  definitions: readonly EntitlementDefinition[],
  planValues: EntitlementValues | null | undefined,
  overrides?: EntitlementValues | null
): EntitlementValues {
  const resolved: EntitlementValues = {}

  for (const definition of definitions) {
    resolved[definition.key] =
      coerceEntitlementValue(definition.type, overrides?.[definition.key]) ??
      coerceEntitlementValue(definition.type, planValues?.[definition.key]) ??
      coerceEntitlementValue(definition.type, definition.defaultValue) ??
      zeroValue(definition.type)
  }

  return resolved
}
