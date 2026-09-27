import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

/**
 * Nothing under `/api` sends a cookie (licence plan M8).
 *
 * The session and shield middleware run on every route, because auth and
 * impersonation downstream expect a session to exist. On `/api` that session
 * is never read — the license API authenticates by license key, the rest by
 * bearer token — but it was still written back as `Set-Cookie`, along with an
 * XSRF token, on every call a plugin made. Wasted bytes on the hottest
 * endpoint, and a cookie on a surface whose CORS policy is `*` is one more
 * thing to reason about.
 *
 * Registered first in the router stack, so this runs *after* everything
 * inside it has written its cookies, and removes them.
 */
export default class ApiWithoutCookiesMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const result = await next()

    if (ctx.request.url().startsWith('/api/')) {
      ctx.response.removeHeader('set-cookie')
    }

    return result
  }
}
