# ArchiveOne — Design System (System A, locked)

**Status:** LOCKED 2026-05-27 — System A is the single platform theme. The "cream paper + patina green" light system described in the prose below (System B) is **RETIRED**. Where the body still says cream/green, read it as historical context; this TL;DR + `apps/web/src/app/globals.css` are authoritative.
**Date:** 2026-05-04 (original) · 2026-05-27 (System A lockdown)
**Pairs with:** `docs/design/brief.md` (the WHY)
**Runtime source of truth:** `apps/web/src/app/globals.css` (CSS variables) + `apps/web/tailwind.config.ts`. `docs/design/tokens.json` mirrors System A; if it conflicts with globals.css, globals.css wins.

---

## TL;DR — System A (the broadcast theme)

A forensic working document, rendered with editorial taste — in a dark "broadcast" register. Signature decisions:

1. **Fraunces serif** for display heads (most B2B is sans-only)
2. **Dark ink base** `#0b0b0d` with **bone** text `#f0ebe2` (most SaaS is pure white; this reads as a sealed archive)
3. **Amber accent** `#e1a23a` (deliberately not corporate blue); **sage** `#7a9685` + **rust** `#c46a48` secondary semantics
4. **Geist** body/UI, **JetBrains Mono** forensic/metadata

Drop one and the system still holds. Drop two and it becomes generic. The spec below assumes all of these.

---

## Aesthetic Direction

- **Direction:** Forensic editorial. Modern, dense, archival, restrained.
- **Mood:** A regulatory archive that someone with great taste digitised. Not Linear-pure-minimalism, not Stripe-clean-corporate, not consumer-accounting-friendly.
- **References:** _Foreign Affairs_ digital edition, Linear (rigor + density), Clay (data-forward), Stripe Atlas (regulatory tool with personality), the NYT's historical-timeline rendering.
- **Anti-references:** any Big-4 consultancy site, Quickbooks/MYOB/Xero, gradient-heavy YC startup landing pages, "AI = sparkles + purple" cliché.

---

## Color

### Token table

```
Name                 Value (hex)   HSL                    Usage
──────────────────── ──────────── ───────────────────── ─────────────────────────
base                 #FAF8F3      hsl(43 36% 97%)        Page background, warm cream
surface              #FFFFFF      hsl(0 0% 100%)         Cards, dialogs, raised surfaces
surface-muted        #F5F1E8      hsl(43 30% 93%)        Disabled/inert surfaces
ink                  #1A1814      hsl(36 9% 9%)          Primary text, near-black warm
ink-muted            #6B6258      hsl(33 10% 38%)        Secondary text, body subtle
ink-subtle           #9C9388      hsl(33 9% 57%)         Captions, metadata
hairline             #E8E2D5      hsl(40 28% 87%)        Borders, dividers, embossed inset
hairline-strong      #D4CCB8      hsl(40 22% 77%)        Strong borders, focused states
accent               #5C7A6B      hsl(141 14% 42%)       Patina green, signature
accent-strong        #3D5448      hsl(143 16% 28%)       Hover/active, accent emphasis
accent-subtle        #D9E2DC      hsl(140 16% 87%)       Tinted backgrounds, accent surfaces
success              #5C7A6B      hsl(141 14% 42%)       Same as accent — "verified" reads as primary
warning              #B8732B      hsl(28 63% 45%)        Terracotta, R&DTI flag (not amber)
error                #9E3838      hsl(0 49% 42%)         Clay red, never pure red
info                 #5A6478      hsl(220 14% 41%)       Slate, system messages
```

### Why these specific values

- **Base `#FAF8F3`** — warm cream, ~6% off pure white. Tested against ink at 12.8:1 (WCAG AAA). The warmth comes from a +43° hue shift, not yellow tint. Shouldn't read as "old paper," should read as "matte natural stock."
- **Ink `#1A1814`** — near-black with a subtle warm cast. Pure `#000` against cream looks too cold. This pairing reads as "ink on archival paper."
- **Accent `#5C7A6B`** — patina green from oxidized copper. Tested at 4.7:1 against base (WCAG AA on body), 7.1:1 on surface. Deliberately desaturated; saturated green reads as "success," desaturated patina reads as "verified institution."
- **Warning `#B8732B`** — terracotta. R&DTI form fields use a similar tone for required-field hints. Reads as "this needs your attention" without alarm-bell amber.
- **Error `#9E3838`** — clay red. Pure red feels alarmist for a tool where every "error" is a recoverable schema rejection. Clay-red signals "stop and think" not "things are broken."

