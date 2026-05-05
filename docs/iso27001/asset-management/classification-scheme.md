# Information Classification Scheme (A.5.9, A.5.10)

**ISO 27001 Reference:** Annex A controls A.5.9 (Inventory of information and other associated assets), A.5.10 (Acceptable use of information and other associated assets)

| Field           | Value                               |
| --------------- | ----------------------------------- |
| Document Owner  | Aaron                               |
| Last Reviewed   | 2026-05-06                          |
| Next Review     | 2027-05-06                          |
| Classification  | Internal                            |
| Version         | 1.0                                 |
| Approval Status | Draft — pending management sign-off |

## 1. Purpose

Define a consistent classification scheme for all information assets within the CPA Platform ISMS boundary. Classification drives handling rules for storage, transmission, access control, retention, and disposal.

## 2. Classification Tiers

### 2.1 Public

Information explicitly approved for external disclosure with no restrictions.

**Examples:**

- Marketing website content
- Published API documentation
- Open-source dependency attributions

### 2.2 Internal

Information intended for use within the organisation. Disclosure would cause minimal harm but is not intended.

**Examples:**

- Source code (private repositories)
- Internal process documentation
- RIF (Regulatory Intelligence Feed) events after publication
- Sprint retrospective notes
- Architecture Decision Records (ADRs)

### 2.3 Confidential

Information whose unauthorised disclosure could cause material harm to the business or its clients.

**Examples:**

- R&D narrative drafts (client IP)
- Expenditure data and financial mappings
- Client contact details and email addresses
- AI agent prompt templates and system prompts
- OAuth tokens (encrypted at rest via `TOKEN_ENCRYPTION_KEY`)

### 2.4 Restricted

The most sensitive tier. Unauthorised disclosure could cause severe harm, regulatory breach, or loss of client trust.

**Examples:**

- Customer claimant data (subject tenant PII)
- Audit chain records (forensic evidence with `first_recorded_at`, `hypothesis_formed_at`)
- Production database credentials and secrets
- Encryption keys (`TOKEN_ENCRYPTION_KEY`, database certificates)
- Penetration test reports

## 3. Handling Rules

| Rule              | Public                | Internal                              | Confidential                                                     | Restricted                                                                   |
| ----------------- | --------------------- | ------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Access**        | Unrestricted          | Authenticated team members            | Role-based; need-to-know within tenant                           | Named individuals only; MFA required                                         |
| **Encryption**    | None required         | TLS in transit                        | TLS in transit; encrypted at rest (provider-managed disk)        | TLS in transit; column-level encryption (AES-256-GCM); encrypted at rest     |
| **Storage**       | Any approved location | Private repo; approved cloud services | RLS-protected database; encrypted cloud storage                  | RLS-protected database with append-only controls; hardware-backed key stores |
| **Transmission**  | Any channel           | HTTPS/TLS 1.2+                        | HTTPS/TLS 1.2+; no email attachments without encryption          | HTTPS/TLS 1.2+; end-to-end encryption where possible                         |
| **Labeling**      | None required         | Footer or header: "Internal"          | Footer or header: "Confidential"; watermark on exports           | Footer or header: "Restricted"; watermark; access logged                     |
| **Retention**     | No minimum            | Duration of project + 1 year          | 7 years (ATO compliance)                                         | 7 years minimum (ATO compliance); append-only                                |
| **Disposal**      | Standard deletion     | Secure deletion from all storage      | Cryptographic erasure or secure multi-pass deletion              | Cryptographic erasure; disposal certificate; audit log entry                 |
| **Backup**        | Not required          | Standard backup schedule              | Encrypted backups; tested restore                                | Encrypted backups; tested restore; off-site copy                             |
| **Incident**      | No reporting required | Report to team lead within 24 hours   | Report to risk owner within 4 hours; assess regulatory reporting | Report to risk owner immediately; mandatory regulatory notification review   |
| **Printing**      | Permitted             | Permitted; shred after use            | Minimise; collect from printer immediately; shred                | Prohibited unless explicitly authorised; secure print release only           |
| **Sharing**       | Unrestricted          | Internal team only                    | Approved recipients with NDA/DPA                                 | Named recipients; documented approval; DPA mandatory                         |
| **Remote access** | Permitted             | VPN or zero-trust network             | VPN or zero-trust; endpoint protection required                  | VPN or zero-trust; endpoint protection; MFA; no public Wi-Fi                 |

## 4. Labeling Requirements

All documents and data stores must be labelled with their classification tier:

1. **Documents (Markdown, PDF, exports):** Include the classification in the document header metadata table (as shown in this document).
2. **Database tables:** Classification is recorded in the asset inventory (`asset-inventory.md`). RLS enforcement provides the access-control boundary.
3. **Source code repositories:** Classification noted in repository description and `CLAUDE.md` project guidance.
4. **Emails:** Classification in subject prefix for Confidential and Restricted content (e.g., `[CONFIDENTIAL]`).
5. **Cloud storage:** Folder-level labelling with classification tier.

## 5. Reclassification

Classification may change over time:

- **Upgrade:** When additional sensitivity is discovered (e.g., a data field is found to contain PII). Immediate reclassification and handling adjustment.
- **Downgrade:** When information is declassified (e.g., after public disclosure of a feature). Requires risk owner approval and audit log entry.

## 6. References

- ISO/IEC 27001:2022 Annex A controls A.5.9, A.5.10
- CPA Platform risk assessment methodology (`docs/iso27001/03-risk-assessment-methodology.md`)
- Asset inventory (`docs/iso27001/asset-management/asset-inventory.md`)
