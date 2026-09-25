import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

import type User from '#models/user'
import type Organization from '#models/organization'

/**
 * A demo dataset: enough of everything that every screen shows what it is
 * for, rather than an empty state.
 *
 *   Acme               a small customer, with a staff limit override
 *   Pro Widgets        an agency: a team, API keys, files — and, from the
 *                      licensing seeder, licenses installed on several sites
 *   Business Widgets   a second customer, so no list is a list of one
 *
 * plus the catalog and licenses (`#seeding/licensing_seeder`), published
 * announcements, a stuck webhook and a failed job, because the operations
 * screens are only legible with something on them (plan §12).
 *
 * Development only.
 */
export default class DevSeed extends BaseCommand {
  static commandName = 'dev:seed'
  static description = 'Create demo accounts, a catalog and licenses (development only)'

  static options: CommandOptions = {
    startApp: true,
  }

  async run() {
    if (!this.app.inDev) {
      this.logger.error('dev:seed only runs in development')
      this.exitCode = 1
      return
    }

    const { DateTime } = await import('luxon')
    const { default: registration } = await import('#auth/registration_service')
    const { default: invitations } = await import('#organizations/invitation_service')

    const { user, organization } = await registration.register({
      fullName: 'Jane Cooper',
      email: 'jane@example.com',
      password: 'correct-horse-battery',
      organizationName: 'Acme',
    })

    user.emailVerifiedAt = DateTime.utc()
    await user.save()

    /**
     * A staff-style override, so the back-office shows what one looks like.
     */
    organization.limitOverrides = { seats: 5 }
    await organization.save()

    const joining = await invitations.invite({
      organization,
      invitedBy: user,
      email: 'sam@example.com',
    })
    await invitations.accept({
      token: joining.token,
      fullName: 'Sam Member',
      password: 'correct-horse-battery',
    })

    const pending = await invitations.invite({
      organization,
      invitedBy: user,
      email: 'alex@example.com',
    })

    await this.backdate(organization, user, 7)

    const { default: UserModel } = await import('#models/user')
    const member = await UserModel.findByOrFail('email', 'sam@example.com')

    const env = await import('#start/env')

    /**
     * Two more customers. What they bought comes from the licensing seeder,
     * which also gives the agency a subscription with charges behind it.
     */
    const pro = await this.seedCustomerWorkspace(
      'Pro Widgets',
      'owner-pro@example.com',
      4,
      'Marguerite Hayes'
    )
    await this.seedCustomerWorkspace(
      'Business Widgets',
      'owner-business@example.com',
      2,
      'Kenji Okafor'
    )

    /**
     * The workspace the demo is toured in: a team, two API keys with traffic
     * behind them, and a few files.
     */
    const proMembers = await this.seedProWorkspace(pro.organization, pro.user)

    /**
     * Whatever the features registered in `start/seeders.ts` want to put in
     * these workspaces (plan §12). Runs here, after every workspace and
     * person exists, so a seeder can assign a row to a member and know they
     * are there.
     *
     * Their limit overrides are merged first: a meter is only worth showing
     * near its ceiling, and a plan's real ceiling is usually too high to
     * demonstrate against.
     */
    const { default: seeders } = await import('#seeding/demo_seeders')

    const context = {
      free: { organization, owner: user, members: [member] },
      pro: { organization: pro.organization, owner: pro.user, members: proMembers },
    }

    for (const [key, workspace] of Object.entries(context) as [
      keyof typeof context,
      (typeof context)[keyof typeof context],
    ][]) {
      const overrides = seeders.overridesFor(key)

      if (Object.keys(overrides).length > 0) {
        workspace.organization.limitOverrides = {
          ...(workspace.organization.limitOverrides ?? {}),
          ...overrides,
        }
        await workspace.organization.save()
      }
    }

    for (const seeder of seeders.all()) {
      await seeder.seed(context)
      this.logger.info(`seeded ${seeder.key}`)
    }

    await this.seedAnnouncements()
    await this.seedSupportTickets()
    await this.seedOperations()

    this.logger.success('Seeded Acme')
    this.logger.log('  owner:   jane@example.com / correct-horse-battery')
    this.logger.log('  member:  sam@example.com / correct-horse-battery')
    this.logger.log('  invited: alex@example.com (pending)')
    this.logger.log('')
    this.logger.success('Seeded customers')
    this.logger.log(
      '  agency:   owner-pro@example.com / correct-horse-battery (licenses, installs)'
    )
    this.logger.log('  another:  owner-business@example.com / correct-horse-battery')
    this.logger.log('  pricing:  /pricing/invoice-pro')
    this.logger.log('  plus 3 announcements, 3 support tickets, a stuck webhook and a failed job')
    this.logger.log('')
    /**
     * Only the hash of the token is stored, so this is the one moment the
     * link exists — printing it here saves reaching into Mailpit.
     */
    this.logger.log(`  invitation link: ${env.default.get('APP_URL')}/invitations/${pending.token}`)
  }

