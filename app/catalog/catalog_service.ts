import db from '@adonisjs/lucid/services/db'

import Plan from '#models/plan'
import Product from '#models/product'
import Entitlement from '#models/entitlement'
import { planShapeErrors, type LicenseTerm, type PlanBilling } from '#catalog/plan_shape'
import {
  coerceEntitlementValue,
  type EntitlementType,
  type EntitlementValue,
  type EntitlementValues,
} from '#catalog/entitlements'

/**
 * A rule the catalog refuses, tied to the form field it is about so the admin
 * screen can put the message next to the input rather than in a banner.
 */
export class CatalogError extends Error {
  constructor(readonly errors: Record<string, string>) {
    super(Object.values(errors).join(' '))
  }
}

export interface ProductInput {
  name: string
  slug: string
  kind: Product['kind']
  keyPrefix: string
  status?: Product['status']
  description?: string | null
  homepageUrl?: string | null
  docsUrl?: string | null
  validationIntervalHours: number
  offlineGraceDays: number
  countDevSites: boolean
}

export interface PlanInput {
  name: string
  slug: string
  billing: PlanBilling
  priceCents: number
  currency: string
  licenseTerm: LicenseTerm
  termDays?: number | null
  updatesDays?: number | null
  maxActivations?: number | null
  providerProductId?: string | null
  isPublic: boolean
  sortOrder?: number | null
}

export interface EntitlementInput {
  key: string
  name: string
  type: EntitlementType
  description?: string | null
  defaultValue?: unknown
}

/**
 * Products, plans and entitlements (licence plan §4, M1).
 *
 * Every catalog write goes through here, because the catalog has one kind of
 * rule the database cannot express: **what has shipped is permanent**. A
 * product's slug is compiled into every copy of the software that calls us; a
 * plan's billing rhythm is what its customers agreed to pay; an entitlement
 * key is read by `license.has('…')` in code we will never see again. All of
 * them may change freely while the product is still a draft, and not after.
 */
export class CatalogService {
  async products(): Promise<Product[]> {
    return Product.query()
      .withCount('plans', (query) => query.where('status', 'active'))
      .orderBy('name', 'asc')
  }

  async findProduct(publicId: string): Promise<Product | null> {
    return Product.query()
      .where('public_id', publicId)
      .preload('plans', (query) => query.orderBy('sort_order', 'asc').orderBy('id', 'asc'))
      .preload('entitlements', (query) => query.orderBy('key', 'asc'))
      .first()
  }

  async findProductBySlug(slug: string): Promise<Product | null> {
    return Product.findBy('slug', slug)
  }

  /**
   * A plan, looked up **within** its product so a plan id pasted into another
   * product's URL behaves exactly like a missing one.
   */
  async findPlan(product: Product, publicId: string): Promise<Plan | null> {
    return Plan.query().where('product_id', product.id).where('public_id', publicId).first()
  }

  async findEntitlement(product: Product, publicId: string): Promise<Entitlement | null> {
    return Entitlement.query().where('product_id', product.id).where('public_id', publicId).first()
  }

  async createProduct(input: ProductInput): Promise<Product> {
    await this.assertSlugFree(input.slug)

    return Product.create({
      name: input.name,
      slug: input.slug,
      kind: input.kind,
      keyPrefix: input.keyPrefix,
      status: 'draft',
      description: input.description ?? null,
      homepageUrl: input.homepageUrl ?? null,
      docsUrl: input.docsUrl ?? null,
      validationIntervalHours: input.validationIntervalHours,
      offlineGraceDays: input.offlineGraceDays,
      countDevSites: input.countDevSites,
    })
  }

