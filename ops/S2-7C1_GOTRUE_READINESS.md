# S2-7C1 — GoTrue (Supabase Auth) readiness checklist

**Staging project ref:** `tdikhfeinufaahagmpjz` (org `azejxaifhjzbishwnpvp`). Production
(`wnswassgfuuivmfwjxsf`) is **out of scope and must not be touched**.

## Access note — PRE state NOT captured in this session

This session had **no Supabase Management API token and no dashboard access**, so the live PRE
configuration could not be read and nothing could be applied automatically. Everything below
is therefore an **owner / privileged-session action**. Do **not** treat any row as configured
until it has been verified in the dashboard or via the Management API.

To capture PRE and to apply, a holder of the project's **Management API token** can use:

```
# READ current auth config (PRE)
curl -s -H "Authorization: Bearer $SUPABASE_MANAGEMENT_TOKEN" \
  https://api.supabase.com/v1/projects/tdikhfeinufaahagmpjz/config/auth

# APPLY (example — only the fields you intend to change)
curl -s -X PATCH -H "Authorization: Bearer $SUPABASE_MANAGEMENT_TOKEN" \
  -H "Content-Type: application/json" \
  https://api.supabase.com/v1/projects/tdikhfeinufaahagmpjz/config/auth \
  -d '{ "...": "..." }'
```

Capture the raw PRE JSON into `ops/S2-7C1_GOTRUE_PRE.json` and the POST JSON into
`ops/S2-7C1_GOTRUE_POST.json` for the audit trail.

## Required values before the real owner is onboarded

Dashboard base: `https://supabase.com/dashboard/project/tdikhfeinufaahagmpjz`

| # | Setting | Required staging value | Dashboard path | Mgmt-API field | Class |
|--:|---|---|---|---|---|
| 1 | **Site URL** | the **staging** frontend origin only (e.g. `https://<staging-site>.netlify.app`), never a production domain | Authentication → URL Configuration → Site URL | `site_url` | **Blocking** |
| 2 | **Redirect allow-list** | exact staging callback URLs only: `<staging-origin>/auth/callback` (email confirm) and `<staging-origin>/auth/reset` (password reset). **No wildcard** like `https://*.netlify.app`, `http://localhost/*`, or `*` | Authentication → URL Configuration → Redirect URLs | `uri_allow_list` (comma-separated) | **Blocking** |
| 3 | **Email confirmation (signup)** | **ON** — a new user is created unconfirmed and must click the emailed link before login | Authentication → Providers → Email → "Confirm email" | `mailer_autoconfirm=false` | **Blocking** |
| 4 | **Signups enabled** | ON for the controlled staging test; may be turned OFF again after onboarding to avoid open registration | Authentication → Providers → Email (Allow new users) | `disable_signup=false` | Recommended |
| 5 | **Refresh-token rotation** | **ON** | Authentication → Sessions/Settings → Refresh token rotation | `refresh_token_rotation_enabled=true` | **Blocking** |
| 6 | **Refresh-token reuse interval** | small, e.g. `10` s (only meaningful with rotation on) | same panel | `security_refresh_token_reuse_interval=10` | Recommended |
| 7 | **Access-token (JWT) TTL** | documented, keep short — e.g. `3600` s (1 h). **This TTL is the residual window** for the token-revocation caveat (see below); shorter = smaller window | Authentication → Sessions/Settings → Access token expiry | `jwt_exp=3600` | **Blocking** (must be documented) |
| 8 | **Password minimum length** | ≥ `10` | Authentication → Providers → Email → Password settings | `password_min_length=10` | **Blocking** |
| 9 | **Password required characters** | require mixed classes (lower+upper+digit+symbol) | same panel | `password_required_characters="abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789:!@#$%^&*()"` | Recommended |
| 10 | **Leaked-password protection** | **ON** if available on the plan (HaveIBeenPwned check) | Authentication → Providers → Email → Password settings | `password_hibp_enabled=true` | Recommended (Blocking if plan supports it) |
| 11 | **Email rate limit** | sane per-hour cap (default `~30/h` is fine for a single test mailbox); do not raise for testing | Authentication → Rate Limits → Email | `rate_limit_email_sent` | Recommended |
| 12 | **Token-verification / OTP rate limit** | keep defaults; do not disable | Authentication → Rate Limits | `rate_limit_verify` / `rate_limit_token_refresh` | Recommended |
| 13 | **CAPTCHA** | optional for staging; if enabled, use a staging key and wire it into the test client | Authentication → Settings → Bot & Abuse Protection | `security_captcha_enabled` / `security_captcha_provider` | Recommended |
| 14 | **SMTP** | **decision required** — either configure a real SMTP sender (recommended for a genuine deliverability test) OR explicitly accept the built-in Supabase mailer with its low rate cap for a one-off test. Custom SMTP `from` must be a domain you control, not the owner's personal address | Authentication → Emails → SMTP Settings | `smtp_*` (`smtp_host`, `smtp_port`, `smtp_user`, `smtp_pass`, `smtp_sender_name`, `smtp_admin_email`) | **Blocking** (pick one and record the choice) |
| 15 | **Email templates** | Confirm-signup and Reset-password templates point at the staging redirect and contain the `{{ .ConfirmationURL }}` token; no production links | Authentication → Emails → Templates | `mailer_templates_*` | Recommended |

## Token-revocation reality (must be documented — see Part 2 / the report)

A Supabase **access token is a stateless JWT**. GoTrue's logout and refresh-token revocation
invalidate the **refresh** token, but an already-issued **access** token stays
signature-valid until its `exp`. Therefore:

- **Delete / ban / email-unconfirm** are caught **immediately** by the canonical server-side
  check: `/api/account/me` sends the **presented token** to GoTrue `/auth/v1/user` (anon apikey,
  not service-role) and treats GoTrue's answer as authority — GoTrue refuses a
  deleted/banned/invalid token (401/403 → 401) and returns `email_confirmed_at` for the
  confirmed check. (Revised in S2-7C1B; the earlier admin-lookup-by-`sub` method is superseded.)
- **Logout / refresh revocation** does **not** immediately invalidate an outstanding access
  token. The **maximum residual window equals the access-token TTL** (row 7). Setting
  `jwt_exp=3600` bounds it to ≤ 1 hour. Do **not** claim "immediate revocation" for the
  logout case.

## Definition of done for this part

Blocking rows 1, 2, 3, 5, 7, 8, 14 must be set to the required staging values and rows PRE/POST
captured to the two JSON files above **before** the real owner email is used.
