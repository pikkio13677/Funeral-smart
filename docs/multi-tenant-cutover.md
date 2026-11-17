# Multi-company API cutover — release gates

The tenant route modules are intentionally dormant until the production data migration is approved. Do not mount them merely because the integration tests pass.

## Prepared in PR #54

- `tenant-api-router.js` composes the tenant data routers behind authenticated identity and a PostgreSQL-verified active membership.
- Company selection is exposed separately because a user must be able to select a company before tenant context exists.
- Invitation acceptance is exposed before tenant context; invitation creation/list/revocation remain behind tenant context.
- The session token is SHA-256 digested consistently for company selection and tenant-context validation.
- The composition test asserts middleware order and verifies the tenant route set.

## Still required before mounting

1. Restore the latest production backup into an isolated PostgreSQL database.
2. Run the read-only preflight and record all rows that need a company assignment; do not infer company ownership from arbitrary IDs.
3. Produce and review an explicit mapping for the existing legacy business data to the initial company.
4. Backfill in a transaction on the restored database, then run the complete tenant integration suite and inspect row counts and foreign-key violations.
5. Rehearse rollback from the pre-migration backup, including the new finalization migration 012; compare table counts and verify application reads after restore.
6. On the restored clone, apply draft migrations 005–011, execute the reviewed backfill in one transaction, verify all nine tenant tables and cross-company references, then apply draft migration 012 to set `company_id NOT NULL` and replace global code uniqueness with company-scoped unique indexes. Migration 012 must never run before the backfill.
7. Mount `companyContextRouter` after the existing auth router and mount the tenant router before the legacy admin router.
8. Remove or isolate the legacy global business-data routes in the same cutover. They must never remain as a fall-through path for tenant resources.
9. The admin UI now has a dormant company selector/switcher, tenant-role navigation, company member/invitation management, tenant activity log, task PATCH contract and logout. Keep its `TENANT_API_ENABLED` flag false until the reviewed migration and route cutover are complete.
10. Keep platform-wide inquiries, provider applications, user administration and support tools behind the separate platform-owner authorization design (PR #55), not tenant `admin`.

## Frontend/API integration status

The interface preparation is implemented and syntax-tested, but intentionally dormant:

- company selection and switching use `/api/v1/auth/companies` and `/api/v1/auth/active-company`;
- tenant navigation and create forms follow the verified membership role rather than the global account role;
- tenant administrators must complete MFA before the tenant context middleware grants data access;
- company members and invitations use the tenant-scoped company endpoints;
- activity log uses `/api/v1/admin/company/activity` and task completion uses `PATCH /tasks/:id`;
- the tenant toolbar includes explicit logout.

Invitation onboarding is now prepared: the public site path redirects to the same-origin API page, which supports existing-account login with MFA or new account creation from the email-bound invitation token. The registration router and tenant acceptance endpoint remain unmounted until cutover. Still outstanding: full browser/API end-to-end tests against a migrated staging database, including rate-limit behaviour, email delivery and duplicate/expired invitations. `TENANT_API_ENABLED` must remain false until those tests and the production backfill rehearsal pass.

## Safety boundary

Until these gates are complete, `server.js` continues to use the legacy router and the new tenant API remains unmounted. Migration 012 is a separate finalization gate and is intentionally not included in `migrate.js`. No production database migration, backfill, merge or deployment is authorized by this preparation work.
