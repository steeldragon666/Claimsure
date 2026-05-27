'use client';

import {
  amber,
  bone,
  bone2,
  bone3,
  bone4,
  fMono,
  fSans,
  fSerif,
  ink,
  rule,
  ruleStrong,
} from '../consultant/_components/tokens';
import { Diamond, MonoLabel } from '../consultant/_components/atoms';

/* ------------------------------------------------------------------ */
/*  Shared layout primitives                                          */
/* ------------------------------------------------------------------ */

function Section({
  id,
  label,
  title,
  children,
}: {
  id: string;
  label: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} style={{ marginBottom: 48 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginBottom: 6,
        }}
      >
        <Diamond size={6} />
        <MonoLabel size={10} color={bone3} tracking="0.22em">
          {label}
        </MonoLabel>
      </div>
      <h2
        style={{
          fontFamily: fSerif,
          fontWeight: 400,
          fontSize: 28,
          lineHeight: 1.2,
          letterSpacing: '-0.01em',
          color: bone,
          margin: '0 0 18px',
        }}
      >
        {title}
      </h2>
      <div
        style={{
          fontFamily: fSans,
          fontSize: 14.5,
          lineHeight: 1.7,
          color: bone2,
        }}
      >
        {children}
      </div>
    </section>
  );
}

function SubHead({ children }: { children: React.ReactNode }) {
  return (
    <h3
      style={{
        fontFamily: fSerif,
        fontWeight: 500,
        fontSize: 18,
        color: bone,
        margin: '28px 0 10px',
        letterSpacing: '-0.005em',
      }}
    >
      {children}
    </h3>
  );
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: fMono,
        fontSize: 12,
        color: amber,
        background: 'rgba(225,162,58,0.08)',
        padding: '2px 6px',
        borderRadius: 2,
        letterSpacing: '0.04em',
      }}
    >
      {children}
    </span>
  );
}

function Divider() {
  return <hr style={{ border: 'none', borderTop: `1px solid ${rule}`, margin: '40px 0' }} />;
}

