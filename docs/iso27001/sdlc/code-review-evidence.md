# Code Review Evidence (A.8.28)

**ISO 27001 Reference:** Annex A control A.8.28 (Secure coding)

| Field           | Value                               |
| --------------- | ----------------------------------- |
| Document Owner  | Aaron                               |
| Last Reviewed   | 2026-05-06                          |
| Next Review     | 2027-05-06                          |
| Classification  | Internal                            |
| Version         | 1.0                                 |
| Approval Status | Draft — pending management sign-off |

## 1. Purpose

Document the evidence that all code changes to the CPA Platform undergo mandatory review before deployment to production, and define the review standards that must be met.

## 2. Review Requirement

**All pull requests require at least one review before merge to `main`.**

This is enforced via GitHub branch protection rules on the `main` branch:

| Protection Rule                   | Setting |
| --------------------------------- | ------- |
| Require pull request reviews      | Enabled |
| Required number of approvals      | >= 1    |
| Dismiss stale reviews on push     | Enabled |
| Require status checks to pass     | Enabled |
| Require branches to be up to date | Enabled |
| Include administrators            | Enabled |

## 3. CI Checks Required Before Merge

The following automated checks must pass before a PR can be merged:

| Check      | Tool                        | Purpose                          |
| ---------- | --------------------------- | -------------------------------- |
| Format     | Prettier (`--check`)        | Code formatting consistency      |
| Lint       | ESLint (`--max-warnings=0`) | Code quality and error detection |
| Type check | TypeScript (`tsc --noEmit`) | Type safety verification         |
| Test       | `tsx --test` (node:test)    | Unit and integration tests       |
| Build      | Turbo (`turbo run build`)   | Build verification               |

Any failing check blocks the merge. There is no mechanism to bypass CI checks for standard PRs.

## 4. Code Review Checklist

Reviewers assess each PR against the following criteria:

### 4.1 Security

- [ ] No secrets, API keys, or credentials in code
- [ ] RLS compliance: new tables have policies; existing policies not weakened
- [ ] Input validation: all external inputs validated
- [ ] No SQL injection vectors (parameterised queries only)
- [ ] Error responses do not leak internal details

### 4.2 Performance

- [ ] No N+1 query patterns
- [ ] Appropriate database indexes for new queries
- [ ] No unbounded queries (pagination or LIMIT applied)
- [ ] No unnecessary data fetching

### 4.3 RLS Compliance

- [ ] New tenant-scoped tables include `ENABLE ROW LEVEL SECURITY`
- [ ] RLS policies use the canonical `NULLIF(current_setting('app.current_tenant_id', true), '')::uuid` pattern
- [ ] Application code uses `db` (not `privilegedSql`) for application paths
- [ ] Exempt tables (if any) are documented in `rls-coverage.md`

### 4.4 Test Coverage

- [ ] New functionality has corresponding tests
- [ ] Edge cases and error paths are tested
- [ ] Security-relevant behaviour (auth, RLS, audit) has explicit tests
- [ ] Tests follow TDD: failing test committed before implementation

### 4.5 Architecture Compliance

- [ ] Three-way parity maintained (SQL CHECK, Zod enum, AUDIT_KINDS)
- [ ] JSONB double-cast pattern used for `postgres-js` bindings
- [ ] Package boundaries respected (`@cpa/agents` and `@cpa/db` not imported by `apps/web`)
- [ ] Append-only tables not granted UPDATE/DELETE
- [ ] Forensic metadata (`first_recorded_at`, `hypothesis_formed_at`) preserved

## 5. Evidence Trail

### 5.1 GitHub PR History

The GitHub repository maintains a complete, immutable record of:

- **PR description:** What changed and why
- **Review comments:** Inline and general review feedback
- **Approval records:** Who approved and when
- **CI check results:** Pass/fail status for each automated check
- **Merge metadata:** Merge commit SHA, timestamp, and author

This history serves as the primary audit trail for code review evidence.

### 5.2 Accessing Review Evidence

Review evidence is accessible via:

- **GitHub UI:** `https://github.com/[org]/[repo]/pulls?q=is:merged`
- **GitHub CLI:** `gh pr list --state merged --limit 100`
- **GitHub API:** `GET /repos/{owner}/{repo}/pulls?state=closed`

### 5.3 Retention

GitHub retains PR history indefinitely as part of the repository. This exceeds the minimum retention requirement of 7 years for audit purposes.

## 6. Exceptions

### 6.1 Emergency Hotfixes

Emergency changes follow the expedited review process defined in `docs/iso27001/operations/change-management.md`:

- Single reviewer sufficient (risk owner preferred)
- CI checks must still pass (no bypass)
- Post-merge review within 48 hours

### 6.2 Documentation-Only Changes

Changes that only affect documentation files (`.md`, comments) may receive a lighter review but still require at least one approval and passing CI checks.

## 7. Review Metrics

Quarterly, the following metrics are reviewed to assess code review effectiveness:

| Metric                       | Target                 |
| ---------------------------- | ---------------------- |
| PRs merged without review    | 0 (enforced by GitHub) |
| Average time to first review | < 24 hours             |
| CI check failure rate        | Trending downward      |
| Security findings in review  | Tracked per quarter    |

## 8. References

- ISO/IEC 27001:2022 Annex A control A.8.28
- Secure development policy (`docs/iso27001/sdlc/secure-development-policy.md`)
- Change management policy (`docs/iso27001/operations/change-management.md`)
- GitHub branch protection documentation
