'use client';
import { AuthGuard } from '@/components/auth-guard';
import { IntelligenceEventList } from './_components/intelligence-event-list';
import { IntelligenceStaleBanner } from './_components/intelligence-stale-banner';

/**
 * /intelligence — Regulatory Intelligence Feed (P7 Theme D Task D.12).
 */
export default function IntelligencePage() {
  return (
    <AuthGuard>
      <main className="container mx-auto py-8 px-4">
        <div className="mb-6">
          <h1 className="font-display text-3xl font-semibold text-foreground">
            Regulatory Intelligence
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Events from ATO, AustLII, ISA, and industry sources classified by the RIF agent. High
            and medium severity events generate prompt suggestions automatically.
          </p>
        </div>
        <IntelligenceStaleBanner />
        <IntelligenceEventList />
      </main>
    </AuthGuard>
  );
}
