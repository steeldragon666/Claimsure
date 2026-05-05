# Access Review Procedure (A.5.18)

**ISO 27001 Reference:** Annex A control A.5.18 (Access rights)

| Field           | Value                               |
| --------------- | ----------------------------------- |
| Document Owner  | Aaron                               |
| Last Reviewed   | 2026-05-06                          |
| Next Review     | 2026-08-06                          |
| Classification  | Internal                            |
| Version         | 1.0                                 |
| Approval Status | Draft — pending management sign-off |

## 1. Purpose

Define the process for periodic review of access rights to ensure they remain appropriate, that orphaned accounts are removed, and that privileged access is revalidated.

## 2. Review Schedule

| Review Type              | Frequency | Reviewer                                              |
| ------------------------ | --------- | ----------------------------------------------------- |
| Tenant user access       | Quarterly | Tenant admin (for their tenant's users)               |
| Privileged accounts      | Quarterly | Risk owner (Aaron)                                    |
| Service account/API keys | Quarterly | Risk owner (Aaron)                                    |
| Orphaned users           | Quarterly | Risk owner (Aaron)                                    |
| Full access audit        | Annually  | Risk owner (Aaron) + external auditor (if applicable) |

## 3. Quarterly Review Process

### 3.1 Preparation

1. Run the access review script (`tools/iso27001/access-review.sh`) to generate the current access report
2. Export the report output as the review baseline
3. Cross-reference with the previous quarter's review log

### 3.2 Tenant User Review

For each tenant, the tenant admin reviews:

1. **Active users:** Is each user still active in the organisation? Do they still require platform access?
2. **Role appropriateness:** Is the assigned role (admin/consultant/viewer) still correct for the user's current responsibilities?
3. **Subject tenant ACL:** Does each consultant's subject tenant access match their current client assignments?
4. **Stale accounts:** Flag any user who has not logged in during the review period

### 3.3 Privileged Access Review

The risk owner reviews:

1. **Database admin access:** Confirm that only authorised individuals have database admin credentials
2. **Infrastructure access:** Confirm cloud console access is limited to named individuals
3. **Secrets access:** Verify that secret rotation schedule has been followed
4. **Service accounts:** Confirm Agent A and Agent B system users are configured correctly
5. **CI/CD tokens:** Verify GitHub Actions OIDC configuration is current

### 3.4 Orphaned User Check

Run the orphan user query (included in `tools/iso27001/access-review.sh`):

- Users with no active `tenant_user` records should be investigated
- If the user has been offboarded from all tenants, confirm whether the `user` record should be retained or flagged for data retention review

### 3.5 MFA Compliance

Verify with each tenant's IDP administrator that MFA policies are enforced for:

- All admin role holders
- All consultant role holders
- All infrastructure access accounts

## 4. Review Log Format

Each quarterly review produces a log entry with the following fields:

| Field            | Description                                                     |
| ---------------- | --------------------------------------------------------------- |
| Review Date      | Date the review was conducted                                   |
| Reviewer         | Name of the person conducting the review                        |
| Scope            | Tenant name or "privileged accounts" or "orphaned users"        |
| Users Reviewed   | Count of user accounts reviewed                                 |
| Anomalies Found  | Description of any issues (e.g., stale account, excessive role) |
| Actions Taken    | Remediation steps (e.g., role downgraded, account removed)      |
| Next Review Date | Scheduled date for next review                                  |

### 4.1 Review Log Template

```
## Access Review — [Quarter] [Year]

**Date:** YYYY-MM-DD
**Reviewer:** [Name]
**Scope:** [Tenant name / Privileged accounts / Orphaned users]

### Users Reviewed

| User Email | Role | Last Login | Status |
| ---------- | ---- | ---------- | ------ |
| ...        | ...  | ...        | OK / Action Required |

### Anomalies Found

- [ ] [Description of anomaly]

### Actions Taken

- [ ] [Description of action and date completed]

### Sign-off

Reviewer: _________________ Date: _________
```

## 5. Access Review SQL Queries

The following queries support the review process. They are automated in `tools/iso27001/access-review.sh`.

### 5.1 Active Users per Tenant

```sql
SELECT
  t.name AS firm,
  u.email,
  tu.role,
  tu.created_at
FROM tenant_user tu
JOIN tenant t ON t.id = tu.tenant_id
JOIN "user" u ON u.id = tu.user_id
WHERE tu.deleted_at IS NULL
ORDER BY t.name, tu.role DESC, u.email;
```

### 5.2 Orphaned Users (No Active Tenant Membership)

```sql
SELECT
  u.email,
  u.created_at
FROM "user" u
LEFT JOIN tenant_user tu
  ON tu.user_id = u.id
  AND tu.deleted_at IS NULL
WHERE tu.id IS NULL;
```

### 5.3 Users with Admin Role

```sql
SELECT
  t.name AS firm,
  u.email,
  tu.created_at AS admin_since
FROM tenant_user tu
JOIN tenant t ON t.id = tu.tenant_id
JOIN "user" u ON u.id = tu.user_id
WHERE tu.role = 'admin'
  AND tu.deleted_at IS NULL
ORDER BY t.name, u.email;
```

## 6. Remediation Actions

| Finding                  | Action                                             | Timeline  |
| ------------------------ | -------------------------------------------------- | --------- |
| Stale account (no login) | Contact user; remove if no response within 14 days | 14 days   |
| Excessive role           | Downgrade role immediately                         | Same day  |
| Orphaned user            | Investigate; remove or reassign within 7 days      | 7 days    |
| MFA non-compliance       | Escalate to tenant admin; enforce within 30 days   | 30 days   |
| Unauthorised access      | Revoke immediately; initiate incident response     | Immediate |

## 7. Review History

| Quarter | Date       | Reviewer | Tenants Reviewed | Anomalies | Actions                              |
| ------- | ---------- | -------- | ---------------- | --------- | ------------------------------------ |
| Q2 2026 | 2026-05-06 | Aaron    | Baseline         | N/A       | Initial review procedure established |

## 8. References

- IAM policy (`docs/iso27001/access-control/iam-policy.md`)
- RLS coverage audit (`docs/iso27001/access-control/rls-coverage.md`)
- Access review script (`tools/iso27001/access-review.sh`)
