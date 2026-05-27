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
  ink2,
  rule,
  ruleStrong,
  rust,
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

/* ------------------------------------------------------------------ */
/*  Table of contents                                                 */
/* ------------------------------------------------------------------ */

const TOC = [
  { id: 'what-files-means', label: 'What "files" means' },
  { id: 'organisation', label: 'How files are organised' },
  { id: 'operations', label: 'Operations' },
  { id: 'compliance', label: 'Compliance and retention' },
  { id: 'supported-types', label: 'Supported file types' },
  { id: 'size-limits', label: 'File-size limits' },
  { id: 'audit-trail', label: 'Audit trail' },
] as const;

/* ------------------------------------------------------------------ */
/*  Blocked extensions table data                                     */
/* ------------------------------------------------------------------ */

const BLOCKED_EXTS = [
  '.exe',
  '.bat',
  '.cmd',
  '.com',
  '.scr',
  '.dll',
  '.msi',
  '.ps1',
  '.psm1',
  '.vbs',
  '.vbe',
  '.js',
  '.jse',
  '.wsf',
  '.wsh',
  '.sh',
  '.bash',
  '.zsh',
  '.app',
  '.pkg',
  '.deb',
  '.rpm',
  '.apk',
  '.dmg',
  '.iso',
];

/* ------------------------------------------------------------------ */
/*  Page                                                              */
/* ------------------------------------------------------------------ */