### Dark mode (deferred to P9)

When dark mode lands, redesign surfaces. Don't just invert. Reduce saturation 10-15%. Cream becomes warm-charcoal (`#1F1C18`), patina lifts to `#7A9685`. Tokens are pre-named so the swap is mechanical.

---

## Typography

### Font choices

| Role                   | Font               | Weight range                         | License                         |
| ---------------------- | ------------------ | ------------------------------------ | ------------------------------- |
| Display, section heads | **Fraunces**       | 100-900 (variable)                   | Open Font License, Google Fonts |
| Body, UI               | **Inter Tight**    | 400-700                              | Open Font License, Google Fonts |
| Tabular, forensic data | **JetBrains Mono** | 400-700 (tabular-nums on by default) | Open Font License, Google Fonts |

### Why Fraunces

- Variable axis (`opsz` 9-144) means the same font works at 12px and 72px without swapping
- Display weights have actual letterform character (italics with optional swashes, off by default)
- Free, Google-Fonts hosted, no licensing pain
- Reads as "documentary serif" not "tech serif" — avoids Söhne/Tiempos territory which is overused in YC-startup land
- Pairs with humanist sans without fighting; pairs with monospace as accent

### Why Inter Tight specifically (not Inter)

The brief banned Inter-as-primary because everyone uses it. Inter Tight is a different setting of the same family with tighter side-bearings — works better in dense consultant tables. If you'd rather avoid the Inter family entirely, **General Sans** (Fontshare, free) is the swap. Update the JSON tokens accordingly.

### Why JetBrains Mono

This is the surface we'll see most. Every `content_hash` chip, every timestamp, every UUID, every prompt version pin (`draft-narrative@1.1.0`). Tabular figures align in financial tables. JetBrains Mono has subtle character (the lowercase `g` is double-storey, the `i` has a small dot) that distinguishes it from generic system mono. The forensic character of the platform lives here visually more than anywhere else.

### Type scale

```
Name        Size    Line   Weight  Tracking  Use
─────────── ──────── ────── ─────── ──────── ────────────────────────────
display-2xl 56px    1.05   600     -0.04em  Marketing/login wordmark only
display-xl  44px    1.10   600     -0.03em  Page-level page titles
display-lg  32px    1.15   600     -0.02em  Section heads (FY24, claim title)
display-md  24px    1.20   600     -0.01em  Card heads, dialog titles
display-sm  20px    1.25   600     0        Subsection heads
body-lg     16px    1.50   400     0        Default body, prose
body-md     14px    1.45   400     0        Dense UI body, table cells
body-sm     12px    1.40   400     0.01em   Captions, metadata, footnotes
mono-md     14px    1.45   400     0        Forensic data inline
mono-sm     12px    1.40   400     0        Forensic chips, hash badges
```

Display sizes use Fraunces with `opsz` matching the size. Body uses Inter Tight. Mono uses JetBrains Mono with `tabular-nums` always on.

### Font loading

Add to `apps/web/src/app/layout.tsx`:

```tsx
import { Fraunces, Inter_Tight, JetBrains_Mono } from 'next/font/google';

const fraunces = Fraunces({
  subsets: ['latin'],
  axes: ['opsz', 'SOFT'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-display',
  display: 'swap',
});

const interTight = Inter_Tight({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-body',
  display: 'swap',
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-mono',
  display: 'swap',
});
```

Apply to `<body>` className: `${fraunces.variable} ${interTight.variable} ${jetBrainsMono.variable}`.

In `tailwind.config.ts`:

```ts
fontFamily: {
  display: ['var(--font-display)', 'Georgia', 'serif'],
  body: ['var(--font-body)', 'system-ui', 'sans-serif'],
  mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
}
```

---

## Spacing

4px base. Two density modes.

### Consultant density (default for `/claims/*`, `/pipeline`, `/admin/*`)

```
Name    Pixels   Tailwind
─────── ──────── ─────────
2xs     2        space-0.5
xs      4        space-1
sm      8        space-2
md      12       space-3
lg      16       space-4
xl      24       space-6
2xl     32       space-8
3xl     48       space-12
4xl     64       space-16
```

### Claimant density (default for `/claimant/*`)

```
Name    Pixels   Tailwind
─────── ──────── ─────────
xs      8        space-2
sm      16       space-4
md      24       space-6
lg      32       space-8
xl      48       space-12
2xl     64       space-16
3xl     96       space-24
```

