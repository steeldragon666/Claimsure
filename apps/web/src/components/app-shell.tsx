'use client';
/**
 * AppShell — top-tab navigation chrome for every authenticated page.
 *
 * NAVIGATION MODEL (workflow-shaped, not entity-shaped):
 *
 *   Claimants → Activities → Evidence → Claims → Financing
 *
 * Claimants is the entry. Once a claimant is picked on tab 1, tabs 2-5
 * scope to that claimant's context (handled by per-tab route logic).
 *
 * Settings (tenant switcher, admin pages) live behind the ⚙ icon in the
 * header — workflow nav stays at exactly 5 tabs.
 *
 * Pages opt in by wrapping their content:
 *
 *   export default function MyPage() {
 *     return <AppShell><PageContent /></AppShell>;
 *   }
 *
 * AppShell embeds AuthGuard. The page should not wrap itself with both.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Building2,
  Beaker,
  FileText,
  ClipboardCheck,
  Wallet,
  Settings,
  LogOut,
} from 'lucide-react';
import { AuthGuard } from '@/components/auth-guard';
import { TenantSwitcher } from '@/components/tenant-switcher';
import { Button } from '@/components/ui/button';
import { useWhoami } from '@/hooks/use-whoami';

interface WorkflowTab {
  /** First-segment path this tab owns. Used for active-state matching. */
  segment: string;
  /** Default href when clicked. */
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Tab is gated until a claimant is selected (tabs 2-5). */
  scoped?: boolean;
}

const WORKFLOW_TABS: WorkflowTab[] = [
  // Claimants tab points at the existing /subject-tenants list. The internal
  // schema name is `subject_tenant`; the user-facing term is "Claimant" /
  // "Client firm". Keeping the URL consistent with the schema means existing
  // bookmarks + the existing list page work unchanged.
  { segment: 'subject-tenants', href: '/subject-tenants', label: 'Claimants', icon: Building2 },
  { segment: 'activities', href: '/activities', label: 'Activities', icon: Beaker, scoped: true },
  { segment: 'evidence', href: '/evidence', label: 'Evidence', icon: FileText, scoped: true },
  // Claims tab points at /claims; the per-claim wizard already lives at
  // /claims/[claim_id]. PR #1 adds /claims/page.tsx as the list view.
  { segment: 'claims', href: '/claims', label: 'Claims', icon: ClipboardCheck, scoped: true },
  { segment: 'financing', href: '/financing', label: 'Financing', icon: Wallet },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <AppShellInner>{children}</AppShellInner>
    </AuthGuard>
  );
}

function AppShellInner({ children }: { children: React.ReactNode }) {
  const { data } = useWhoami();
  if (!data) return null;

  const isAdmin = data.user.role === 'admin';

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <Header
        availableTenants={data.availableTenants}
        activeTenantId={data.user.tenantId}
        userEmail={data.user.email}
        isAdmin={isAdmin}
      />
      <WorkflowTabBar />
      <main className="flex-1 px-8 py-8 max-w-7xl mx-auto w-full">{children}</main>
    </div>
  );
}

function Header({
  availableTenants,
  activeTenantId,
  userEmail,
  isAdmin,
}: {
  availableTenants: {
    tenantId: string;
    name: string;
    slug: string;
    role: 'admin' | 'consultant' | 'viewer';
    isDefault: boolean;
  }[];
  activeTenantId: string | null;
  userEmail: string;
  isAdmin: boolean;
}) {
  return (
    <header className="border-b border-border bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-30">
      <div className="flex items-center justify-between gap-4 px-6 h-14">
        <Link href="/subject-tenants" className="flex items-baseline gap-2 group">
          <span className="font-display text-xl font-semibold tracking-tight">ArchiveOne</span>
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground group-hover:text-foreground transition-colors">
            R&amp;D Tax Incentive
          </span>
        </Link>
        <div className="flex items-center gap-3">
          <TenantSwitcher tenants={availableTenants} activeTenantId={activeTenantId} />
          <div className="hidden md:flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground border-l border-border ml-1">
            <span className="font-mono text-xs">{userEmail}</span>
          </div>
          {isAdmin && <SettingsMenu />}
          <SignoutButton />
        </div>
      </div>
    </header>
  );
}

function WorkflowTabBar() {
  const pathname = usePathname();
  return (
    <nav className="border-b border-border bg-background/60 sticky top-14 z-20">
      <div className="px-6 max-w-7xl mx-auto">
        <ol className="flex items-center gap-1" data-testid="workflow-tabs">
          {WORKFLOW_TABS.map((tab) => {
            const active =
              pathname === tab.href ||
              pathname.startsWith(`/${tab.segment}/`) ||
              // Root / (Dashboard) counts as "Claimants" — the workflow home
              (tab.segment === 'subject-tenants' && pathname === '/');
            const Icon = tab.icon;
            return (
              <li key={tab.segment}>
                <Link
                  href={tab.href}
                  aria-current={active ? 'page' : undefined}
                  data-testid={`workflow-tab-${tab.segment}`}
                  className={[
                    'flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors',
                    active
                      ? 'border-primary text-primary'
                      : 'border-transparent text-foreground/70 hover:text-foreground hover:border-foreground/20',
                  ].join(' ')}
                >
                  <Icon className="h-4 w-4" />
                  <span>{tab.label}</span>
                </Link>
              </li>
            );
          })}
        </ol>
      </div>
    </nav>
  );
}

/**
 * Settings menu — admin-only access to firm-config pages (members, tenants,
 * apportionment defaults, brand, billing). Lives behind a gear icon so the
 * top-tab workflow nav stays at exactly 5 entries.
 *
 * For PR #1 this is a stub — the menu links to existing admin routes.
 * PR #5 will polish the dropdown UX.
 */
function SettingsMenu() {
  return (
    <Link
      href="/users"
      title="Settings"
      className="flex items-center justify-center h-8 w-8 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
    >
      <Settings className="h-4 w-4" />
    </Link>
  );
}

function SignoutButton() {
  const handleSignout = () => {
    void fetch('/v1/auth/signout', {
      method: 'POST',
      credentials: 'include',
    }).then(() => {
      window.location.href = '/signup';
    });
  };
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={handleSignout}
      className="text-muted-foreground hover:text-foreground"
    >
      <LogOut className="h-4 w-4 mr-1.5" />
      <span className="hidden sm:inline">Sign out</span>
    </Button>
  );
}
