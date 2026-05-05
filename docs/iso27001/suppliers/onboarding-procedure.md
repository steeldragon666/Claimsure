# Supplier Onboarding Procedure (A.5.19)

**ISO 27001 Reference:** Annex A control A.5.19 (Information security in supplier relationships)

| Field           | Value                               |
| --------------- | ----------------------------------- |
| Document Owner  | Aaron                               |
| Last Reviewed   | 2026-05-06                          |
| Next Review     | 2027-05-06                          |
| Classification  | Internal                            |
| Version         | 1.0                                 |
| Approval Status | Draft — pending management sign-off |

## 1. Purpose

Define the due diligence and onboarding process for new third-party suppliers that will process, store, or have access to CPA Platform data.

## 2. When This Procedure Applies

This procedure must be followed before:

- Integrating a new SaaS service that receives platform data
- Engaging a new infrastructure provider
- Contracting a third party for security testing, consulting, or development
- Adding a new npm dependency that communicates with external services

## 3. Due Diligence Checklist

Before approving a new supplier, complete the following assessment:

### 3.1 Security Certification Review

- [ ] **SOC 2 Type II report:** Request and review the most recent report
- [ ] **ISO 27001 certification:** Check if the supplier holds current certification
- [ ] **Other certifications:** Note any relevant certifications (e.g., CSA STAR, FedRAMP)
- [ ] **Certification gaps:** If no independent certification, assess the supplier's published security practices

### 3.2 Data Handling Assessment

- [ ] **Data classification:** Determine the classification tier of data that will be shared (per `classification-scheme.md`)
- [ ] **Data residency:** Confirm where data will be stored and processed (prefer Australia or OECD countries)
- [ ] **Data retention:** Understand the supplier's data retention and deletion policies
- [ ] **Sub-processors:** Identify any sub-processors the supplier uses and assess their security posture
- [ ] **Encryption:** Verify encryption at rest and in transit for shared data

### 3.3 Contractual Requirements

- [ ] **Data Processing Agreement (DPA):** Execute a DPA that covers:
  - Purpose limitation (data used only for the agreed service)
  - Data minimisation (only necessary data is processed)
  - Breach notification (timely notification of security incidents)
  - Data deletion on contract termination
  - Compliance with Australian Privacy Act 1988
- [ ] **Non-Disclosure Agreement (NDA):** If the supplier will access Confidential or Restricted data
- [ ] **Service Level Agreement (SLA):** Define availability, support response times, and incident notification timelines
- [ ] **Right to audit:** Contract includes the right to audit the supplier's security practices (or reliance on SOC 2 report as audit proxy)

### 3.4 Integration Security Review

- [ ] **Authentication method:** How will the CPA Platform authenticate with the supplier? (API key, OAuth, webhook secret)
- [ ] **Data in transit:** Confirm TLS 1.2+ for all data transmission
- [ ] **API security:** Review API documentation for security best practices (rate limiting, input validation)
- [ ] **Webhook security:** If the supplier sends webhooks, verify signature validation is supported
- [ ] **Secret management:** Confirm that credentials for the supplier will be stored in the secrets manager (not source code)
- [ ] **Failure mode:** How does the platform behave if the supplier is unavailable? (graceful degradation, queue/retry, error response)

### 3.5 Risk Assessment

- [ ] **Risk rating:** Assign a risk rating per the criteria in `supplier-register.md`
- [ ] **Mitigations:** Document any mitigations for identified risks
- [ ] **Residual risk:** If residual risk is Medium or above, obtain risk owner approval

## 4. Approval Process

| Data Classification | Approver                                      |
| ------------------- | --------------------------------------------- |
| Public / Internal   | Development team lead                         |
| Confidential        | Risk owner (Aaron)                            |
| Restricted          | Risk owner (Aaron) + documented justification |

## 5. Onboarding Steps

After due diligence is complete and approval is granted:

1. **Execute contracts:** Sign DPA, NDA, and SLA as applicable
2. **Configure integration:** Set up API keys, webhooks, and other integration points
3. **Store credentials:** Add supplier credentials to the secrets manager
4. **Update supplier register:** Add the new supplier to `supplier-register.md` with all assessment details
5. **Update asset inventory:** Add any new service assets to `asset-inventory.md`
6. **Configure monitoring:** Set up alerts for the supplier integration (error rates, availability)
7. **Document in ADR:** If the supplier represents a significant architectural decision, create an ADR in `docs/decisions/`

## 6. Ongoing Monitoring

After onboarding, suppliers are monitored through:

| Activity                        | Frequency                                      |
| ------------------------------- | ---------------------------------------------- |
| Service availability monitoring | Continuous                                     |
| Error rate monitoring           | Continuous                                     |
| Security incident watch         | Continuous                                     |
| DPA/contract review             | Annually                                       |
| Certification renewal check     | Annually                                       |
| Full supplier risk review       | Semi-annually (per supplier register schedule) |

## 7. Supplier Offboarding

When a supplier relationship ends:

1. **Revoke access:** Rotate or delete all API keys, webhook secrets, and credentials
2. **Data deletion:** Request confirmation that the supplier has deleted all CPA Platform data
3. **Update register:** Mark the supplier as inactive in `supplier-register.md`
4. **Update asset inventory:** Remove associated service assets from `asset-inventory.md`
5. **Code changes:** Remove integration code and dependencies (via standard PR process)
6. **Audit log:** Document the offboarding in the audit trail

## 8. References

- ISO/IEC 27001:2022 Annex A controls A.5.19-A.5.22
- Supplier register (`docs/iso27001/suppliers/supplier-register.md`)
- Classification scheme (`docs/iso27001/asset-management/classification-scheme.md`)
- Cryptography policy (`docs/iso27001/cryptography/cryptography-policy.md`)
