import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';

/**
 * Sign-in page. Bare layout — does NOT use AppShell (no auth context yet).
 * Uses design system tokens directly so it visually belongs to the platform
 * even at the unauthenticated entry point.
 */

// Faint ledger-grid background for the full login surface
function LedgerBackground() {
  return (
    <svg
      aria-hidden="true"
      className="fixed inset-0 w-full h-full pointer-events-none select-none z-0"
      xmlns="http://www.w3.org/2000/svg"
      style={{ opacity: 0.04 }}
    >
      <defs>
        <pattern id="login-ledger" x="0" y="0" width="1" height="32" patternUnits="userSpaceOnUse">
          <line x1="0" y1="31.5" x2="100%" y2="31.5" stroke="#5C7A6B" strokeWidth="0.75" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#login-ledger)" />
    </svg>
  );
}

export default function LoginPage() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-background text-foreground px-4 relative">
      <LedgerBackground />
      <div className="w-full max-w-md relative z-10">
        <header className="text-center mb-10">
          {/* Kicker */}
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground mb-4">
            Forensic R&amp;DTI consulting
          </p>
          {/* Display headline — Fraunces with mixed weight */}
          <h1 className="font-display text-5xl tracking-tight leading-tight">
            Claims<span className="italic font-semibold text-[hsl(var(--brand-accent))]">ure</span>
          </h1>
          <p className="mt-3 text-sm text-muted-foreground max-w-xs mx-auto leading-relaxed">
            Hash-chained evidence. ATO-defensible audit trails. Every artefact provenance-stamped.
          </p>
        </header>

        <Card className="border-border">
          <CardHeader className="pb-4">
            <h2 className="font-display text-xl text-center">Sign in to your firm</h2>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button asChild className="w-full">
              <a href="/v1/auth/microsoft/login">Continue with Microsoft</a>
            </Button>
            <Button asChild className="w-full" variant="outline">
              <a href="/v1/auth/google/login">Continue with Google</a>
            </Button>
            <Button asChild className="w-full" variant="outline">
              <a href="/v1/auth/auth0/login">Continue with Auth0</a>
            </Button>
            <p className="text-sm text-muted-foreground text-center pt-2">
              Your firm administrator must add you to a firm before you can sign in.
            </p>
            <p className="text-sm text-muted-foreground text-center">
              Starting a new firm?{' '}
              <a className="text-foreground underline underline-offset-4" href="/signup">
                Create a trial workspace
              </a>
            </p>
          </CardContent>
        </Card>

        <p className="text-center mt-6 text-xs text-muted-foreground font-mono">
          Australian R&amp;DTI &middot; TR 2021/5 compliant
        </p>
      </div>
    </main>
  );
}