  async updateProduct(product: Product, input: ProductInput): Promise<Product> {
    if (input.slug !== product.slug) {
      if (!product.isDraft) {
        throw new CatalogError({
          slug: 'The slug is fixed once a product has left draft — shipped software sends it.',
        })
      }

      await this.assertSlugFree(input.slug, product.id)
    }

    const status = input.status ?? product.status

    /**
     * Draft means "never sold". Going back to it would re-open the slug and
     * the plans' billing to edits that break customers who already bought.
     */
    if (status === 'draft' && !product.isDraft) {
      throw new CatalogError({ status: 'A product cannot go back to draft once it has left it.' })
    }

    product.merge({
      name: input.name,
      slug: input.slug,
      kind: input.kind,
      keyPrefix: input.keyPrefix,
      status,
      description: input.description ?? null,
      homepageUrl: input.homepageUrl ?? null,
      docsUrl: input.docsUrl ?? null,
      validationIntervalHours: input.validationIntervalHours,
      offlineGraceDays: input.offlineGraceDays,
      countDevSites: input.countDevSites,
    })

    await product.save()
    return product
  }

  async createPlan(product: Product, input: PlanInput): Promise<Plan> {
    this.assertPlanShape(input)
    await this.assertPlanSlugFree(product, input.slug)
    await this.assertProviderProductFree(input.providerProductId)

    return Plan.create({
      productId: product.id,
      ...this.planColumns(input),
      status: 'active',
      entitlements: {},
    })
  }

  async updatePlan(product: Product, plan: Plan, input: PlanInput): Promise<Plan> {
    this.assertPlanShape(input)

    /**
     * What a customer agreed to buy. Price is deliberately *not* in this list:
     * a new price applies to the next purchase and changes nothing about the
     * licenses already issued, which copy what they need when they are made.
     */
    if (!product.isDraft) {
      const locked: Record<string, string> = {}

      if (input.slug !== plan.slug) {
        locked.slug = 'The slug is fixed once the product has left draft.'
      }
      if (input.billing !== plan.billing) {
        locked.billing =
          'Billing is fixed once the product has left draft. Archive this plan and add a new one.'
      }
      if (input.licenseTerm !== plan.licenseTerm) {
        locked.licenseTerm = 'The license term is fixed once the product has left draft.'
      }

      if (Object.keys(locked).length) {
        throw new CatalogError(locked)
      }
    }

    if (input.slug !== plan.slug) {
      await this.assertPlanSlugFree(product, input.slug, plan.id)
    }

    if ((input.providerProductId ?? null) !== plan.providerProductId) {
      await this.assertProviderProductFree(input.providerProductId, plan.id)
    }

    plan.merge(this.planColumns(input))
    await plan.save()

    return plan
  }

  /**
   * Plans are archived, never deleted: licenses point at them for as long as
   * the license lives. An archived plan cannot be bought and keeps working for
   * everyone who already has it.
   */
  async setPlanArchived(plan: Plan, archived: boolean): Promise<Plan> {
    plan.status = archived ? 'archived' : 'active'
    await plan.save()

    return plan
  }

  /**
   * Replace a plan's entitlement values from raw form input.
   *
   * Keys the product does not define are dropped, and an empty value means
   * "not set" — the definition's default applies — which is different from a
   * value that happens to be zero or false.
   */
  async setPlanEntitlements(
    product: Product,
    plan: Plan,
    raw: Record<string, unknown> | null | undefined
  ): Promise<Plan> {
    const definitions = await Entitlement.query().where('product_id', product.id)
    const values: EntitlementValues = {}
    const errors: Record<string, string> = {}

    for (const definition of definitions) {
      const input = raw?.[definition.key]

      if (input === undefined || input === null || input === '') {
        continue
      }

      const value = coerceEntitlementValue(definition.type, input)

      if (value === undefined) {
        errors[`entitlements.${definition.key}`] =
          `${definition.name} must be ${articleFor(definition.type)}.`
        continue
      }

      values[definition.key] = value
    }

    if (Object.keys(errors).length) {
      throw new CatalogError(errors)
    }

    plan.entitlements = values
    await plan.save()

    return plan
  }

  async createEntitlement(product: Product, input: EntitlementInput): Promise<Entitlement> {
    const existing = await Entitlement.query()
      .where('product_id', product.id)
      .where('key', input.key)
      .first()

    if (existing) {
      throw new CatalogError({
        key: `${product.name} already has an entitlement called ${input.key}.`,
      })
    }

    return Entitlement.create({
      productId: product.id,
      key: input.key,
      name: input.name,
      type: input.type,
      description: input.description ?? null,
      defaultValue: this.defaultValueFor(input.type, input.defaultValue),
    })
  }

