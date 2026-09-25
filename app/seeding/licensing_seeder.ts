import { DateTime } from 'luxon'

import Payment from '#models/payment'
import Subscription from '#models/subscription'
import catalog from '#catalog/catalog_service'
import activations from '#licensing/activation_service'
import licenses, { SYSTEM_ACTOR } from '#licensing/license_service'
import type { DemoSeeder } from '#seeding/demo_seeders'

/**
 * The licensing share of `node ace dev:seed` (licence plan M5): a product with
 * three plans and entitlements, and licenses in the states a screen has to
 * render — active with installs, a subscription one, one near its limit, one
 * suspended — so neither the portal nor the back-office opens empty.
 */
export const licensingDemoSeeder: DemoSeeder = {
  key: 'licensing',

  async seed({ free, pro }) {
    const product = await catalog.createProduct({
      name: 'Invoice Pro',
      slug: 'invoice-pro',
      kind: 'wordpress_plugin',
      keyPrefix: 'WIPRO',
      description: 'Invoices, recurring billing and PDF export for WooCommerce.',
      validationIntervalHours: 24,
      offlineGraceDays: 7,
      countDevSites: false,
    })

    await catalog.createEntitlement(product, {
      key: 'pdf_export',
      name: 'PDF export',
      type: 'boolean',
    })
    await catalog.createEntitlement(product, {
      key: 'recurring_invoices',
      name: 'Recurring invoices',
      type: 'boolean',
    })
    await catalog.createEntitlement(product, {
      key: 'max_clients',
      name: 'Clients',
      type: 'integer',
      defaultValue: '50',
    })

    const yearly = await catalog.createPlan(product, {
      name: 'Yearly',
      slug: 'yearly',
      billing: 'yearly',
      priceCents: 14_900,
      currency: 'EUR',
      licenseTerm: 'subscription',
      maxActivations: 3,
      isPublic: true,
      sortOrder: 1,
      /**
       * Placeholder provider ids, so the pricing page shows its Buy buttons.
       * Replace them with real Creem product ids in the back-office to take a
       * payment; until then checkout says it cannot sell online.
       */
      providerProductId: 'prod_seed_yearly',
    })
    await catalog.setPlanEntitlements(product, yearly, { pdf_export: '1', max_clients: '500' })

    const lifetime = await catalog.createPlan(product, {
      name: 'Lifetime',
      slug: 'lifetime',
      billing: 'one_time',
      priceCents: 39_900,
      currency: 'EUR',
      licenseTerm: 'perpetual',
      updatesDays: 365,
      maxActivations: null,
      isPublic: true,
      sortOrder: 2,
      providerProductId: 'prod_seed_lifetime',
    })
    await catalog.setPlanEntitlements(product, lifetime, {
      pdf_export: '1',
      recurring_invoices: '1',
      max_clients: '100000',
    })

    const trial = await catalog.createPlan(product, {
      name: '30-day trial',
      slug: 'trial',
      billing: 'one_time',
      priceCents: 0,
      currency: 'EUR',
      licenseTerm: 'fixed_days',
      termDays: 30,
      maxActivations: 1,
      isPublic: false,
      sortOrder: 3,
    })

    await catalog.updateProduct(product, {
      name: product.name,
      slug: product.slug,
      kind: product.kind,
      keyPrefix: product.keyPrefix,
      description: product.description,
      status: 'active',
      validationIntervalHours: 24,
      offlineGraceDays: 7,
      countDevSites: false,
    })

    const { license: agency } = await licenses.issue({
      organization: pro.organization,
      plan: lifetime,
      source: 'manual',
      actor: SYSTEM_ACTOR,
      notes: 'Seeded: lifetime license with several installs.',
    })

    for (const [instanceId, siteUrl, version] of [
      ['seed-1', 'https://shop.prowidgets.example', '2.4.1'],
      ['seed-2', 'https://eu.prowidgets.example', '2.4.1'],
      ['seed-3', 'https://staging.prowidgets.example', '2.5.0-beta'],
    ]) {
      await activations.activate(
        agency,
        { instanceId, siteUrl, clientVersion: version },
        SYSTEM_ACTOR
      )
    }

    /**
     * A yearly subscription with a year of charges behind it — one of them
     * partly refunded — so the billing screen, MRR and the revenue chart all
     * have something to show. Provider ids are obviously fake (`…_seed_…`),
     * so `billing:sync` reports them missing rather than looking real.
     */
    const periodEnd = DateTime.utc().plus({ days: 20 }).startOf('second')
    const subscription = await Subscription.create({
      organizationId: pro.organization.id,
      provider: 'creem',
      providerSubscriptionId: 'sub_seed_prowidgets',
      providerCustomerId: 'cus_seed_prowidgets',
      planKey: 'license',
      planId: yearly.id,
      status: 'active',
      currentPeriodStart: periodEnd.minus({ years: 1 }),
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
    })

    for (const [index, occurredAt] of [
      periodEnd.minus({ years: 2 }),
      periodEnd.minus({ years: 1 }),
    ].entries()) {
      await Payment.create({
        organizationId: pro.organization.id,
        subscriptionId: subscription.id,
        provider: 'creem',
        providerOrderId: `ord_seed_prowidgets_${index}`,
        amountCents: yearly.priceCents,
        currency: yearly.currency,
        status: index === 0 ? 'partially_refunded' : 'succeeded',
        refundedAmountCents: index === 0 ? 2_000 : 0,
        description:
          index === 0 ? 'Invoice Pro · Yearly (partly refunded)' : 'Invoice Pro · Yearly',
        occurredAt,
      })
    }

    const { license: yearlyLicense } = await licenses.issue({
      organization: pro.organization,
      plan: yearly,
      source: 'manual',
      actor: SYSTEM_ACTOR,
      subscriptionId: subscription.id,
      expiresAt: periodEnd.plus({ days: 7 }),
      notes: 'Seeded: a yearly subscription license close to renewal.',
    })

    for (const [instanceId, siteUrl] of [
      ['seed-4', 'https://a.example'],
      ['seed-5', 'https://b.example'],
      ['seed-6', 'https://c.example'],
    ]) {
      await activations.activate(yearlyLicense, { instanceId, siteUrl }, SYSTEM_ACTOR)
    }

    const { license: trialLicense } = await licenses.issue({
      organization: free.organization,
      plan: trial,
      source: 'manual',
      actor: SYSTEM_ACTOR,
    })
    await activations.activate(
      trialLicense,
      { instanceId: 'seed-7', siteUrl: 'http://localhost:8080' },
      SYSTEM_ACTOR
    )

    const { license: disputed } = await licenses.issue({
      organization: free.organization,
      plan: lifetime,
      source: 'manual',
      actor: SYSTEM_ACTOR,
    })
    await licenses.suspend(disputed, 'Payment disputed (seeded)', SYSTEM_ACTOR)
  },
}
