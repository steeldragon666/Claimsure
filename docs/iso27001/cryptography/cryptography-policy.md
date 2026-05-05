# Cryptography Policy (A.8.24)

**ISO 27001 Reference:** Annex A control A.8.24 (Use of cryptography)

| Field           | Value                               |
| --------------- | ----------------------------------- |
| Document Owner  | Aaron                               |
| Last Reviewed   | 2026-05-06                          |
| Next Review     | 2027-05-06                          |
| Classification  | Internal                            |
| Version         | 1.0                                 |
| Approval Status | Draft — pending management sign-off |

## 1. Purpose

Define the approved cryptographic controls for the CPA Platform, covering encryption at rest, encryption in transit, key management, and algorithm selection. This policy ensures consistent, auditable protection of Confidential and Restricted data.

## 2. Encryption at Rest

### 2.1 Column-Level Encryption

Sensitive fields requiring application-level encryption use AES-256-GCM:

| Field         | Table / Location | Method      | Key                    |
| ------------- | ---------------- | ----------- | ---------------------- |
| `oauth_token` | user / IDP store | AES-256-GCM | `TOKEN_ENCRYPTION_KEY` |

Implementation notes:

- The `TOKEN_ENCRYPTION_KEY` is a 256-bit key stored in the hosting provider's secrets manager
- Encryption and decryption occur in the application layer (Node.js `crypto` module), not in PostgreSQL
- Each encrypted value includes a unique initialisation vector (IV) and authentication tag

### 2.2 Disk-Level Encryption

- **Database storage:** Provider-managed disk encryption (AES-256) for all PostgreSQL volumes
- **Backup storage:** Encrypted at rest using provider-managed keys
- **Object storage:** Server-side encryption enabled by default on all buckets

### 2.3 Content Hashing

The audit chain uses cryptographic hashing for integrity verification:

- **Algorithm:** SHA-256
- **Purpose:** `content_hash` fields on event records provide tamper-evident integrity proof
- **Note:** These are integrity hashes, not encryption. They verify that event payloads have not been modified after recording.

## 3. Encryption in Transit

### 3.1 HTTPS

All HTTP traffic uses TLS 1.2 or higher:

| Connection                    | TLS Version | Certificate Source                 |
| ----------------------------- | ----------- | ---------------------------------- |
| Client to application         | TLS 1.2+    | Let's Encrypt or provider-managed  |
| Application to PostgreSQL     | TLS 1.2+    | Provider-managed (sslmode=require) |
| Application to Anthropic API  | TLS 1.3     | Anthropic-managed                  |
| Application to Sentry         | TLS 1.2+    | Sentry-managed                     |
| Application to GitHub API     | TLS 1.2+    | GitHub-managed                     |
| Application to Resend         | TLS 1.2+    | Resend-managed                     |
| CI/CD to cloud infrastructure | TLS 1.2+    | Provider-managed                   |

### 3.2 Database Connections

- PostgreSQL connections require `sslmode=require` in the connection string
- The application rejects unencrypted database connections
- Connection strings containing credentials are stored in the secrets manager, never in source code

### 3.3 Internal Service Communication

- All inter-service communication uses HTTPS
- No plaintext HTTP endpoints are exposed, even internally

## 4. Approved Algorithms

### 4.1 Symmetric Encryption

| Algorithm | Key Length | Use Case                | Status                       |
| --------- | ---------- | ----------------------- | ---------------------------- |
| AES-256   | 256-bit    | Column encryption, disk | Approved                     |
| AES-128   | 128-bit    | —                       | Approved (AES-256 preferred) |

### 4.2 Asymmetric Encryption / Key Exchange

| Algorithm   | Key Length | Use Case          | Status   |
| ----------- | ---------- | ----------------- | -------- |
| RSA-2048    | 2048-bit   | TLS certificates  | Approved |
| RSA-4096    | 4096-bit   | TLS certificates  | Approved |
| Ed25519     | 256-bit    | SSH keys, signing | Approved |
| ECDSA P-256 | 256-bit    | TLS, code signing | Approved |

