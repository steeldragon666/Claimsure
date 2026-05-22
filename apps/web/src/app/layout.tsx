import './globals.css';
import type { Metadata, Viewport } from 'next';
import {
  Fraunces,
  Inter_Tight,
  Inter,
  Plus_Jakarta_Sans,
  JetBrains_Mono,
  Geist,
} from 'next/font/google';
import { Providers } from '@/components/providers';

/*
 * Font loading — see docs/design/system.md "Typography".
 * Variable fonts (Fraunces, Inter Tight) load full weight ranges so
 * Tailwind font-weight utilities resolve without round-tripping the
 * network. JetBrains Mono is loaded with explicit weights since the
 * variable axis isn't needed for monospace.
 */

const fraunces = Fraunces({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
});

const interTight = Inter_Tight({
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
});

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const plusJakartaSans = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['600', '700', '800'],
  variable: '--font-jakarta',
  display: 'swap',
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-mono',
  display: 'swap',
});

// Geist — used by the broadcast-themed consultant workspace at /consultant.
// Loaded via next/font/google so SSR and pre-fetch behave like the other faces.
const geist = Geist({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-geist',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'Claimsure',
    template: '%s · Claimsure',
  },
  description: 'Forensic R&D Tax Incentive consulting platform.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${interTight.variable} ${inter.variable} ${plusJakartaSans.variable} ${jetBrainsMono.variable} ${geist.variable}`}
    >
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
