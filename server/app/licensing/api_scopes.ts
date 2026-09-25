import type { ApiScope, ScopeDefinition } from '#api/scopes'

/**
 * The organisation API's license scopes (licence plan M5). The augmentation
 * is what keeps `ApiScope` a closed union, so `requireScope(ctx,
 * 'licenses:read')` stays a compile-time check.
 */
declare module '#api/scopes' {
  interface ApiScopes {
    'licenses:read': true
  }
}

export const licenseApiScopes: [ApiScope, ScopeDefinition][] = [
  [
    'licenses:read',
    {
      description: 'Read your licenses and where they are installed (never the keys)',
      default: true,
    },
  ],
]
