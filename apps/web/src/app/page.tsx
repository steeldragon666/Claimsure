import Link from 'next/link';

const claims = [
  ['CAPTURE', 'White-labelled mobile capture for photos, voice notes, documents, hypotheses, and time entries.'],
  ['STAMP', 'SHA-256 claimant chains, content hashes, prompt versions, source event citations, and review overrides.'],
  ['SEAL', 'Portal narratives, activity registers, expenditure schedules, claim PDFs, and final evidence packs.'],
];

const ledger = [
  ['LIVE', 'Hash-chained evidence ledger', 'Per-claimant event chains with verification tests and UI chain status.'],
  ['LIVE', 'AusIndustry portal fields', 'Core and Supporting activity field generation with character counters and citations.'],
  ['LIVE', 'Xero accounting ingestion', 'Invoices, receipts, contacts, accounts, bank transactions, and raw payload preservation.'],
  ['BUILDING', 'MYOB AccountRight ingestion', 'OAuth, company-file discovery, and authenticated API client scaffold now in code.'],
  ['LIVE', 'Regulatory intelligence feed', 'ATO RSS and AustLII AAT/ART polling with event classification and backfill scripts.'],
  ['NEXT', 'External timestamp anchoring', 'Independent OpenTimestamps-style anchors for public blockchain/timestamp claims.'],
  ['NEXT', 'Client-controlled GitHub mirror', 'Signed evidence manifests committed to a client-owned repository.'],
  ['NEXT', 'HSM-backed tenant keys', 'KMS/HSM isolation, break-glass controls, and customer-facing trust evidence.'],
];

const proofStats = [
  ['13/9', 'Portal schema fields in code'],
  ['SHA-256', 'Claimant chain primitive'],
  ['ATO/AAT/ART', 'Regulatory feed coverage'],
  ['XERO + MYOB', 'Accounting source direction'],
];

function Diamond({ className = '' }: { className?: string }) {
  return <span className={`inline-block rotate-45 bg-[#e1a23a] ${className}`} aria-hidden="true" />;
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 font-mono text-[11px] uppercase tracking-[0.22em] text-[#8a857c]">
      <span className="h-px w-12 bg-[#e1a23a]" />
      {children}
    </div>
  );
}

function RegistrationMarks() {
  return (
    <>
      <span className="absolute left-6 top-6 h-4 w-4 border-l border-t border-[#8a857c]/45" />
      <span className="absolute right-6 top-6 h-4 w-4 border-r border-t border-[#8a857c]/45" />
      <span className="absolute bottom-6 left-6 h-4 w-4 border-b border-l border-[#8a857c]/45" />
      <span className="absolute bottom-6 right-6 h-4 w-4 border-b border-r border-[#8a857c]/45" />
    </>
  );
}