### 4.3 Hashing

| Algorithm | Output  | Use Case                      | Status   |
| --------- | ------- | ----------------------------- | -------- |
| SHA-256   | 256-bit | Content hashing, integrity    | Approved |
| SHA-384   | 384-bit | TLS cipher suites             | Approved |
| SHA-512   | 512-bit | General purpose hashing       | Approved |
| bcrypt    | N/A     | Password hashing (cost >= 12) | Approved |

### 4.4 Prohibited Algorithms

The following algorithms must not be used for any purpose:

| Algorithm | Reason                                              |
| --------- | --------------------------------------------------- |
| MD5       | Collision vulnerabilities; cryptographically broken |
| SHA-1     | Collision vulnerabilities; deprecated by NIST       |
| DES       | 56-bit key; trivially broken                        |
| 3DES      | Deprecated by NIST; performance issues              |
| RC4       | Multiple known vulnerabilities; prohibited in TLS   |
| Blowfish  | 64-bit block size; birthday attack vulnerability    |

Any use of a prohibited algorithm discovered during code review or security audit must be remediated immediately and tracked as a security finding.

## 5. Key Management

### 5.1 Key Lifecycle

| Phase        | Procedure                                                                       |
| ------------ | ------------------------------------------------------------------------------- |
| Generation   | Keys generated using cryptographically secure random number generators (CSPRNG) |
| Storage      | Stored in the hosting provider's secrets manager; never in source code          |
| Distribution | Injected via environment variables at runtime; never transmitted in plaintext   |
| Rotation     | Quarterly or immediately upon suspected compromise                              |
| Revocation   | Immediate rotation + redeployment upon compromise                               |
| Destruction  | Secure deletion from secrets manager; verify no cached copies                   |

### 5.2 Key Rotation Schedule

| Key                    | Rotation Frequency | Procedure                                                                       |
| ---------------------- | ------------------ | ------------------------------------------------------------------------------- |
| `TOKEN_ENCRYPTION_KEY` | Quarterly          | Generate new key; re-encrypt active tokens; retire old key after 30-day overlap |
| Database credentials   | Quarterly          | Rotate via provider tooling; update secrets manager; redeploy                   |
| API keys (Anthropic)   | Quarterly          | Generate new key in provider console; update secrets manager; revoke old key    |
| API keys (Sentry)      | Annually           | Rotate via Sentry dashboard                                                     |
| API keys (Resend)      | Quarterly          | Generate new key; update secrets manager                                        |
| TLS certificates       | Auto-renewed       | Let's Encrypt auto-renewal (90-day cycle) or provider-managed                   |

### 5.3 Key Access

- Only the application runtime and authorised administrators can access encryption keys
- Key access is logged by the secrets manager
- No developer has standing access to production encryption keys

## 6. Certificate Management

### 6.1 TLS Certificates

- **Source:** Let's Encrypt (ACME protocol) or hosting provider managed certificates
- **Renewal:** Automated; certificates renewed at least 30 days before expiry
- **Monitoring:** Certificate expiry monitored via Sentry or provider alerting
- **Revocation:** Certificates revoked immediately if the private key is compromised

### 6.2 Certificate Pinning

Certificate pinning is not currently implemented. The platform relies on standard certificate validation (CA chain verification) for all TLS connections. This decision may be revisited if threat modelling identifies a need for pinning specific supplier connections.

## 7. Compliance and Audit

- Cryptographic controls are reviewed during quarterly security reviews
- Any use of non-approved algorithms is treated as a security finding
- Key rotation compliance is verified during quarterly access reviews
- Penetration tests include assessment of cryptographic implementation

## 8. References

- ISO/IEC 27001:2022 Annex A control A.8.24
- NIST SP 800-57 Part 1 — Recommendation for Key Management
- ACSC ISM — Cryptographic controls
- IAM policy (`docs/iso27001/access-control/iam-policy.md`)
- Classification scheme (`docs/iso27001/asset-management/classification-scheme.md`)
