# 05 — Mobile First-Launch Sign Screen

**Depends on:** 02 (API endpoints)

## Goal

The mobile app's first-launch experience (after sign-in) checks if any of the user's engagements are in `sent` state. If so, the engagement letter sign screen renders inline, blocking other navigation until the letter is signed or declined.

## Files to add/modify

Inspect `apps/mobile/` first — determine stack (React Native? Expo? Capacitor?).

Likely:
- `apps/mobile/src/screens/EngagementSignScreen.tsx` (or equivalent)
- `apps/mobile/src/lib/hooks/use-pending-engagement.ts`
- Update root navigator to route to EngagementSignScreen when `pendingEngagement` is non-null
- `apps/mobile/src/api/engagement.ts` — API client wrapper if not present

## Implementation

1. **`usePendingEngagement` hook** — calls a new endpoint `GET /v1/me/pending-engagement` that returns the most recent engagement letter in `sent` state for any claim the signed-in user is associated with. (This endpoint may need to be added to task 02 — verify.)
2. **EngagementSignScreen** — renders the engagement letter markdown (use `react-native-markdown-display` or similar), shows:
   - Letter content (scrollable)
   - "Type your full name" text input
   - Checkbox: "I have read and agree to this engagement letter"
   - Two buttons: "Sign" (calls `POST /v1/engagement/[token]/sign`), "Decline" (opens reason modal then `POST /v1/engagement/[token]/decline`)
3. **After successful sign**: navigate to the normal home screen, invalidate the hook's query so it doesn't keep showing the sign screen.

## Design language

- Match the mobile app's existing token system if one exists (likely in `apps/mobile/src/theme/` or similar). Do NOT introduce Tailwind or web tokens.
- Letter content rendering: monospace for the legal text, generous line-height, large tap targets for the sign button.

## Acceptance

- [ ] First-launch flow: install → sign in → engagement screen appears if pending.
- [ ] Sign button is disabled until both checkbox is ticked AND typedName is non-empty.
- [ ] On successful sign, screen dismisses and home screen appears.
- [ ] On decline, claim's engagement_status flips and a "Cannot proceed" message renders.
- [ ] Pull-to-refresh on the sign screen works (in case the consultant resent the letter while the app was open).

## Deliverable

PR titled `feat(mobile): engagement letter first-launch sign screen`.

## Notes

This task explicitly depends on knowing the mobile stack. If it turns out `apps/mobile/` is empty or in a state where the scaffold doesn't support a new screen yet, the agent should STOP and report — don't try to scaffold a mobile app within this task.
