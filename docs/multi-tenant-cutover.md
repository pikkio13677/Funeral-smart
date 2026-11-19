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
3. The current owner decision is that all legacy managed data belongs to one initial company. Create and verify exactly one `companies` row using its real legal details; do not invent the company name or VAT number.
4. Use `scripts/backfill-single-company.js` on the local restored clone. It is read-only by default, creates memberships matching existing supported account roles, leaves platform owners separate, links existing sessions, and leaves historical audit rows untouched. Review the dry-run report before a separately confirmed local-clone apply.
5. Run the complete tenant integration suite and inspect row counts and foreign-key violations.
6. Rehearse rollback from the pre-migration backup, including the finalization migration 013; compare table counts and verify application reads after restore.
7. On the restored clone, apply draft migrations 005–012 (including platform audit), execute the reviewed single-company backfill in one transaction, verify all nine tenant tables and cross-company references, then apply draft migration 013 to set `company_id NOT NULL` and replace global code uniqueness with company-scoped unique indexes. Migration 013 must never run before the backfill.
8. Mount `companyContextRouter` after the existing auth router and mount the tenant router before the legacy admin router.
9. Remove or isolate the legacy global business-data routes in the same cutover. They must never remain as a fall-through path for tenant resources.
10. The admin UI now has a dormant company selector/switcher, tenant-role navigation, company member/invitation management, tenant activity log, task PATCH contract and logout. Keep its `TENANT_API_ENABLED` flag false until the reviewed migration and route cutover are complete.
11. Keep platform-wide inquiries, provider applications, user administration and support tools behind the separate platform-owner authorization design (PR #55), not tenant `admin`.

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

Until these gates are complete, `server.js` continues to use the legacy router and the new tenant API remains unmounted. Migration 013 is a separate finalization gate and is intentionally not included in `migrate.js`. No production database migration, backfill, merge or deployment is authorized by this preparation work.
