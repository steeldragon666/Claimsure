'use client';

import Link from 'next/link';
import { useState } from 'react';

// ---------------------------------------------------------------------------
// VIDEO URL PLACEHOLDERS — single-line swap when the actual videos are hosted.
//
// Local default: /marketing/videos/<id>.mp4 resolves to
//   apps/web/public/marketing/videos/<id>.mp4
//
// If files grow beyond ~80 MB total, swap these to absolute URLs (Cloudflare
// R2, S3, YouTube iframe embeds, etc.) — the <video> tag is URL-agnostic.
//
// See apps/web/public/marketing/videos/README.md for the drop-point spec.
// ---------------------------------------------------------------------------

const HERO_VIDEO_URL = '/marketing/videos/index-explainer.mp4'; // TODO: upload + swap URL
const HERO_VIDEO_POSTER = '/marketing/videos/index-explainer-poster.jpg'; // TODO: upload + swap URL

type DemoAspect = '16:9' | '9:16';
type DemoVideo = {
  id: string;
  url: string;
  poster: string;
  caption: string;
  aspect: DemoAspect;
};

const DEMO_VIDEOS: readonly DemoVideo[] = [
  {
    id: 'signup',
    url: '/marketing/videos/signup-demo.mp4',
    poster: '/marketing/videos/signup-poster.jpg',
    caption: 'Signup → workspace provisioned',
    aspect: '16:9',
  },
  {
    id: 'evidence-mobile',
    url: '/marketing/videos/evidence-mobile.mp4',
    poster: '/marketing/videos/evidence-mobile-poster.jpg',
    caption: 'Evidence capture — claimant mobile app',
    aspect: '9:16',
  },
  {
    id: 'evidence-desktop',
    url: '/marketing/videos/evidence-desktop.mp4',
    poster: '/marketing/videos/evidence-desktop-poster.jpg',
    caption: 'Evidence intake — consultant workspace',
    aspect: '16:9',
  },
  {
    id: 'activity-register',
    url: '/marketing/videos/activity-register.mp4',
    poster: '/marketing/videos/activity-register-poster.jpg',
    caption: 'Activity register synthesis',
    aspect: '16:9',
  },
  {
    id: 'narrative',
    url: '/marketing/videos/narrative-drafting.mp4',
    poster: '/marketing/videos/narrative-drafting-poster.jpg',
    caption: 'Narrative drafting with citations',
    aspect: '16:9',
  },
  {
    id: 'export',
    url: '/marketing/videos/claim-pack-export.mp4',
    poster: '/marketing/videos/claim-pack-export-poster.jpg',
    caption: 'Claim pack export → ATO-ready',
    aspect: '16:9',
  },
] as const;

// ---------------------------------------------------------------------------
// Content data
// ---------------------------------------------------------------------------

const platformPillars: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: 'Evidence chain',
    body: 'Every R&D artefact lands in a forensic chain. Voice notes from the lab, Xero invoices, lab notebook PDFs, calculations, photos — each one hash-stamped at capture and forwarded into the chain ledger. AusIndustry reviewers see provenance, not interpretation.',
  },
  {
    title: 'Activity register',
    body: 'The platform clusters captured evidence into core-activity and supporting-activity proposals, mapped to Division 355 of the ITAA 1997. Consultants review and approve; the system handles the §355-25(1)(a) experimentation-vocabulary work.',
  },
  {
    title: 'Narrative drafting',
    body: 'Multi-cycle narrative generation with citation-only summaries. Prior-year content is referenced by content_hash + segment_indices — never re-paraphrased — so a five-year claim history reads as one coherent program of research.',
  },
  {
    title: 'Expenditure mapping',
    body: 'Connect Xero or upload statements. The dedicated expenditure classifier applies Division 355-25(2)(a) ordinary-business exclusions against vendor + line-item descriptions, mapping the eligible dollars into apportioned activity buckets.',
  },
  {
    title: 'Claim pack export',
    body: 'Generates the AusIndustry application + ATO R&D Schedule with full audit trail. Every claimed activity carries its evidence-chain anchor; every dollar carries its mapping rationale.',
  },
];

