# Email verification rollout — FUNERAL SMART

## Current code state

The authenticated email-verification endpoints and management UI are implemented behind the independent `ENABLE_EMAIL_VERIFICATION` feature flag. The multi-tenant router activation remains a separate control (`ENABLE_MULTI_TENANT`).

The management page is published from `public/admin.html`; the root `admin.html` is kept in sync for repository compatibility.

## Required database changes

The draft migrations must be applied in order on a disposable or dedicated staging database:

1. `005_multi_tenant_foundation.draft.sql`
2. `006_session_active_membership.draft.sql`
3. `007_audit_invitations.draft.sql`
4. `008_email_verification.draft.sql`

They are deliberately not registered in `migrate.js`. The CI migration check applies them only to its temporary PostgreSQL service.

## Required private configuration for a future staging test

- `ENABLE_EMAIL_VERIFICATION=true` only after the staging database has the required columns and table.
- Keep `ENABLE_MULTI_TENANT=false` until tenant isolation, route wiring, authorization, rollback and backup checks are separately approved.
- `EMAIL_VERIFICATION_PEPPER`: private random value with at least 32 bytes; never commit it or send it in chat.
- Resend sender credentials and a verified sender domain are separate staging configuration tasks. Do not send real messages as part of CI.

## Safety

Do not enable these flags on production, apply migrations to the production database, or deploy this branch until a separately approved rollout and restore plan is complete. Invitation acceptance must continue to fail closed unless the account has independently verified the exact invited email address.

## Remaining work

The static invitation acceptance page now reads the bearer token from the URL fragment, removes it from the visible address, loads `public/api-config.js` before computing the backend URL, and sends the token only in the authenticated POST body. A regression test covers the API configuration and token handling. The backend route wiring is now prepared in `server.js` behind `ENABLE_MULTI_TENANT=true`: company selection, invitation acceptance, and tenant business routers are mounted only when explicitly enabled. Invitation acceptance authenticates before tenant selection; all other invitation/business routes require a database-derived active tenant context. Company-context endpoints authenticate individually so public API routes are not intercepted. Startup fails closed unless email-verification and invitation-registration flags, a 32-byte pepper, migrations 005–008, the company backfill, and at least one active company membership are present. This code is still dormant by default; no Render flags or production database changes were made. The invitation page is therefore not yet an end-to-end working invitation flow.
