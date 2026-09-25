import { errorSchema, json, type OpenApiContribution } from '#api/openapi'
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