  /**
   * Moves a workspace and its owner back in time.
   *
   * Everything a seeder creates is created in the same second, which makes
   * the back-office's growth chart a single bar and its "recent signups" a
   * list of identical dates (plan §12). Spreading the demo workspaces across
   * the year is what makes those screens show their shape at all.
   */
  private async backdate(organization: Organization, user: User, monthsAgo: number) {
    const { DateTime } = await import('luxon')
    const when = DateTime.utc().minus({ months: monthsAgo }).startOf('day').plus({ hours: 10 })

    organization.createdAt = when
    await organization.save()

    user.createdAt = when
    await user.save()
  }

  /**
   * A customer account with a verified owner, backdated so the back-office's
   * growth chart has a shape.
   */
  private async seedCustomerWorkspace(
    name: string,
    email: string,
    monthsAgo: number,
    ownerName = 'Alex Chen'
  ): Promise<{ organization: Organization; user: User }> {
    const { DateTime } = await import('luxon')
    const { default: registration } = await import('#auth/registration_service')

    const { user, organization } = await registration.register({
      /* A person owns the workspace; the workspace is not a person. */
      fullName: ownerName,
      email,
      password: 'correct-horse-battery',
      organizationName: name,
    })

    user.emailVerifiedAt = DateTime.utc()
    await user.save()

    await this.backdate(organization, user, monthsAgo)

    return { organization, user }
  }

  /**
   * The workspace the demo is toured in: a second and third pair of hands,
   * two API keys with traffic behind them, and some files.
   */
  private async seedProWorkspace(organization: Organization, owner: User) {
    const { DateTime } = await import('luxon')
    const { default: invitations } = await import('#organizations/invitation_service')

    /**
     * An agency that asked support for a team, uploads and API access — the
     * staff overrides that switch on what accounts do not get by default
     * (licence plan M5: one seat, no storage, no API keys).
     */
    organization.limitOverrides = { seats: 10, storageMb: 1_000, apiKeys: 5 }
    await organization.save()

    const joining = await invitations.invite({
      organization,
      invitedBy: owner,
      email: 'dev@prowidgets.example',
    })
    await invitations.accept({
      token: joining.token,
      fullName: 'Priya Raghavan',
      password: 'correct-horse-battery',
    })

    const second = await invitations.invite({
      organization,
      invitedBy: owner,
      email: 'design@prowidgets.example',
    })
    await invitations.accept({
      token: second.token,
      fullName: 'Tomas Ferreira',
      password: 'correct-horse-battery',
    })

    await invitations.invite({
      organization,
      invitedBy: owner,
      email: 'ops@prowidgets.example',
    })

    const { default: UserModel } = await import('#models/user')
    const priya = await UserModel.findByOrFail('email', 'dev@prowidgets.example')
    const tomas = await UserModel.findByOrFail('email', 'design@prowidgets.example')

    /*
     * A team where nobody has ever signed in reads as a team nobody uses.
     * One of them genuinely has not, because that is also a real row.
     */
    priya.lastLoginAt = DateTime.utc().minus({ hours: 3 })
    await priya.save()

    tomas.lastLoginAt = DateTime.utc().minus({ days: 2 })
    await tomas.save()

    /*
     * The owner has been reading along: only what was published since their
     * last look carries the "new" flag, which is the whole feature (plan
     * §20.5). Acme's member is left unread, so the bell keeps its dot.
     */
    owner.notificationsSeenAt = DateTime.utc().minus({ days: 2 })
    await owner.save()

    /*
     * Two-factor, on. Optional for customers and mandatory for staff, so the
     * security screen has both states to show across the demo accounts —
     * and in development `DEV_TWO_FACTOR_CODE` signs this account in without
     * an authenticator app.
     */
    const { default: twoFactor } = await import('#auth/two_factor_service')
    const { generate } = await import('otplib')
    const { secret } = await twoFactor.beginEnrolment(owner)
    await twoFactor.confirmEnrolment(owner, await generate({ secret }))

    await this.seedApiKeys(organization, owner)
    await this.seedFiles(organization, owner, priya)

    return [priya, tomas]
  }

