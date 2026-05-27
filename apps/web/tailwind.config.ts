import type { Config } from 'tailwindcss';

/**
 * CPA Platform Tailwind config.
 * Source of truth: docs/design/system.md + docs/design/tokens.json
 *
 * Color tokens are split into two layers:
 *   - shadcn semantic (primary, secondary, muted, accent, destructive, ...)
 *     — these populate existing component classes; mapped to brand values via CSS vars
 *   - brand-* — direct access to the design system's named colors
 *     (e.g. brand-warning, brand-info, brand-accent-strong) for components that
 *     need semantic precision beyond what shadcn surface tokens express.
 */
const config: Config = {
  darkMode: ['class'],
  content: ['./src/**/*.{ts,tsx,js,jsx,mdx}'],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: { '2xl': '1400px' },
    },
    extend: {
      fontFamily: {
        // Wired to next/font CSS variables in apps/web/src/app/layout.tsx
        display: ['var(--font-display)', 'Georgia', 'serif'],
        body: ['var(--font-body)', 'system-ui', 'sans-serif'],
        sans: ['var(--font-body)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
        // ArchiveOne dark-UI fonts
        inter: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        jakarta: ['var(--font-jakarta)', 'system-ui', 'sans-serif'],
      },
      colors: {
        // shadcn semantic tokens — populated from CSS variables in globals.css
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        // CPA Platform brand tokens — direct access for components needing
        // semantic precision (forensic chips, transition badges, status pills).
        brand: {
          base: 'hsl(var(--brand-base))',
          ink: 'hsl(var(--brand-ink))',
          'ink-muted': 'hsl(var(--brand-ink-muted))',
          'ink-subtle': 'hsl(var(--brand-ink-subtle))',
          hairline: 'hsl(var(--brand-hairline))',
          'hairline-strong': 'hsl(var(--brand-hairline-strong))',
          accent: 'hsl(var(--brand-accent))',
          'accent-strong': 'hsl(var(--brand-accent-strong))',
          'accent-subtle': 'hsl(var(--brand-accent-subtle))',
          warning: 'hsl(var(--brand-warning))',
          error: 'hsl(var(--brand-error))',
          info: 'hsl(var(--brand-info))',
        },
      },
      borderRadius: {
        // Design system spec: sm(4) buttons/inputs, md(8) cards, lg(12) dialogs/popovers
        none: '0',
        sm: '0.25rem', // 4px
        DEFAULT: '0.25rem', // 4px (rounded-DEFAULT == rounded-sm; matches buttons)
        md: '0.5rem', // 8px (cards)
        lg: '0.75rem', // 12px (dialogs, popovers, toasts)
        xl: '1rem', // 16px (rare; reserved for hero-style surfaces)
        full: '9999px', // pills, forensic chips
      },
      boxShadow: {
        soft: '0 1px 2px rgba(26, 24, 20, 0.04), 0 1px 1px rgba(26, 24, 20, 0.02)',
        medium: '0 4px 8px rgba(26, 24, 20, 0.06), 0 2px 4px rgba(26, 24, 20, 0.04)',
        high: '0 12px 24px rgba(26, 24, 20, 0.08), 0 4px 8px rgba(26, 24, 20, 0.06)',
        embossed: 'inset 0 1px 0 rgba(255, 255, 255, 0.4), inset 0 -1px 0 rgba(26, 24, 20, 0.04)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        // Forensic-metadata chip: chain-verify pulse (the platform's signature flourish)
        'verify-pulse': {
          '0%': { borderColor: 'hsl(var(--brand-hairline))' },
          '50%': { borderColor: 'hsl(var(--brand-accent))' },
          '100%': { borderColor: 'hsl(var(--brand-accent))' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'verify-pulse': 'verify-pulse 200ms ease-out forwards',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