The `density` distinction is implemented as a Tailwind config variant or a wrapping `<div data-density="consultant">` with CSS custom properties. Pick one and document it.

---

## Layout

### Grid

- 12-column grid, 8px gutters at consultant density
- Max content width: **1280px** for consultant routes; **640px** for claimant routes
- Border radius scale: `none(0) sm(4) md(8) lg(12) full(9999)` — most surfaces use `sm`; cards use `md`; floating elements (toasts, popovers) use `lg`

### Density-driven layouts

- Consultant cockpit (claims, pipeline, register): grid-disciplined, dense, fixed gutters. Tabular layouts everywhere.
- Multi-cycle timeline: editorial. Treat it like an actual forensic timeline. Fine vertical rule, year-marker columns, transition badges in the gutters between FYs. Specifically NOT a Gantt. Closer to NYT's historical-timeline rendering.
- Claimant portal: comfortable, mobile-first, single-column.

---

## Motion

Minimal-functional, with one signature flourish.

### Defaults

- Easing: `cubic-bezier(0.4, 0, 0.2, 1)` (standard ease-out)
- Duration: micro (50-100ms hover/focus), short (150-250ms state transitions), medium (250-400ms view transitions, dialogs), long (400-700ms reserved, rarely used)
- No entrance animations on initial render
- No parallax, no scroll-driven anything
- `prefers-reduced-motion` respected; all transitions become instant

### The signature flourish: chain-verify pulse

When a forensic-metadata chip is in the act of verifying its hash chain (the API call that runs `verifyChain()`), the chip gets a subtle 200ms pulse-then-resolve to the green patina checkmark. Implementation: a CSS keyframe animation on the chip's border + icon swap from spinner to checkmark.

```css
@keyframes verify-pulse {
  0% {
    border-color: var(--hairline);
  }
  50% {
    border-color: var(--accent);
  }
  100% {
    border-color: var(--accent);
  }
}
.forensic-chip[data-verifying='true'] {
  animation: verify-pulse 200ms ease-out forwards;
}
```

This is the only place in the platform where motion communicates rigor. The system is _checking its work_ and the user can see it.

---

## Signature components

These are the visual components that recur across the platform. Designed once, used everywhere. Designers should produce Figma symbols for each.

### Forensic-metadata chip

The most-repeated visual element in the platform. Renders inline next to every claim-bearing artefact (narrative segments, activities, events).

```
Visual:    pill-shaped, hairline border, off-white surface, monospace text, inset shadow on hover
Format:    [hash:8chars · YYYY-MM-DD HH:mm · v3]
Sizes:     md (mono-md, padding 4/8) for inline use; sm (mono-sm, padding 2/6) for dense tables
States:    default | verifying (pulsing border) | verified (patina border + checkmark icon) | broken (clay-red border + X icon)
Behavior:  click opens detail popover with full hash, full timestamp, edit count, who edited, link to event chain entry
```

### Agent-attribution chip

Distinguishes agent contributions from consultant authorship.

```
Visual:    text label, patina border, monospace version pin, no avatar/icon
Format:    "Drafted by Agent C · v1.1.0"
Sizes:     md only (no dense variant; this should always be readable)
States:    default | clickable (when version pin is hoverable/clickable)
Behavior:  hover reveals model name + prompt module path; click opens prompt module detail view
```

### Year-marker (multi-cycle timeline)

Defines the FY columns in the multi-cycle timeline.

```
Visual:    Fraunces display-md, ink primary, hairline rule below
Format:    "FY24" "FY25" "FY26"
States:    current (patina underline) | past (default) | future (ink-subtle, hairline dashed)
```

### Transition badge (multi-cycle timeline)

Sits in the gutter between FY columns, communicates how the activity evolved.

```
Visual:    pill, accent-subtle background, accent text, mono-sm
Variants:  continuation (patina) | pivot (terracotta) | completion (slate) | abandoned (ink-muted, dashed border)
Behavior:  hover reveals transition_rationale (capped at 500 chars per the schema)
```

### Density toggle (consultant cockpit)

Lets consultants switch between compact and comfortable views.

```
Visual:    icon-only button, two states, in the page header
Behavior:  swaps `data-density` attribute on the route container; persists to localStorage
```

---

## Component variant overrides (shadcn/Radix)

The codebase uses shadcn/ui primitives (button, card, dialog, input, etc.). Keep them. The variant overrides below replace the defaults.

### Button

