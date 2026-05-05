# Post-Incident Review Template

_Copy this template for each Sev 1 or Sev 2 incident. Save as `pir-YYYY-MM-DD-[brief-description].md`._

## Incident summary

| Field              | Value                |
| ------------------ | -------------------- |
| Incident ID        | INC-YYYY-NNN         |
| Date/time detected | YYYY-MM-DD HH:MM UTC |
| Date/time resolved | YYYY-MM-DD HH:MM UTC |
| Duration           | Xh Ym                |
| Severity           | Sev N                |
| Incident Commander | [Name]               |
| Customers affected | [Count or "none"]    |

## Timeline

| Time (UTC) | Event                                        |
| ---------- | -------------------------------------------- |
| HH:MM      | Alert triggered by [source]                  |
| HH:MM      | Acknowledged by [name]                       |
| HH:MM      | Initial assessment: [description]            |
| HH:MM      | Containment action: [description]            |
| HH:MM      | Root cause identified: [description]         |
| HH:MM      | Fix deployed: [commit/PR]                    |
| HH:MM      | Service restored; monitoring confirmed green |

## Root cause

[Describe the underlying cause, not just the symptoms]

## Contributing factors

- [Factor 1]
- [Factor 2]

## What went well

- [Thing 1]
- [Thing 2]

## What could be improved

- [Thing 1]
- [Thing 2]

## Action items

| Action     | Owner  | Due date   | Status |
| ---------- | ------ | ---------- | ------ |
| [Action 1] | [Name] | YYYY-MM-DD | Open   |
| [Action 2] | [Name] | YYYY-MM-DD | Open   |

## Lessons learned

[Key takeaways for future incident response]