  /**
   * Name, description and default only. The key is read by customers' code
   * and the type decides how every stored value is read, so changing either
   * is a delete and a re-create — which says out loud what it breaks.
   */
  async updateEntitlement(
    entitlement: Entitlement,
    input: Pick<EntitlementInput, 'name' | 'description' | 'defaultValue'>
  ): Promise<Entitlement> {
    entitlement.merge({
      name: input.name,
      description: input.description ?? null,
      defaultValue: this.defaultValueFor(entitlement.type, input.defaultValue),
    })

    await entitlement.save()
    return entitlement
  }

  /**
   * Removes the definition **and** every plan's value for it, in one
   * transaction. Resolution already ignores a stale key, but leaving one
   * behind means re-creating the key later — with a different type — would
   * silently resurrect old values.
   */
  async deleteEntitlement(entitlement: Entitlement): Promise<void> {
    await db.transaction(async (trx) => {
      const plans = await Plan.query({ client: trx })
        .where('product_id', entitlement.productId)
        .forUpdate()

      for (const plan of plans) {
        if (plan.entitlements && entitlement.key in plan.entitlements) {
          const remaining = { ...plan.entitlements }
          delete remaining[entitlement.key]
          plan.entitlements = remaining
          await plan.save()
        }
      }

      entitlement.useTransaction(trx)
      await entitlement.delete()
    })
  }

  private defaultValueFor(type: EntitlementType, raw: unknown): EntitlementValue | null {
    if (raw === undefined || raw === null || raw === '') {
      return null
    }

    const value = coerceEntitlementValue(type, raw)

    if (value === undefined) {
      throw new CatalogError({ defaultValue: `The default must be ${articleFor(type)}.` })
    }

    return value
  }

  private planColumns(input: PlanInput) {
    return {
      name: input.name,
      slug: input.slug,
      billing: input.billing,
      priceCents: input.priceCents,
      currency: input.currency.toUpperCase(),
      licenseTerm: input.licenseTerm,
      termDays: input.termDays ?? null,
      updatesDays: input.updatesDays ?? null,
      maxActivations: input.maxActivations ?? null,
      providerProductId: input.providerProductId || null,
      isPublic: input.isPublic,
      sortOrder: input.sortOrder ?? 0,
    }
  }

  private assertPlanShape(input: PlanInput) {
    const errors = planShapeErrors({
      billing: input.billing,
      licenseTerm: input.licenseTerm,
      termDays: input.termDays ?? null,
      updatesDays: input.updatesDays ?? null,
    })

    if (Object.keys(errors).length) {
      throw new CatalogError(errors)
    }
  }

  private async assertSlugFree(slug: string, exceptId?: number) {
    const query = Product.query().where('slug', slug)

    if (exceptId) {
      query.whereNot('id', exceptId)
    }

    if (await query.first()) {
      throw new CatalogError({ slug: `Another product already uses the slug ${slug}.` })
    }
  }

  private async assertPlanSlugFree(product: Product, slug: string, exceptId?: number) {
    const query = Plan.query().where('product_id', product.id).where('slug', slug)

    if (exceptId) {
      query.whereNot('id', exceptId)
    }

    if (await query.first()) {
      throw new CatalogError({ slug: `${product.name} already has a plan with the slug ${slug}.` })
    }
  }

  /**
   * One provider product, one plan: a webhook for that product has to resolve
   * to exactly one thing to issue.
   */
  private async assertProviderProductFree(providerProductId?: string | null, exceptId?: number) {
    if (!providerProductId) {
      return
    }

    const query = Plan.query().where('provider_product_id', providerProductId)

    if (exceptId) {
      query.whereNot('id', exceptId)
    }

    if (await query.first()) {
      throw new CatalogError({
        providerProductId: 'Another plan is already mapped to that payment-provider product.',
      })
    }
  }
}

function articleFor(type: EntitlementType): string {
  switch (type) {
    case 'boolean':
      return 'yes or no'
    case 'integer':
      return 'a whole number'
    case 'string':
      return 'text of at most 500 characters'
  }
}

export default new CatalogService()