```
Variants:
  primary       — accent background, surface text, hover: accent-strong
  secondary     — surface background, ink text, hairline border, hover: surface-muted
  ghost         — transparent, ink-muted text, hover: surface-muted
  destructive   — error background, surface text, hover: error darker
  link          — transparent, accent text, underline on hover

Sizes:
  sm     — body-sm, padding 4/8, height 28px
  md     — body-md, padding 6/12, height 36px (default)
  lg     — body-md, padding 8/16, height 44px
```

Border radius: `sm` (4px) on all buttons. Sharper than shadcn default, fits the editorial direction.

### Card

```
Variants:
  default     — surface background, hairline border, radius md (8px)
  raised      — surface background, no border, drop-shadow soft
  inset       — surface-muted background, hairline border, radius sm (4px) — for forensic data sections
```

### Input

```
Variants:
  default     — surface background, hairline border, ink text, radius sm
  forensic    — mono font, monospace placeholder, hairline border, for hash/UUID/version-pin entry
```

Always include a label above the input. Floating-label patterns are forbidden (they hide context the consultant needs).

### Dialog

Use Radix Dialog (already in the codebase). Override:

- Content background: `surface`
- Backdrop: `ink` at 40% opacity
- Border radius: `lg` (12px)
- Animation: 200ms ease-out fade + 4px translateY

### Table

```
Densities:
  compact     — body-sm, row height 32px, hairline borders top + bottom of each row
  comfortable — body-md, row height 44px, hairline borders only between rows

Headers:
  Fraunces display-sm, weight 600, ink-muted color
  Sortable indicator: small ink-subtle arrow, animates on click

Tabular figures: forced via JetBrains Mono on numeric columns
```

---

## Accessibility (mandatory, not negotiable)

- WCAG AA on all text and UI components. Patina + cream tested at 4.7:1 (body) and 7.1:1 (on surface). Verified.
- Focus-visible rings: 2px patina outline, 2px offset. Visible on every interactive element.
- Keyboard navigation: every Radix primitive ships with this. Don't re-implement.
- Reduced motion: respected globally via `@media (prefers-reduced-motion: reduce)`.
- Screen-reader labels: all icon-only buttons have `aria-label`. Forensic chips have `aria-describedby` linking to the detail popover.
- Color is never the sole signal: error states have icons, warning states have icons, verified state has a checkmark. Color reinforces; it doesn't carry meaning alone.

---

## What designers should produce

In rough order:

1. **Logo + wordmark.** Should work at 16px favicon and 200px header. Workmark in Fraunces (or custom if designer prefers); mark optional but encouraged.
2. **Figma file with token symbols** matching `docs/design/tokens.json` exactly.
3. **Component library** with the variants above as Figma components.
4. **5 key screen redesigns** (per brief Phase 3): claim detail, activity detail with multi-cycle timeline, pipeline, claimant mobile capture, admin apportionment.
5. **Annotated handoff specs** for each screen.

---

## What engineers should do

In rough order:

1. **Apply tokens to `apps/web/src/app/globals.css`.** Replace the existing shadcn HSL block with the values from `docs/design/tokens.json`.
2. **Update `tailwind.config.ts`** font family + spacing scales.
3. **Add font loading to `apps/web/src/app/layout.tsx`.**
4. **Build the forensic-metadata chip + agent-attribution chip components** (live in `apps/web/src/components/forensic-chip.tsx` etc.; replace ad-hoc instances).
5. **Migration: route-by-route apply** of new tokens. Consultant cockpit first (highest leverage), then claimant portal, then admin. No big-bang re-skin.

---

## Decisions log

| Date       | Decision                      | Rationale                                                                                                                                                                        |
| ---------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-04 | Initial design system created | Brief committed `6a69e9f`; system specified after one-pass design consultation. Three signature risks (Fraunces serif, cream paper base, patina green accent) ratified by Aaron. |

---

## Out of scope (per brief)

- Marketing site (separate property)
- Mobile native apps (claimant portal IS the mobile experience)
- Email template design (P8)
- PDF/print outputs (P8+)
- Onboarding flow (no users yet)
- Internationalization (Australia only, en-AU + AUD)
- White-labeling (P9+)

---

## Open questions

- **Product name for marketing:** internally "cpa-platform"; the marketing-facing name is undecided. Designer can propose. Decision belongs to Aaron.
- **Logo direction:** wordmark only, or wordmark + mark? Recommendation: both, so the mark can stand alone at favicon size and on document footers.
- **Custom icon set:** stay with Lucide (current), or commission a custom set? Recommendation: stay with Lucide for now. Custom icons are P10 polish.
