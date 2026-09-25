import { randomUUID } from 'node:crypto'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

/**
 * The public license API's envelope (licence plan §6).
 *
 * - **CORS open to every origin.** The JS SDK calls from customers' pages on
 *   domains we will never know. That is safe here and nowhere else: this
 *   surface reads no cookie and no session, so a cross-origin caller can do
 *   nothing a curl could not. No `Allow-Credentials`, ever.
 * - **A request id on every response**, errors included — what a customer
 *   quotes to support when their plugin says "invalid". Echoed when the
 *   client sends one, so an SDK can correlate its own logs.
 * - **Preflights answered here**, before any route handler, so the browser's
 *   OPTIONS never reaches validation or the rate limiter.
 */
export default class LicenseApiMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const requestId = ctx.request.header('x-request-id')?.slice(0, 64) || randomUUID()

    ctx.response.header('x-request-id', requestId)
    ctx.response.header('access-control-allow-origin', '*')
    ctx.response.header('access-control-allow-methods', 'GET, POST, OPTIONS')
    ctx.response.header('access-control-allow-headers', 'content-type, x-request-id')
    ctx.response.header('access-control-expose-headers', 'x-request-id, retry-after')
    ctx.response.header('access-control-max-age', '86400')

    /**
     * Never cached by anything in between: a cached "valid" is exactly the
     * answer a revoked license must not keep getting.
     */
    ctx.response.header('cache-control', 'no-store')

    if (ctx.request.method() === 'OPTIONS') {
      return ctx.response.noContent()
    }

    return next()
  }
}
