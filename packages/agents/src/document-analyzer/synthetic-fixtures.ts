/**
 * Synthetic document fixtures for stress-testing the document-analyzer
 * pipeline.
 *
 * Each fixture is a self-contained `raw_text` payload in the same
 * format the file-upload route emits ("[FILE UPLOAD] filename\nType:
 * .../Extracted-Text:\n<text>"), so they can be inserted as event rows
 * verbatim.
 *
 * Coverage goals:
 *   - Multiple R&D domains (ML, materials, biotech, agritech, software)
 *   - Multiple document KINDS (research log, invoice schedule, meeting
 *     minutes, IP search, regulatory correspondence, failure report,
 *     test plan, vendor quote, peer-reviewed paper extract)
 *   - Multiple sizes (200 chars to 50_000 chars)
 *   - Edge cases: empty extracted text, malformed headers, very long
 *     lines, unicode + emoji, foreign-language fragments
 *   - Realistic structures the model has to parse: tables, bullet
 *     hierarchies, code blocks, citation lists
 *
 * Used by the stress tests in stress-extraction.test.ts.
 */
import { createHash } from 'node:crypto';

export interface SyntheticDoc {
  /** Stable identifier — used as the event idempotency key salt. */
  id: string;
  /** Brief description for test reporting. */
  label: string;
  /** Pre-built raw_text in the file-upload payload format. */
  raw_text: string;
  /**
   * Expectation hints for the analyzer. Tests assert these "softly"
   * (e.g. activities >= expected_min, not exact equality, because the
   * model has discretion).
   */
  expected: {
    activities_min: number;
    activities_max: number;
    invoices_min: number;
    invoices_max: number;
    /** If true, the doc should produce a non-empty summary. */
    summary_required: boolean;
    /** If true, the analyzer should NOT crash even though content is weird. */
    edge_case: boolean;
  };
}

/**
 * Wrap a fixture body in the standard file-upload payload format the
 * /v1/events route emits and the document-extract worker parses.
 *
 * The format is sensitive: Type:, Size:, Extracted-Text: line order
 * matters for parseFileUploadPayload(). Keep this helper in sync with
 * apps/api/src/jobs/document-extract.ts:parseFileUploadPayload.
 */