  /**
   * Two keys and the traffic behind them: one live key a nightly job uses,
   * one test key with nothing much, and fourteen days of usage so the chart
   * on the API screen has a shape (plan §13.5).
   */
  private async seedApiKeys(organization: Organization, owner: User) {
    const { DateTime } = await import('luxon')
    const { default: apiKeys } = await import('#api/api_key_service')
    const { default: ApiRequest } = await import('#models/api_request')
    const { default: ApiUsageDay } = await import('#models/api_usage_day')

    const nightly = await apiKeys.create(organization, owner, {
      name: 'Nightly sync',
      scopes: ['licenses:read', 'members:read'],
      environment: 'live',
    })

    await apiKeys.create(organization, owner, {
      name: 'Staging import',
      scopes: ['licenses:read'],
      environment: 'test',
    })

    /**
     * Rolled-up days for everything before today, raw requests for today —
     * the two sources the usage screen reads, and it reads them differently
     * (see ApiUsageService).
     */
    for (let back = 13; back >= 1; back--) {
      const day = DateTime.utc().minus({ days: back })
      const requests = 40 + ((back * 37) % 55)

      await ApiUsageDay.create({
        organizationId: organization.id,
        day: day.toFormat('yyyy-MM-dd'),
        requests,
        /* One bad afternoon, so the chart has a red bar to explain. */
        errors: back === 4 ? 9 : back === 11 ? 2 : 0,
      })
    }

    for (let index = 0; index < 26; index++) {
      await ApiRequest.create({
        organizationId: organization.id,
        apiKeyId: nightly.apiKey.id,
        requestId: `req_seed_${index.toString().padStart(3, '0')}`,
        method: index % 6 === 0 ? 'POST' : 'GET',
        path: index % 6 === 0 ? '/api/v1/members' : '/api/v1/licenses',
        status: index === 11 ? 404 : 200,
        durationMs: 25 + ((index * 13) % 90),
        ip: '203.0.113.7',
      })
    }

    nightly.apiKey.lastUsedAt = DateTime.utc().minus({ hours: 3 })
    await nightly.apiKey.save()
  }

  /**
   * A few files, uploaded the way the application uploads them — through
   * `FileService`, so the checksum, the sniffed type and the storage quota
   * are all real.
   */
  private async seedFiles(organization: Organization, owner: User, member: User) {
    const { writeFile, mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { default: files } = await import('#storage/file_service')

    const directory = await mkdtemp(join(tmpdir(), 'dev-seed-'))

    const fixtures: { name: string; bytes: Buffer; actor: User }[] = [
      {
        name: 'launch-plan.pdf',
        bytes: Buffer.concat([Buffer.from('%PDF-1.7\n', 'ascii'), Buffer.alloc(24_000, 0x20)]),
        actor: owner,
      },
      {
        name: 'signups-by-week.csv',
        bytes: Buffer.from(
          `week,signups\n${Array.from(
            { length: 220 },
            (_, index) => `2026-W${String(index % 52).padStart(2, '0')},${12 + (index % 30)}`
          ).join('\n')}\n`,
          'utf8'
        ),
        actor: member,
      },
      {
        name: 'hero-shot.png',
        bytes: Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.alloc(180_000, 0x11),
        ]),
        actor: owner,
      },
    ]

