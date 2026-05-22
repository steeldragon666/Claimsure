'use client';

const kpis = [
  ['ACTIVE CLAIMS', '14', 'across 11 entities', '+3 vs last FY'],
  ['EVIDENCE INDEXED', '2,847', 'artefacts this FY', '+38%'],
  ['AT-RISK', '2', 'needs your judgement', '-1 since yesterday'],
  ['CHAIN COVERAGE', '94%', 'of FY26 claims', '+11pts YoY'],
];

const claims = [
  ['VANT-7', 'Vantage Industries', 'STAGE 04 - APPORTION', 'UNDER REVIEW', '47', '$2.42M', true],
  ['BORE-2', 'Borealis Bio', 'STAGE 03 - ASSEMBLE', 'DRAFTING', '28', '$1.18M', false],
  ['LYRA-1', 'Lyra Compute', 'STAGE 02 - STAMP', 'DRAFTING', '19', '$840K', false],
  ['GQHC-1', 'GQHC Materials', 'STAGE 06 - SEAL', 'SEALED', '92', '$3.16M', false],
  ['OREN-1', 'Oren Robotics', 'STAGE 04 - APPORTION', 'FLAGGED', '22', '$610K', true],
  ['ARI-3', 'Aristocrat sub-entity', 'STAGE 06 - SEAL', 'CHAIN-LOCKED', '142', '$5.04M', false],
];

const watchSignals = [
  ['ATO', 'TAXPAYER ALERT', 'TA 2026/03', 'Software development eligibility - new evidence standard', '3 CLAIMS EXPOSED'],
  ['AUSINDUSTRY', 'GUIDANCE', 'GN 26-04', 'Updated guidance - supporting activities', '1 CLAIM EXPOSED'],
  ['AAT', 'DECISION', '[2026] AATA 412', 'Body by Michael doctrine extended', '2 CLAIMS EXPOSED'],
];

const blocks = [
  ['#00184_3F', 'WHITEBOARD', 'VANT-7', '14:01'],
  ['#00184_3E', 'VOICE NOTE', 'VANT-7', '13:48'],
  ['#00184_3D', 'CALC', 'BORE-2', '12:22'],
  ['#00184_3C', 'LAB BOOK', 'LYRA-1', '11:15'],
];

function Diamond({ className = '' }: { className?: string }) {
  return <span className={`inline-block rotate-45 bg-[#e1a23a] ${className}`} aria-hidden="true" />;
}

function Mono({ children, muted = false }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <span className={`font-mono text-[10px] uppercase tracking-[0.2em] ${muted ? 'text-[#8a857c]' : 'text-[#e1a23a]'}`}>
      {children}
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'FLAGGED'
      ? 'border-[#c46a48] bg-[#c46a48]/15 text-[#c46a48]'
      : status === 'CHAIN-LOCKED'
        ? 'border-[#7a9685] bg-[#7a9685]/15 text-[#9ab2a3]'
        : status === 'SEALED' || status === 'UNDER REVIEW'
          ? 'border-[#e1a23a] bg-[#e1a23a]/10 text-[#e1a23a]'
          : 'border-[#f0ebe2]/20 bg-[#1c1c20] text-[#cdc7bd]';

  return (
    <span className={`border px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.16em] ${tone}`}>
      {status}
    </span>
  );
}