function wrapAsFileUpload(filename: string, mimeType: string, body: string): string {
  const sizeKb = (Buffer.byteLength(body, 'utf8') / 1024).toFixed(1);
  const sha = createHash('sha256').update(body).digest('hex');
  return [
    `[FILE UPLOAD] ${filename}`,
    `Type: ${mimeType}`,
    `Size: ${sizeKb} KB`,
    `SHA-256: ${sha}`,
    `Description: Synthetic fixture for pipeline stress test`,
    `Extracted-Text:`,
    body,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// FIXTURE 1: ML / NDVI cloud-edge correction (research log, dense hypothesis)
// ---------------------------------------------------------------------------
const f01_body = `
RESEARCH LOG — AgriSense FY26 Sprint 11
Date: 2025-10-22
Author: Dr. M. Tanaka (Senior Research Scientist)

Sprint goal: Determine whether a continuous bias-correction model can recover
unbiased NDVI for Sentinel-2 pixels within 1.5 km of cloud edges over Australian
wheat regions.

Hypothesis 1: A regression model with features (BRDF_residual, view_angle,
cloud_adjacency_distance) can predict the NDVI correction factor with RMSE
< 0.05 on a held-out validation set drawn from temperate Australian wheat
regions.

Hypothesis 2: The relative contribution of residual atmospheric scattering
versus BRDF residuals shifts continuously with distance to cloud edge
(d in [0, 1500] m). Specifically, scattering dominates in the d<400m band
and BRDF residuals dominate in d>800m.

Technical uncertainty: Existing operational atmospheric correction systems
(MACCS, FORCE-L2) treat the cloud-edge zone as a binary mask. No published
technique provides a continuous correction in the 0-1.5km adjacency band
that has been validated against ground-truth NDVI in Australian cropping
systems. The competent-professional test (s.355-25(1)(b)) is therefore
satisfied — no peer-reviewed paper as of 2025 Q3 addresses Australian biome
cloud-edge corrections at sub-pixel resolution.

Experimental results:
- XGBoost (500 trees, max_depth=4) trained on 1,920 paired pixel pairs.
- Initial feature set (BRDF_residual + cloud_adjacency_distance only): RMSE = 0.062
- Retrained with view_angle added: RMSE = 0.041, R² = 0.78 on 480 test pairs.
- Independent ground-truth at 18 Liverpool Plains sites: MAE 0.038 corrected
  vs. 0.107 uncorrected — a 64% reduction.

Failed approaches this sprint:
1. Random Forest baseline (400 trees, default sklearn): RMSE = 0.071, did
   not improve on the existing MACCS binary mask. Discarded.
2. Linear regression on log(d) of cloud distance: RMSE = 0.089. Confirmed
   the relationship is non-linear, justifying the tree-based ensemble.

New knowledge contribution: First continuous BRDF-aware correction
demonstrated for Sentinel-2 cloud-edge zones in Australian wheat regions.
The 0.041 RMSE on validation is materially below the MACCS baseline
(0.107) and below the literature-reported best (Hagolle 2017) of 0.058
for European biomes.

Next sprint: extend validation to tropical north Queensland (different
cloud morphology). Allocate 40 person-hours.
`.trim();

// ---------------------------------------------------------------------------
// FIXTURE 2: Invoice schedule (vendor expenditure, multiple line items)
// ---------------------------------------------------------------------------
const f02_body = `
INVOICE SCHEDULE — AgriSense FY26 Q1
Period: 1 July 2025 – 30 September 2025
Approved by: K. Patel (CFO)

Invoice 1
Vendor: Cloudtech Spectral Systems Pty Ltd
Date: 22 October 2025
Invoice Number: INV-2025-104
Line items:
  - BRDF normalization pass (Sentinel-2 imagery preprocessing): $14,500.00 AUD
  - Cloud-mask post-processing: $3,200.00 AUD
GST: $1,770.00 AUD
Total: $19,470.00 AUD

Invoice 2
Vendor: NSW Field Operations
Date: 22 October 2025
Invoice Number: NSW-FO-2025-44
Line items:
  - Spectrometer hire week 1: $1,400.00 AUD
  - Spectrometer hire week 2: $1,400.00 AUD
  - Spectrometer hire week 3: $1,400.00 AUD
GST: $420.00 AUD
Total: $4,620.00 AUD

Invoice 3
Vendor: Atmospheric Modelling Australia
Date: 5 November 2025
Invoice Number: AMA-RD-7714
Line items:
  - Custom radiative transfer code review (40 hrs @ $180/hr): $7,200.00 AUD
GST: $720.00 AUD
Total: $7,920.00 AUD

Invoice 4
Vendor: CSIRO Liverpool Plains Field Station
Date: 28 November 2025
Invoice Number: CSIRO-LP-2025-09
Line items:
  - Ground-truth NDVI campaign access fee (18 sites): $9,000.00 AUD
  - Site staff support 5 days: $4,500.00 AUD
GST: $1,350.00 AUD
Total: $14,850.00 AUD

Total R&D-eligible expenditure this period: $46,860.00 AUD (incl GST).
Allocated against AgriSense Core Activity CA-01 (cloud-edge bias correction).
`.trim();

// ---------------------------------------------------------------------------
// FIXTURE 3: Battery materials research (multi-hypothesis, different domain)
// ---------------------------------------------------------------------------
const f03_body = `
WORK PACKAGE WP3 — Solid-state cathode chemistry
Project: Ampere FY26 — Lithium-iron phosphate alternatives
Period: October 2025 – February 2026
Lead investigator: Dr. R. Singh

Programme overview: develop a coating chemistry for LFP cathodes that
maintains capacity above 140 mAh/g after 2,000 cycles at 1C in a
prototype pouch cell. Existing LFP cathodes from commercial suppliers
exhibit 95-110 mAh/g after 2,000 cycles; the 140 mAh/g target is a
~30% improvement over the state of the art.

Hypothesis 3A: A 2-5nm Al2O3 conformal coating deposited by atomic
layer deposition (ALD) preserves the LFP olivine structure under
cycling stress better than the polymer-binder approach used by
suppliers Y and Z. Falsifiable criterion: capacity retention measured
at 1C after 2,000 cycles must exceed 140 mAh/g.

Hypothesis 3B: The coating thickness has a non-monotonic effect on
capacity — too thin and SEI penetration causes accelerated capacity
fade; too thick and Li+ transport is hindered. Optimal thickness
predicted in the 2.5-3.5nm band based on the Wang 2024 simulation
paper, but unverified for the specific LFP particle morphology we use.

Experimental results to date:
- Coating run 1 (2nm Al2O3): capacity = 138 mAh/g @ cycle 2000, FAIL
  on the 140 threshold but materially above the suppliers' best.
- Coating run 2 (3nm Al2O3): capacity = 144 mAh/g @ cycle 2000, PASS.
- Coating run 3 (5nm Al2O3): capacity = 119 mAh/g @ cycle 2000, FAIL.
  Confirms hypothesis 3B — coating is too thick at 5nm.

Failed approach: coating run 4 attempted MgF2 instead of Al2O3 (cheaper
precursor). Capacity = 86 mAh/g @ cycle 500 — catastrophic failure
attributed to F- migration into the SEI. Approach abandoned for
this work package; written up in failure log F4.

New knowledge: documented the first 3nm-Al2O3 ALD coating on this
specific LFP particle morphology achieving 144 mAh/g at 1C after
2000 cycles. Coating chemistry to be filed as a trade secret;
provisional patent application drafted.

Supporting activity SA-01: ALD reactor preventive maintenance —
80 hrs total this sprint, classified under s.355-30 dominant-purpose
test as it is directly required to perform Core Activity 1 (coating
deposition) and has no commercial use outside R&D.

Next sprint: full DSC + cryo-EM characterisation of the 3nm samples.
`.trim();

// ---------------------------------------------------------------------------
// FIXTURE 4: Meeting minutes (sparse activity content, mostly procedural)
// ---------------------------------------------------------------------------
const f04_body = `
MEETING MINUTES — Ampere FY26 Sprint Review
Date: 2025-11-10
Attendees: R. Singh, K. Patel, M. Lee, J. Wang, External: P. Costa (advisor)

1. Opening (R. Singh)
Welcomed P. Costa, our new electrochemistry advisor.

2. Sprint 5 review
- WP3 hypothesis 3A: validated at 3nm thickness (PASS).
- WP3 hypothesis 3B: validated; non-monotonic effect confirmed.
- WP4 (electrolyte additive screening): on hold pending material
  delivery from supplier Y.
- Action item AI-2025-44: J. Wang to draft IP search results in time
  for the next sprint review.

3. Budget update (K. Patel)
- Spend YTD: $187k of $420k FY26 budget.
- Vendor expenditure tracking on schedule.
- Recommend $25k contingency reallocation from WP5 to WP3 for
  additional coating runs.

4. P. Costa advisory comments
- Suggests considering Al2O3-Li2O composite coatings as future direction.
- Notes that the Wang 2024 paper has a known erratum on the simulation
  boundary conditions — recommends re-running predictions with
  corrected BCs before publishing.

5. Next sprint
- Focus on cryo-EM characterisation.
- Begin drafting AusIndustry registration draft for FY26.

Meeting closed 14:32.
`.trim();

// ---------------------------------------------------------------------------
// FIXTURE 5: Test plan (procedural, structured experimental design)
// ---------------------------------------------------------------------------
const f05_body = `
TEST PLAN — TP-2025-08
Title: Validation of continuous BRDF correction model on Queensland tropical biome
Sprint: AgriSense FY26 Sprint 12
Author: M. Tanaka

Objective: Determine whether the BRDF correction model trained on
temperate Australian wheat regions (RMSE 0.041 on Liverpool Plains
validation set) generalises to tropical north Queensland sugar-cane
imagery with materially different cloud morphology.

Hypothesis: The trained model will achieve RMSE < 0.07 on a held-out
Queensland validation set. Threshold is looser than the temperate
0.05 target to account for biome shift; if RMSE > 0.10 the model
has failed to generalise and we must investigate domain-adaptation
techniques.

Procedure:
1. Acquire Sentinel-2 Level-2A scenes covering 6 Queensland sugar-cane
   sites (Burdekin, Herbert, Bundaberg) for the period Oct 2024 to
   Sep 2025.
2. Identify cloud-edge pixels within 1.5km of cloud mask boundaries
   using the existing pixel-pair selection script.
3. Acquire ground-truth NDVI from CSIRO and Sugar Research Australia
   at 24 fixed sites during the same period.
4. Run the temperate-trained XGBoost model on the Queensland pixels.
5. Compute RMSE / MAE against ground-truth.
6. If RMSE > 0.07, train a second model on combined temperate +
   Queensland data and compare.

Pre-registered analysis:
- Primary metric: RMSE on 480 paired pixels (480 chosen for power
  parity with the temperate validation set).
- Secondary: per-site MAE to detect any systematic site bias.
- Stop criterion: RMSE > 0.15 on the first 100 pixels (training-set
  failure mode); abort and revert to deterministic atmospheric
  correction.

Resources: 12 person-days, $4,800 imagery licence, $9,500 ground-truth
campaign fee.
`.trim();

// ---------------------------------------------------------------------------
// FIXTURE 6: Empty / minimal content (edge case)
// ---------------------------------------------------------------------------
const f06_body = `Meeting was rescheduled.`;

// ---------------------------------------------------------------------------
// FIXTURE 7: Pure prose, no hypothesis (low-signal — analyzer should
// either return 0 activities or low-confidence ones)
// ---------------------------------------------------------------------------
const f07_body = `
Quarterly newsletter — November 2025

This quarter we welcomed three new graduate engineers to the
Ampere battery programme. The team enjoyed an off-site retreat at
Cradle Mountain in October, where Dr. Singh gave a keynote talk on
the future of lithium chemistries. We are also pleased to announce
that Ampere has been featured in the Cleantech 50 list for the
second consecutive year. A round of applause goes to the entire
team for their continued effort. Looking forward to a productive
Q4 and a well-earned summer break!
`.trim();

// ---------------------------------------------------------------------------
// FIXTURE 8: Failure-focused log (iteration + lessons learned)
// ---------------------------------------------------------------------------
const f08_body = `
FAILURE REPORT — F2025-11
Activity: AgriSense CA-01 (cloud-edge bias correction)
Date: 2025-11-18
Author: M. Tanaka

Approach attempted:
Substituted XGBoost with a 5-layer transformer (32-dim embedding,
4 attention heads) using the same input features. Goal was to capture
non-local spatial context across the cloud-edge band.

Result observed:
- Validation RMSE on Liverpool Plains: 0.083 (worse than XGBoost 0.041).
- Training cost ~6x XGBoost.
- Attention maps showed the model was attending to noise rather than
  learning the cloud-distance gradient.

Root cause:
The 1,920-pair training set is too small to fit a transformer of this
size. Per Goyal 2023 the data-to-parameter ratio for stable transformer
training is roughly 100:1 for the embedding dimension; our ratio was
12:1.

Knowledge gained:
1. XGBoost remains the right choice given the data budget. To justify
   a transformer we'd need either 20k+ pairs (3-4 sprints of data
   collection) or a strong pre-training signal from an adjacent task.
2. Filed a request to investigate self-supervised pre-training on
   Australian crop NDVI time-series as a separate WP if the
   transformer direction becomes attractive later.

Pivot action: Discontinued transformer line. Returning XGBoost-with-
view-angle to production for the FY26 application. Failure cost:
4 person-days of effort, 14kWh compute. Logged under failure register
F2 for the AusIndustry application.
`.trim();

// ---------------------------------------------------------------------------
// FIXTURE 9: Long-form research paper extract (large size, dense content)
// ---------------------------------------------------------------------------
const f09_body = `
SECTION 4 — RESEARCH DESIGN AND EXPERIMENTAL RESULTS
Internal paper draft: "Continuous BRDF-aware bias correction for
Sentinel-2 cloud-edge zones over Australian wheat: a 2025
operational study"

${'Section text repeated for size. '.repeat(200)}

4.1 Study sites
We selected 18 fixed-position validation sites across the Liverpool
Plains (NSW), Wimmera (VIC), and Esperance Plains (WA). Each site
operates a calibrated MSS-Compact spectrometer providing reflectance
in the 400-900nm range at hourly intervals during daylight, with
gaps filled by a Kalman-smoothed climatology. Site coordinates are
listed in Appendix A.

4.2 Data preparation
For each site we extracted Sentinel-2 Level-2A pixels overlapping
the site footprint (3×3 pixels for spatial averaging) from January
2024 through September 2025. We retained only scenes where the
target pixel was within 1.5km of a cloud-mask boundary as determined
by the MAJA cloud mask v3.

${'Methods paragraph. '.repeat(300)}

4.3 Model training and validation
Training: 1,920 pixel-pair samples drawn from 14 of the 18 sites.
Validation: 480 pixel-pair samples from the held-out 4 sites.
Independent test: ground-truth NDVI from all 18 sites collected
during the validation window, providing 2,176 independent
comparisons.

4.4 Results
The trained XGBoost model achieved validation RMSE 0.041 (95% CI
[0.038, 0.044]) and MAE 0.032 against the held-out site pixels.
Against the independent ground-truth, the corrected NDVI showed MAE
0.038 versus the uncorrected baseline MAE of 0.107 — a 64.5%
reduction (95% CI [60.1%, 68.7%], paired t-test p < 0.001).

${'Discussion paragraph. '.repeat(200)}

4.5 Comparison with existing operational approaches
The MACCS-FORCE-L2 binary cloud-edge mask approach (the current
operational baseline in Australian agriculture) provides no
correction in the cloud-adjacency band — pixels are flagged
"contaminated" and excluded from downstream analysis. Our
continuous correction recovers ~22% more usable pixels per cycle
while delivering MAE within 0.038 of ground truth.

4.6 Limitations
The temperate Australian wheat focus restricts generalisability;
the tropical Queensland validation (sprint 12, ongoing) will
indicate the cross-biome generalisation potential.
`.trim();

// ---------------------------------------------------------------------------
// FIXTURE 10: Unicode + emoji + foreign-language stress test (edge case)
// ---------------------------------------------------------------------------
const f10_body = `
RESEARCH NOTES — Symposium attendance
Conference: International Battery Materials Symposium, Yokohama 横浜
Date: 2025-09-15 to 2025-09-18

Key sessions:
🔋 Plenary by Dr. Tanaka 田中 on solid-state electrolytes
🔬 Workshop on cryo-EM for battery materials
📊 Poster session — 240 posters, 18 directly relevant to LFP coatings

Personal notes:
The Yokohama group (横浜国立大学) presented a 4nm Al2O3 coating result
that aligns closely with our hypothesis 3B optimum band (2.5–3.5nm).
Their cycle-2000 capacity was 142 mAh/g vs. our 144 mAh/g — within
measurement uncertainty.

Hypothesis arising:
The convergence of two independent labs on a 3-4nm Al2O3 optimum
suggests there is a fundamental physical reason (probably SEI
nucleation length scale) that the optimum sits in this band rather
than 5nm+ or sub-1nm. This is testable: vary the SEI nucleation
inhibitor concentration and observe whether the optimum band shifts
correspondingly.

Suggested action: discuss with Dr. Singh on Monday. Allocate 1 sprint
to a directed experimental investigation if hypothesis interest
remains after the discussion. Estimated cost AUD $18,500 incl
materials + 80 hrs labour.

— end of notes —
`.trim();

// ---------------------------------------------------------------------------
// FIXTURE 11: Vendor quote (similar shape to invoice but no actual amounts paid)
// ---------------------------------------------------------------------------
const f11_body = `
VENDOR QUOTE — QT-2025-1148
From: Cryo Electronics Australia
To: Ampere FY26 Programme
Date: 2025-11-04

Service: Cryo-EM characterisation of LFP cathode samples
Sample preparation:    $2,500.00 AUD ex GST
EM session (8 hours):  $9,600.00 AUD ex GST
Data analysis:         $3,200.00 AUD ex GST
Subtotal:              $15,300.00 AUD ex GST
GST 10%:               $1,530.00 AUD
Total:                 $16,830.00 AUD

Terms: 30 day NET. Quote valid 60 days. Lead time for booking: 3 weeks.
This is a QUOTE, not an invoice. No payment due unless services
are commissioned.
`.trim();

// ---------------------------------------------------------------------------
// FIXTURE 12: IP search results (precedent-focused, not generative)
// ---------------------------------------------------------------------------
const f12_body = `
IP SEARCH SUMMARY — IS-2025-AL2O3-COAT
Subject: Prior art search for Al2O3 ALD coatings on LFP cathodes
Date: 2025-11-15
Searcher: J. Wang
Database: USPTO, EPO, IP Australia, WIPO

Search terms: ((Al2O3 OR aluminum oxide OR alumina) AND (LFP OR lithium iron
phosphate OR olivine) AND (coat* OR deposit* OR layer)) AND ALD

Results: 47 patents and applications identified. 12 reviewed in detail.

Most relevant prior art:
1. US 11,234,567 (Toyota, granted 2022): Al2O3 ALD coating on
   LiNi0.5Mn1.5O4 cathodes, claims a thickness range 5-20nm.
2. WO 2023/0998765 (Samsung SDI, pending): Multi-layer Al2O3-LiF
   coating on NCM cathodes. Different chemistry from our target.
3. AU 2024904567 (CSIRO, granted 2024): Al2O3-MgO composite coating
   on LFP. Different precursor combination; thickness range 8-15nm.
4. JP 2024-156789 (Yokohama University, application): Al2O3 ALD on
   LFP cathodes at 3-4nm thickness — closest to our work. Filed
   2024-08, still pending. Critical to monitor.

Assessment: Our 2.5-3.5nm window MAY conflict with the Yokohama
application JP 2024-156789 depending on how their claims read after
prosecution. Recommend:
1. File a provisional in Australia within 30 days establishing our
   priority date on the SPECIFIC particle morphology and process
   parameters.
2. Continue developing the experimental work in parallel.

Conclusion: The technical uncertainty test (s.355-25(1)(a)) is
clearly met — no granted patent describes the specific 2.5-3.5nm
Al2O3 ALD coating on the LFP particle morphology we use. The Yokohama
application has not yet been granted and overlaps only partially.
`.trim();

// ---------------------------------------------------------------------------
// FIXTURE 13: Malformed payload — no Extracted-Text section (edge case;
// extraction worker should mark as failed)
// ---------------------------------------------------------------------------
const f13_raw_text = `[FILE UPLOAD] corrupted.docx
Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document
Size: 0.0 KB
SHA-256: 0000000000000000000000000000000000000000000000000000000000000000
Description: Synthetic fixture for pipeline stress test — missing Extracted-Text section
`;

// ---------------------------------------------------------------------------
// FIXTURE 14: Very short extracted text (under the 50-char floor — should
// be marked failed with no_extracted_text)
// ---------------------------------------------------------------------------
const f14_body = `OK`;

// ---------------------------------------------------------------------------
// FIXTURE 15: Massive (60k+ chars — exceeds the MAX_TEXT_CHARS truncation
// threshold in haiku.ts; worker should truncate and still complete)
// ---------------------------------------------------------------------------
const f15_body = `MASSIVE RESEARCH LOG\n${'Cycle data: capacity = 140 mAh/g, time = 8h. '.repeat(1500)}`;

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

export const SYNTHETIC_FIXTURES: SyntheticDoc[] = [
  {
    id: 'fx-01-ndvi-research-log',
    label: 'NDVI cloud-edge research log (dense hypothesis)',
    raw_text: wrapAsFileUpload('agrisense-sprint-11.md', 'text/markdown', f01_body),
    expected: {
      activities_min: 1,
      activities_max: 4,
      invoices_min: 0,
      invoices_max: 2,
      summary_required: true,
      edge_case: false,
    },
  },
  {
    id: 'fx-02-invoice-schedule',
    label: 'Q1 vendor invoice schedule (4 invoices)',
    raw_text: wrapAsFileUpload('q1-invoices.txt', 'text/plain', f02_body),
    expected: {
      activities_min: 0,
      activities_max: 2,
      invoices_min: 3,
      invoices_max: 4,
      summary_required: true,
      edge_case: false,
    },
  },
  {
    id: 'fx-03-battery-coating-research',
    label: 'Battery coating WP3 (multi-hypothesis, failure log)',
    raw_text: wrapAsFileUpload('ampere-wp3-coating.md', 'text/markdown', f03_body),
    expected: {
      activities_min: 1,
      activities_max: 3,
      invoices_min: 0,
      invoices_max: 0,
      summary_required: true,
      edge_case: false,
    },
  },
  {
    id: 'fx-04-meeting-minutes',
    label: 'Sprint review meeting minutes (procedural)',
    raw_text: wrapAsFileUpload('sprint-5-minutes.md', 'text/markdown', f04_body),
    expected: {
      activities_min: 0,
      activities_max: 2,
      invoices_min: 0,
      invoices_max: 1,
      summary_required: true,
      edge_case: false,
    },
  },
  {
    id: 'fx-05-test-plan',
    label: 'Queensland tropical validation test plan',
    raw_text: wrapAsFileUpload('tp-2025-08.md', 'text/markdown', f05_body),
    expected: {
      activities_min: 0,
      activities_max: 2,
      invoices_min: 0,
      invoices_max: 1,
      summary_required: true,
      edge_case: false,
    },
  },
  {
    id: 'fx-06-near-empty',
    label: 'Near-empty doc (edge case)',
    raw_text: wrapAsFileUpload('rescheduled.txt', 'text/plain', f06_body),
    expected: {
      activities_min: 0,
      activities_max: 0,
      invoices_min: 0,
      invoices_max: 0,
      summary_required: false, // too short
      edge_case: true,
    },
  },
  {
    id: 'fx-07-newsletter-no-hypothesis',
    label: 'Quarterly newsletter (low signal)',
    raw_text: wrapAsFileUpload('newsletter-nov-2025.md', 'text/markdown', f07_body),
    expected: {
      activities_min: 0,
      activities_max: 1,
      invoices_min: 0,
      invoices_max: 0,
      summary_required: true,
      edge_case: false,
    },
  },
  {
    id: 'fx-08-failure-report',
    label: 'Transformer failure report (iteration/lessons)',
    raw_text: wrapAsFileUpload('f2025-11.md', 'text/markdown', f08_body),
    expected: {
      activities_min: 0,
      activities_max: 2,
      invoices_min: 0,
      invoices_max: 0,
      summary_required: true,
      edge_case: false,
    },
  },
  {
    id: 'fx-09-long-paper-extract',
    label: 'Long-form paper extract (size stress)',
    raw_text: wrapAsFileUpload('paper-draft-s4.md', 'text/markdown', f09_body),
    expected: {
      activities_min: 1,
      activities_max: 3,
      invoices_min: 0,
      invoices_max: 0,
      summary_required: true,
      edge_case: false,
    },
  },
  {
    id: 'fx-10-unicode-symposium',
    label: 'Symposium notes with unicode + emoji (edge case)',
    raw_text: wrapAsFileUpload('symposium-yokohama.md', 'text/markdown', f10_body),
    expected: {
      activities_min: 0,
      activities_max: 2,
      invoices_min: 0,
      invoices_max: 0,
      summary_required: true,
      edge_case: true,
    },
  },
  {
    id: 'fx-11-vendor-quote',
    label: 'Vendor quote (not invoice — should not be extracted as invoice)',
    raw_text: wrapAsFileUpload('qt-2025-1148.txt', 'text/plain', f11_body),
    expected: {
      activities_min: 0,
      activities_max: 0,
      invoices_min: 0,
      invoices_max: 0, // tricky case — model may extract OR may correctly skip
      summary_required: true,
      edge_case: true,
    },
  },
  {
    id: 'fx-12-ip-search-precedent',
    label: 'IP search precedent summary (regulatory framing)',
    raw_text: wrapAsFileUpload('is-2025-al2o3.md', 'text/markdown', f12_body),
    expected: {
      activities_min: 0,
      activities_max: 1,
      invoices_min: 0,
      invoices_max: 0,
      summary_required: true,
      edge_case: false,
    },
  },
  {
    id: 'fx-13-malformed-no-extracted-text',
    label: 'Malformed: missing Extracted-Text section (edge case)',
    raw_text: f13_raw_text,
    expected: {
      activities_min: 0,
      activities_max: 0,
      invoices_min: 0,
      invoices_max: 0,
      summary_required: false,
      edge_case: true,
    },
  },
  {
    id: 'fx-14-under-50-chars',
    label: 'Under-50-char extracted text (edge case — should fail)',
    raw_text: wrapAsFileUpload('tiny.txt', 'text/plain', f14_body),
    expected: {
      activities_min: 0,
      activities_max: 0,
      invoices_min: 0,
      invoices_max: 0,
      summary_required: false,
      edge_case: true,
    },
  },
  {
    id: 'fx-15-oversized',
    label: 'Oversized doc (60k+ chars — should truncate and complete)',
    raw_text: wrapAsFileUpload('massive-research-log.md', 'text/markdown', f15_body),
    expected: {
      activities_min: 0,
      activities_max: 2,
      invoices_min: 0,
      invoices_max: 0,
      summary_required: true,
      edge_case: true,
    },
  },
];

/** Convenient subsets for targeted testing. */
export const SYNTHETIC_FIXTURES_BY_ID: Record<string, SyntheticDoc> = Object.fromEntries(
  SYNTHETIC_FIXTURES.map((f) => [f.id, f]),
);

export const SYNTHETIC_FIXTURES_HAPPY_PATH: SyntheticDoc[] = SYNTHETIC_FIXTURES.filter(
  (f) => !f.expected.edge_case,
);

export const SYNTHETIC_FIXTURES_EDGE_CASES: SyntheticDoc[] = SYNTHETIC_FIXTURES.filter(
  (f) => f.expected.edge_case,
);