function FaqItem({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div
        style={{
          fontFamily: fSans,
          fontSize: 15,
          fontWeight: 600,
          color: bone,
          marginBottom: 6,
        }}
      >
        {q}
      </div>
      <div
        style={{
          fontFamily: fSans,
          fontSize: 14,
          lineHeight: 1.7,
          color: bone2,
          paddingLeft: 16,
          borderLeft: `2px solid ${ruleStrong}`,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Table of contents                                                 */
/* ------------------------------------------------------------------ */

const TOC = [
  { id: 'getting-started', label: 'Getting started' },
  { id: 'core-concepts', label: 'Core concepts' },
  { id: 'workflows', label: 'Workflows' },
  { id: 'faq', label: 'Frequently asked questions' },
  { id: 'support', label: 'Where to get more help' },
] as const;

/* ------------------------------------------------------------------ */
/*  Page                                                              */
/* ------------------------------------------------------------------ */

export default function HelpPage() {
  return (
    <div
      style={{
        width: '100vw',
        minHeight: '100vh',
        background: ink,
        color: bone,
        fontFamily: fSans,
      }}
    >
      {/* Top bar */}
      <header
        style={{
          height: 56,
          display: 'flex',
          alignItems: 'center',
          borderBottom: `1px solid ${rule}`,
          background: ink,
          padding: '0 28px',
          gap: 14,
        }}
      >
        <Diamond size={10} style={{ boxShadow: '0 0 12px rgba(225,162,58,0.5)' }} />
        <span
          style={{
            fontFamily: fSerif,
            fontWeight: 600,
            fontSize: 18,
            color: bone,
            letterSpacing: '-0.01em',
          }}
        >
          ClaimSure
        </span>
        <span style={{ width: 1, height: 20, background: ruleStrong, margin: '0 8px' }} />
        <MonoLabel size={10} color={bone3}>
          HELP
        </MonoLabel>
      </header>

      <div
        style={{
          display: 'flex',
          maxWidth: 1120,
          margin: '0 auto',
          padding: '40px 28px 80px',
          gap: 48,
        }}
      >
        {/* Sidebar TOC */}
        <nav
          style={{
            width: 200,
            flexShrink: 0,
            position: 'sticky',
            top: 96,
            alignSelf: 'flex-start',
          }}
        >
          <MonoLabel size={9} color={bone4} tracking="0.22em">
            On this page
          </MonoLabel>
          <ul style={{ listStyle: 'none', padding: 0, marginTop: 14 }}>
            {TOC.map((entry) => (
              <li key={entry.id} style={{ marginBottom: 10 }}>
                <a
                  href={`#${entry.id}`}
                  style={{
                    fontFamily: fSans,
                    fontSize: 13,
                    color: bone3,
                    textDecoration: 'none',
                  }}
                >
                  {entry.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {/* Main content */}
        <main style={{ flex: 1, minWidth: 0 }}>
          <MonoLabel size={10} color={bone3} tracking="0.22em">
            DOCUMENTATION
          </MonoLabel>
          <h1
            style={{
              fontFamily: fSerif,
              fontWeight: 300,
              fontSize: 44,
              lineHeight: 1.05,
              letterSpacing: '-0.025em',
              color: bone,
              margin: '12px 0 10px',
            }}
          >
            Help Centre
          </h1>
          <p
            style={{
              fontFamily: fSans,
              fontSize: 15,
              color: bone3,
              margin: '0 0 12px',
              maxWidth: 600,
            }}
          >
            How the platform works, key concepts, common workflows, and answers to frequently asked
            questions.
          </p>
          <p
            style={{
              fontFamily: fMono,
              fontSize: 10,
              color: bone4,
              letterSpacing: '0.14em',
              margin: '0 0 40px',
            }}
          >
            LAST UPDATED 2026-05-26
          </p>

          <Divider />

          {/* -------------------------------------------------------- */}
          {/*  1. Getting started                                      */}
          {/* -------------------------------------------------------- */}

          <Section id="getting-started" label="01" title="Getting started">
            <SubHead>Signing in</SubHead>
            <p style={{ margin: '0 0 14px' }}>
              Claimsure supports three identity providers for sign-in:{' '}
              <strong>Microsoft (Entra / Azure AD)</strong>, <strong>Google Workspace</strong>, and{' '}
              <strong>Auth0</strong>. Your firm administrator must add your account to a firm before
              you can sign in for the first time. Visit <InlineCode>/login</InlineCode> and choose
              the provider your firm uses. After authentication you are redirected to the main
              workspace.
            </p>
            <p style={{ margin: '0 0 14px' }}>
              There is also a development-only sign-in route used for internal testing. It is
              disabled in production deployments and is not available to end users.
            </p>

            <SubHead>Tour of the consultant workspace</SubHead>
            <p style={{ margin: '0 0 14px' }}>
              The consultant workspace is the primary working surface for R&DTI consultants. It is
              accessed at <InlineCode>/consultant</InlineCode> and consists of four main views,
              accessible from the left sidebar:
            </p>
            <ul style={{ margin: '0 0 14px', paddingLeft: 22 }}>
              <li style={{ marginBottom: 8 }}>
                <strong>Dashboard</strong> -- overview KPIs (active claims, evidence indexed,
                at-risk claims, chain coverage), active claims table, the Watch panel (regulatory
                signals), and the Chain panel (recent audit chain blocks).
              </li>
              <li style={{ marginBottom: 8 }}>
                <strong>Active claim (Wizard)</strong> -- the guided claim preparation flow. A
                six-step wizard walks you through profile, hypotheses, activities, apportionment,
                evidence review, and final review. The wizard&apos;s apportionment step includes a
                ledger mapping interface where expenditure lines are assigned to activities.
              </li>
              <li style={{ marginBottom: 8 }}>
                <strong>Watch</strong> -- the daily regulatory signal scanner. Surfaces alerts from
                the ATO, AusIndustry, the AAT, and the Federal Court, ranked by exposure to your
                active claims.
              </li>
              <li style={{ marginBottom: 8 }}>
                <strong>Financing</strong> -- (beta) claim financing functionality, anticipated for
                launch in FY26/27.
              </li>
            </ul>

            {/* SCREENSHOT: consultant workspace dashboard with sidebar visible */}

            <p
              style={{
                margin: '14px 0',
                padding: '10px 14px',
                border: `1px solid ${amber}`,
                background: 'rgba(225,162,58,0.06)',
                fontFamily: fMono,
                fontSize: 11,
                color: amber,
                letterSpacing: '0.06em',
                lineHeight: 1.6,
              }}
            >
              Note: The consultant workspace currently displays fictional data (preview mode). Every
              value shown -- KPIs, claims, signals, chain blocks, ledger lines -- is a design
              fixture, not live data. The preview banner at the top of the workspace makes this
              clear. Data-backed wiring is in active development.
            </p>

            <SubHead>Your first claim</SubHead>
            <p style={{ margin: '0 0 14px' }}>
              To create a claim, use the <InlineCode>+ New claim</InlineCode> button on the
              consultant dashboard. You will need to select a claimant (subject tenant) and a fiscal
              year. The claim is created in the <em>engagement</em> stage and can then be progressed
              through the claim wizard or the standard tabbed claim view.
            </p>
          </Section>

          <Divider />

          {/* -------------------------------------------------------- */}
          {/*  2. Core concepts                                        */}
          {/* -------------------------------------------------------- */}

          <Section id="core-concepts" label="02" title="Core concepts">
            <SubHead>Claim</SubHead>
            <p style={{ margin: '0 0 14px' }}>
              A <strong>claim</strong> is a single R&DTI registration submission for one claimant
              entity in one Australian fiscal year (1 July to 30 June). Each claim progresses
              through seven pipeline stages: <InlineCode>engagement</InlineCode>,{' '}
              <InlineCode>activity_capture</InlineCode>, <InlineCode>narrative_drafting</InlineCode>
              , <InlineCode>expenditure_schedule</InlineCode>, <InlineCode>review</InlineCode>,{' '}
              <InlineCode>submitted</InlineCode>, and <InlineCode>audit_defence</InlineCode>. These
              stages correspond to the real-world lifecycle of an R&DTI engagement, from initial
              onboarding through AusIndustry submission and any subsequent ATO review.
            </p>

            <SubHead>Activity</SubHead>
            <p style={{ margin: '0 0 14px' }}>
              An <strong>activity</strong> is a discrete unit of R&D work registered against a
              claim. Activities are classified as either <InlineCode>core</InlineCode> (per s.355-25
              ITAA 1997) or <InlineCode>supporting</InlineCode> (per s.355-30). Each activity is
              assigned an auto-generated code -- <InlineCode>CA-01</InlineCode>,{' '}
              <InlineCode>CA-02</InlineCode> for core activities, and <InlineCode>SA-01</InlineCode>
              , <InlineCode>SA-02</InlineCode> for supporting activities. Activities carry narrative
              fields: hypothesis, technical uncertainty, experimentation log, expected outcome, and
              actual outcome. These map directly to the 13 fields (core) or 10 fields (supporting)
              required by the AusIndustry portal registration form.
            </p>

            <SubHead>Evidence</SubHead>
            <p style={{ margin: '0 0 14px' }}>
              <strong>Evidence</strong> refers to the source artefacts that substantiate an R&D
              claim: meeting notes, design documents, code commits, lab notebook entries, invoices,
              timesheets, photos, voice recordings, and any other contemporaneous record. Each piece
              of evidence is captured as an <strong>event</strong> on an immutable, append-only
              chain. Events are classified by the AI engine into taxonomy kinds such as{' '}
              <InlineCode>HYPOTHESIS</InlineCode>, <InlineCode>EXPERIMENT</InlineCode>,{' '}
              <InlineCode>OBSERVATION</InlineCode>, <InlineCode>DESIGN</InlineCode>,{' '}
              <InlineCode>NEW_KNOWLEDGE</InlineCode>, <InlineCode>EVIDENCE_UPLOADED</InlineCode>,
              and others.
            </p>
            <p style={{ margin: '0 0 14px' }}>
              The cross-claimant evidence feed is available at <InlineCode>/evidence</InlineCode>,
              where you can filter by evidence kind and claimant.
            </p>

            <SubHead>Stages in the consultant workspace</SubHead>
            <p style={{ margin: '0 0 14px' }}>
              The consultant workspace wizard uses a different stage labelling scheme from the API
              pipeline stages. The wizard steps are named: <InlineCode>PROFILE</InlineCode>,{' '}
              <InlineCode>HYPOTHESES</InlineCode>, <InlineCode>ACTIVITIES</InlineCode>,{' '}
              <InlineCode>APPORTIONMENT</InlineCode>, <InlineCode>EVIDENCE</InlineCode>, and{' '}
              <InlineCode>REVIEW</InlineCode>. These correspond to the natural preparation sequence
              within a claim. In the dashboard claims table, claims show numbered stages like{' '}
              <InlineCode>STAGE 02 -- STAMP</InlineCode>,{' '}
              <InlineCode>STAGE 03 -- ASSEMBLE</InlineCode>,{' '}
              <InlineCode>STAGE 04 -- APPORTION</InlineCode>, and{' '}
              <InlineCode>STAGE 06 -- SEAL</InlineCode>. Claims also carry a <strong>status</strong>
              : <InlineCode>DRAFTING</InlineCode>, <InlineCode>UNDER REVIEW</InlineCode>,{' '}
              <InlineCode>SEALED</InlineCode>, <InlineCode>CHAIN-LOCKED</InlineCode>, or{' '}
              <InlineCode>FLAGGED</InlineCode>.
            </p>

            <SubHead>Audit chain</SubHead>
            <p style={{ margin: '0 0 14px' }}>
              The <strong>audit chain</strong> is the platform&apos;s tamper-evident evidence
              ledger. Every event -- evidence upload, classification, stage transition, narrative
              draft -- is appended to a per-claimant SHA-256 hash chain. Each block references the
              content hash of the previous block, creating a verifiable sequence of custody. The
              chain panel in the consultant sidebar shows the current block height and the most
              recent block ID.
            </p>
            <p style={{ margin: '0 0 14px' }}>
              Ingestion of the chain into an external timestamping service (for independently
              verifiable anchoring) is planned but not yet shipped.
            </p>

            <SubHead>Signals (regulatory watch)</SubHead>
            <p style={{ margin: '0 0 14px' }}>
              <strong>Signals</strong> are entries in the Regulatory Intelligence Feed (RIF). The
              platform scrapes the ATO, AusIndustry, AAT, and Federal Court sources daily,
              classifies new items, and cross-references them against your active claims to
              determine exposure. Signals are displayed in the Watch panel on the consultant
              dashboard, and in the full Watch view at <InlineCode>/consultant</InlineCode> (sidebar
              &gt; Watch). Each signal shows the source, reference code, headline, number of exposed
              claims, and ingestion time.
            </p>
          </Section>

          <Divider />

          {/* -------------------------------------------------------- */}
          {/*  3. Workflows                                            */}
          {/* -------------------------------------------------------- */}

          <Section id="workflows" label="03" title="Workflows">
            <SubHead>Start a new claim</SubHead>
            <ol style={{ margin: '0 0 14px', paddingLeft: 22 }}>
              <li style={{ marginBottom: 6 }}>
                Navigate to the consultant dashboard (<InlineCode>/consultant</InlineCode>).
              </li>
              <li style={{ marginBottom: 6 }}>
                Click <InlineCode>+ New claim</InlineCode> in the top-right action bar.
              </li>
              <li style={{ marginBottom: 6 }}>
                Select the claimant (subject tenant) and the fiscal year for the claim.
              </li>
              <li style={{ marginBottom: 6 }}>
                The claim is created in the <InlineCode>engagement</InlineCode> stage and appears in
                the active claims table. You can then open it in the claim wizard to begin
                preparation.
              </li>
            </ol>

            <SubHead>Add evidence to a claim</SubHead>
            <ol style={{ margin: '0 0 14px', paddingLeft: 22 }}>
              <li style={{ marginBottom: 6 }}>
                Open the claimant&apos;s detail page (via{' '}
                <InlineCode>/subject-tenants/[id]</InlineCode>).
              </li>
              <li style={{ marginBottom: 6 }}>
                Click <InlineCode>Upload Evidence</InlineCode>. You can select up to 20 files at
                once. Most document, image, audio, video, and archive formats are accepted -- see{' '}
                <a href="/files" style={{ color: amber }}>
                  Files
                </a>{' '}
                for the complete policy.
              </li>
              <li style={{ marginBottom: 6 }}>
                Each file is hashed (SHA-256) client-side, then uploaded and recorded on the
                claimant&apos;s immutable evidence chain as an{' '}
                <InlineCode>EVIDENCE_UPLOADED</InlineCode> event.
              </li>
              <li style={{ marginBottom: 6 }}>
                The AI classifier assigns an evidence kind (e.g. HYPOTHESIS, EXPERIMENT,
                OBSERVATION) to each upload. You can override the classification from the evidence
                feed.
              </li>
              <li style={{ marginBottom: 6 }}>
                Evidence also appears in the cross-claimant feed at{' '}
                <InlineCode>/evidence</InlineCode>, where it can be filtered by kind and claimant.
              </li>
            </ol>

            <SubHead>Watch for regulatory exposure</SubHead>
            <ol style={{ margin: '0 0 14px', paddingLeft: 22 }}>
              <li style={{ marginBottom: 6 }}>
                Open the Watch view from the consultant sidebar (eye icon).
              </li>
              <li style={{ marginBottom: 6 }}>
                Review the signal list. Each entry shows the source (ATO, AusIndustry, AAT, FCA),
                the reference code, a headline summary, and the number of your active claims that
                may be affected.
              </li>
              <li style={{ marginBottom: 6 }}>
                Signals with high exposure (3+ claims) are highlighted with an amber badge. Click a
                signal to navigate to its detail view for full context.
              </li>
            </ol>

            <SubHead>Apportion expenditure</SubHead>
            <ol style={{ margin: '0 0 14px', paddingLeft: 22 }}>
              <li style={{ marginBottom: 6 }}>
                Open an active claim in the wizard view and navigate to Step 04 -- Apportionment.
              </li>
              <li style={{ marginBottom: 6 }}>
                The ledger table displays expenditure lines from the financial year. Each line shows
                a date, vendor, amount, and expenditure category (wages, contractor, overhead).
              </li>
              <li style={{ marginBottom: 6 }}>
                Lines that the platform has automatically matched to an activity are shown with
                their assignment (e.g. CORE or SUPPORT). Unmatched lines display a suggested
                assignment with a dashed border -- review and confirm or change each one.
              </li>
              <li style={{ marginBottom: 6 }}>
                Rollup totals at the bottom show the apportionment split between core and supporting
                activities, with percentage bars.
              </li>
            </ol>

            <SubHead>Seal a finalised claim</SubHead>
            <ol style={{ margin: '0 0 14px', paddingLeft: 22 }}>
              <li style={{ marginBottom: 6 }}>
                Complete all wizard steps (profile through review). Ensure all activities have bound
                evidence and all narrative sections have been approved.
              </li>
              <li style={{ marginBottom: 6 }}>
                Click <InlineCode>Sign &amp; seal</InlineCode> in the wizard header to advance the
                claim to the <InlineCode>submitted</InlineCode> stage. This records a seal event on
                the audit chain and locks the claim for further editing.
              </li>
              <li style={{ marginBottom: 6 }}>
                A sealed claim is marked with the <InlineCode>SEALED</InlineCode> status pill in the
                claims table. Once a claim is chain-locked, its status changes to{' '}
                <InlineCode>CHAIN-LOCKED</InlineCode>, indicating the chain head has been committed.
              </li>
            </ol>
            <p style={{ margin: '0 0 14px' }}>
              Generating a cryptographic claim manifest (an ordered hash of all evidence, narrative,
              and expenditure artefacts) is planned but not yet shipped. The current seal action
              records the event on the chain but does not produce an externally verifiable manifest
              bundle.
            </p>
          </Section>

          <Divider />

          {/* -------------------------------------------------------- */}
          {/*  4. FAQ                                                   */}
          {/* -------------------------------------------------------- */}

          <Section id="faq" label="04" title="Frequently asked questions">
            <FaqItem q="Why does my dashboard show fictional values?">
              <p style={{ margin: '0 0 8px' }}>
                The consultant workspace (<InlineCode>/consultant</InlineCode>) is currently a
                design preview. All KPIs, claim rows, signal entries, chain blocks, and ledger lines
                are hardcoded fixtures, not live data. A yellow banner at the top of the page reads
                &ldquo;Preview -- Design surface only -- Every value on this page is
                fictional.&rdquo; This workspace is being actively wired to the real data layer; it
                will replace the fixture data as each panel is connected.
              </p>
            </FaqItem>

            <FaqItem q="Where is my data stored?">
              <p style={{ margin: '0 0 8px' }}>
                All customer data is stored on infrastructure hosted in Australian regions (Google
                Cloud, Sydney and Melbourne availability zones). The platform is designed for
                Australian data sovereignty -- no claim or claimant data leaves Australian
                jurisdiction. Database backups are retained in Australian regions with point-in-time
                recovery enabled.
              </p>
            </FaqItem>

            <FaqItem q="How long is evidence retained?">
              <p style={{ margin: '0 0 8px' }}>
                Claim-bearing records (audit log, event chain, narrative draft versions, expenditure
                data) are retained for a minimum of 5 years, in line with ATO record-keeping
                obligations under the R&DTI scheme. Audit log and event chain tables are
                append-only; UPDATE and DELETE operations are revoked at the database level.
              </p>
            </FaqItem>

            <FaqItem q="Who can see my claimant data?">
              <p style={{ margin: '0 0 8px' }}>
                Data is isolated per tenant (firm) using PostgreSQL Row-Level Security (RLS). Every
                tenant-scoped table enforces a policy that filters rows by the authenticated tenant
                ID. Users within a firm can see that firm&apos;s claimants and claims; they cannot
                access data belonging to other firms. Operator access is controlled by separate
                database roles and is subject to audit logging.
              </p>
            </FaqItem>

            <FaqItem q="What authentication providers are supported?">
              <p style={{ margin: '0 0 8px' }}>
                The platform supports Microsoft (Entra / Azure AD), Google Workspace, and Auth0 for
                OIDC-based single sign-on. Your firm administrator configures which provider to use.
                Sessions last 24 hours by default; after expiry you are prompted to re-authenticate.
              </p>
            </FaqItem>

            <FaqItem q="How do I export a claim?">
              <p style={{ margin: '0 0 8px' }}>
                The wizard header includes an <InlineCode>Export draft</InlineCode> button for the
                active claim. The platform also supports generating AusIndustry portal-ready field
                content and claim PDFs (activity PDF, compliance memo). Full claim pack export -- a
                single bundle containing all narratives, evidence index, and expenditure schedule --
                is in development.
              </p>
            </FaqItem>

            <FaqItem q="Can I connect my accounting software?">
              <p style={{ margin: '0 0 8px' }}>
                The platform has a live Xero Accounting integration for importing expenditure data
                (invoices, bills, contacts, chart of accounts). MYOB AccountRight integration is
                under development. Connections are managed from the admin area. All OAuth tokens are
                encrypted at rest.
              </p>
            </FaqItem>

            <FaqItem q="What is the audit score?">
              <p style={{ margin: '0 0 8px' }}>
                The audit score is a per-claim metric that evaluates the strength of the evidential
                record against common ATO review criteria. It considers evidence coverage (do all
                activities have contemporaneous evidence?), narrative completeness, expenditure
                reconciliation, and chain integrity. The score is designed to surface gaps before
                submission, not after.
              </p>
            </FaqItem>

            <FaqItem q="Is my data used to train AI models?">
              <p style={{ margin: '0 0 8px' }}>
                No. The platform uses Anthropic Claude for AI-assisted features (evidence
                classification, activity register synthesis, narrative drafting). Customer data is
                not used to train or fine-tune any model. Anthropic&apos;s API usage policy
                prohibits training on API inputs/outputs. All AI outputs are citation-grounded and
                linked to source artefacts.
              </p>
            </FaqItem>
          </Section>

          <Divider />

          {/* -------------------------------------------------------- */}
          {/*  5. Support                                               */}
          {/* -------------------------------------------------------- */}

          <Section id="support" label="05" title="Where to get more help">
            <p style={{ margin: '0 0 14px' }}>
              For product questions, feature requests, or issues, contact your firm&apos;s support
              channel. Each firm can configure a support email address via the admin brand
              configuration panel at <InlineCode>/admin/brand-config</InlineCode>. Your firm
              administrator can set this address to route enquiries to the appropriate team.
            </p>
            <p style={{ margin: '0 0 14px' }}>
              For platform-level issues (login problems, data discrepancies, security concerns),
              contact the platform operations team. The support email is configured per deployment
              and is available from your firm administrator.
            </p>
            <p style={{ margin: '0 0 14px' }}>Related resources:</p>
            <ul style={{ margin: '0 0 14px', paddingLeft: 22 }}>
              <li style={{ marginBottom: 6 }}>
                <a href="/files" style={{ color: amber }}>
                  Files
                </a>{' '}
                -- how evidence files are managed, uploaded, and retained.
              </li>
              <li style={{ marginBottom: 6 }}>
                <a href="/evidence" style={{ color: amber }}>
                  Evidence feed
                </a>{' '}
                -- the cross-claimant evidence browser.
              </li>
              <li style={{ marginBottom: 6 }}>
                <a href="/consultant" style={{ color: amber }}>
                  Consultant workspace
                </a>{' '}
                -- the primary working surface (currently in design preview).
              </li>
            </ul>
          </Section>

          {/* Footer */}
          <div
            style={{
              marginTop: 48,
              paddingTop: 20,
              borderTop: `1px solid ${rule}`,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <MonoLabel size={9} color={bone4}>
              CLAIMSURE -- HELP CENTRE
            </MonoLabel>
            <MonoLabel size={9} color={bone4}>
              2026-05-26
            </MonoLabel>
          </div>
        </main>
      </div>
    </div>
  );
}
