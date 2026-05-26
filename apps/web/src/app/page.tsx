import Link from 'next/link';

const pillars = [
  ['Capture', 'Mobile intake for evidence, voice notes, documents, hypotheses, and time entries.'],
  ['Verify', 'Hash-chained records, content hashes, source citations, and reviewer overrides.'],
  [
    'Assemble',
    'Portal narratives, activity registers, expenditure schedules, and review-ready packs.',
  ],
];

const workflow = [
  [
    '01',
    'Evidence intake',
    'Collect records as work happens, then preserve the source, timestamp, and context.',
  ],
  [
    '02',
    'Claim shaping',
    'Map records into activities, technical uncertainty, experiments, and expenditure support.',
  ],
  [
    '03',
    'Review pack',
    'Export narrative drafts, evidence indexes, schedules, and consultant review trails.',
  ],
];

const proof = [
  ['13/9', 'Core and supporting activity portal fields'],
  ['SHA-256', 'Claimant evidence chain primitive'],
  ['Xero', 'Accounting source ingestion path'],
  ['ATO / ART', 'Regulatory intelligence coverage'],
];

function Mark({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-block h-3 w-3 rotate-45 border border-[#d8b15f] bg-[#d8b15f]/20 ${className}`}
      aria-hidden="true"
    />
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8d8476]">
      <span className="h-px w-10 bg-[#d8b15f]" />
      {children}
    </div>
  );
}

