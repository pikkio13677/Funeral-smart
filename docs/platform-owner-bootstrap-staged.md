# Platform owner bootstrap — staged design

## Identity boundary

The platform owner is an `app_users` identity with role `platform_owner` and a matching active `platform_access` row with role `owner`. It is not a company administrator and receives no company membership. The legacy `admin` role remains reserved for the existing company-management surface.

## One-time bootstrap

The authenticated bootstrap route is protected by the existing rate limit and the server-side `BOOTSTRAP_ADMIN_TOKEN` environment variable. The token is compared in constant time and is never stored or returned. A singleton row in `platform_bootstrap_state` is locked inside the same PostgreSQL transaction that creates the user, platform access row, consumed marker, and audit event. This serializes concurrent attempts and prevents reuse even when legacy users already exist.

The new owner must enroll TOTP immediately. Before MFA is enabled, the authentication middleware permits only the documented MFA setup/recovery paths. The owner role is not accepted by legacy company-admin authorization.

## Migration ordering

1. Existing baseline and tenant draft migrations.
2. `009_platform_access.draft.sql`.
3. `010_platform_owner_bootstrap.draft.sql`.

Both platform migrations remain draft-only and are deliberately absent from `migrate.js`. The CI migration checker applies them only to its disposable PostgreSQL service.

## Not authorized by this change

- No production migration or database write.
- No account creation or bootstrap request.
- No Render configuration change or deployment.
- No activation of `ENABLE_MULTI_TENANT`.
- No platform routes mounted yet.

Before any real bootstrap, the schema must be reviewed, the migrations approved and deployed through a separately authorized change, and the bootstrap operation explicitly scheduled. Do not paste the bootstrap token, password, TOTP seed, or recovery codes into chat or source control.