# Secure Development Policy (A.8.25-A.8.27)

**ISO 27001 Reference:** Annex A controls A.8.25 (Secure development lifecycle), A.8.26 (Application security requirements), A.8.27 (Secure system architecture and engineering principles)

| Field           | Value                               |
| --------------- | ----------------------------------- |
| Document Owner  | Aaron                               |
| Last Reviewed   | 2026-05-06                          |
| Next Review     | 2027-05-06                          |
| Classification  | Internal                            |
| Version         | 1.0                                 |
| Approval Status | Draft — pending management sign-off |

## 1. Purpose

Define the secure development practices for the CPA Platform, embedding security into every phase of the software development lifecycle.

## 2. Development Standards

### 2.1 Test-Driven Development (TDD)

TDD is the standard development practice:

1. Write a failing test that describes the expected behaviour
2. Run the test and confirm it fails
3. Implement the minimum code to pass the test
4. Run the test and confirm it passes
5. Refactor if needed; confirm tests still pass
6. Commit

This ensures that all functionality has test coverage from inception and that security-relevant behaviour (RLS enforcement, auth flows, input validation) is verified by design.

### 2.2 TypeScript Strict Mode

TypeScript is configured with strict mode enabled across the monorepo:

- `strict: true` in all `tsconfig.json` files
- No `any` types without explicit justification
- Null safety enforced by the compiler
- Strict function types prevent unsafe callbacks

### 2.3 Linting and Formatting

Pre-commit hooks (via Husky + lint-staged) enforce:

| Tool     | Configuration               | Enforcement               |
| -------- | --------------------------- | ------------------------- |
| Prettier | Default + project overrides | Pre-commit hook; CI check |
| ESLint   | `--max-warnings=0`          | Pre-commit hook; CI check |

Code that does not pass linting and formatting checks cannot be committed or merged.

### 2.4 Input Validation

All external inputs are validated using Zod schemas:

- API request bodies, query parameters, and path parameters
- Webhook payloads (DocuSign, external services)
- AI agent outputs (structured-output schemas)
- Configuration values and environment variables at startup

Validation failures return structured error responses; they never expose internal details.

## 3. Security Testing

### 3.1 RLS Coverage Tests

Automated tests in `packages/db/src/schema/rls-coverage.test.ts` verify:

- Every public-schema table has RLS enabled or is in the documented exempt list
- Every RLS-enabled table has at least one policy
- The exempt list has no phantom entries

These tests run in CI on every PR and block merge on failure.

### 3.2 Authentication Flow Tests

Tests cover:

- OAuth callback handling (success and failure paths)
- Session creation and validation
- Token refresh flows
- Unauthorised access attempts (401/403 responses)

### 3.3 Audit Chain Integrity Tests

Tests verify:

- Events are correctly recorded with content hashes
- Append-only tables reject UPDATE and DELETE operations
- The `first_recorded_at` and `hypothesis_formed_at` forensic metadata is set correctly
- The `hypothesis_formed_at` immutability trigger prevents post-INSERT modification

### 3.4 Agent Security Tests

Tests for AI agent operations verify:

- Agents operate within RLS boundaries
- Agent outputs conform to structured-output schemas
- Citation-only constraints are enforced (no free-text prior-year content)
- JSONB double-cast is used for all `postgres-js` JSONB bindings

## 4. Secrets in Source Code

### 4.1 Prevention

- **Policy:** No secrets, API keys, passwords, or tokens may be committed to source code
- **Environment variables:** All secrets are injected via environment variables at runtime
- **`.env` files:** Excluded from version control via `.gitignore`
- **gitleaks:** Pre-commit hook planned for automated secret detection in commits

### 4.2 Detection

If a secret is discovered in source code:

1. **Rotate immediately:** The compromised secret must be rotated within 1 hour
2. **Remove from history:** If the secret is in Git history, use `git filter-branch` or BFG Repo Cleaner
3. **Audit:** Review access logs for the compromised credential
4. **Report:** Document the incident in the security findings log

## 5. Dependency Management

### 5.1 Lock File Discipline

- All dependencies are pinned via `pnpm-lock.yaml`
- The lock file is committed to version control and reviewed during code review
- `pnpm install --frozen-lockfile` is used in CI to ensure deterministic builds

### 5.2 Automated Scanning

- Dependabot monitors for known vulnerabilities in npm dependencies
- Security updates generate automatic PRs
- Critical and High CVEs are remediated per the vulnerability management policy timelines

### 5.3 New Dependency Review

Before adding a new dependency:

1. Check for known vulnerabilities
2. Assess maintenance status and community trust
3. Review the licence for compatibility
4. Prefer packages with a narrow scope (avoid monolithic utility libraries)
5. Consider the transitive dependency impact

## 6. Code Review Security Checklist

Every PR review includes security considerations:

- [ ] No secrets in code or configuration files
- [ ] RLS compliance: new tables have policies; existing policies not weakened
- [ ] Input validation: all external inputs validated via Zod schemas
- [ ] SQL injection: parameterised queries only; no string concatenation
- [ ] JSONB double-cast: `${JSON.stringify(value)}::text::jsonb` pattern used
- [ ] Three-way parity: SQL CHECK, Zod enum, and `AUDIT_KINDS` const aligned
- [ ] Audit trail: auditable changes produce audit log entries
- [ ] Error handling: no internal details leaked in error responses
- [ ] Dependency review: new dependencies assessed for security and maintenance

## 7. Secure Build Pipeline

The CI/CD pipeline enforces security gates:

1. **Lint:** Prettier + ESLint catch code quality and style issues
2. **Type check:** TypeScript strict mode catches type safety issues
3. **Test:** Unit and integration tests verify security-relevant behaviour
4. **Build:** Compilation verifies no build-time errors
5. **Container scan:** Base image vulnerabilities detected before deployment

No manual intervention can bypass these gates for standard deployments.

## 8. References

- ISO/IEC 27001:2022 Annex A controls A.8.25-A.8.27
- OWASP Secure Coding Practices Quick Reference Guide
- Change management policy (`docs/iso27001/operations/change-management.md`)
- Code review evidence (`docs/iso27001/sdlc/code-review-evidence.md`)
- Vulnerability management (`docs/iso27001/operations/vulnerability-management.md`)