export default function MarketingHomePage() {
  return (
    <main className="min-h-screen bg-[#0b0b0d] text-[#f0ebe2]">
      <section className="relative isolate min-h-screen overflow-hidden border-b border-[#f0ebe2]/10">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(240,235,226,0.045)_1px,transparent_1px),linear-gradient(to_bottom,rgba(240,235,226,0.045)_1px,transparent_1px)] bg-[size:64px_64px] [mask-image:radial-gradient(ellipse_90%_70%_at_50%_45%,#000_25%,transparent_92%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_50%_35%_at_50%_100%,rgba(225,162,58,0.09),transparent_70%)]" />
        <RegistrationMarks />

        <nav className="relative z-10 mx-auto flex max-w-[1440px] items-center justify-between px-6 py-5 sm:px-10 lg:px-14">
          <Link href="/" className="flex items-center gap-3">
            <Diamond className="h-3 w-3 shadow-[0_0_14px_rgba(225,162,58,0.55)]" />
            <span className="font-display text-2xl font-semibold tracking-[-0.01em]">ClaimSure</span>
          </Link>
          <div className="hidden items-center gap-8 font-body text-sm text-[#cdc7bd] md:flex">
            <Link href="#platform" className="hover:text-[#f0ebe2]">
              Platform
            </Link>
            <Link href="#ledger" className="hover:text-[#f0ebe2]">
              Claim ledger
            </Link>
            <Link href="#founders" className="hover:text-[#f0ebe2]">
              Founders
            </Link>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden rounded-full border border-[#f0ebe2]/20 bg-[#0b0b0d]/60 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.12em] text-[#cdc7bd] sm:block">
              Live - AEST - 2026.05.22
            </div>
            <Link
              href="/signup"
              className="bg-[#e1a23a] px-4 py-3 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-[#0b0b0d] transition hover:bg-[#efb657]"
            >
              Request access
            </Link>
          </div>
        </nav>

        <div className="relative z-10 mx-auto max-w-[1440px] px-6 pb-16 pt-16 sm:px-10 lg:px-14 lg:pb-24 lg:pt-24">
          <Eyebrow>Australian R&DTI evidence infrastructure</Eyebrow>

          <h1 className="mt-8 max-w-6xl font-display text-[clamp(4.5rem,11vw,10rem)] font-light leading-[0.9] tracking-[-0.035em]">
            One missing record.
            <br />
            An entire claim,{' '}
            <em className="text-[#e1a23a]">gone.</em>
          </h1>

          <div className="mt-12 grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-end">
            <p className="max-w-2xl font-body text-xl leading-9 text-[#cdc7bd]">
              ClaimSure is being built as a sovereign R&DTI evidence platform for firms that need
              contemporaneous capture, statutory assessment, portal narratives, accounting source
              data, and audit-defence packs in one chain of record.
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              {claims.map(([label, body]) => (
                <article key={label} className="border border-[#f0ebe2]/20 bg-[#131316]/90 p-5 shadow-[0_30px_80px_rgba(0,0,0,0.45)]">
                  <div className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.2em] text-[#e1a23a]">
                    <Diamond className="h-1.5 w-1.5" />
                    {label}
                  </div>
                  <p className="mt-4 font-body text-sm leading-6 text-[#cdc7bd]">{body}</p>
                </article>
              ))}
            </div>
          </div>

          <div className="mt-16 border-y border-[#f0ebe2]/10 py-4 font-mono text-[11px] uppercase tracking-[0.16em] text-[#8a857c]">
            <div className="flex flex-wrap gap-x-10 gap-y-3">
              <span className="flex items-center gap-3"><Diamond className="h-1.5 w-1.5" /> Body by Michael patterns tracked</span>
              <span className="flex items-center gap-3"><Diamond className="h-1.5 w-1.5" /> GQHC posture modelled</span>
              <span className="flex items-center gap-3"><Diamond className="h-1.5 w-1.5" /> Chain head verification</span>
              <span className="flex items-center gap-3"><Diamond className="h-1.5 w-1.5" /> Founder cohort opening</span>
            </div>
          </div>
        </div>
      </section>

      <section id="platform" className="border-b border-[#f0ebe2]/10 bg-[#101012]">
        <div className="mx-auto grid max-w-[1440px] gap-10 px-6 py-20 sm:px-10 lg:grid-cols-[0.75fr_1.25fr] lg:px-14">
          <div>
            <Eyebrow>Platform posture</Eyebrow>
            <h2 className="mt-6 font-display text-5xl font-light leading-tight tracking-[-0.025em] md:text-7xl">
              The claim file becomes the product.
            </h2>
            <p className="mt-6 max-w-xl font-body text-base leading-8 text-[#cdc7bd]">
              Every workflow is pointed at the same outcome: a year-round evidence chain that a
              consultant can inspect, challenge, export, and defend.
            </p>
          </div>
          <div className="grid gap-px border border-[#f0ebe2]/10 bg-[#f0ebe2]/10 md:grid-cols-4">
            {proofStats.map(([value, label]) => (
              <div key={label} className="bg-[#131316] p-6">
                <div className="font-mono text-2xl text-[#e1a23a]">{value}</div>
                <p className="mt-4 font-mono text-[10px] uppercase leading-5 tracking-[0.18em] text-[#8a857c]">{label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="ledger" className="border-b border-[#f0ebe2]/10">
        <div className="mx-auto max-w-[1440px] px-6 py-20 sm:px-10 lg:px-14">
          <div className="flex flex-col justify-between gap-8 md:flex-row md:items-end">
            <div>
              <Eyebrow>Claim-to-code ledger</Eyebrow>
              <h2 className="mt-6 max-w-4xl font-display text-5xl font-light leading-tight tracking-[-0.025em] md:text-7xl">
                The marketing claim is the engineering backlog.
              </h2>
            </div>
            <Link
              href="/signup"
              className="w-fit border border-[#f0ebe2]/25 px-5 py-4 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-[#f0ebe2] transition hover:border-[#e1a23a] hover:text-[#e1a23a]"
            >
              Apply for pilot access
            </Link>
          </div>

          <div className="mt-12 divide-y divide-[#f0ebe2]/10 border-y border-[#f0ebe2]/10">
            {ledger.map(([status, title, body]) => (
              <article key={title} className="grid gap-4 py-5 md:grid-cols-[140px_0.65fr_1fr] md:items-center">
                <span className={`w-fit border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] ${
                  status === 'LIVE'
                    ? 'border-[#7a9685]/60 text-[#9bb5a6]'
                    : status === 'BUILDING'
                      ? 'border-[#e1a23a]/60 text-[#e1a23a]'
                      : 'border-[#f0ebe2]/25 text-[#8a857c]'
                }`}>
                  {status}
                </span>
                <h3 className="font-display text-2xl font-light tracking-[-0.015em] text-[#f0ebe2]">{title}</h3>
                <p className="font-body text-sm leading-7 text-[#cdc7bd]">{body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="founders" className="relative overflow-hidden bg-[#131316]">
        <RegistrationMarks />
        <div className="mx-auto grid max-w-[1440px] gap-10 px-6 py-20 sm:px-10 lg:grid-cols-[1fr_0.8fr] lg:px-14">
          <div>
            <Eyebrow>Founder intake</Eyebrow>
            <h2 className="mt-6 max-w-4xl font-display text-5xl font-light leading-tight tracking-[-0.025em] md:text-7xl">
              Build the evidence chain before the review begins.
            </h2>
          </div>
          <div className="border border-[#f0ebe2]/20 bg-[#0b0b0d] p-6">
            <p className="font-body text-base leading-8 text-[#cdc7bd]">
              ClaimSure is opening a narrow pilot for firms that want product influence, integration
              coverage, and a measured path from trial workspace to production R&DTI workflow.
            </p>
            <div className="mt-8 grid gap-3">
              {['Verify firm admin', 'Provision trial tenant', 'Connect accounting source', 'Run one active claimant through the chain'].map((item, index) => (
                <div key={item} className="flex items-center gap-4 border border-[#f0ebe2]/10 bg-[#131316] p-4">
                  <span className="font-mono text-sm text-[#e1a23a]">{String(index + 1).padStart(2, '0')}</span>
                  <span className="font-body text-sm text-[#cdc7bd]">{item}</span>
                </div>
              ))}
            </div>
            <Link
              href="/signup"
              className="mt-8 inline-flex bg-[#e1a23a] px-5 py-4 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-[#0b0b0d] transition hover:bg-[#efb657]"
            >
              Start founding partner trial
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
