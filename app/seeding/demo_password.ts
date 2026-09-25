/**
 * One password for every demo account — the test accounts (`db:seed`) and the
 * demo dataset (`dev:seed`) alike. Twelve characters, so it also passes the
 * signup and reset validators.
 *
 * Demo accounts are created by seeders, which never run outside development
 * and test, so this cannot reach a production database.
 */
export const DEMO_PASSWORD = 'Example12345'
