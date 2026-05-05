# Change Management Policy (A.8.9)

**ISO 27001 Reference:** Annex A control A.8.9 (Configuration management)

| Field           | Value                               |
| --------------- | ----------------------------------- |
| Document Owner  | Aaron                               |
| Last Reviewed   | 2026-05-06                          |
| Next Review     | 2027-05-06                          |
| Classification  | Internal                            |
| Version         | 1.0                                 |
| Approval Status | Draft — pending management sign-off |

## 1. Purpose

Define the change management process for the CPA Platform, ensuring that all changes to production systems are controlled, reviewed, tested, and auditable.

## 2. Principles

1. **All changes via version control.** Every change to application code, configuration, infrastructure-as-code, and database schema is committed to Git.
2. **Pull request review mandatory.** No change merges to `main` without at least one code review.
3. **CI validation gates.** Automated checks (lint, typecheck, test, build) must pass before merge.
4. **Production deploys via CI only.** No manual deploys to production. All deployments are triggered through the CI/CD pipeline.
5. **Major changes require ADR.** Significant architectural decisions are documented in `docs/decisions/` as Architecture Decision Records.

## 3. Change Categories

### 3.1 Standard Changes

Routine changes that follow the established PR workflow:

- Bug fixes
- Feature additions
- Dependency updates (Dependabot PRs)
- Documentation updates
- Non-breaking configuration changes

**Process:**

1. Create feature branch from `main`
2. Implement change with tests
3. Open PR with description of change and test plan
4. Pass CI checks (lint, typecheck, test, build)
5. Obtain code review approval
6. Merge to `main`
7. CI deploys to production automatically

### 3.2 Major Changes

Changes with significant architectural impact:

- New database tables or schema changes
- New third-party service integrations
- Changes to authentication or authorisation model
- New data flows involving Confidential or Restricted data
- Changes to the audit chain or append-only tables

**Additional requirements:**

1. Architecture Decision Record (ADR) in `docs/decisions/`
2. Risk assessment update if the change introduces new threats
3. Security review during code review (explicit checklist item)
4. Staged rollout where feasible

### 3.3 Emergency Changes (Hotfixes)

Changes required to resolve production incidents or critical security vulnerabilities:

**Process:**

1. Create `hotfix/` branch from `main`
2. Implement minimal fix with tests
3. Open PR with `[HOTFIX]` prefix in title
4. Expedited review: single reviewer sufficient (risk owner if available)
5. CI checks must still pass (no bypassing automated gates)
6. Merge and deploy
7. Post-incident: full retrospective and follow-up PR for comprehensive fix if needed

**Constraints:**

- Hotfixes must be the minimum viable fix; no feature additions
- Emergency changes are documented in the incident log
- A follow-up review within 48 hours confirms the fix is complete

### 3.4 Database Migrations

Database schema changes follow a stricter process due to their irreversible nature:

1. Hand-authored SQL migration file in `packages/db/migrations/`
2. Migration file includes detailed commentary explaining the change (established convention)
3. RLS policy inclusion verified for any new tenant-scoped table
4. Three-way parity check: SQL CHECK constraints, Zod enum, `AUDIT_KINDS` const
5. Tested in development and staging before production
6. Rollback plan documented in the PR description

## 4. Code Review Checklist

Every PR review must consider:

- [ ] **Security:** No secrets in code; RLS compliance; input validation
- [ ] **Performance:** No N+1 queries; appropriate indexing; no unbounded queries
- [ ] **RLS compliance:** New tables have RLS enabled; existing policies not weakened
- [ ] **Test coverage:** New functionality has tests; edge cases covered
- [ ] **Audit trail:** Changes to auditable entities produce audit log entries
- [ ] **Three-way parity:** If new event kinds added, SQL/Zod/const all updated
- [ ] **JSONB double-cast:** Any new `postgres-js` JSONB bindings use `::text::jsonb`

## 5. Rollback Procedure

### 5.1 Application Rollback

1. Identify the problematic commit via monitoring (Sentry alerts, health checks)
2. Create a revert PR: `git revert <commit-hash>`
3. Fast-track review and merge
4. CI redeploys the reverted version
5. Investigate root cause
6. Fix and re-deploy via standard process

### 5.2 Database Rollback

Database migrations are forward-only by convention. Rollback of a migration requires:

1. A new forward migration that undoes the changes
2. Standard PR review process
3. Data impact assessment before execution
4. Backup verification before applying

### 5.3 Infrastructure Rollback

Infrastructure changes managed via provider console or IaC:

1. Revert the infrastructure configuration change
2. Verify application health after rollback
3. Document the rollback in the incident log

## 6. Deployment Pipeline

```
Feature Branch → PR → Code Review → CI Checks → Merge to main → CI Build → Deploy to Production
```

CI checks include:

- `prettier --check` (formatting)
- `eslint --max-warnings=0` (linting)
- `tsc --noEmit` (type checking)
- `tsx --test` (unit and integration tests)
- `turbo run build` (build verification)

## 7. Change Log

All changes are traceable through:

- **Git history:** Complete commit log with author, date, and message
- **PR history:** GitHub PR descriptions, review comments, and approval records
- **ADR history:** Architecture decisions documented with context and rationale
- **Migration history:** Database changes with inline commentary

## 8. References

- ISO/IEC 27001:2022 Annex A control A.8.9
- Secure development policy (`docs/iso27001/sdlc/secure-development-policy.md`)
- Code review evidence (`docs/iso27001/sdlc/code-review-evidence.md`)
- Architecture Decision Records (`docs/decisions/`)
