import vine from '@vinejs/vine'

import { ENTITLEMENT_KEY_PATTERN, ENTITLEMENT_TYPES } from '#catalog/entitlements'
import { LICENSE_TERMS, PLAN_BILLINGS } from '#catalog/plan_shape'

/**
 * Catalog request bodies (licence plan §4, M1). Rules that relate two fields
 * — billing against license term, what may change after draft — live in
 * `CatalogService`, because they are about the catalog rather than the form.
 */

/**
 * Lowercase words joined by single hyphens. Sent by every SDK call, so it is
 * kept to the characters nobody has to escape anywhere.
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * `149`, `149.9` or `149.00`, in the major unit, turned into integer cents
 * without passing through a float (portability rule 8).
 */
const priceToCents = vine
  .string()
  .trim()
  .regex(/^\d{1,7}(?:\.\d{1,2})?$/)
  .transform((value) => {
    const [whole, fraction = ''] = value.split('.')
    return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  })

const optionalUrl = vine.string().trim().url().maxLength(1024).nullable().optional()

export const productValidator = vine.create({
  name: vine.string().trim().minLength(1).maxLength(120),
  slug: vine.string().trim().toLowerCase().maxLength(64).regex(SLUG_PATTERN),
  kind: vine.enum(['wordpress_plugin', 'app', 'library', 'other'] as const),

  /**
   * The readable head of every key issued for the product (`WIPRO-…`).
   */
  keyPrefix: vine
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9]{1,7}$/),

  status: vine.enum(['draft', 'active', 'retired'] as const).optional(),
  description: vine.string().trim().maxLength(2000).nullable().optional(),
  homepageUrl: optionalUrl,
  docsUrl: optionalUrl,

  /**
   * Handed to every SDK in each validate response. A month between checks
   * and three months offline are the outer bounds of "still meaningfully
   * licensed".
   */
  validationIntervalHours: vine.number().withoutDecimals().range([1, 720]),
  offlineGraceDays: vine.number().withoutDecimals().range([0, 90]),
  countDevSites: vine.boolean().optional(),
})

export const planValidator = vine.create({
  name: vine.string().trim().minLength(1).maxLength(120),
  slug: vine.string().trim().toLowerCase().maxLength(64).regex(SLUG_PATTERN),
  billing: vine.enum(PLAN_BILLINGS),
  price: priceToCents,
  currency: vine
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/),
  licenseTerm: vine.enum(LICENSE_TERMS),
  termDays: vine.number().withoutDecimals().range([1, 3650]).nullable().optional(),
  updatesDays: vine.number().withoutDecimals().range([1, 3650]).nullable().optional(),
  maxActivations: vine.number().withoutDecimals().range([1, 100_000]).nullable().optional(),
  providerProductId: vine.string().trim().maxLength(128).nullable().optional(),
  isPublic: vine.boolean().optional(),
  sortOrder: vine.number().withoutDecimals().range([0, 10_000]).nullable().optional(),
})

export const createEntitlementValidator = vine.create({
  key: vine.string().trim().toLowerCase().regex(ENTITLEMENT_KEY_PATTERN),
  name: vine.string().trim().minLength(1).maxLength(120),
  type: vine.enum(ENTITLEMENT_TYPES),
  description: vine.string().trim().maxLength(500).nullable().optional(),

  /**
   * Raw here and read as the chosen type by `CatalogService`, because which
   * rule applies depends on `type`.
   */
  defaultValue: vine.string().trim().maxLength(500).nullable().optional(),
})

export const updateEntitlementValidator = vine.create({
  name: vine.string().trim().minLength(1).maxLength(120),
  description: vine.string().trim().maxLength(500).nullable().optional(),
  defaultValue: vine.string().trim().maxLength(500).nullable().optional(),
})
