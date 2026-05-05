# Information Security Roles and Responsibilities (ISO 27001:2022 Chapter 5.3)

**Document owner:** Aaron (Founder)
**Last reviewed:** 2026-05-06
**Next review:** 2026-08-06 (quarterly)
**Version:** 1.0

## 1. Purpose

Defines the roles, responsibilities, and authorities for information security within the CPA Platform ISMS.

## 2. Organizational context

CPA Platform is currently a solo-founder operation augmented by AI agents (Claude Code). This structure will evolve; roles defined here accommodate scaling while maintaining clear accountability for the current state.

## 3. Role definitions

### 3.1 Top Management / ISMS Owner -- Aaron (Founder)

**Responsibilities:**

- Overall accountability for the ISMS and its effectiveness
- Approving the information security policy and objectives
- Allocating resources for ISMS implementation
- Conducting (or delegating) management reviews (Ch 9.3)
- Final decision authority on risk acceptance
- Primary on-call responder for all severity levels
- Primary contact for customers, regulators, and auditors

**Authority:**

- Full administrative access to all platform systems
- Authority to accept, mitigate, transfer, or avoid identified risks
- Authority to engage external specialists (fractional CISO, pen-testers)

### 3.2 Fractional CISO (engaged quarterly / for audit cycles)

**Responsibilities:**

- Independent internal audit per ISO Ch 9.2
- Review of ISMS documentation for completeness and accuracy
- Advisory on risk treatment decisions
- Pen-test scoping and vendor liaison

**Authority:**

- Read access to all ISMS documentation and evidence
- Authority to raise non-conformities in audit reports
- No authority to make unilateral changes to platform code or configuration

### 3.3 AI Agents (Claude Code, Claude Sonnet/Haiku)

**Responsibilities:**

- Performing development tasks under explicit instruction
- Following TDD and code review processes
- Flagging potential security issues during code generation
- Operating within defined guardrails (CLAUDE.md, architecture rules)

**Constraints:**

- No autonomous decision authority over security-critical changes
- No access to production secrets or live customer data
- All code changes subject to human review (PR process)
- Cannot modify ISMS documentation without human approval

### 3.4 Future roles (placeholder for scaling)

| Role                          | Trigger for creation                              | Key responsibilities                                   |
| ----------------------------- | ------------------------------------------------- | ------------------------------------------------------ |
| Security Engineer             | First security-focused hire                       | Day-to-day vulnerability management, incident response |
| Platform Engineer             | Infrastructure complexity exceeds solo management | Infrastructure security, monitoring, DR drills         |
| DPO (Data Protection Officer) | If required by jurisdiction or scale              | Privacy compliance, data subject requests              |

## 4. Segregation of duties

Current mitigations for single-person risk:

| Risk                                          | Mitigation                                                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Single point of failure (founder unavailable) | Documented runbooks; fractional CISO as backup contact; automated monitoring alerts to backup channel |
| No independent code review                    | AI-assisted code review (Claude) + automated CI checks (lint, typecheck, tests, RLS audit)            |
| Self-auditing bias                            | Fractional CISO performs independent internal audit; pen-test by external vendor                      |
| Privileged access without oversight           | Audit log is append-only (UPDATE/DELETE revoked); hash-chain verification detects tampering           |

## 5. Communication of roles

- This document is committed to the repository and accessible to all authorized personnel
- New team members (when applicable) receive a copy during onboarding
- Reviewed quarterly as part of management review cycle

## 6. Document control

| Version | Date       | Author | Change                   |
| ------- | ---------- | ------ | ------------------------ |
| 1.0     | 2026-05-06 | Aaron  | Initial roles definition |
