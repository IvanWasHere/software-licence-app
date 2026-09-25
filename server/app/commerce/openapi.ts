import { commonResponses, errorSchema, item, json, type OpenApiContribution } from '#api/openapi'

/**
 * The integration API in the published document (licence plan §6, M4). It
 * uses the ordinary bearer key, but only the system account's key is
 * accepted — which the descriptions say, because a customer reading `/docs`
 * will otherwise try their own.
 */

const tags = ['Integration API']
const systemOnly =
  'Only the integration key (`node ace licensing:integration-key`) is accepted; any other key gets 403 `forbidden`.'

const licenseRef = {
  type: 'object',
  properties: {
    id: { type: 'string', example: 'lic_7fj2k9pqrstu' },
    product: { type: 'string' },
    plan: { type: 'string' },
    key_suffix: {
      type: 'string',
      description: 'The key itself is only ever emailed and shown in the account.',
    },
    status: { type: 'string', enum: ['active', 'suspended', 'revoked'] },
    expires_at: { type: ['string', 'null'], format: 'date-time' },
  },
}

const order = {
  type: 'object',
  properties: {
    id: { type: 'string', example: 'ord_7fj2k9pqrstu' },
    status: { type: 'string', enum: ['pending', 'paid', 'refunded', 'partially_refunded'] },
    email: { type: 'string', format: 'email' },
    total_cents: { type: 'integer' },
    currency: { type: 'string' },
    paid_at: { type: ['string', 'null'], format: 'date-time' },
    fulfilled_at: { type: ['string', 'null'], format: 'date-time' },
    licenses: { type: 'array', items: licenseRef },
  },
}

export const integrationOpenApi: OpenApiContribution = {
  schemas: { Order: order, LicenseRef: licenseRef },
  paths: {
    '/checkout': {
      post: {
        tags,
        summary: 'Start a checkout',
        description: `Creates a pending order and returns the payment provider's checkout URL to send the buyer to. The order is attributed by its id, never by anything the buyer types at the provider. ${systemOnly}`,
        requestBody: json({
          type: 'object',
          required: ['product', 'plan', 'email', 'success_url'],
          properties: {
            product: { type: 'string', example: 'invoice-pro' },
            plan: { type: 'string', example: 'invoice-pro-yearly' },
            email: { type: 'string', format: 'email' },
            success_url: { type: 'string', format: 'uri' },
          },
        }),
        responses: {
          201: {
            description: 'The pending order and where to send the buyer.',
            ...json(
              item({
                type: 'object',
                properties: {
                  order_id: { type: 'string' },
                  status: { type: 'string', enum: ['pending'] },
                  checkout_url: { type: 'string', format: 'uri' },
                },
              })
            ),
          },
          422: {
            description: 'The plan is not on sale or not mapped to the provider.',
            ...json(errorSchema),
          },
          ...commonResponses,
        },
      },
    },

    '/orders/{id}': {
      get: {
        tags,
        summary: 'An order, for a thank-you page to poll',
        description: `\`pending\` until the provider's webhook has landed — returning from checkout grants nothing by itself. ${systemOnly}`,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'The order.', ...json(item(order)) }, ...commonResponses },
      },
    },

    '/customers/licenses': {
      get: {
        tags,
        summary: 'A customer’s licenses, by email',
        description: `For a "resend my key" form or support tooling. An unknown address is an empty list. ${systemOnly}`,
        parameters: [
          {
            name: 'email',
            in: 'query',
            required: true,
            schema: { type: 'string', format: 'email' },
          },
        ],
        responses: {
          200: {
            description: 'Newest first.',
            ...json({ type: 'object', properties: { data: { type: 'array', items: licenseRef } } }),
          },
          ...commonResponses,
        },
      },
    },
  },
}
