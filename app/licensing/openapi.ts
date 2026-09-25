import {
  commonResponses,
  cursorParams,
  errorSchema,
  item,
  json,
  page,
  type OpenApiContribution,
} from '#api/openapi'
import { LICENSE_REASONS } from '#licensing/reasons'

/**
 * The public license API in the published document (licence plan §6).
 *
 * Every operation sets `security: []`: these are called with a product slug
 * and a license key, never an organisation API key, and a generated client
 * that tried to attach one would be wrong in a way that is hard to notice.
 */

const tags = ['License API']

const reason = {
  type: ['string', 'null'],
  enum: [...LICENSE_REASONS, null],
  description:
    'Why the license is not valid; null when it is. **Permanent codes** — branch on these, never on the HTTP status.',
}

const policy = {
  type: 'object',
  properties: {
    validation_interval_hours: { type: 'integer', example: 24 },
    offline_grace_days: { type: 'integer', example: 7 },
  },
}

const license = {
  type: ['object', 'null'],
  description: 'null when the key is unknown or belongs to another product.',
  properties: {
    id: { type: 'string', example: 'lic_7fj2k9pqrstu' },
    status: { type: 'string', enum: ['active', 'suspended', 'revoked'] },
    type: { type: 'string', enum: ['perpetual', 'subscription', 'fixed_days'] },
    expires_at: { type: ['string', 'null'], format: 'date-time' },
    updates_until: { type: ['string', 'null'], format: 'date-time' },
    product: { type: 'string' },
    plan: { type: 'string' },
    key_suffix: { type: 'string', example: 'A0ZT' },
    activations: {
      type: 'object',
      properties: {
        used: { type: 'integer' },
        max: { type: ['integer', 'null'], description: 'null means unlimited.' },
      },
    },
  },
}

const activation = {
  type: ['object', 'null'],
  properties: {
    id: { type: 'string', example: 'act_7fj2k9pqrstu' },
    instance_id: { type: 'string' },
    hostname: { type: ['string', 'null'] },
    is_dev: { type: 'boolean' },
    activated_at: { type: 'string', format: 'date-time' },
  },
}

const signed = {
  type: 'object',
  description:
    'The same answer, signed. `payload` is base64url of the exact JSON bytes that were signed with Ed25519 under `kid` (see GET /keys). Verify `signature` over those bytes, then parse them — trust nothing outside `payload`.',
  properties: {
    alg: { type: 'string', enum: ['Ed25519'] },
    kid: { type: 'string' },
    payload: { type: 'string' },
    signature: { type: 'string' },
  },
}

const echoed = {
  product: { type: 'string' },
  instance_id: { type: ['string', 'null'] },
  nonce: {
    type: ['string', 'null'],
    description: 'Echoed from the request, inside the signed payload, to rule out replays.',
  },
  checked_at: { type: 'string', format: 'date-time' },
  request_id: { type: 'string' },
}

const decision = {
  type: 'object',
  properties: {
    valid: { type: 'boolean' },
    reason,
    license,
    activation,
    entitlements: {
      type: 'object',
      additionalProperties: { type: ['boolean', 'integer', 'string'] },
      description: 'Empty unless valid.',
    },
    policy,
    ...echoed,
    signed,
  },
}

const licenseKeyFields = {
  product: { type: 'string', example: 'invoice-pro' },
  license_key: { type: 'string', example: 'WIPRO-7K4DX-82M91-QP6F3-A0ZT9' },
  nonce: {
    type: 'string',
    description: '8–64 characters, optional. Echoed in the signed payload.',
  },
}

const instanceId = {
  type: 'string',
  description: 'Generated once per installation by the client (a UUID is ideal) and kept.',
}

const businessAnswer =
  'Always 200 for a decision, valid or not. A 4xx means the request was malformed (422) or too frequent (429).'

const failures = {
  422: { description: 'The body is malformed.', ...json(errorSchema) },
  429: {
    description: 'Too many requests for this key or address. See Retry-After.',
    ...json(errorSchema),
  },
}

