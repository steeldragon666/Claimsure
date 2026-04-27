# @cpa/mobile

Expo SDK 51 + React Native 0.74 native app for **claimant employees** —
the engineers and lab techs at a consultancy's R&D-active client firms
who use the platform to capture evidence at source (voice notes,
photos, documents, hypothesis prompts, time tracking) without the
consultant having to chase them.

This is the Module 3 mobile surface — the consultant-facing
counterparts (`apps/web`) and the operator-facing API (`apps/api`)
serve different audiences. Architectural rationale lives in
[ADR-0004](../../docs/decisions/0004-claimant-identity-and-mobile.md)
(claimant identity model + magic-link auth + mobile session) and
[ADR-0005](../../docs/decisions/0005-white-label-and-hostname-routing.md)
(white-label hostname routing).

## Setup

### Quickest path: Expo Go on your phone

```sh
pnpm install
pnpm --filter @cpa/mobile run start
# Scan the QR code with the Expo Go app on iOS or Android.
```

Expo Go works for everything in P3 except the in-app DocuSign signing
browser (which requires a custom dev client) and EAS-built push
notifications. Anything else — voice capture, camera, magic-link deep
linking, offline queue — runs unchanged on Expo Go.

### Simulator path

```sh
# iOS simulator (macOS only)
pnpm --filter @cpa/mobile run ios

# Android emulator
pnpm --filter @cpa/mobile run android
```

### EAS CLI (for native builds + TestFlight / Play Internal)

```sh
npm install -g eas-cli
eas login    # first time only; uses your Expo account
```

## Environment variables

The mobile app reads env vars at build time via `EXPO_PUBLIC_*`
prefixing (Expo's convention — only `EXPO_PUBLIC_*` vars are available
to JS at runtime).

| Variable                         | Required | Default                   | Notes                                                                                                              |
| -------------------------------- | -------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `EXPO_PUBLIC_API_URL`            | yes      | `https://platform.com.au` | Base URL for the platform API. Set to `http://localhost:3000` (or your LAN IP for a real device) for local dev.    |
| `EXPO_PUBLIC_DEFAULT_BRAND_HOST` | no       | `platform.com.au`         | The hostname the magic-link redeem flow falls back to when the deep link doesn't carry a firm-specific brand host. |

For local development against a Fastify API on your machine:

```sh
# .env.local in apps/mobile/
EXPO_PUBLIC_API_URL=http://192.168.1.42:3000
```

The `192.168.1.42` is your machine's LAN IP; `localhost` does not
resolve from the simulator/device. `expo start` shows the LAN URL in
its launch banner.

## EAS builds

The internal-distribution profile in `eas.json` ships unsigned dev
builds suitable for TestFlight (iOS) and Google Play Internal Testing
(Android). Public App Store / Play Store distribution is **out of P3
scope** — see the architecture doc, deferred to P4.

```sh
# iOS (TestFlight). Requires Apple Developer account on Expo's side.
eas build --profile internal --platform ios

# Android (Play Internal Testing).
eas build --profile internal --platform android

# Both at once
eas build --profile internal --platform all
```

Build minutes are billed by EAS; expect ~12-15 minutes per platform.
Each build is uploaded to EAS, then submitted via `eas submit` (or the
EAS dashboard) to the relevant store's internal track.

**Apple TestFlight gating** — even internal distribution requires
basic App Store review (~24-48h on average). Plan binary submissions
ahead of demos. Android Play Internal has no review delay.

## Architecture

### Navigation — Expo Router

File-system based routing in `app/`. The two top-level groups are:

```
app/(unauthed)/
  login.tsx                  Magic-link landing + redeem
app/(authed)/
  _layout.tsx                AuthGuard (redirects to /login if no session)
                             + brand theme provider
  index.tsx                  Daily prompt (capture CTA + recent events)
  capture/voice.tsx          Voice recording + Deepgram transcription
  capture/photo.tsx          Camera + EXIF capture
  capture/document.tsx       Document picker
  hypothesis.tsx             Pre-experiment hypothesis prompt
  time.tsx                   Time tracking entries
  signing/[id].tsx           In-app DocuSign browser
  status.tsx                 Claim status (mirrors PWA)
  settings.tsx               Profile, push toggle, sign out
```

**Route groups in parentheses** (`(authed)`, `(unauthed)`) are
non-URL-affecting layout boundaries — the URL `/index` resolves to
`app/(authed)/index.tsx`, not `/authed/index`. The auth gate at
`(authed)/_layout.tsx` is a server-component-style middleware: it
runs on every navigation into the group and redirects unauthenticated
sessions to `/login`.

### State management — three concerns, three tools

- **Server state** (data fetched from the platform API):
  **TanStack Query**. One `useEvents()`, `useTimeEntries()`, etc. hook
  per resource; React Query handles caching, refetch, and the
  `isLoading` / `error` / `data` discriminated union.
- **Local UI state** (current screen, form drafts, transient
  toggles): **React component state** (`useState`, `useReducer`).
- **Cross-screen client state** (current session, active claimant,
  brand config, push-token registration): **zustand**. Stored in
  one `useSession()` store with selectors so screens only re-render
  on the slice they consume.

### Auth & session

The magic-link flow (per ADR-0004 §3.1):

```
[Consultant invites Jane in admin portal]
   ↓ /v1/employees/:id/invite generates 256-bit token, hashes it,
   ↓ sends email with link: cpa-scribe://auth/redeem?t=<raw-token>
[Jane taps link on phone]
   ↓ iOS / Android deep-link handler opens the Expo app at /auth/redeem
   ↓ POST /v1/auth/magic-link/redeem { token, device_fingerprint }
   ↓ on success: { access_token, refresh_token, employee_profile, brand_config }
[Mobile stores refresh_token in expo-secure-store; access_token in memory]
```

