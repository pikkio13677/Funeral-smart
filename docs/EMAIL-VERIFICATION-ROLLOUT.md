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

The tenant invitation acceptance page and its static route still need to be wired to read the token from the URL fragment and submit it only in the authenticated request body. The API tenant routers are also not mounted in the current server entry point. Those are deliberate blockers, not completed features.