export function DashboardClient() {
  return (
    <div className="-m-8 min-h-[calc(100vh-64px)] bg-[#0b0b0d] p-7 text-[#f0ebe2]">
      <div className="mb-7 flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
        <div>
          <Mono muted>Dashboard - FY26</Mono>
          <h1 className="mt-3 font-display text-5xl font-light leading-none tracking-[-0.025em]">
            Good morning, Anna.
          </h1>
          <p className="mt-3 text-sm text-[#8a857c]">
            Three signals overnight. Two claims need your judgement today.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="border border-[#f0ebe2]/20 px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.16em] text-[#cdc7bd] hover:border-[#e1a23a] hover:text-[#e1a23a]">
            + Import client
          </button>
          <button className="bg-[#e1a23a] px-4 py-2.5 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-[#0b0b0d]">
            + New claim
          </button>
        </div>
      </div>

      <div className="mb-6 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {kpis.map(([label, value, sub, trend]) => (
          <article key={label} className="border border-[#f0ebe2]/20 bg-[#131316] p-5">
            <Mono muted>{label}</Mono>
            <div className={`mt-4 font-display text-5xl font-light leading-none tracking-[-0.025em] ${label === 'AT-RISK' ? 'text-[#c46a48]' : label === 'CHAIN COVERAGE' ? 'text-[#e1a23a]' : 'text-[#f0ebe2]'}`}>
              {value}
            </div>
            <p className="mt-2 text-xs text-[#8a857c]">{sub}</p>
            <p className="mt-3 border-t border-[#f0ebe2]/10 pt-2 font-mono text-[9px] uppercase tracking-[0.14em] text-[#5d594f]">
              {trend}
            </p>
          </article>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
        <section className="overflow-hidden border border-[#f0ebe2]/20 bg-[#131316]">
          <div className="flex flex-col justify-between gap-3 border-b border-[#f0ebe2]/10 px-5 py-4 md:flex-row md:items-center">
            <div className="flex items-center gap-3">
              <Diamond className="h-2 w-2" />
              <h2 className="font-display text-xl font-medium">Active claims</h2>
              <Mono muted>- FY26 BOOK</Mono>
            </div>
            <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#8a857c]">
              <span className="text-[#f0ebe2]">All</span> - Drafting - Review - Sealed
            </div>
          </div>

          <div className="hidden grid-cols-[90px_1fr_190px_140px_70px_90px] border-b border-[#f0ebe2]/10 px-5 py-3 font-mono text-[10px] uppercase tracking-[0.16em] text-[#8a857c] lg:grid">
            <span>ID</span>
            <span>Client</span>
            <span>Stage</span>
            <span>Status</span>
            <span className="text-right">Evid</span>
            <span className="text-right">Value</span>
          </div>

          {claims.map(([id, client, stage, status, evidence, value, gap]) => (
            <div
              key={id as string}
              className="grid gap-3 border-b border-[#f0ebe2]/10 px-5 py-4 last:border-b-0 lg:grid-cols-[90px_1fr_190px_140px_70px_90px] lg:items-center"
            >
              <span className="font-mono text-xs tracking-[0.08em] text-[#e1a23a]">{id}</span>
              <span className="flex items-center gap-2 text-sm font-medium text-[#f0ebe2]">
                {client}
                {gap ? <span className="h-1.5 w-1.5 rounded-full bg-[#c46a48] shadow-[0_0_8px_#c46a48]" /> : null}
              </span>
              <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-[#8a857c]">{stage}</span>
              <StatusPill status={status as string} />
              <span className="font-mono text-xs text-[#cdc7bd] lg:text-right">{evidence}</span>
              <span className="font-mono text-sm tracking-[0.04em] text-[#f0ebe2] lg:text-right">{value}</span>
            </div>
          ))}
        </section>

        <aside className="space-y-4">
          <section className="border border-[#f0ebe2]/20 bg-[#131316]">
            <div className="flex items-center justify-between border-b border-[#f0ebe2]/10 px-5 py-4">
              <div className="flex items-center gap-3">
                <Diamond className="h-2 w-2" />
                <h2 className="font-display text-lg font-medium">Watch</h2>
              </div>
              <Mono muted>Today - 3 signals</Mono>
            </div>
            {watchSignals.map(([src, tag, code, title, exposure]) => (
              <article key={`${src}-${code}`} className="border-b border-[#f0ebe2]/10 px-5 py-4 last:border-b-0">
                <div className="mb-2 flex items-baseline justify-between">
                  <Mono>{src}</Mono>
                  <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-[#5d594f]">LIVE</span>
                </div>
                <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-[#5d594f]">
                  {tag} - <span className="text-[#8a857c]">{code}</span>
                </p>
                <p className="mt-2 text-sm leading-6 text-[#f0ebe2]">{title}</p>
                <div className="mt-3 inline-block border border-[#e1a23a]/70 bg-[#e1a23a]/10 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-[#e1a23a]">
                  {exposure}
                </div>
              </article>
            ))}
          </section>

          <section className="border border-[#f0ebe2]/20 bg-[#131316]">
            <div className="flex items-center justify-between border-b border-[#f0ebe2]/10 px-5 py-4">
              <div className="flex items-center gap-3">
                <Diamond className="h-2 w-2" />
                <h2 className="font-display text-lg font-medium">Recent chain blocks</h2>
              </div>
              <Mono muted>Height - 3,247</Mono>
            </div>
            {blocks.map(([id, kind, claim, time]) => (
              <div key={id} className="grid grid-cols-[110px_1fr_54px] items-center gap-3 border-b border-[#f0ebe2]/10 px-5 py-3 last:border-b-0">
                <span className="font-mono text-[11px] tracking-[0.08em] text-[#e1a23a]">{id}</span>
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#8a857c]">{kind}</p>
                  <p className="mt-1 font-mono text-[10px] tracking-[0.04em] text-[#f0ebe2]">{claim}</p>
                </div>
                <span className="text-right font-mono text-[10px] text-[#8a857c]">{time}</span>
              </div>
            ))}
          </section>
        </aside>
      </div>
    </div>
  );
}