Refresh handling (ADR-0004 §3.2): `access_token` lifetime is 1h. On
401 from the API, the API client transparently calls
`POST /v1/auth/refresh { refresh_token, device_fingerprint }`,
swaps in the new token pair, and retries the original request. If
refresh itself returns 401, the user is bounced to `/login`.

The deep-link scheme is `cpa-scribe://` (registered in `app.json`).
Universal links (https-domain-verified deep links) on a per-firm
hostname are a P3.5 follow-up — the v1 mobile build accepts the
`cpa-scribe://` scheme and any `https://*.platform.com.au/m/auth?t=`
URL the email might generate.

### Offline queue (`expo-sqlite`)

All capture writes hit a local SQLite table (`mobile_event_queue`)
first, then a background sync worker drains them when the network is
available.

```ts
type MobileQueueRow = {
  local_id: string; // uuid generated client-side, used as API idempotency key
  kind: 'event' | 'media_artefact' | 'time_entry' | 'signing_response';
  payload: string; // JSON
  created_at: number;
  status: 'queued' | 'syncing' | 'synced' | 'failed';
  remote_id?: string;
  retry_count: number;
  last_error?: string;
};
```

Worker behaviour:

- **Online detection** via `expo-network`. Status flips fire a drain
  attempt.
- **iOS background fetch** via `expo-task-manager` runs the worker
  even when the app is backgrounded (within OS-imposed budget).
- **Idempotency**: each sync call passes `local_id` as the API's
  idempotency key — a duplicate sync (e.g. crash mid-write) returns
  the original `remote_id` instead of double-writing.
- **Retry policy**: exponential backoff up to 5 attempts. After 5,
  the row stays in `failed` and surfaces in the UI with a
  manual-retry button. The sync worker never silently drops rows.
- **Server-authoritative chain**: mobile NEVER computes `prev_hash`.
  The server appends events in `received_at` order at sync time
  (per architecture §7 risk #3). Mobile knows local ordering only.

### Branding

`brand_config` is fetched at session bootstrap (returned with the
magic-link redeem response) and refreshed on every app launch. The
theme provider in `(authed)/_layout.tsx` applies:

- `primary_color` and `accent_color` to the design-system tokens.
- `display_name` to the app's nav header.
- `logo_s3_key` (downloaded + cached in `expo-file-system`) to the
  in-app logo slots.

`useTheme()` is the screen-level hook that exposes the resolved
theme:

```ts
const theme = useTheme();
return <View style={{ backgroundColor: theme.primary }} />;
```

App icon + splash screen are baked at EAS build time and **not**
themed per-tenant in v1 — the platform ships a single neutral icon
and the white-label happens in-app once the user is authenticated.
Per-tenant icons are a P3.5 follow-up (would require per-tenant EAS
builds, which multiplies build cost by tenant count).

### Adding a new screen

1. Create `app/(authed)/<screen-name>.tsx`. Route auto-registers via
   Expo Router's file-system convention.
2. AuthGuard at `app/(authed)/_layout.tsx` runs automatically — no
   per-screen auth check.
3. For server data, add a `use<Resource>()` TanStack Query hook in
   `src/api-client/hooks/`. Reuse the typed fetch helpers in
   `src/api-client/` so auth-token attachment + refresh-on-401
   plumbing is automatic.
4. For navigation links from other screens, use Expo Router's
   `<Link href="/<screen-name>" />` or `router.push(...)` from
   `useRouter()`.

## Testing

```sh
pnpm --filter @cpa/mobile typecheck    # TypeScript only
pnpm --filter @cpa/mobile lint         # ESLint
```

**Detox e2e is a placeholder until D9-D10.** The project will run
Detox against an iOS simulator and Android emulator covering: voice
capture flow, vault upload flow, hypothesis flow, offline queue sync,
and magic-link redemption. The harness shape lives at
`e2e/` and the runner config at `.detoxrc.js` (both placeholder until
the Detox task lands).

For unit-style tests of pure helpers (form validation, date
formatting, queue state machine), use Node's native test runner via
`tsx --test` matching the repo-wide convention in ADR-0001.

## Reference layout

```
apps/mobile/
├── app.json                       Expo project config (scheme, icon, splash, plugins)
├── eas.json                       EAS build profiles (internal, production)
├── babel.config.js                Babel + Reanimated plugin
├── metro.config.js                Metro bundler — workspace symlink resolution
├── tsconfig.json                  TS config (extends repo root)
├── package.json
├── app/                           Expo Router routes
│   ├── (unauthed)/
│   │   └── login.tsx
│   └── (authed)/
│       ├── _layout.tsx            AuthGuard + theme provider
│       ├── index.tsx              Daily prompt
│       ├── capture/
│       ├── hypothesis.tsx
│       ├── time.tsx
│       ├── signing/[id].tsx
│       ├── status.tsx
│       └── settings.tsx
├── src/
│   ├── api-client/                Typed fetch helpers + React Query hooks
│   ├── auth/                      Magic-link redeem + refresh state machine
│   ├── branding/                  Theme provider + logo cache
│   ├── components/
│   ├── db/                        SQLite schema + migrations + queue ops
│   ├── hooks/
│   ├── sync/                      Offline queue worker
│   └── store/                     zustand stores (session, brand)
└── e2e/                           Detox harness (placeholder until D9-D10)
```
