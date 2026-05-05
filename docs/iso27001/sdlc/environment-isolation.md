# Environment Isolation Policy (A.8.31)

**ISO 27001 Reference:** Annex A control A.8.31 (Separation of development, test and production environments)

| Field           | Value                               |
| --------------- | ----------------------------------- |
| Document Owner  | Aaron                               |
| Last Reviewed   | 2026-05-06                          |
| Next Review     | 2027-05-06                          |
| Classification  | Internal                            |
| Version         | 1.0                                 |
| Approval Status | Draft — pending management sign-off |

## 1. Purpose

Define the separation between development, staging, and production environments to prevent accidental data exposure, ensure that testing does not affect production, and maintain the integrity of production data.

## 2. Environment Definitions

| Environment | Purpose                                        | Access                                           |
| ----------- | ---------------------------------------------- | ------------------------------------------------ |
| Development | Local developer machines; feature development  | Individual developers                            |
| Staging     | Pre-production validation; integration testing | Development team                                 |
| Production  | Live system serving real customers             | CI/CD pipeline (deploy); restricted human access |

## 3. Isolation Requirements

### 3.1 Network Isolation

| Requirement                                         | Status           |
| --------------------------------------------------- | ---------------- |
| Production database not accessible from dev/staging | Enforced         |
| Staging database not accessible from dev machines   | Enforced         |
| Production API endpoints separated from staging     | Enforced         |
| Network-level segmentation between environments     | Provider-managed |

### 3.2 Data Isolation

| Requirement                                       | Status   |
| ------------------------------------------------- | -------- |
| Dev/staging never connect to production database  | Enforced |
| No production data copied to dev/staging          | Policy   |
| Test data is synthetic (seeded via test fixtures) | Enforced |
| PII never present in dev/staging environments     | Policy   |

### 3.3 Credential Isolation

| Requirement                                  | Status   |
| -------------------------------------------- | -------- |
| Production secrets distinct from dev/staging | Enforced |
| API keys are environment-specific            | Enforced |
| Database credentials differ per environment  | Enforced |
| Secrets manager separates environments       | Enforced |

## 4. Environment Configuration

### 4.1 Development Environment

- **Database:** Local PostgreSQL (Docker, port 5433 via `pnpm db:up`)
- **Secrets:** `.env` file (not committed to version control)
- **Data:** Synthetic test data from test fixtures and seed scripts
- **AI services:** Development API keys with lower rate limits
- **Monitoring:** No Sentry integration; console logging only

### 4.2 Staging Environment

- **Database:** Dedicated staging PostgreSQL instance (provider-managed)
- **Secrets:** Staging-specific secrets in provider secrets manager
- **Data:** Synthetic test data; seeded during deployment
- **AI services:** Staging API keys
- **Monitoring:** Staging Sentry project (separate from production)

### 4.3 Production Environment

- **Database:** Production PostgreSQL instance (provider-managed, encrypted, backed up)
- **Secrets:** Production secrets in provider secrets manager (restricted access)
- **Data:** Real customer data (Restricted classification)
- **AI services:** Production API keys with production rate limits
- **Monitoring:** Production Sentry project + PagerDuty alerting

## 5. Environment Promotion

Changes flow through environments in a strict order:

```
Development → Staging → Production
```

### 5.1 Promotion Process

| Stage                 | Trigger                    | Validation                               |
| --------------------- | -------------------------- | ---------------------------------------- |
| Dev to Staging        | PR merge to `main`         | CI checks pass (lint, type, test, build) |
| Staging to Production | Automated after CI success | Build artefact matches staging build     |

### 5.2 Promotion Rules

1. **No environment skipping:** Code cannot go directly from development to production
2. **Same artefact:** The build artefact deployed to production is identical to the one validated in staging
3. **No manual configuration:** Environment-specific configuration is injected via environment variables, not baked into the artefact
4. **Rollback path:** Every promotion can be reversed by deploying the previous artefact

## 6. Test Data Management

### 6.1 Synthetic Data Only

All test data in development and staging environments is synthetic:

- Generated by test fixtures in the codebase
- Contains no real customer names, emails, or financial data
- Tenant names, user emails, and data values are clearly fictional
- The `onboard-tenant.ts` script creates realistic but synthetic tenant structures

### 6.2 No Production Data in Lower Environments

Production data must never be copied to development or staging environments:

- Database snapshots of production are not used for testing
- If production-like data is needed, it is generated synthetically
- Any exception requires explicit risk owner approval and data anonymisation

## 7. Access Control per Environment

| Action                | Development | Staging     | Production       |
| --------------------- | ----------- | ----------- | ---------------- |
| Deploy                | Developer   | CI pipeline | CI pipeline only |
| Database access       | Developer   | Dev team    | DBA (risk owner) |
| Log access            | Developer   | Dev team    | Ops (risk owner) |
| Configuration changes | Developer   | Dev team    | Risk owner + PR  |
| Secret rotation       | Developer   | Dev team    | Risk owner only  |

## 8. Verification

Environment isolation is verified through:

1. **Connection string auditing:** Production connection strings are not present in dev/staging configurations
2. **Secret separation:** Provider secrets manager enforces environment-scoped access
3. **Network policy review:** Provider network configuration prevents cross-environment database access
4. **Quarterly access review:** Confirms production access is limited to authorised personnel

## 9. References

- ISO/IEC 27001:2022 Annex A control A.8.31
- Change management policy (`docs/iso27001/operations/change-management.md`)
- IAM policy (`docs/iso27001/access-control/iam-policy.md`)
- Classification scheme (`docs/iso27001/asset-management/classification-scheme.md`)