const workflow: ReadonlyArray<readonly [string, string, string]> = [
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

const proof: ReadonlyArray<readonly [string, string]> = [
  ['13/9', 'Core and supporting activity portal fields'],
  ['SHA-256', 'Claimant evidence chain primitive'],
  ['Xero', 'Accounting source ingestion path'],
  ['ATO / ART', 'Regulatory intelligence coverage'],
];

const pilotSteps: ReadonlyArray<string> = [
  'Submit firm details — automatic eligibility screen',
  'Workspace and 30-day trial provisioned immediately',
  'Add your first claimant and R&D project',
  'Upload evidence — the platform classifies and drafts the activity register',
];

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

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

function PlayGlyph() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 flex items-center justify-center"
    >
      <span className="flex h-16 w-16 items-center justify-center rounded-full bg-[#d8b15f] shadow-[0_8px_32px_rgba(0,0,0,0.45)] transition-transform group-hover:scale-110">
        <span className="ml-1 block h-0 w-0 border-y-[10px] border-l-[16px] border-y-transparent border-l-white" />
      </span>
    </span>
  );
}

function DemoTile({ demo }: { demo: DemoVideo }) {
  const [playing, setPlaying] = useState(false);
  const aspectClass = demo.aspect === '9:16' ? 'aspect-[9/16]' : 'aspect-video';

  return (
    <figure className="flex flex-col gap-3">
      <div
        className={`group relative overflow-hidden border border-[#f7f1e4]/14 bg-[#0d100c] ${aspectClass}`}
      >
        {playing ? (
          <video
            className="h-full w-full object-cover"
            src={demo.url}
            poster={demo.poster}
            controls
            autoPlay
            playsInline
          >
            <track kind="captions" />
          </video>
        ) : (
          <button
            type="button"
            onClick={() => setPlaying(true)}
            aria-label={`Play: ${demo.caption}`}
            className="absolute inset-0 h-full w-full"
          >
            {/* Poster image. If the file is missing the browser shows the
                background colour beneath — graceful degradation.
                Using a plain <img> rather than next/image because the
                images may not exist at build time (placeholder slots). */}
            <img
              src={demo.poster}
              alt=""
              className="h-full w-full object-cover opacity-90 transition-opacity group-hover:opacity-100"
              onError={(e) => {
                // Hide the broken image icon if the poster doesn't exist yet.
                e.currentTarget.style.visibility = 'hidden';
              }}
            />
            <span className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(216,177,95,0.10),transparent_70%)]" />
            <PlayGlyph />
          </button>
        )}
      </div>
      <figcaption className="font-mono text-xs uppercase tracking-[0.16em] text-[#8d8476]">
        {demo.caption}
      </figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

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
            <Link href="#see-it-work" className="hover:text-[#f7f1e4]">
              See it work
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
          <Link
            href="/signup"
            className="bg-[#d8b15f] px-4 py-3 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-[#10130f] transition hover:bg-[#f0c96f]"
          >
            Request access
          </Link>
        </nav>

        {/* Hero — explainer video above the H1, headline + CTA below the
            video so the meaning still lands quickly for text-led readers. */}
        <div className="relative z-10 mx-auto max-w-[1420px] px-5 pb-10 pt-12 sm:px-8 lg:px-12 lg:pt-8">
          <SectionLabel>Evidence infrastructure for Australian R&D claims</SectionLabel>

          <figure className="mt-8 overflow-hidden border border-[#f7f1e4]/14 bg-[#0d100c] shadow-[0_32px_120px_rgba(0,0,0,0.45)]">
            <div className="relative aspect-video">
              <video
                className="h-full w-full object-cover"
                src={HERO_VIDEO_URL}
                poster={HERO_VIDEO_POSTER}
                autoPlay
                muted
                loop
                playsInline
                preload="metadata"
                aria-hidden="true"
              >
                <track kind="captions" />
              </video>
              <span className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,transparent_55%,rgba(16,19,15,0.7)_100%)]" />
            </div>
          </figure>

          <div className="mt-12 grid gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:items-start">
            <section>
              <h1 className="max-w-5xl font-display text-[3.75rem] font-light leading-[0.92] tracking-tight sm:text-[5rem] lg:text-[6.5rem]">
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
                  href="#see-it-work"
                  className="border border-[#f7f1e4]/20 px-5 py-4 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-[#f7f1e4] transition hover:border-[#d8b15f] hover:text-[#d8b15f]"
                >
                  See it work
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
        </div>
      </section>

      {/* Platform — expanded copy with concrete capability descriptions. */}
      <section id="platform" className="border-b border-[#f7f1e4]/10 bg-[#f3ebdd] text-[#181a16]">
        <div className="mx-auto grid max-w-[1420px] gap-10 px-5 py-20 sm:px-8 lg:grid-cols-[0.8fr_1.2fr] lg:px-12">
          <div>
            <SectionLabel>Platform</SectionLabel>
            <h2 className="mt-6 max-w-xl font-display text-5xl font-light leading-tight tracking-tight md:text-7xl">
              Built for the work consultants already do.
            </h2>
            <p className="mt-8 max-w-md font-body text-base leading-7 text-[#5f5a50]">
              Five surfaces, one chain of record. The platform shapes raw lab activity into an
              AusIndustry-ready submission without asking consultants to change how they advise
              their clients.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {platformPillars.map(({ title, body }) => (
              <article key={title} className="border border-[#181a16]/15 bg-white p-6">
                <Mark />
                <h3 className="mt-8 font-display text-3xl font-light">{title}</h3>
                <p className="mt-4 font-body text-sm leading-7 text-[#5f5a50]">{body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* Who it's for — short positioning strip. */}
      <section className="border-b border-[#f7f1e4]/10 bg-[#10130f]">
        <div className="mx-auto max-w-[1420px] px-5 py-12 sm:px-8 lg:px-12">
          <div className="flex flex-col items-start justify-between gap-6 md:flex-row md:items-center">
            <div>
              <SectionLabel>Who it&rsquo;s for</SectionLabel>
              <p className="mt-4 max-w-3xl font-display text-2xl font-light leading-snug text-[#f7f1e4] md:text-3xl">
                ArchiveOne is built for Australian R&amp;DTI consulting firms managing 5&ndash;500
                claimants. Big-4 audit-grade documentation, sole-practitioner pricing.
              </p>
            </div>
            <Link
              href="/signup"
              className="w-fit border border-[#f7f1e4]/25 px-5 py-4 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-[#f7f1e4] transition hover:border-[#d8b15f] hover:text-[#d8b15f]"
            >
              Request access
            </Link>
          </div>
        </div>
      </section>

      {/* See it work — demo video tiles. */}
      <section id="see-it-work" className="border-b border-[#f7f1e4]/10 bg-[#10130f]">
        <div className="mx-auto max-w-[1420px] px-5 py-20 sm:px-8 lg:px-12">
          <SectionLabel>See it in motion</SectionLabel>
          <div className="mt-6 grid gap-10 lg:grid-cols-[0.85fr_1.15fr]">
            <div>
              <h2 className="font-display text-5xl font-light leading-tight tracking-tight md:text-6xl">
                Two minutes from intake to defensible claim pack.
              </h2>
            </div>
            <p className="max-w-2xl font-body text-base leading-8 text-[#cfc5b3] md:text-lg md:leading-9">
              Real workflow against the working product — consultants capturing evidence on desktop,
              claimants capturing it on mobile, the AI classifying activities, the narrative drafter
              producing AusIndustry-ready text. Click a tile to play.
            </p>
          </div>

          <div className="mt-12 grid gap-8 sm:grid-cols-2">
            {DEMO_VIDEOS.map((demo) => (
              <DemoTile key={demo.id} demo={demo} />
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

      {/* Pilot intake — customer-facing copy (carry-forward of
          fix/landing-pilot-intake-copy @ 9031367). */}
      <section id="pilot" className="bg-[#161a14]">
        <div className="mx-auto grid max-w-[1420px] gap-10 px-5 py-20 sm:px-8 lg:grid-cols-[1fr_0.85fr] lg:px-12">
          <div>
            <SectionLabel>Pilot intake</SectionLabel>
            <h2 className="mt-6 max-w-4xl font-display text-5xl font-light leading-tight tracking-tight md:text-7xl">
              Stand up your firm&rsquo;s first claim before lunch.
            </h2>
          </div>
          <div className="border border-[#f7f1e4]/16 bg-[#0d100c] p-6">
            <p className="font-body text-base leading-8 text-[#cfc5b3]">
              Self-serve workspace provisioning for qualifying R&amp;DTI consulting firms. No
              procurement cycle, no implementation week — submit your firm details and the system
              provisions the workspace, primes a fiscal-year claim, and walks you through the first
              evidence intake.
            </p>
            <div className="mt-8 grid gap-3">
              {pilotSteps.map((item, index) => (
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