export default function MarketingHomePage() {
  return (
    <main className="min-h-screen bg-[#10130f] text-[#f7f1e4]">
      <section className="relative isolate overflow-hidden border-b border-[#f7f1e4]/10">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(247,241,228,0.055)_1px,transparent_1px),linear-gradient(to_bottom,rgba(247,241,228,0.055)_1px,transparent_1px)] bg-[size:72px_72px] [mask-image:linear-gradient(to_bottom,#000_10%,transparent_92%)]" />
        <div className="absolute inset-x-0 top-0 h-[38rem] bg-[radial-gradient(ellipse_70%_50%_at_50%_0%,rgba(216,177,95,0.18),transparent_68%)]" />

        <nav className="relative z-10 mx-auto flex max-w-[1420px] items-center justify-between px-5 py-5 sm:px-8 lg:px-12">
          <Link href="/" className="flex items-center gap-3">
            <Mark className="shadow-[0_0_22px_rgba(216,177,95,0.55)]" />
            <span className="font-display text-2xl font-semibold tracking-tight">ArchiveOne</span>
          </Link>
          <div className="hidden items-center gap-8 font-body text-sm text-[#cfc5b3] md:flex">
            <Link href="#platform" className="hover:text-[#f7f1e4]">
              Platform
            </Link>
            <Link href="#workflow" className="hover:text-[#f7f1e4]">
              Workflow
            </Link>
            <Link href="/blog" className="hover:text-[#f7f1e4]">
              Blog
            </Link>
            <Link href="#pilot" className="hover:text-[#f7f1e4]">
              Pilot
            </Link>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/login"
              className="hidden border border-[#f7f1e4]/16 px-4 py-3 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-[#cfc5b3] hover:border-[#f7f1e4]/35 hover:text-[#f7f1e4] sm:inline-flex"
            >
              Sign in
            </Link>
            <Link
              href="/signup"
              className="bg-[#d8b15f] px-4 py-3 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-[#10130f] transition hover:bg-[#f0c96f]"
            >
              Request access
            </Link>
          </div>
        </nav>

        <div className="relative z-10 mx-auto grid min-h-[calc(100vh-86px)] max-w-[1420px] gap-12 px-5 pb-10 pt-16 sm:px-8 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:px-12 lg:pt-8">
          <section>
            <SectionLabel>Evidence infrastructure for Australian R&D claims</SectionLabel>
            <h1 className="mt-8 max-w-5xl font-display text-[4.25rem] font-light leading-[0.9] tracking-tight sm:text-[6rem] lg:text-[7.5rem]">
              Make every claim traceable before review day.
            </h1>
            <p className="mt-8 max-w-2xl font-body text-lg leading-8 text-[#cfc5b3] sm:text-xl sm:leading-9">
              ArchiveOne gives R&DTI consultants a single chain of record for evidence capture,
              technical narratives, accounting source data, and defensible claim packs.
            </p>
            <div className="mt-10 flex flex-wrap gap-3">
              <Link
                href="/signup"
                className="bg-[#d8b15f] px-5 py-4 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-[#10130f] transition hover:bg-[#f0c96f]"
              >
                Start pilot intake
              </Link>
              <Link
                href="/consultant"
                className="border border-[#f7f1e4]/20 px-5 py-4 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-[#f7f1e4] transition hover:border-[#d8b15f] hover:text-[#d8b15f]"
              >
                View app workspace
              </Link>
            </div>
          </section>

          <section className="relative border border-[#f7f1e4]/14 bg-[#161a14]/90 p-5 shadow-[0_32px_120px_rgba(0,0,0,0.45)]">
            <div className="border border-[#f7f1e4]/12 bg-[#0d100c] p-5">
              <div className="flex items-center justify-between border-b border-[#f7f1e4]/10 pb-4">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#8d8476]">
                    Active claim chain
                  </p>
                  <h2 className="mt-2 font-display text-3xl font-light">FY25 evidence vault</h2>
                </div>
                <span className="border border-[#6fa484]/45 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[#9bc9aa]">
                  Verified
                </span>
              </div>

              <div className="mt-5 grid gap-3">
                {workflow.map(([step, title, body]) => (
                  <article
                    key={step}
                    className="grid grid-cols-[58px_1fr] gap-4 border border-[#f7f1e4]/10 bg-[#161a14] p-4"
                  >
                    <span className="font-mono text-xl text-[#d8b15f]">{step}</span>
                    <div>
                      <h3 className="font-body text-sm font-semibold uppercase tracking-[0.12em] text-[#f7f1e4]">
                        {title}
                      </h3>
                      <p className="mt-2 font-body text-sm leading-6 text-[#bcb2a0]">{body}</p>
                    </div>
                  </article>
                ))}
              </div>

              <div className="mt-5 grid grid-cols-2 gap-px border border-[#f7f1e4]/10 bg-[#f7f1e4]/10">
                {proof.map(([value, label]) => (
                  <div key={label} className="bg-[#0d100c] p-4">
                    <div className="font-mono text-xl text-[#d8b15f]">{value}</div>
                    <p className="mt-2 font-body text-xs leading-5 text-[#8d8476]">{label}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>
      </section>

      <section id="platform" className="border-b border-[#f7f1e4]/10 bg-[#f3ebdd] text-[#181a16]">
        <div className="mx-auto grid max-w-[1420px] gap-10 px-5 py-20 sm:px-8 lg:grid-cols-[0.8fr_1.2fr] lg:px-12">
          <div>
            <SectionLabel>Platform</SectionLabel>
            <h2 className="mt-6 max-w-xl font-display text-5xl font-light leading-tight tracking-tight md:text-7xl">
              Built for the work consultants already do.
            </h2>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {pillars.map(([title, body]) => (
              <article key={title} className="border border-[#181a16]/15 bg-white p-6">
                <Mark />
                <h3 className="mt-8 font-display text-3xl font-light">{title}</h3>
                <p className="mt-4 font-body text-sm leading-7 text-[#5f5a50]">{body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="workflow" className="border-b border-[#f7f1e4]/10">
        <div className="mx-auto max-w-[1420px] px-5 py-20 sm:px-8 lg:px-12">
          <div className="flex flex-col justify-between gap-8 md:flex-row md:items-end">
            <div>
              <SectionLabel>Workflow</SectionLabel>
              <h2 className="mt-6 max-w-4xl font-display text-5xl font-light leading-tight tracking-tight md:text-7xl">
                From first record to final claim pack.
              </h2>
            </div>
            <Link
              href="/signup"
              className="w-fit border border-[#f7f1e4]/25 px-5 py-4 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-[#f7f1e4] transition hover:border-[#d8b15f] hover:text-[#d8b15f]"
            >
              Apply for access
            </Link>
          </div>

          <div className="mt-12 divide-y divide-[#f7f1e4]/10 border-y border-[#f7f1e4]/10">
            {workflow.map(([step, title, body]) => (
              <article
                key={step}
                className="grid gap-4 py-6 md:grid-cols-[110px_0.65fr_1fr] md:items-center"
              >
                <span className="font-mono text-2xl text-[#d8b15f]">{step}</span>
                <h3 className="font-display text-3xl font-light text-[#f7f1e4]">{title}</h3>
                <p className="font-body text-sm leading-7 text-[#cfc5b3]">{body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="border-b border-[#f7f1e4]/10 bg-[#f3ebdd] text-[#181a16]">
        <div className="mx-auto grid max-w-[1420px] gap-10 px-5 py-20 sm:px-8 lg:grid-cols-[0.8fr_1.2fr] lg:px-12">
          <div>
            <SectionLabel>Field notes</SectionLabel>
            <h2 className="mt-6 max-w-xl font-display text-5xl font-light leading-tight tracking-tight md:text-7xl">
              Evidence, workflow, and review readiness.
            </h2>
            <Link
              href="/blog"
              className="mt-8 inline-flex border border-[#181a16]/20 px-5 py-4 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-[#181a16] transition hover:border-[#d8b15f] hover:text-[#8a6728]"
            >
              Read the blog
            </Link>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {[
              {
                title: 'What contemporaneous documentation looks like in 2026',
                body: 'A practical guide for evidence that can be inspected, traced, and understood.',
                href: '/blog/contemporaneous-documentation-2026',
              },
              {
                title: 'Hypothesis articulation for software R&D',
                body: 'A working frame for uncertainty, experiment, and technical learning.',
                href: '/blog/hypothesis-articulation-software-rd',
              },
            ].map(({ title, body, href }) => (
              <Link key={title} href={href} className="border border-[#181a16]/15 bg-white p-6">
                <Mark />
                <h3 className="mt-8 font-display text-3xl font-light">{title}</h3>
                <p className="mt-4 font-body text-sm leading-7 text-[#5f5a50]">{body}</p>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section id="pilot" className="bg-[#161a14]">
        <div className="mx-auto grid max-w-[1420px] gap-10 px-5 py-20 sm:px-8 lg:grid-cols-[1fr_0.85fr] lg:px-12">
          <div>
            <SectionLabel>Pilot intake</SectionLabel>
            <h2 className="mt-6 max-w-4xl font-display text-5xl font-light leading-tight tracking-tight md:text-7xl">
              Put archiveone.com.au in front of the working product.
            </h2>
          </div>
          <div className="border border-[#f7f1e4]/16 bg-[#0d100c] p-6">
            <p className="font-body text-base leading-8 text-[#cfc5b3]">
              The marketing site leads qualified firms into signup, and the same deployment serves
              the consultant workspace, API, and database behind a managed TLS edge.
            </p>
            <div className="mt-8 grid gap-3">
              {[
                'Point DNS to the Binary Lane VPS',
                'Run the production Compose stack',
                'Apply database migrations',
                'Smoke test signup and app access',
              ].map((item, index) => (
                <div
                  key={item}
                  className="flex items-center gap-4 border border-[#f7f1e4]/10 bg-[#161a14] p-4"
                >
                  <span className="font-mono text-sm text-[#d8b15f]">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span className="font-body text-sm text-[#cfc5b3]">{item}</span>
                </div>
              ))}
            </div>
            <Link
              href="/signup"
              className="mt-8 inline-flex bg-[#d8b15f] px-5 py-4 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-[#10130f] transition hover:bg-[#f0c96f]"
            >
              Request founder workspace
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
