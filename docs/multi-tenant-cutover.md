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
5. Rehearse rollback from the pre-migration backup.
6. Only after approval, apply migrations 005–008 and the reviewed backfill to the target environment.
7. Mount `companyContextRouter` after the existing auth router and mount the tenant router before the legacy admin router.
8. Remove or isolate the legacy global business-data routes in the same cutover. They must never remain as a fall-through path for tenant resources.
9. Update the admin UI to select and display the active company, then call the tenant API contract below.
10. Keep platform-wide inquiries, provider applications, user administration and support tools behind the separate platform-owner authorization design (PR #55), not tenant `admin`.

## Frontend/API contract work still outstanding

The current `admin.html` still uses the legacy global API and assumes a single global role. Before cutover it must:

- call `/api/v1/auth/companies` and `/api/v1/auth/active-company` to select the company;
- display the verified tenant role returned by the active-company selection and refresh it after switching company;
- use `/api/v1/admin/company/activity` instead of the legacy global `/audit` endpoint;
- align task status updates with `PATCH /tasks/:id` (or add a compatibility route);
- preserve the company context after login, logout and session expiry;
- separate platform-wide user management from company membership management.

## Safety boundary

Until these gates are complete, `server.js` continues to use the legacy router and the new tenant API remains unmounted. No production database migration, backfill, merge or deployment is authorized by this preparation work.
