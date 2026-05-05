# Incident Communication Plan (ISO 27001 A.5.26)

**Document owner:** Aaron (Founder)
**Last reviewed:** 2026-05-06
**Version:** 1.0

## Purpose

Defines when, how, and to whom incidents are communicated.

## Communication matrix

| Audience           | Sev 1                   | Sev 2                 | Sev 3        | Sev 4        |
| ------------------ | ----------------------- | --------------------- | ------------ | ------------ |
| Incident Commander | Immediate (auto-page)   | Immediate (auto-page) | 1h (email)   | Next day     |
| Backup contact     | 30 min escalation       | 1h escalation         | Not notified | Not notified |
| Affected customers | Within 4h               | Within 8h             | Not notified | Not notified |
| All customers      | If platform-wide outage | Not notified          | Not notified | Not notified |
| Regulators         | If data breach (72h)    | If data breach (72h)  | Not notified | Not notified |

## Communication templates

### Customer notification — service outage

> Subject: CPA Platform — Service disruption [resolved/ongoing]
>
> We detected a service disruption affecting [component] at [time UTC].
> [We have identified the cause and deployed a fix. / We are actively investigating.]
>
> **Impact:** [Description of what was affected]
> **Status:** [Resolved at HH:MM UTC / Under investigation]
> **Next update:** [Time or "when resolved"]
>
> We apologize for any inconvenience. If you have questions, reply to this email.

### Customer notification — data breach

> Subject: Important security notice — CPA Platform
>
> We are writing to inform you of a security incident that may have affected your data.
>
> **What happened:** [Brief description]
> **When:** [Date/time range]
> **What data was involved:** [Specific data types]
> **What we're doing:** [Actions taken]
> **What you should do:** [Recommended actions for customer]
>
> We take the security of your data seriously and are taking all necessary steps to prevent recurrence.
> We have notified [relevant regulators] as required by law.

## Regulatory notification requirements

| Jurisdiction                 | Requirement                                                       | Timeline                                        | Authority |
| ---------------------------- | ----------------------------------------------------------------- | ----------------------------------------------- | --------- |
| Australia (Privacy Act 1988) | Notifiable Data Breaches scheme (Part IIIC)                       | 30 days (assessment) + "as soon as practicable" | OAIC      |
| ATO (R&DTI specific)         | No specific breach notification, but scheme integrity obligations | Varies                                          | ATO       |

## Document control

| Version | Date       | Author | Change                     |
| ------- | ---------- | ------ | -------------------------- |
| 1.0     | 2026-05-06 | Aaron  | Initial communication plan |