export const licenseApiOpenApi: OpenApiContribution = {
  schemas: { LicenseDecision: decision },
  paths: {
    '/licenses/validate': {
      post: {
        tags,
        security: [],
        summary: 'Is this license valid?',
        description: `Pass \`instance_id\` to also ask whether this installation is activated. ${businessAnswer}`,
        requestBody: json({
          type: 'object',
          required: ['product', 'license_key'],
          properties: { ...licenseKeyFields, instance_id: instanceId },
        }),
        responses: { 200: { description: 'The decision.', ...json(decision) }, ...failures },
      },
    },

    '/licenses/activate': {
      post: {
        tags,
        security: [],
        summary: 'Activate this installation',
        description: `Idempotent per \`instance_id\`: retrying costs the customer no slot. Development and staging hostnames do not count toward the limit unless the product says so. ${businessAnswer}`,
        requestBody: json({
          type: 'object',
          required: ['product', 'license_key', 'instance_id'],
          properties: {
            ...licenseKeyFields,
            instance_id: instanceId,
            site_url: { type: 'string', example: 'https://shop.example.com' },
            label: { type: 'string', description: 'A name for installs with no site.' },
            client_version: { type: 'string', example: '1.4.0' },
          },
        }),
        responses: {
          200: {
            description: 'The decision, with `activated`.',
            ...json({
              ...decision,
              properties: { activated: { type: 'boolean' }, ...decision.properties },
            }),
          },
          ...failures,
        },
      },
    },

    '/licenses/deactivate': {
      post: {
        tags,
        security: [],
        summary: 'Release this installation’s slot',
        description:
          'Works whatever state the license is in. `deactivated: false` with a null reason means it was not active — not an error.',
        requestBody: json({
          type: 'object',
          required: ['product', 'license_key', 'instance_id'],
          properties: { ...licenseKeyFields, instance_id: instanceId },
        }),
        responses: {
          200: {
            description: 'Whether a slot was released.',
            ...json({
              type: 'object',
              properties: {
                deactivated: { type: 'boolean' },
                reason: {
                  type: ['string', 'null'],
                  enum: ['invalid_license', 'product_mismatch', null],
                },
                license,
                ...echoed,
                signed,
              },
            }),
          },
          ...failures,
        },
      },
    },

    '/products/{slug}': {
      get: {
        tags,
        security: [],
        summary: 'A product and its plans on sale',
        parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'The product.', ...json({ type: 'object' }) },
          404: { description: 'No such product, or not yet on sale.', ...json(errorSchema) },
        },
      },
    },

    '/products/{slug}/releases/latest': {
      get: {
        tags,
        security: [],
        summary: 'The newest build, and a download link if this license covers it',
        description: `The release is described whether or not the caller may have it, so software can say "2.1 is available — renew to get it". \`download\` is a link that works for 10 minutes, for this license and this build only. With \`instance_id\`, the installation must be activated. ${businessAnswer}`,
        parameters: [
          { name: 'slug', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'channel', in: 'query', schema: { type: 'string', enum: ['stable', 'beta'] } },
          { name: 'license_key', in: 'query', schema: { type: 'string' } },
          { name: 'instance_id', in: 'query', schema: instanceId },
          { name: 'nonce', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          200: {
            description:
              'The newest release on the channel, or `release: null` when there is none.',
            ...json({
              type: 'object',
              properties: {
                release: {
                  type: ['object', 'null'],
                  properties: {
                    id: { type: 'string', example: 'rel_8x2k4m9qz1ab' },
                    version: { type: 'string', example: '2.1.0' },
                    channel: { type: 'string', enum: ['stable', 'beta'] },
                    changelog: { type: ['string', 'null'] },
                    requires: {
                      type: 'object',
                      additionalProperties: { type: 'string' },
                      example: { wp: '6.5', php: '7.4' },
                    },
                    tested_up_to: { type: ['string', 'null'] },
                    published_at: { type: ['string', 'null'], format: 'date-time' },
                    file_name: { type: 'string' },
                    file_size: { type: 'integer' },
                    checksum_sha256: { type: 'string' },
                  },
                },
                update_allowed: { type: 'boolean' },
                reason: {
                  type: ['string', 'null'],
                  enum: [...LICENSE_REASONS, 'updates_expired', 'license_required', null],
                  description:
                    'Why there is no download: a license reason, `updates_expired` (a perpetual license whose update window closed before this build), or `license_required` (no key sent).',
                },
                download: {
                  type: ['object', 'null'],
                  properties: {
                    url: { type: 'string', format: 'uri' },
                    expires_at: { type: 'string', format: 'date-time' },
                  },
                },
                license: { ...license, type: ['object', 'null'] },
                ...echoed,
                signed,
              },
            }),
          },
          404: { description: 'No such product, or not yet on sale.', ...json(errorSchema) },
          ...failures,
        },
      },
    },
    '/releases/{id}/download': {
      get: {
        tags,
        security: [],
        summary: 'Download a build (a link from releases/latest)',
        description:
          'Not called directly: follow the `download.url` a `releases/latest` answer gave. Redirects to the file. The license is checked again, so a link issued before a refund stops working.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          302: { description: 'To the file.' },
          403: {
            description:
              'The link is invalid or expired, or the license no longer covers this build.',
            ...json(errorSchema),
          },
          404: { description: 'No such release.', ...json(errorSchema) },
        },
      },
    },
    '/keys': {
      get: {
        tags,
        security: [],
        summary: 'Public keys that sign license answers',
        responses: {
          200: {
            description: 'Raw 32-byte Ed25519 public keys, base64url.',
            ...json({
              type: 'object',
              properties: {
                data: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      kid: { type: 'string' },
                      alg: { type: 'string', enum: ['Ed25519'] },
                      public_key: { type: 'string' },
                    },
                  },
                },
              },
            }),
          },
        },
      },
    },
  },
}

/**
 * A customer's own licenses on the organisation API (licence plan M5) —
 * API-key authenticated, unlike everything above.
 */
const accountLicense = {
  type: 'object',
  properties: {
    id: { type: 'string', example: 'lic_7fj2k9pqrstu' },
    product: { type: 'string' },
    plan: { type: 'string' },
    key_suffix: { type: 'string', description: 'The key itself is only shown in the account.' },
    status: { type: 'string', enum: ['active', 'suspended', 'revoked'] },
    expires_at: { type: ['string', 'null'], format: 'date-time' },
    updates_until: { type: ['string', 'null'], format: 'date-time' },
    max_activations: { type: ['integer', 'null'] },
    created_at: { type: 'string', format: 'date-time' },
  },
}

export const accountLicensesOpenApi: OpenApiContribution = {
  schemas: { License: accountLicense },
  paths: {
    '/licenses': {
      get: {
        summary: 'List your licenses',
        description: 'Requires `licenses:read`. Oldest first, cursor-paginated.',
        parameters: [...cursorParams],
        responses: {
          200: { description: 'A page of licenses.', ...json(page(accountLicense)) },
          ...commonResponses,
        },
      },
    },
    '/licenses/{id}': {
      get: {
        summary: 'One of your licenses',
        description: 'Requires `licenses:read`.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'The license.', ...json(item(accountLicense)) },
          ...commonResponses,
        },
      },
    },
  },
}
