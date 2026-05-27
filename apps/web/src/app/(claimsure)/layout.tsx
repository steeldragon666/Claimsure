import type { Metadata } from 'next';
import { ClaimsureShell } from '@/components/claimsure/shell';

export const metadata: Metadata = {
  title: {
    default: 'ArchiveOne',
    template: '%s · ArchiveOne',
  },
};

export default function ClaimsureLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="dark" style={{ minHeight: '100vh', background: 'var(--cs-surface, #0a0d14)' }}>
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200"
      />
      <ClaimsureShell>{children}</ClaimsureShell>
    </div>
  );
}
