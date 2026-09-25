/*
|--------------------------------------------------------------------------
| Quota registry
|--------------------------------------------------------------------------
|
| Every quota this application enforces, in the order the meter grids render
| them (plan §7.3, §7.4).
|
| A quota is a limit from `config/plans.ts` plus how to count what is using
| it and what to label its meter. How a limit is *named* in a `402` lives
| beside the limit itself, in `LIMIT_NOUNS`. `PlanService` owns the arithmetic — the amber-at-80% rule, the `>=`
| that makes a downgraded workspace read as full, the row lock inside a
| create — and knows nothing about what is being counted. This file is where
| the two meet.
|
| An explicit file rather than each feature registering itself on import, for
| the reason `app/queue/registry.ts` is one: a quota that silently stopped
| being registered would be a limit that silently stopped being enforced, and
| the first person to notice would be a customer on the wrong side of it.
|
| **Removing a feature means deleting its lines here** — see
| `docs/modules.md`. Nothing else needs to change: the meter grids, the
| at-cap banner and the API's usage payload all iterate what is registered.
|
*/

/**
 * Nothing is registered (licence plan M5).
 *
 * The account limits that remain — one seat, no uploads, API keys only when
 * staff switch them on — are fixed per account rather than something a
 * customer fills up over time, so a meter would only ever read "1 of 1, full"
 * and put an at-cap banner on every screen. Each limit is still enforced
 * where its rows are created, independently of this registry:
 *
 *   seats     `InvitationService` — row-locked, `plans.lockAndAssertLimit`
 *   storage   `FileService`       — `plans.assertStorageWithinLimit`
 *   apiKeys   `ApiKeyService`     — row-locked, `plans.lockAndAssertLimit`
 *
 * Register a quota here again if a limit ever becomes something customers
 * spend down; the meters, the banner and the API's usage payload follow.
 */
export {}