export default function FilesPage() {
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
          FILES
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
            Files
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
            How evidence files are stored, organised, and managed within the platform -- including
            upload policy, retention requirements, and the audit trail.
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
          {/*  1. What "files" means                                   */}
          {/* -------------------------------------------------------- */}

          <Section id="what-files-means" label="01" title='What "files" means in this product'>
            <p style={{ margin: '0 0 14px' }}>
              In Claimsure, a <strong>file</strong> is any document, image, recording, or digital
              artefact uploaded as evidence to support an R&DTI claim. Files are not stored in a
              general-purpose file manager -- they are forensic evidence artefacts, immutably
              recorded on a per-claimant hash chain the moment they enter the system.
            </p>

            <SubHead>The relationship between files and platform records</SubHead>
            <p style={{ margin: '0 0 14px' }}>
              Every uploaded file becomes an <strong>event</strong> on the claimant&apos;s evidence
              chain. The event records:
            </p>
            <ul style={{ margin: '0 0 14px', paddingLeft: 22 }}>
              <li style={{ marginBottom: 6 }}>
                The file&apos;s <strong>SHA-256 content hash</strong>, computed client-side before
                upload.
              </li>
              <li style={{ marginBottom: 6 }}>The original filename, MIME type, and byte size.</li>
              <li style={{ marginBottom: 6 }}>An ingestion timestamp (server-side, UTC).</li>
              <li style={{ marginBottom: 6 }}>
                A chain block reference linking this event to the previous block in the
                claimant&apos;s hash chain.
              </li>
            </ul>
            <p style={{ margin: '0 0 14px' }}>
              Once recorded, the event can be <strong>classified</strong> by the AI engine into an
              evidence kind (e.g. <InlineCode>HYPOTHESIS</InlineCode>,{' '}
              <InlineCode>EXPERIMENT</InlineCode>, <InlineCode>OBSERVATION</InlineCode>,{' '}
              <InlineCode>DESIGN</InlineCode>). This classification determines how the evidence
              appears in the cross-claimant feed at <InlineCode>/evidence</InlineCode>.
            </p>
            <p style={{ margin: '0 0 14px' }}>
              Files can then be <strong>linked to activities</strong> within a claim. An
              activity&apos;s evidential strength depends on having contemporaneous source artefacts
              bound to it. The claim wizard&apos;s evidence step (<InlineCode>EVIDENCE</InlineCode>)
              and the auto-allocator agent handle this binding.
            </p>
            <p style={{ margin: '0 0 14px' }}>
              Separately, the platform generates <strong>output documents</strong> during the claim
              lifecycle: activity PDFs, narrative drafts, AusIndustry portal field exports,
              compliance memos, and claim packs. These are produced files rather than uploaded
              evidence, and follow a different retention path.
            </p>
          </Section>

          <Divider />

          {/* -------------------------------------------------------- */}
          {/*  2. Organisation                                         */}
          {/* -------------------------------------------------------- */}

          <Section id="organisation" label="02" title="How files are organised">
            <SubHead>Per claimant, per chain</SubHead>
            <p style={{ margin: '0 0 14px' }}>
              Files are organised primarily by <strong>claimant</strong> (subject tenant). Each
              claimant maintains its own independent evidence chain. When you upload files via the
              claimant detail page at <InlineCode>/subject-tenants/[id]</InlineCode>, those files
              become events on that specific claimant&apos;s chain.
            </p>

            <SubHead>Per claim, per activity</SubHead>
            <p style={{ margin: '0 0 14px' }}>
              Within a claim, evidence is associated with individual activities through
              <strong> artefact links</strong>. Each activity (e.g. <InlineCode>CA-01</InlineCode>)
              can have multiple pieces of evidence bound to it. The wizard&apos;s apportionment and
              evidence steps surface which activities have bound evidence and which have gaps.
            </p>

            <SubHead>Evidence kind as a label</SubHead>
            <p style={{ margin: '0 0 14px' }}>
              Rather than traditional folder hierarchies, the platform uses the AI-assigned
              <strong> evidence kind</strong> as the primary organisational label. The evidence feed
              at <InlineCode>/evidence</InlineCode> supports filtering by kind:{' '}
              <InlineCode>HYPOTHESIS</InlineCode>, <InlineCode>DESIGN</InlineCode>,{' '}
              <InlineCode>EXPERIMENT</InlineCode>, <InlineCode>OBSERVATION</InlineCode>,{' '}
              <InlineCode>ITERATION</InlineCode>, <InlineCode>NEW_KNOWLEDGE</InlineCode>,{' '}
              <InlineCode>UNCERTAINTY</InlineCode>, <InlineCode>TIME_LOG</InlineCode>,{' '}
              <InlineCode>EXPENDITURE_NOTE</InlineCode>, <InlineCode>SUPPORTING</InlineCode>,{' '}
              <InlineCode>EVIDENCE_UPLOADED</InlineCode>, and others. You can also filter by
              claimant to narrow the feed to a single entity.
            </p>

            <SubHead>No user-defined folders or tags (yet)</SubHead>
            <p style={{ margin: '0 0 14px' }}>
              The platform does not currently support user-defined folders, labels, or tags on
              files. Evidence is organised by claimant, claim, activity, and AI-assigned kind.
              User-defined tagging is a candidate for a future release.
            </p>
          </Section>

          <Divider />

          {/* -------------------------------------------------------- */}
          {/*  3. Operations                                           */}
          {/* -------------------------------------------------------- */}

          <Section id="operations" label="03" title="Operations">
            <SubHead>Upload (single and bulk)</SubHead>
            <p style={{ margin: '0 0 14px' }}>
              Upload files via the <InlineCode>Upload Evidence</InlineCode> button on a
              claimant&apos;s detail page or the claim&apos;s evidence tab. The upload dialog
              supports selecting <strong>up to 20 files at once</strong>. Files are processed in a
              concurrency-limited pool (3 simultaneous uploads) to avoid saturating bandwidth.
            </p>
            <p style={{ margin: '0 0 14px' }}>For each file in the batch, the platform:</p>
            <ol style={{ margin: '0 0 14px', paddingLeft: 22 }}>
              <li style={{ marginBottom: 6 }}>
                Validates the file against the type policy (denylist-based -- see Supported file
                types below) and the size limit.
              </li>
              <li style={{ marginBottom: 6 }}>
                Extracts text content where possible (PDF, DOCX, plain text) for downstream AI
                classification.
              </li>
              <li style={{ marginBottom: 6 }}>
                Computes the SHA-256 digest of the file bytes using the browser&apos;s Web Crypto
                API.
              </li>
              <li style={{ marginBottom: 6 }}>
                Uploads the file and metadata to the server, which records it as an{' '}
                <InlineCode>EVIDENCE_UPLOADED</InlineCode> event on the claimant&apos;s chain.
              </li>
            </ol>
            <p style={{ margin: '0 0 14px' }}>
              Per-file status is tracked in the upload dialog: <InlineCode>queued</InlineCode>,{' '}
              <InlineCode>extracting</InlineCode>, <InlineCode>hashing</InlineCode>,{' '}
              <InlineCode>uploading</InlineCode>, <InlineCode>done</InlineCode>, or{' '}
              <InlineCode>error</InlineCode>. If a file&apos;s content hash already exists on the
              claimant&apos;s chain (a duplicate), the upload is rejected with an &ldquo;Already
              uploaded&rdquo; status -- this is the chain-of-custody deduplication mechanism.
            </p>

            <SubHead>Search</SubHead>
            <p style={{ margin: '0 0 14px' }}>
              The cross-claimant evidence feed at <InlineCode>/evidence</InlineCode> provides
              filtering by evidence kind and by claimant ID. URL query parameters control the filter
              state (<InlineCode>?kinds=HYPOTHESIS,EXPERIMENT</InlineCode> and{' '}
              <InlineCode>?claimant_ids=...</InlineCode>). Results are paginated with cursor-based
              pagination (default 50 items per page, maximum 200).
            </p>
            <p style={{ margin: '0 0 14px' }}>
              Full-text search across evidence content is not yet available. The consultant
              workspace top bar includes a search field placeholder ({' '}
              <InlineCode>Search claims, evidence, blocks...</InlineCode>) that is planned but not
              yet wired to a search backend.
            </p>

            <SubHead>Link to claim</SubHead>
            <p style={{ margin: '0 0 14px' }}>
              Evidence events can be linked to specific activities within a claim through artefact
              links. The claim wizard&apos;s evidence step provides an interface for reviewing and
              confirming these bindings. The <InlineCode>auto-allocator</InlineCode> agent can
              suggest bindings automatically based on content similarity between evidence and
              activity descriptions.
            </p>

            <SubHead>Archive and delete</SubHead>
            <p style={{ margin: '0 0 14px' }}>
              Because the evidence chain is append-only, individual files cannot be deleted from the
              chain once recorded. The event record persists for the retention period (see
              Compliance below). Soft-delete patterns are used elsewhere in the platform (via{' '}
              <InlineCode>deleted_at</InlineCode> columns), but evidence chain entries are exempt --
              this is by design, to preserve the audit trail&apos;s integrity.
            </p>

            <SubHead>Export</SubHead>
            <p style={{ margin: '0 0 14px' }}>
              The wizard provides an <InlineCode>Export draft</InlineCode> button for the active
              claim. The platform can generate claim PDFs and AusIndustry portal field exports. A
              full &ldquo;sealed claim pack&rdquo; export -- a single bundle containing the evidence
              index, narratives, expenditure schedule, and chain verification data -- is planned but
              not yet available.
            </p>
          </Section>

          <Divider />

          {/* -------------------------------------------------------- */}
          {/*  4. Compliance and retention                              */}
          {/* -------------------------------------------------------- */}

          <Section id="compliance" label="04" title="Compliance and retention">
            <SubHead>R&DTI record-keeping requirements</SubHead>
            <p style={{ margin: '0 0 14px' }}>
              Under the R&D Tax Incentive scheme, claimants must retain records sufficient to
              demonstrate that eligible R&D activities were conducted and that the claimed
              expenditure relates to those activities. The ATO generally requires records to be kept
              for a period of 5 years from the date of lodgement of the return in which the R&DTI
              offset was claimed, though some circumstances may extend this.
            </p>

            <SubHead>Platform retention periods</SubHead>
            <p style={{ margin: '0 0 14px' }}>
              The platform applies a <strong>5-year retention period</strong> to all claim-bearing
              records, matching the ATO statutory minimum for the R&D Tax Incentive scheme. This
              covers the following record categories:
            </p>
            <div
              style={{
                background: ink2,
                border: `1px solid ${ruleStrong}`,
                borderRadius: 4,
                overflow: 'hidden',
                margin: '14px 0',
              }}
            >
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 120px 180px',
                  padding: '10px 18px',
                  borderBottom: `1px solid ${rule}`,
                  fontFamily: fMono,
                  fontSize: 10,
                  color: bone3,
                  letterSpacing: '0.16em',
                }}
              >
                <span>RECORD TYPE</span>
                <span>RETENTION</span>
                <span>PROTECTION</span>
              </div>
              {[
                ['Audit log', '5 years', 'Append-only (UPDATE/DELETE revoked)'],
                ['Event chain', '5 years', 'Content hash chain integrity'],
                ['Narrative draft versions', '5 years', 'Append-only (UPDATE/DELETE revoked)'],
                ['Expenditure data', '5 years', 'Standard RLS isolation'],
                ['Customer claimant data', '5 years', 'RLS + append-only audit'],
                ['Application logs', '~15 months', 'Provider-managed immutability'],
              ].map(([type, retention, protection], i) => (
                <div
                  key={type}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 120px 180px',
                    padding: '10px 18px',
                    borderBottom: i < 5 ? `1px solid ${rule}` : 'none',
                    fontFamily: fSans,
                    fontSize: 13,
                    color: bone2,
                  }}
                >
                  <span style={{ color: bone }}>{type}</span>
                  <span style={{ fontFamily: fMono, fontSize: 11, color: amber }}>{retention}</span>
                  <span style={{ fontSize: 12, color: bone3 }}>{protection}</span>
                </div>
              ))}
            </div>

            <SubHead>Australian sovereign data location</SubHead>
            <p style={{ margin: '0 0 14px' }}>
              All data is stored in Google Cloud Australian regions (Sydney:{' '}
              <InlineCode>australia-southeast1</InlineCode>, Melbourne:{' '}
              <InlineCode>australia-southeast2</InlineCode>). Database backups use point-in-time
              recovery (PITR) with a 7-day retention window, stored in the Melbourne region. No
              claim or claimant data leaves Australian jurisdiction.
            </p>

            <SubHead>Tamper resistance</SubHead>
            <p style={{ margin: '0 0 14px' }}>
              Three database tables are protected by append-only constraints:{' '}
              <InlineCode>audit_log</InlineCode>, <InlineCode>narrative_draft_version</InlineCode>,
              and <InlineCode>prompt_suggestion_review</InlineCode>. UPDATE and DELETE grants are
              revoked at the database level (enforced since migration 0035). The event chain table
              uses SHA-256 hash chaining so any tampering with historical entries invalidates the
              chain from that point forward.
            </p>
            <p style={{ margin: '0 0 14px' }}>
              Every claim-bearing row carries a <InlineCode>first_recorded_at</InlineCode>{' '}
              timestamp. Where applicable, rows also carry a{' '}
              <InlineCode>hypothesis_formed_at</InlineCode> timestamp that is immutable post-INSERT
              (enforced by a PostgreSQL trigger). This supports the contemporaneity argument
              required by <em>Body by Michael v Commissioner of Taxation</em>.
            </p>
          </Section>

          <Divider />

          {/* -------------------------------------------------------- */}
          {/*  5. Supported file types                                 */}
          {/* -------------------------------------------------------- */}

          <Section id="supported-types" label="05" title="Supported file types">
            <p style={{ margin: '0 0 14px' }}>
              The platform uses a <strong>denylist policy</strong> for file uploads: all file types
              are accepted <em>except</em> known executable and script formats. This is because
              R&DTI consultants routinely receive evidence in a wide variety of formats -- HEIC
              photos from iPhones, XLSX expenditure trackers, P7M signed contracts, ODT files, EML
              email exports, ZIP bundles, and more. A strict whitelist would prevent legitimate
              evidence from entering the system.
            </p>

            <SubHead>Accepted formats (non-exhaustive)</SubHead>
            <p style={{ margin: '0 0 14px' }}>
              The following formats are accepted and represent the most common evidence types:
            </p>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 10,
                margin: '14px 0',
              }}
            >
              {[
                { cat: 'DOCUMENTS', exts: 'PDF, DOCX, DOC, ODT, TXT, MD, RTF' },
                { cat: 'SPREADSHEETS', exts: 'XLSX, XLS, CSV, ODS' },
                { cat: 'PRESENTATIONS', exts: 'PPTX, PPT, ODP' },
                { cat: 'IMAGES', exts: 'PNG, JPG, JPEG, HEIC, WEBP, TIFF, BMP, SVG' },
                { cat: 'AUDIO', exts: 'M4A, MP3, WAV, OGG, FLAC' },
                { cat: 'VIDEO', exts: 'MP4, MOV, AVI, MKV, WEBM' },
                { cat: 'ARCHIVES', exts: 'ZIP, 7Z, TAR, GZ' },
                { cat: 'EMAIL', exts: 'EML, MSG' },
                { cat: 'SIGNED', exts: 'P7M, P7S' },
              ].map((g) => (
                <div
                  key={g.cat}
                  style={{
                    padding: '12px 14px',
                    background: ink2,
                    border: `1px solid ${ruleStrong}`,
                    borderRadius: 4,
                  }}
                >
                  <MonoLabel size={9} color={amber}>
                    {g.cat}
                  </MonoLabel>
                  <div
                    style={{
                      fontFamily: fMono,
                      fontSize: 11,
                      color: bone2,
                      marginTop: 8,
                      lineHeight: 1.6,
                    }}
                  >
                    {g.exts}
                  </div>
                </div>
              ))}
            </div>

            <SubHead>Blocked extensions</SubHead>
            <p style={{ margin: '0 0 14px' }}>
              The following executable and script extensions are blocked at upload. The evidence
              chain treats every file as opaque bytes (hash and record metadata), so blocked types
              are rejected to prevent confusion with legitimate evidence -- not because the platform
              executes them.
            </p>
            <div
              style={{
                padding: '12px 18px',
                background: ink2,
                border: `1px solid ${ruleStrong}`,
                borderRadius: 4,
                margin: '14px 0',
                fontFamily: fMono,
                fontSize: 11.5,
                color: rust,
                lineHeight: 2,
                letterSpacing: '0.04em',
              }}
            >
              {BLOCKED_EXTS.map((ext, i) => (
                <span key={ext}>
                  {ext}
                  {i < BLOCKED_EXTS.length - 1 ? <span style={{ color: bone4 }}> </span> : null}
                </span>
              ))}
            </div>

            <SubHead>Text extraction</SubHead>
            <p style={{ margin: '0 0 14px' }}>
              For file types that contain readable text (PDF, DOCX, TXT, MD), the platform extracts
              text content client-side before upload. This extracted content is sent alongside the
              file and is used by the AI classifier to determine the evidence kind. If text
              extraction is not available for a file type, the upload proceeds without extracted
              content and classification relies on filename and metadata.
            </p>
          </Section>

          <Divider />

          {/* -------------------------------------------------------- */}
          {/*  6. File-size limits                                     */}
          {/* -------------------------------------------------------- */}

          <Section id="size-limits" label="06" title="File-size limits">
            <p style={{ margin: '0 0 14px' }}>
              Each individual file is limited to <strong style={{ color: amber }}>50 MB</strong>.
              This cap covers the common evidence types encountered in R&DTI work: scanned PDFs,
              high-resolution photographs (including HEIC from mobile devices), and modest video
              recordings.
            </p>
            <div
              style={{
                background: ink2,
                border: `1px solid ${ruleStrong}`,
                borderRadius: 4,
                padding: '16px 20px',
                margin: '14px 0',
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 20,
              }}
            >
              <div>
                <MonoLabel size={9} color={bone3}>
                  PER-FILE LIMIT
                </MonoLabel>
                <div
                  style={{
                    fontFamily: fSerif,
                    fontSize: 32,
                    color: amber,
                    fontWeight: 300,
                    marginTop: 8,
                    letterSpacing: '-0.02em',
                  }}
                >
                  50 MB
                </div>
              </div>
              <div>
                <MonoLabel size={9} color={bone3}>
                  MAX FILES PER BATCH
                </MonoLabel>
                <div
                  style={{
                    fontFamily: fSerif,
                    fontSize: 32,
                    color: amber,
                    fontWeight: 300,
                    marginTop: 8,
                    letterSpacing: '-0.02em',
                  }}
                >
                  20
                </div>
              </div>
            </div>
            <p style={{ margin: '0 0 14px' }}>
              The theoretical maximum per batch is therefore 1 GB (20 files at 50 MB each). In
              practice, uploads are processed with a concurrency limit of 3 simultaneous uploads to
              manage bandwidth.
            </p>
            <p style={{ margin: '0 0 14px' }}>
              If you need to upload files larger than 50 MB (e.g. long video recordings or large CAD
              files), contact your firm administrator to discuss alternative ingestion methods.
              Chunked or resumable uploads are not currently supported.
            </p>
          </Section>

          <Divider />

          {/* -------------------------------------------------------- */}
          {/*  7. Audit trail                                          */}
          {/* -------------------------------------------------------- */}

          <Section id="audit-trail" label="07" title="Audit trail">
            <p style={{ margin: '0 0 14px' }}>
              Every file-related action is recorded on the platform&apos;s audit infrastructure. The
              following events are captured:
            </p>
            <ul style={{ margin: '0 0 14px', paddingLeft: 22 }}>
              <li style={{ marginBottom: 8 }}>
                <strong>Upload</strong> -- an <InlineCode>EVIDENCE_UPLOADED</InlineCode> event is
                appended to the claimant&apos;s hash chain. The event payload includes the filename,
                MIME type, byte size, and the SHA-256 content hash.
              </li>
              <li style={{ marginBottom: 8 }}>
                <strong>Classification</strong> -- when the AI classifier assigns or changes an
                evidence kind, this is recorded as a separate event on the chain with the
                classification result and confidence score.
              </li>
              <li style={{ marginBottom: 8 }}>
                <strong>Override</strong> -- if a consultant manually overrides the AI
                classification (e.g. reclassifying an <InlineCode>OBSERVATION</InlineCode> as a{' '}
                <InlineCode>HYPOTHESIS</InlineCode>), the override is recorded as an{' '}
                <InlineCode>OVERRIDE</InlineCode> event with the original and new kinds preserved.
              </li>
              <li style={{ marginBottom: 8 }}>
                <strong>Activity binding</strong> -- when evidence is linked to an activity
                (manually or via the auto-allocator), the artefact link creation is logged.
              </li>
              <li style={{ marginBottom: 8 }}>
                <strong>Duplicate rejection</strong> -- when an upload is rejected because the
                content hash already exists on the claimant&apos;s chain, this is a no-op on the
                chain itself (no event is appended), but the client-side upload dialog reports the
                duplicate status.
              </li>
            </ul>

            <SubHead>Chain verification</SubHead>
            <p style={{ margin: '0 0 14px' }}>
              The integrity of the evidence chain can be verified by recomputing the SHA-256 hash
              sequence from the first event to the chain head. Each event&apos;s block contains a
              reference to the previous block&apos;s content hash. If any historical event has been
              modified, the hash chain breaks from that point forward. Chain verification tests run
              as part of the platform&apos;s continuous integration pipeline.
            </p>

            <SubHead>Who can access the audit trail?</SubHead>
            <p style={{ margin: '0 0 14px' }}>
              The audit trail is scoped by the same Row-Level Security (RLS) policies that protect
              all tenant data. Users within a firm can view the audit chain for their firm&apos;s
              claimants. Cross-tenant access is prevented at the database level. Append-only
              constraints mean that even users with write access to other tables cannot modify or
              delete audit entries.
            </p>

            <SubHead>External anchoring</SubHead>
            <p style={{ margin: '0 0 14px' }}>
              Independent external timestamping (e.g. OpenTimestamps or a similar anchoring service)
              for the chain head is planned but not yet implemented. When available, this will
              provide third-party verifiable proof of the chain&apos;s state at a given point in
              time, independent of the platform operator.
            </p>
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
              CLAIMSURE -- FILES DOCUMENTATION
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
