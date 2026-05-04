import './globals.css';
import type { Metadata, Viewport } from 'next';
import { Fraunces, Inter_Tight, JetBrains_Mono } from 'next/font/google';
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

const jetBrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'CPA Platform',
  description: 'Australian R&D Tax Incentive consultant portal',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${interTight.variable} ${jetBrainsMono.variable}`}
    >
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
