# Identity and Access Management Policy (A.5.15-A.5.18, A.8.2-A.8.3)

**ISO 27001 Reference:** Annex A controls A.5.15 (Access control), A.5.16 (Identity management), A.5.17 (Authentication information), A.5.18 (Access rights), A.8.2 (Privileged access rights), A.8.3 (Information access restriction)

| Field           | Value                               |
| --------------- | ----------------------------------- |
| Document Owner  | Aaron                               |
| Last Reviewed   | 2026-05-06                          |
| Next Review     | 2027-05-06                          |
| Classification  | Internal                            |
| Version         | 1.0                                 |
| Approval Status | Draft — pending management sign-off |

## 1. Purpose

Define the access control policy for the CPA Platform, ensuring that access to information and systems is granted on a least-privilege, need-to-know basis, and that identities are managed throughout their lifecycle.

## 2. Principles

1. **Least privilege:** Users receive the minimum access required for their role. No standing access to production data beyond what the role demands.
2. **Need-to-know:** Access to Confidential and Restricted data requires a documented business justification.
3. **Separation of duties:** No single individual can both deploy code and approve their own changes.
4. **Defence in depth:** Multiple layers of access control (application roles, database RLS, network controls) operate independently.

## 3. Authentication Methods

### 3.1 Primary Identity Provider (IDP)

All platform users authenticate via federated OAuth:

- **Microsoft OAuth** — primary IDP for enterprise tenants
- **Google OAuth** — alternative IDP

The `primary_idp` field on the `user` record tracks which provider authenticated the user. The `external_id` field (unique per IDP) binds the platform identity to the provider identity.

### 3.2 Multi-Factor Authentication (MFA)

| Role                  | MFA Requirement          |
| --------------------- | ------------------------ |
| Admin (any tenant)    | Mandatory (IDP-enforced) |
| Consultant            | Mandatory (IDP-enforced) |
| Viewer                | Recommended              |
| Infrastructure access | Mandatory (cloud IAM)    |
| Database admin        | Mandatory                |

MFA is enforced at the IDP level. The CPA Platform does not implement its own MFA; it relies on the federated provider's MFA policies. Tenants whose IDP does not enforce MFA will be flagged during quarterly access reviews.

### 3.3 Service Accounts

- **Agent A / Agent B:** System users (migrations 0032, 0033) for AI agent operations. These accounts authenticate via internal service tokens, not OAuth. They operate within RLS boundaries using the same GUC-based tenant isolation as human users.
- **CI/CD:** GitHub Actions authenticates via short-lived OIDC tokens to cloud infrastructure. No long-lived service account keys.

## 4. Authorisation Model

### 4.1 Application Roles

Access within the platform is governed by the `tenant_user` junction table. Each user-tenant relationship carries a role:

| Role         | Permissions                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------- |
| `admin`      | Full tenant management: user invitation/removal, settings, all data read/write              |
| `consultant` | Read/write access to claims, narratives, expenditures, events within their assigned tenants |
| `viewer`     | Read-only access to claims, narratives, and reports within assigned tenants                 |

### 4.2 Subject Tenant ACL

For multi-tenant consulting firms, the `subject_tenant_user` ACL controls which subject tenants (client companies) a consultant can access:

- A consultant must have an explicit `subject_tenant_user` record to access a client's data
- The `admin` role at the firm level does not automatically grant access to all subject tenants
- ACL entries are managed by the tenant admin

### 4.3 Database-Level Access Control

| Database Role | Purpose                             | Grants                                                                       |
| ------------- | ----------------------------------- | ---------------------------------------------------------------------------- |
| `cpa_app`     | Application runtime                 | SELECT, INSERT on all tables; UPDATE on most; DELETE revoked on audit tables |
| `cpa_admin`   | Migration runner and DBA operations | Full DDL; used only during migrations                                        |
| Superuser     | Cloud provider managed              | Emergency break-glass only                                                   |

Row-Level Security (RLS) is enforced on all tenant-scoped tables via the `app.current_tenant_id` GUC. See `docs/iso27001/access-control/rls-coverage.md` for the full coverage audit.

## 5. User Lifecycle

### 5.1 Registration (Onboarding)

1. Tenant admin invites user via the platform UI (email-based invitation)
2. User authenticates via IDP (Microsoft/Google OAuth)
3. Platform creates `user` record (if new) and `tenant_user` record with assigned role
4. Admin verifies the user's role is appropriate
5. Audit log entry: `TENANT_USER_CREATED`

### 5.2 Role Changes

1. Tenant admin modifies user role via platform UI
2. Previous role and new role recorded in audit log
3. Audit log entry: `TENANT_USER_ROLE_CHANGED`
4. Role change takes effect on next request (no cached session role)

### 5.3 De-registration (Offboarding)

1. Tenant admin removes user via platform UI (soft delete: `deleted_at` set on `tenant_user`)
2. User's active sessions are invalidated
3. Audit log entry: `TENANT_USER_REMOVED`
4. User record in `user` table is retained (may belong to other tenants)
5. Orphaned users (no active `tenant_user` records) are identified during quarterly access reviews

### 5.4 Emergency Access Revocation

In the event of a suspected compromise:

1. Tenant admin immediately soft-deletes the `tenant_user` record
2. If IDP-level compromise is suspected, disable the account at the IDP
3. Notify the risk owner (Aaron) within 1 hour
4. Conduct access review of affected tenant within 24 hours

## 6. Privileged Access Management

### 6.1 Database Administration

- Direct database access requires explicit authorisation from the risk owner
- All database admin sessions must use MFA-protected credentials
- No standing access: database admin credentials are rotated after each use or on a 90-day schedule
- All DDL changes go through version-controlled migrations (reviewed via PR)

### 6.2 Infrastructure Access

- Cloud console access restricted to named individuals (currently: Aaron)
- Infrastructure changes managed via Infrastructure-as-Code where possible
- Emergency break-glass credentials stored in a secrets manager with access logging

### 6.3 Secrets Management

- Application secrets (`TOKEN_ENCRYPTION_KEY`, database credentials, API keys) stored in the hosting provider's secrets manager
- No secrets in source code (gitleaks pre-commit hook planned; see `docs/iso27001/sdlc/secure-development-policy.md`)
- Secret rotation: quarterly or immediately upon suspected compromise

## 7. Access Review

Quarterly access reviews are conducted per `docs/iso27001/access-control/access-review-procedure.md`. The review verifies:

- All active users have a current business justification for their access level
- Orphaned users are identified and removed
- Privileged access grants are revalidated
- MFA compliance is confirmed at the IDP level

## 8. References

- ISO/IEC 27001:2022 Annex A controls A.5.15-A.5.18, A.8.2-A.8.3
- RLS coverage audit (`docs/iso27001/access-control/rls-coverage.md`)
- Access review procedure (`docs/iso27001/access-control/access-review-procedure.md`)
- Architecture Decision Record 0002 (`docs/decisions/0002-identity-and-tenancy.md`)