    for (const fixture of fixtures) {
      const tmpPath = join(directory, fixture.name)
      await writeFile(tmpPath, fixture.bytes)

      await files.upload(organization, fixture.actor, {
        tmpPath,
        clientName: fixture.name,
        sizeBytes: fixture.bytes.length,
      })
    }
  }

  /**
   * Three announcements, because the feed's job is to be read in order and
   * one entry does not show that (plan §20).
   */
  private async seedAnnouncements() {
    const { DateTime } = await import('luxon')
    const { default: StaffUser } = await import('#models/staff_user')
    const { default: notifications } = await import('#notifications/notification_service')

    const staff = await StaffUser.findBy('email', 'admin@example.com')
    if (!staff) {
      return
    }

    const older = await notifications.create(staff, {
      title: 'Scheduled maintenance on Sunday',
      body: 'The API will be read-only between 02:00 and 03:00 UTC while we move the database.',
      level: 'warning',
      audienceType: 'all',
    })
    older.publishedAt = DateTime.utc().minus({ days: 9 })
    await older.save()

    const middle = await notifications.create(staff, {
      title: 'Two-factor authentication is available',
      body: 'Turn it on under Settings → Security. Staff accounts already require it.',
      level: 'success',
      audienceType: 'all',
    })
    middle.publishedAt = DateTime.utc().minus({ days: 3 })
    await middle.save()

    await notifications.create(staff, {
      title: 'Invoice Pro 2.5 is out',
      body: 'Recurring invoices can now be paused and resumed. Update from your WordPress dashboard.',
      level: 'info',
      audienceType: 'all',
      actionLabel: 'See pricing',
      actionUrl: '/pricing/invoice-pro',
    })
  }

  /**
   * Three conversations, one in each state (plan §21.2), so the queue, the
   * badges and the two-pane layout all have something to show. The one
   * waiting on the customer is what puts a count beside *Support* in the
   * account menu.
   */
  private async seedSupportTickets() {
    const { DateTime } = await import('luxon')
    const { default: StaffUser } = await import('#models/staff_user')
    const { default: UserModel } = await import('#models/user')
    const { default: Organization } = await import('#models/organization')
    const { default: support } = await import('#support/support_service')

    const staff = await StaffUser.findBy('email', 'support@example.com')
    const jane = await UserModel.findBy('email', 'jane@example.com')
    const pro = await Organization.findBy('slug', 'pro-widgets')
    const proOwner = await UserModel.findBy('email', 'owner-pro@example.com')

    if (!staff || !jane || !pro || !proOwner) {
      return
    }

    const acme = await Organization.findOrFail(jane.organizationId)

    /* Waiting on us: nobody has answered it yet. */
    const waiting = await support.open(acme, jane, {
      subject: 'Uploads over 10 MB time out',
      body: 'Every file above ten megabytes stops at 90% and then fails. This is on a 40 Mbit connection, and smaller files are fine.',
    })
    waiting.ticket.createdAt = DateTime.utc().minus({ hours: 5 })
    waiting.ticket.lastMessageAt = DateTime.utc().minus({ hours: 5 })
    await waiting.ticket.save()

    /* Waiting on them: answered, and the count in the account menu. */
    const answered = await support.open(pro, proOwner, {
      subject: 'Can we get a second API key for staging?',
      body: 'We would rather not point the staging import at the live key.',
    })
    await support.replyAsStaff(
      answered.ticket,
      staff,
      'You can — the Pro plan allows five keys. Settings → API Keys → New key, and pick the test environment so the prefix says which is which.'
    )

    /* Resolved: done, until somebody replies to it. */
    const resolved = await support.open(pro, proOwner, {
      subject: 'Invoice address is wrong',
      body: 'Our billing address changed last month.',
    })
    await support.replyAsStaff(
      resolved.ticket,
      staff,
      'Updated on the subscription — the next invoice will carry the new address.'
    )
    await support.resolve(resolved.ticket)
    resolved.ticket.createdAt = DateTime.utc().minus({ days: 9 })
    await resolved.ticket.save()
  }

  /**
   * The two rows the operations screens exist for. Neither is alarming on its
   * own; both are invisible until something reads them, which is why the
   * dashboard leads with them (plan §12).
   */
  private async seedOperations() {
    const { DateTime } = await import('luxon')
    const { default: Job } = await import('#models/job')
    const { default: WebhookEvent } = await import('#models/webhook_event')

    await Job.create({
      queue: 'default',
      name: 'SendMailJob',
      payload: { to: 'owner-northwind@example.com', mail: 'PaymentFailedNotification' },
      attempts: 3,
      maxAttempts: 3,
      availableAt: DateTime.utc().minus({ hours: 6 }),
      failedAt: DateTime.utc().minus({ hours: 5 }),
      lastError: 'Error: connect ECONNREFUSED 127.0.0.1:1025',
    })

    await WebhookEvent.create({
      provider: 'creem',
      providerEventId: 'evt_seed_unapplied',
      eventType: 'subscription.updated',
      payload: { id: 'sub_seed_pro', status: 'active' },
      signatureVerified: true,
      attempts: 1,
      lastError: 'Unknown subscription: sub_not_in_this_database',
      receivedAt: DateTime.utc().minus({ hours: 2 }),
    })
  }

  /* ---------------------------------------------------------------------- */
}
