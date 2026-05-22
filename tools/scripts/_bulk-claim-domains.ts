/**
 * Domain configs for `seed-bulk-claims.ts`. Ten distinct R&D programs,
 * each on its own consultant firm tenant. The generator samples vendors
 * + theme phrases from these pools to compose realistic noise — 500
 * transactions, 80 notes, 120 images, plus a few PDFs / voice / sheets
 * per claim — without the test fixture being identical-looking across
 * claims.
 *
 * Vendors are categorised by RD relevance: rdCritical (the core R&D
 * inputs), rdSupporting (compute, lab consumables, metrology — would
 * map to the supporting activity if discovered), and nonRd (admin,
 * insurance, marketing — should NOT be claimable). The bulk seed
 * splits the 500 transactions across the three pools roughly 40/30/30,
 * and the mapping engine's job is to figure out which is which.
 */

export interface Domain {
  slug: string;
  firm: { name: string; slug: string };
  user: { name: string; email: string };
  claimant: { name: string; abn?: string };
  project: { name: string; summary: string };
  vendors: {
    rdCritical: string[];
    rdSupporting: string[];
    nonRd: string[];
  };
  themes: {
    hypothesis: string[];
    observation: string[];
    experiment: string[];
    iteration: string[];
    uncertainty: string[];
    newKnowledge: string[];
    timeLog: string[];
    associateFlag: string[]; // meeting / decision notes
  };
  imageSubjects: string[];
  pdfTitles: string[];
  voiceNoteTopics: string[];
}

/**
 * Contamination pool — notes that LOOK like R&D evidence but are
 * actually non-R&D corporate activity. Shared across every domain
 * because admin / marketing / refactoring noise reads the same across
 * industries. The generator stamps these with
 * `payload.rd_band_hint = 'non_rd'` so the scoring CLI can verify the
 * classifier flagged them INELIGIBLE rather than rolling them into the
 * claim.
 *
 * Grouped by the HEURISTIC kind a naive pattern matcher might assign
 * (EXPERIMENT-looking, ITERATION-looking, etc.). The point: only
 * semantic classification catches these — keyword matching would put
 * them straight into the claim.
 */
export const CONTAMINATION_THEMES: {
  experiment: string[];
  iteration: string[];
  observation: string[];
  timeLog: string[];
  associateFlag: string[];
} = {
  experiment: [
    'A/B test on the landing page hero — variant B (orange CTA) lifted CTR by 12% vs control. Promoting to default for Q3.',
    'Email subject-line experiment across the {n}-user newsletter cohort. Open-rate winner clear after {h} h.',
    'Pricing-page experiment — added the "$30k founder" tile. Conversion lift {pct}% but anchored on $60k tile.',
    'Onboarding-flow eval — removed the email-verification step for sub-trial accounts. Drop in support tickets {pct}%.',
    'Internal tool eval — Notion vs Linear vs Coda for the program board. Voted Linear unanimously after a fortnight trial.',
  ],
  iteration: [
    'Refactored the legacy reports module — extracted the date-window helper into shared/date. No behaviour change; tests still green.',
    'Migrated the team Slack workspace to the new pricing plan. Imported {n} historic channels; archived {old} inactive.',
    'Switched the CI runner from {old} to {new} after a Q2 pricing review. Build-time delta {pct}%.',
    'Bumped the staging cluster from t3.large to t3.xlarge after the OOM kills on {temp} k req/min sustained load.',
    'Cleaned up the marketing-site favicon set after the {b} brand-asset review. No code change beyond /public.',
  ],
  observation: [
    'Q{n} marketing spend review — agency budget tracking 8% under target. Surplus shifting to Q{next} brand work.',
    'PI premium quote came back from Marsh — {pct}% above last year. Need to raise this with the broker.',
    'Salesforce seat audit — {n} inactive logins this quarter. Reclaiming for the FY26 budget.',
    'Office lease renewal landed — same terms, +3% on the annual review. Signed and filed.',
    'Quarterly team NPS survey result — {n} responses, average score {pct}. Two themes: tooling fragmentation, more 1:1s.',
  ],
  timeLog: [
    '{hours} h on Q{n} board-pack preparation + ELT review meeting',
    '{hours} h on FY26 budget reforecast + spreadsheet rebuild',
    '{hours} h on tax-prep handover with EY + supporting documentation',
    '{hours} h on PI insurance renewal — broker call, schedule review, signing',
    '{hours} h on payroll system migration (admin assistant project)',
  ],
  associateFlag: [
    'Team offsite at the wineries — Tuesday agenda whiteboarded then dinner at the cellar door. Some great cross-team conversations.',
    'Onboarded new admin assistant — set up payroll, HR system, Slack, calendar. Took most of Monday.',
    'Renewed PI insurance with Marsh — moved from tier C2 to B1 after the evidence-chain conversation last quarter.',
    'Tax prep for FY26 with EY — handover meeting, evidence pack agreed, return drafted by end of next week.',
    'Q{n} board pack review with the CFO — minor tweaks to the slide deck; nothing structural.',
  ],
};

export const DOMAINS: Domain[] = [
  // ── 1. Vantage Industries — Hi-temp alloy phase stability ──────────
  {
    slug: 'vantage-alloys',
    firm: { name: 'Pemberton & Cole', slug: 'pemberton-cole' },
    user: { name: 'Anna Pemberton', email: 'anna.pemberton@pemberton.test' },
    claimant: { name: 'Vantage Industries Pty Ltd', abn: '12 345 678 901' },
    project: {
      name: 'Hi-temp alloy phase-stability program',
      summary:
        'B-substituted gamma-prime alloy R&D for components operating above 800 °C. Furnace cycling, quench-rate sensitivity, XRD at temperature, casting trials.',
    },
    vendors: {
      rdCritical: [
        'Bluescope Labs Pty Ltd',
        'CSIRO Materials',
        'Sandvik Coromant Australia',
        'Höganäs APAC',
        'Carpenter Technology APAC',
        'ATI Specialty Alloys',
        'Praxair Materials Tech',
        'Thermo-Calc Software',
        'Bruker XRD APAC',
        'Hardinge Workholding',
        'IPSEN Heat Treatment',
        'Element Materials Testing',
        'Stork Australia',
        'Holcroft Furnace',
      ],
      rdSupporting: [
        'AWS Australia Pty Ltd',
        'Agilent Metrology',
        'Coregas',
        'BOC Industrial Gases',
        'Olympus Microscopy',
        'Keyence Australia',
        'JetBrains s.r.o.',
        'GitHub Inc.',
        'Anthropic Australia',
        'Comsol AB',
      ],
      nonRd: [
        'Officeworks',
        'Aon Risk Services',
        'Marsh Insurance',
        'PwC Tax Advisory',
        'Webjet Corporate',
        'Salesforce Australia',
        'Telstra Corporate',
        'Bunnings Warehouse',
        'Caltex StarCard',
        'IPS Construction',
      ],
    },
    themes: {
      hypothesis: [
        'We hypothesise that the B+{x}% composition will preserve γ′ phase stability at {temp} °C under a {rate} K/s quench for at least {window} seconds',
        'The N{prev} cracking is driven by quench-rate sensitivity rather than composition — N{next} will hold a {temp} °C / {rate} K/s envelope without surface cracking',
        'Modified crucible geometry should reduce the mass-loss variance to within the {tol} g tolerance observed in the N7 reference protocol',
      ],
      observation: [
        'N{n} specimen survived the {rate} K/s quench from {temp} °C; mass loss {ml} g (within tolerance). No surface cracking visible at 5× loupe.',
        'XRD at {temp} °C: γ′ peak intensity {pct}% of reference; phase boundary stable through {window} s window. Stage drifted +0.{cs} °C — within run-to-run repeatability.',
        'Two faint banding marks at upper third of N{n} specimen, non-penetrating. Cross-section etch tomorrow.',
      ],
      experiment: [
        'Furnace cycle N{n} — B+{x}% composition, argon shroud, Type-K probes P1/P2/P3 calibrated against cert {cert}',
        'High-temp XRD survey at {temp} °C, scan rate 0.{cs}°/s, dwell 30 s per step',
        'Metallographic cross-section preparation: polish to 1 µm, etch in modified Kallings reagent, optical at 200×–1000×',
      ],
      iteration: [
        'Adjusted quench rate from {rate1} to {rate2} K/s after N{n} cracked at the fillet — same crack pattern at slower rate ruled out quench-rate as sole driver',
        'Crucible geometry revised — radius increased from 18 to 22 mm to reduce thermal-gradient stress at the corner',
        'Argon flow stepped up from 8 to 12 L/min after N{n} oxidation halo; held N{next} surface clean through cycle',
      ],
      uncertainty: [
        'No published prior art for B-substituted γ′ above 800 °C — phase-boundary behaviour unknown',
        'Quench-rate sensitivity envelope not documented for this composition class',
        'Whether the B+{x}% ratio is sufficient to suppress fillet cracking without a creep penalty remains open',
      ],
      newKnowledge: [
        'N{n} held intact through to room temperature — first B+{x}% run to survive the {rate} K/s quench. Closes N7 hypothesis branch.',
        'Discovered that crucible-corner thermal gradient drives the N10/N11 fillet cracks, not the composition. Geometry revision unlocks the result envelope.',
        'γ′ stability holds for the full {window} s window post-quench — opens the casting-trial branch.',
      ],
      timeLog: [
        '{hours} h on Vantage-7 furnace prep + argon shroud calibration (N{n} setup)',
        '{hours} h on Vantage-7 cross-section preparation + metallographic etch',
        '{hours} h on Vantage-7 XRD high-temp stage + data reduction vs N7 reference',
      ],
      associateFlag: [
        'Standup decision: progress N{n} to XRD next week; defer casting-trial branch pending the result',
        'Joint review with Sandvik on the crucible geometry revision — agreed on the 22 mm radius',
        'PR carrier pre-renewal call: contemporaneous-evidence chain reduces premium tier from C2 to B1',
      ],
    },
    imageSubjects: [
      'whiteboard sketch of furnace setup',
      'N{n} specimen pre-cycle',
      'N{n} specimen post-cycle (intact)',
      'cracked fillet macro shot — N10 reference',
      'argon shroud calibration jig',
      'crucible geometry comparison (18 mm vs 22 mm radius)',
      'XRD spectrum γ′ peak overlay',
      'metallographic cross-section at 500×',
      'mass-loss chart (N7 vs N12 reference)',
      'lab book p.{n} (handwritten)',
      'quench bath thermal trace',
      'Type-K probe placement diagram',
    ],
    pdfTitles: [
      'Bluescope test report — N{n} XRD scan',
      'CSIRO contract — phase-stability program FY26',
      'IPSEN heat treatment protocol manual',
      'Sandvik crucible geometry datasheet',
      'Bluescope service agreement Q3 renewal',
    ],
    voiceNoteTopics: [
      'post-N{n}-quench standup result note',
      'pre-XRD-run hypothesis voice memo',
      'casting-trial branch decision note',
    ],
  },

  // ── 2. Lyra Compute — ML inference platform optimisation ───────────
  {
    slug: 'lyra-compute',
    firm: { name: 'TechGrowth Advisory', slug: 'techgrowth' },
    user: { name: 'Sam Tran', email: 'sam.tran@techgrowth.test' },
    claimant: { name: 'Lyra Compute Pty Ltd', abn: '23 456 789 012' },
    project: {
      name: 'Real-time inference platform — kernel + scheduling R&D',
      summary:
        'Custom CUDA / Metal kernels for sub-100 ms LLM inference, novel batching scheduler, FP8 quantisation experiments, latency-aware autoscaler.',
    },
    vendors: {
      rdCritical: [
        'Lambda Labs',
        'CoreWeave',
        'Modal Labs',
        'Together AI',
        'Hugging Face',
        'Anthropic API',
        'OpenAI API',
        'GroundTruth Labs',
        'Vast.ai',
        'Paperspace',
        'NVIDIA Developer Program',
        'Cerebras Systems',
        'Tenstorrent',
      ],
      rdSupporting: [
        'AWS Australia Pty Ltd',
        'Datadog APM',
        'Grafana Labs',
        'GitHub Inc.',
        'Linear',
        'JetBrains s.r.o.',
        'Sentry.io',
        'Vercel Inc.',
        'Honeycomb.io',
      ],
      nonRd: [
        'WeWork Melbourne',
        'Aon Insurance',
        'Stripe',
        'Officeworks',
        'Webjet',
        'Latitude Legal',
        'Slack Technologies',
        'Notion Labs',
      ],
    },
    themes: {
      hypothesis: [
        'Fused softmax+matmul kernel will cut end-to-end latency by {pct}% on B={batch} workloads vs the stock kernel',
        'Continuous-batching scheduler with prefix-cache awareness should hold p99 below {p99} ms at QPS={qps}',
        'FP8 quantisation of the K/V cache should reduce memory pressure by {pct}% without measurable quality loss on MMLU',
      ],
      observation: [
        'kernel-{ver} cold-start p50 {p50} ms / p99 {p99} ms across {n} runs; matches the simulated profile within {tol}%',
        'autoscaler holds queue depth ≤ {qd} under the synthetic shock load; recovers within {recover} s',
        'FP8 K/V cache: MMLU delta -0.{mp} pts vs FP16; latency improvement {pct}%; memory drop {mem}%',
      ],
      experiment: [
        'Microbenchmark — fused vs stock kernel across B ∈ {{ 1, 4, 16, 64 }}, sequence length 2048',
        'Continuous-batching latency profile under Poisson arrivals (λ={lambda}) for 60 s',
        'End-to-end MMLU under FP8 K/V cache, 3 seeds, paired t-test vs FP16',
      ],
      iteration: [
        'Reverted FP8 weight quantisation after MMLU drop — keeping FP8 on K/V cache only',
        'Switched from PagedAttention to a custom block allocator after fragmentation observations',
        'Bumped batch-formation deadline from {old} ms to {new} ms after p99 regression on cold-start',
      ],
      uncertainty: [
        'No literature on combined fused-kernel + continuous-batching latency envelope for our workload mix',
        'FP8 quantisation quality impact on long-context retrieval is not characterised in the published evals',
        'Block allocator vs PagedAttention trade-off under bursty load is open',
      ],
      newKnowledge: [
        'Fused kernel + continuous batching shaves {pct}% end-to-end latency vs the published baseline — first measured result in this combo',
        'FP8 K/V cache is quality-neutral up to context {ctx} k; degrades beyond that — boundary characterised',
        'Block allocator gives lower fragmentation than PagedAttention under our arrival mix but worse p999 — opens a hybrid path',
      ],
      timeLog: [
        '{hours} h on kernel-{ver} fused-attention rewrite + microbenchmark sweep',
        '{hours} h on continuous-batching scheduler + autoscaler integration',
        '{hours} h on FP8 quantisation eval + paired-eval analysis',
      ],
      associateFlag: [
        'Standup: FP8 ships behind a flag; default stays FP16 until long-context eval signs off',
        'Customer call: Anthropic flagged the cold-start latency as a concern — kernel work is on the critical path',
        'PR carrier conversation: contemporaneous eval evidence reduces our liability tier',
      ],
    },
    imageSubjects: [
      'flame graph — fused kernel cold start',
      'latency profile p50/p99/p999 vs batch size',
      'autoscaler queue-depth chart',
      'MMLU paired-eval scatter (FP8 vs FP16)',
      'memory-pressure heatmap under bursty load',
      'whiteboard sketch — block allocator vs PagedAttention',
      'kernel-{ver} disassembly screenshot',
      'cold-start histogram (1000 runs)',
      'continuous-batching state diagram',
      'GPU utilisation timeline (DCGM)',
    ],
    pdfTitles: [
      'Lambda Labs contract — H100 burst capacity FY26',
      'Anthropic API enterprise terms',
      'CoreWeave service agreement Q3',
      'NVIDIA Developer Program — research access',
      'IP assignment — kernel-{ver} contributions',
    ],
    voiceNoteTopics: [
      'kernel-{ver} cold-start finding standup',
      'FP8 long-context eval debrief',
      'autoscaler shock-load post-mortem',
    ],
  },

  // ── 3. Borealis Bio — Microbial fermentation chemistry ─────────────
  {
    slug: 'borealis-bio',
    firm: { name: 'Northern Insights', slug: 'northern-insights' },
    user: { name: 'Mei Chen', email: 'mei.chen@northern.test' },
    claimant: { name: 'Borealis Bio Pty Ltd', abn: '34 567 890 123' },
    project: {
      name: 'Sustainable adipic-acid fermentation R&D',
      summary:
        'Engineered E. coli strain expressing a heterologous adipic-acid pathway. Bioreactor optimisation, substrate-feed strategy, downstream separation.',
    },
    vendors: {
      rdCritical: [
        'Sigma-Aldrich Australia',
        'Eppendorf',
        'Sartorius Stedim',
        'Twist Bioscience',
        'Integrated DNA Technologies',
        'New England Biolabs',
        'Bio-Rad Laboratories',
        'Macrogen Sequencing',
        'Sequencher Genomics',
        'Cytiva Bioprocess',
        'Pall Life Sciences',
        'Thermo Fisher Scientific',
      ],
      rdSupporting: [
        'AWS Australia Pty Ltd',
        'BOC Industrial Gases',
        'Coregas',
        'Genscript',
        'GraphPad Software',
        'Snapgene',
        'Benchling',
      ],
      nonRd: [
        'Officeworks',
        'Aon Risk Services',
        'Marsh Insurance',
        'KPMG Tax',
        'Webjet Corporate',
        'Salesforce',
        'Bunnings',
      ],
    },
    themes: {
      hypothesis: [
        'The {gene}-knockout strain expressing pathway variant v{v} should reach a titer of {titer} g/L on glucose feed at pH {ph}',
        'Pulsed-feed glucose strategy will improve carbon flux to product by {pct}% over continuous feed',
        'Downstream reactive-extraction with {solvent} should recover ≥ {pct}% of the fermentation broth without enzyme inactivation',
      ],
      observation: [
        'Fermentation run F{n} reached {titer} g/L at {h} h; final pH {ph}; OD600 {od} at end',
        'Mass-balance closes within {tol}% across the run; carbon-loss accounting consistent with by-product profile',
        'HPLC peak at {rt} min matches authentic standard within {pct}%; product identity confirmed',
      ],
      experiment: [
        'Bioreactor run F{n} — 5 L vessel, strain v{v}, pulsed glucose feed, DO controlled at {do}%',
        'Substrate sweep: glucose vs glycerol vs xylose at matched C-feed rate',
        'Downstream extraction trial — solvent screen ({solvent1}, {solvent2}, {solvent3}) at 25 °C and 4 °C',
      ],
      iteration: [
        'Strain v{v}+1: re-engineered the pathway terminal step after the v{v} bottleneck identified in F{n}',
        'Switched from continuous to pulsed feed after F{n} substrate inhibition profile',
        'Replaced the in-broth pH probe after F{n} drift exceeded ±0.{dp} pH units',
      ],
      uncertainty: [
        'Whether the heterologous pathway flux is rate-limited by the terminal enzyme or by precursor availability is unresolved',
        'The downstream solvent partition coefficient at pilot scale is not documented in the published literature',
        'Long-term strain stability across {n} generations under selection-free conditions is open',
      ],
      newKnowledge: [
        'Pathway variant v{v} achieves {titer} g/L in 5 L vessel — first heterologous adipic-acid demonstration at this titre in E. coli',
        'Pulsed-feed strategy lifts product flux by {pct}% — characterised the substrate-inhibition envelope',
        'Reactive extraction with {solvent} recovers ≥ {pct}% with the strain enzyme intact — opens the integrated upstream/downstream branch',
      ],
      timeLog: [
        '{hours} h on bioreactor run F{n} setup + monitoring + sampling',
        '{hours} h on HPLC method development + peak identification',
        '{hours} h on strain engineering — Gibson assembly + transformation + colony screen',
      ],
      associateFlag: [
        'Standup: F{n} confirms the v{v} pathway; advance to fed-batch optimisation',
        'Joint review with Twist on the upcoming v{v}+1 build — 6-week lead time agreed',
        'Patent counsel call: pathway v{v} composition disclosed; v{v}+1 to be filed before publication',
      ],
    },
    imageSubjects: [
      'F{n} bioreactor at the {h} h mark',
      'HPLC chromatogram with product peak labelled',
      'whiteboard sketch of pathway variant v{v}',
      'colony plate — strain v{v} screen',
      'mass-balance accounting chart',
      'downstream solvent screen — phase separation',
      'OD600 vs time curve for F{n}',
      'gel electrophoresis — Gibson assembly verification',
      'agitator + DO probe assembly',
      'lab book p.{n} — F{n} run log',
    ],
    pdfTitles: [
      'Twist Bioscience contract — v{v}+1 gene build',
      'NEB enzyme datasheets — Q3 batch',
      'Macrogen sequencing report — strain v{v}',
      'GMP-aligned bioreactor SOP',
      'Patent search — adipic-acid biosynthesis',
    ],
    voiceNoteTopics: [
      'F{n} mid-run observation memo',
      'strain v{v}+1 design rationale',
      'downstream solvent screen result note',
    ],
  },

  // ── 4. GQHC Materials — Graphene composite battery anodes ──────────
  {
    slug: 'gqhc-materials',
    firm: { name: 'Sage R&DTI', slug: 'sage-rdti' },
    user: { name: 'Diego Alvarez', email: 'diego@sage.test' },
    claimant: { name: 'GQHC Materials Pty Ltd', abn: '45 678 901 234' },
    project: {
      name: 'Graphene-silicon composite anode R&D',
      summary:
        'Si/C composite anodes for Li-ion cells with graphene scaffold. Cycle-life testing, dendrite suppression, scale-up to pouch format.',
    },
    vendors: {
      rdCritical: [
        'XG Sciences Graphene',
        'Targray Technology',
        'BTR New Energy',
        'Shanshan Battery Materials',
        'Maccor Cycler',
        'Arbin Instruments',
        'Bio-Logic SP-150',
        'Pacific Scientific Instruments',
        'Sigma-Aldrich',
        'Coregas',
      ],
      rdSupporting: [
        'AWS Australia Pty Ltd',
        'Zeiss Microscopy',
        'Renishaw Raman',
        'Bruker AXS',
        'COMSOL Multiphysics',
        'GitHub Inc.',
      ],
      nonRd: [
        'Officeworks',
        'PwC Tax',
        'Marsh Insurance',
        'Telstra Corporate',
        'Aon Risk',
        'Webjet',
        'Stripe',
      ],
    },
    themes: {
      hypothesis: [
        'Si content of {pct}% in the graphene scaffold will deliver {cap} mAh/g initial capacity at {rate} C-rate without dendrite formation',
        'Pre-lithiation of the Si phase to {li}% should reduce first-cycle irreversible loss below {loss}%',
        'A {thick} µm anode coating will hold ≥ 80% capacity retention through {cyc} cycles',
      ],
      observation: [
        'Cell C{n} — initial discharge {cap} mAh/g; CE {ce}% after cycle 5; no dendrite signature in SEM at 1000×',
        'Capacity retention {ret}% at cycle {cyc}; impedance growth Δ{imp} Ω over the period',
        'Post-mortem SEM: Si particles still in contact with graphene scaffold; no electrode delamination',
      ],
      experiment: [
        'Cycle-life run on Maccor channels {ch} — {cyc} cycles at C/2, voltage window 0.{lo}–1.{hi} V',
        'Galvanostatic intermittent titration — 30-min pulse / 4-h rest, full SOC sweep',
        'Coin-cell baseline vs pouch-format scale-up; capacity normalised by anode mass',
      ],
      iteration: [
        'Reduced binder fraction from {old}% to {new}% after capacity fade in C{n}',
        'Switched from PVDF to CMC/SBR binder after the electrolyte-compatibility result',
        'Increased Si pre-lithiation from {old}% to {new}% after the first-cycle loss observation',
      ],
      uncertainty: [
        'Long-term cycle stability of the Si/graphene interface under the {temp} °C stress test is not characterised',
        'Whether the scale-up from coin-cell to pouch format introduces a uniformity penalty is open',
        'Dendrite-suppression mechanism (mechanical vs electrochemical) remains to be isolated',
      ],
      newKnowledge: [
        'Si/graphene composite at {pct}% Si delivers {cap} mAh/g with {ret}% retention at cycle {cyc} — exceeds the published commercial benchmark',
        'Pre-lithiation of the Si phase reduces first-cycle loss to {loss}% — characterised the dose-response',
        'No dendrite signature observed under the {rate} C-rate stress — opens the fast-charge characterisation branch',
      ],
      timeLog: [
        '{hours} h on coin-cell assembly + Maccor channel setup',
        '{hours} h on SEM post-mortem + image analysis',
        '{hours} h on COMSOL model — Li transport in the composite scaffold',
      ],
      associateFlag: [
        'Standup: advance C{n} to the pouch-format scale-up trial',
        'Targray review: scaffold supplier confirmed the {pct}% Si build',
        'IP counsel: pre-lithiation method ready for provisional filing',
      ],
    },
    imageSubjects: [
      'SEM of Si/graphene composite at 1000×',
      'Maccor cycle-life chart — capacity retention',
      'pouch cell post-cycle CT slice',
      'Raman spectrum — graphene scaffold D/G ratio',
      'XRD pattern overlay (pristine vs cycled)',
      'EDS map — Si distribution in the scaffold',
      'whiteboard sketch — pre-lithiation circuit',
      'cell-build glovebox setup',
      'impedance spectroscopy Nyquist plot',
      'lab book p.{n} — C{n} build log',
    ],
    pdfTitles: [
      'XG Sciences supply contract — Q3 graphene scaffold',
      'Targray Si powder specification',
      'Maccor cycler maintenance contract',
      'IP provisional — pre-lithiation method',
      'COMSOL model documentation v{v}',
    ],
    voiceNoteTopics: [
      'C{n} mid-cycle observation',
      'pouch-format scale-up planning memo',
      'IP filing strategy debrief',
    ],
  },

  // ── 5. Oren Robotics — Autonomous vineyard robotics ────────────────
  {
    slug: 'oren-robotics',
    firm: { name: 'Apex Tax', slug: 'apex-tax' },
    user: { name: 'Jacob Whitford', email: 'jacob.w@apex.test' },
    claimant: { name: 'Oren Robotics Pty Ltd', abn: '56 789 012 345' },
    project: {
      name: 'Autonomous vineyard canopy-management platform',
      summary:
        'Tracked rover with stereo + LiDAR perception for selective canopy thinning. Path planning under inconsistent row geometry, vision-based fruit-load estimation, fleet coordination.',
    },
    vendors: {
      rdCritical: [
        'Velodyne LiDAR',
        'Ouster Inc.',
        'Stereolabs ZED',
        'Intel RealSense',
        'NVIDIA Jetson',
        'Boston Dynamics Spot SDK',
        'iCubic Robotics',
        'Maxon Motor Australia',
        'Bosch Rexroth',
        'igus Bearings',
      ],
      rdSupporting: [
        'AWS Australia Pty Ltd',
        'Roboflow',
        'Weights & Biases',
        'GitHub Inc.',
        'Foxglove Studio',
        'PyTorch Foundation',
      ],
      nonRd: [
        'Officeworks',
        'BP Fuel Card',
        'Aon Insurance',
        'Marsh',
        'Salesforce',
        'PwC Tax',
        'Stripe',
      ],
    },
    themes: {
      hypothesis: [
        'Stereo-LiDAR fusion will hold canopy-edge localisation within ±{tol} cm at {speed} m/s vehicle speed',
        'A learned fruit-load estimator should reach R²={r2} on the cross-cultivar validation set',
        'Adaptive row-following will keep the rover within row geometry for >{pct}% of the season at {speed} m/s',
      ],
      observation: [
        'Field run R{n}: canopy-edge tracking RMSE {rmse} cm across {dist} m at {speed} m/s; no untracked deviations',
        'Fruit-load estimator R² {r2} on validation; underestimates densely-clustered bunches by {pct}%',
        'Battery-runtime test: rover held {h} h of canopy work on the {kw} kWh pack at {pct}% duty cycle',
      ],
      experiment: [
        'Field run R{n} — controlled environment block (Shiraz, vine age {age}), stereo + LiDAR active, 30 Hz logging',
        'Fruit-load model A/B — baseline RCNN vs the row-aware variant on the cross-cultivar test set',
        'Path-planner sweep across row gaps {gap1}–{gap2} m with the new occupancy-grid representation',
      ],
      iteration: [
        'Switched from monocular to stereo perception after the depth-error analysis on R{n}',
        'Rewrote the occupancy-grid update from naive to log-odds after the curved-row failure mode',
        'Reduced LiDAR scan rate from {old} to {new} Hz after the CPU budget regression',
      ],
      uncertainty: [
        'Cross-cultivar generalisation of the fruit-load estimator is not characterised beyond Shiraz and Chardonnay',
        'Path-planner robustness under inconsistent row spacing (old vineyards) is open',
        'Whether the adaptive following algorithm degrades on muddy soil is unmeasured',
      ],
      newKnowledge: [
        'Stereo-LiDAR fusion holds canopy-edge tracking within ±{tol} cm at {speed} m/s — exceeds the GPS-only baseline by 4×',
        'Fruit-load estimator R²={r2} on cross-cultivar validation — first published-quality result for vineyard variety mix',
        'Adaptive following kept the rover within row geometry for {pct}% of the run — characterised the failure modes',
      ],
      timeLog: [
        '{hours} h on field run R{n} setup + on-site data capture',
        '{hours} h on perception-stack tuning + dataset labelling',
        '{hours} h on path-planner integration + simulation regression',
      ],
      associateFlag: [
        'Standup: R{n} confirmed stereo-LiDAR fusion; archive the monocular branch',
        'Vineyard owner debrief: rover passed acceptance for the FY27 trial',
        'Insurance review: contemporaneous evidence chain improves the autonomous-equipment risk class',
      ],
    },
    imageSubjects: [
      'rover R{n} in Shiraz block',
      'canopy-edge tracking overlay',
      'fruit-load detection heatmap',
      'LiDAR point-cloud snapshot',
      'whiteboard sketch — occupancy-grid update',
      'battery-runtime chart',
      'on-site setup with Jetson + ZED rig',
      'lab book p.{n} — R{n} run log',
      'dataset-labelling screenshot (Roboflow)',
      'rover CAD assembly screenshot',
    ],
    pdfTitles: [
      'Vineyard access agreement — Coonawarra FY26',
      'Velodyne supply contract Q3',
      'NVIDIA Jetson Developer Program',
      'Dataset licensing — cross-cultivar fruit-load',
      'Insurance schedule — autonomous-equipment cover',
    ],
    voiceNoteTopics: [
      'R{n} mid-row debrief on a curved row',
      'fruit-load estimator A/B result memo',
      'vineyard owner acceptance call',
    ],
  },

  // ── 6. Proceptual Games — Procedural content generation ────────────
  {
    slug: 'proceptual-games',
    firm: { name: 'Tasman Innovation Group', slug: 'tasman-innovation' },
    user: { name: 'Charlie Munro', email: 'charlie.munro@tasman.test' },
    claimant: { name: 'Proceptual Games Pty Ltd', abn: '67 890 123 456' },
    project: {
      name: 'Procedural narrative generation for open-world games',
      summary:
        'LLM-driven quest synthesis grounded in player history + world state. Constraint satisfaction over the quest graph, lore consistency checking, runtime perf budgets.',
    },
    vendors: {
      rdCritical: [
        'Anthropic API',
        'OpenAI API',
        'Together AI',
        'Hugging Face',
        'Modal Labs',
        'Pinecone Vector DB',
        'Weaviate',
        'Lambda Labs',
        'Unity Pro',
        'Unreal Engine Marketplace',
      ],
      rdSupporting: [
        'AWS Australia Pty Ltd',
        'GitHub Inc.',
        'JetBrains s.r.o.',
        'Linear',
        'Notion Labs',
        'Datadog',
        'Sentry.io',
      ],
      nonRd: [
        'WeWork Wellington',
        'Aon Insurance',
        'Stripe',
        'Officeworks',
        'PwC Tax',
        'Webjet',
        'Slack Technologies',
      ],
    },
    themes: {
      hypothesis: [
        'Constraint-graph quest synthesis will hold player-history consistency at >{pct}% across {n} session-hours',
        'Retrieval-augmented lore checking should catch >{pct}% of canon contradictions in the staging build',
        'A {budget} ms per-frame budget for narrative-prep coroutines is sufficient on the target console hardware',
      ],
      observation: [
        'Build {b}: quest-graph SAT solver returns within {ms} ms on the standard quest template; no timeouts in {n} runs',
        'Lore-check eval: {pct}% catch rate on the seeded canon contradictions; {fp} false positives per 1000 quests',
        'Per-frame coroutine budget never exceeded {budget} ms across the {n}-session capture',
      ],
      experiment: [
        'Quest-graph generation across {n} player-state seeds, measured under the staging worldspace',
        'Lore-check accuracy on the seeded canon-contradiction dataset — {fp} known plants per build',
        'Frame-time profile capture across {sess} sessions on the target hardware',
      ],
      iteration: [
        'Switched constraint encoding from CNF to pseudo-Boolean after the {ms} ms tail latency',
        'Reduced retrieval top-k from {old} to {new} after the lore-check false-positive rate observation',
        'Moved narrative-prep coroutine off the gameplay thread after the {budget} ms budget overrun',
      ],
      uncertainty: [
        'Whether the constraint-graph approach scales to {n}+ active quests per region is open',
        'Long-tail narrative coherence under unusual player histories is not characterised',
        'Console memory pressure under the retrieval index is unmeasured at the staging build size',
      ],
      newKnowledge: [
        'Constraint-graph quest synthesis with retrieval-grounded lore checking achieves {pct}% consistency at the target perf budget — first measured result for this combo',
        'Pseudo-Boolean encoding cuts the SAT solver tail latency by {pct}% vs CNF — characterised the gain',
        'Per-frame coroutine budget is feasible on the target console — opens the runtime-streaming branch',
      ],
      timeLog: [
        '{hours} h on quest-graph SAT integration + perf benchmarking',
        '{hours} h on lore-check eval dataset curation + evaluation runs',
        '{hours} h on per-frame coroutine refactor + console-hardware profiling',
      ],
      associateFlag: [
        'Standup: B{b} ships the pseudo-Boolean encoding; rollback path documented',
        'IP review: constraint-graph approach disclosed under NDA to two studios',
        'Console-vendor cert call: per-frame budget evidence supports the technical-cert submission',
      ],
    },
    imageSubjects: [
      'quest-graph visualisation — build {b}',
      'SAT solver latency histogram',
      'lore-check false-positive analysis',
      'frame-time profile screenshot',
      'whiteboard sketch — narrative-prep pipeline',
      'console hardware test rig',
      'in-game screenshot — generated quest text',
      'retrieval index size vs latency chart',
      'session telemetry dashboard',
      'lab book p.{n} — B{b} regression log',
    ],
    pdfTitles: [
      'Anthropic API enterprise contract',
      'Console developer kit licensing',
      'IP NDA — Studio A',
      'Lore-check dataset licensing',
      'Per-frame budget technical cert',
    ],
    voiceNoteTopics: [
      'B{b} pseudo-Boolean rollout memo',
      'lore-check false-positive triage',
      'console cert submission planning',
    ],
  },

  // ── 7. Solstice Energy — Hydrogen electrolyser stack ───────────────
  {
    slug: 'solstice-energy',
    firm: { name: 'Coastal R&D Partners', slug: 'coastal-rd' },
    user: { name: 'Pip Henderson', email: 'pip@coastal.test' },
    claimant: { name: 'Solstice Energy Pty Ltd', abn: '78 901 234 567' },
    project: {
      name: 'PEM electrolyser stack — catalyst loading + flow-field R&D',
      summary:
        'Reduced-Ir catalyst loading for PEM electrolysers, novel serpentine flow-field geometry, 50-cell stack durability testing under load cycling.',
    },
    vendors: {
      rdCritical: [
        'Johnson Matthey Catalysts',
        'Umicore Precious Metals',
        'Greenerity Membranes',
        'Nafion / Chemours',
        'Treadstone Technologies',
        'Plug Power Components',
        'Gamry Electrochemical',
        'Bio-Logic Science',
        'Endress+Hauser',
        'Fluke Calibration',
      ],
      rdSupporting: [
        'AWS Australia Pty Ltd',
        'COMSOL Multiphysics',
        'ANSYS Fluent',
        'BOC Industrial Gases',
        'Coregas',
        'Bruker XRD',
        'JEOL Microscopy',
      ],
      nonRd: [
        'Officeworks',
        'Aon Risk Services',
        'EY Tax',
        'Salesforce',
        'Webjet',
        'Telstra',
        'Bunnings',
      ],
    },
    themes: {
      hypothesis: [
        'Ir loading of {load} mg/cm² with the new serpentine flow-field will hold {pct}% performance vs the {ref} mg/cm² reference',
        'The revised flow-field geometry should reduce mass-transport overpotential by {mv} mV at {ad} A/cm²',
        'Stack durability under {cyc} load cycles will hold degradation below {deg} µV/h on the {ncell}-cell build',
      ],
      observation: [
        'Cell C{n} polarisation curve: {pct}% of reference at {ad} A/cm²; HFR {hfr} mΩ·cm²',
        'Mass-transport overpotential {mv} mV at {ad} A/cm² — matches the CFD prediction within {tol}%',
        'Stack S{n} cycled to {cyc} cycles; degradation {deg} µV/h; no measurable membrane thinning at the post-test XRD',
      ],
      experiment: [
        'Polarisation curve across the catalyst sweep ({load1}, {load2}, {load3} mg/cm²) at 60 °C, 80 °C',
        'CFD-validated flow-field comparison against the legacy serpentine on a single-cell rig',
        '{ncell}-cell stack build + load-cycling endurance for {cyc} cycles',
      ],
      iteration: [
        'Switched binder ratio in the catalyst layer from {old}:{new1} to {new}:{new2} after the durability run',
        'Revised the flow-field channel depth from {old} to {new} mm after the CFD outlet-pressure result',
        'Increased catalyst-layer dry weight from {old} to {new} mg/cm² after the polarisation regression',
      ],
      uncertainty: [
        'Whether the reduced Ir loading holds the {pct}% performance band at the upper temperature range is open',
        'Long-term stack durability beyond {cyc} cycles under the new flow-field is unmeasured',
        'Membrane-electrode adhesion at low Ir loading is not characterised across the full operating envelope',
      ],
      newKnowledge: [
        'Reduced Ir loading at {load} mg/cm² holds {pct}% performance with the revised flow-field — first measured result at this combination',
        'Mass-transport overpotential reduced by {mv} mV vs the legacy geometry — characterised the flow-field gain',
        'Stack endured {cyc} cycles at degradation {deg} µV/h — opens the {ncell}+cell scale-up path',
      ],
      timeLog: [
        '{hours} h on stack S{n} build + leak-check + commissioning',
        '{hours} h on Gamry polarisation runs + EIS sweep',
        '{hours} h on COMSOL flow-field model + validation analysis',
      ],
      associateFlag: [
        'Standup: S{n} confirms the flow-field; advance to the {ncell}+cell build',
        'Johnson Matthey review: reduced-Ir catalyst sample arriving for the next sweep',
        'PR carrier check-in: high-pressure H₂ evidence chain improves our coverage band',
      ],
    },
    imageSubjects: [
      'stack S{n} fully assembled',
      'polarisation curve sweep',
      'EIS Nyquist plot',
      'CFD flow-field velocity field',
      'post-test membrane SEM cross-section',
      'whiteboard sketch — catalyst-layer build',
      'leak-check setup',
      'load-cycling endurance chart',
      'XRD pattern overlay (pristine vs cycled)',
      'lab book p.{n} — S{n} commissioning log',
    ],
    pdfTitles: [
      'Johnson Matthey catalyst supply contract',
      'Greenerity membrane spec sheet',
      'High-pressure H₂ test-rig safety case',
      'Gamry calibration certificate',
      'COMSOL model documentation v{v}',
    ],
    voiceNoteTopics: [
      'S{n} commissioning result memo',
      'polarisation regression triage',
      'scale-up build planning standup',
    ],
  },

  // ── 8. Quartzcore — Mineral leaching / lithium recovery ────────────
  {
    slug: 'quartzcore',
    firm: { name: 'Outback Tax Co', slug: 'outback-tax' },
    user: { name: 'Ngaire Watson', email: 'ngaire@outback.test' },
    claimant: { name: 'Quartzcore Mining Pty Ltd', abn: '89 012 345 678' },
    project: {
      name: 'Selective lithium leaching from spodumene tailings',
      summary:
        'Low-acid sulphation roast + water leach for lithium recovery from low-grade tailings. Reagent screen, kinetics, downstream impurity rejection.',
    },
    vendors: {
      rdCritical: [
        'Outotec Australia',
        'FLSmidth Mining',
        'Metso Outotec',
        'Sandvik Mining',
        'Carbon Active',
        'BASF Performance Materials',
        'Sigma-Aldrich',
        'Bureau Veritas Minerals',
        'ALS Minerals',
        'Intertek Minerals',
      ],
      rdSupporting: [
        'AWS Australia Pty Ltd',
        'JKTech Simulation',
        'JKMRC',
        'METSIM',
        'Bruker XRF',
        'Malvern Mastersizer',
      ],
      nonRd: [
        'Officeworks',
        'BP Diesel',
        'Aon Risk',
        'EY Tax',
        'Webjet',
        'Telstra',
        'Bunnings',
        'Salesforce',
      ],
    },
    themes: {
      hypothesis: [
        'Sulphation roast at {temp} °C / {res} min residence with {acid}% acid will release ≥ {rec}% of contained Li',
        'Water-leach kinetics on the calcined product should reach >{pct}% extraction within {min} min at {temp} °C',
        'Two-stage impurity precipitation should reject ≥ {pct}% of Fe, Al, and Mg from the pregnant leach solution',
      ],
      observation: [
        'Run L{n}: Li extraction {rec}% at {res} min residence; calcine XRD shows {pct}% conversion to soluble form',
        'Leach kinetics: {pct}% Li at {min} min; matches Avrami fit with k={k} min⁻¹',
        'Impurity rejection: Fe {fe}%, Al {al}%, Mg {mg}% in the precipitate at pH {ph}',
      ],
      experiment: [
        'Sulphation roast L{n} — {mass} kg charge, {temp} °C, {res} min, {acid}% acid',
        'Water-leach kinetics — calcine from L{n}, particle size {p10}/{p50}/{p90} µm',
        'Impurity precipitation pH sweep ({ph1}–{ph2}) on the L{n} pregnant solution',
      ],
      iteration: [
        'Reduced acid loading from {old}% to {new}% after the L{n} energy-balance review',
        'Changed feed P80 from {old} to {new} µm after the slow-leach kinetics on coarser feed',
        'Switched impurity precipitant from {oldp} to {newp} after the Fe/Mg co-precipitation analysis',
      ],
      uncertainty: [
        'Whether the {acid}% acid loading holds the {rec}% recovery on weathered tailings (vs fresh) is unmeasured',
        'Long-term wear rate of the calciner refractory under the new acid regime is open',
        'Downstream solvent-extraction selectivity on the pregnant solution is not characterised',
      ],
      newKnowledge: [
        'L{n} achieves {rec}% Li recovery at {acid}% acid — first demonstration for the tailings grade band',
        'Calcine kinetics follow Avrami with k={k} min⁻¹ — characterised the rate envelope',
        'Two-stage impurity rejection delivers ≥ {pct}% on Fe/Al/Mg — opens the SX/IX downstream branch',
      ],
      timeLog: [
        '{hours} h on calciner setup + L{n} run + sample preparation',
        '{hours} h on ALS Minerals assay coordination + data reduction',
        '{hours} h on METSIM model — water-leach + impurity-rejection circuit',
      ],
      associateFlag: [
        'Standup: L{n} confirms the {acid}% acid path; advance to pilot continuous-feed',
        'JKTech review: comminution circuit aligned with the P80 result',
        'Tenement renewal call: evidence chain supports the FY27 prospectus position',
      ],
    },
    imageSubjects: [
      'calciner discharge L{n}',
      'pregnant leach solution beaker',
      'XRD pattern — pristine vs calcined',
      'particle-size distribution P80 chart',
      'kinetics Avrami fit plot',
      'impurity precipitate XRF spectrum',
      'whiteboard sketch — leach circuit',
      'core-shed sample tray',
      'cyclone underflow image',
      'lab book p.{n} — L{n} mass-balance',
    ],
    pdfTitles: [
      'ALS Minerals assay contract',
      'Calciner safety operating procedure',
      'METSIM model documentation v{v}',
      'JKTech consulting agreement',
      'Tenement renewal — FY27 prospectus',
    ],
    voiceNoteTopics: [
      'L{n} post-run result memo',
      'impurity-rejection result triage',
      'pilot continuous-feed planning',
    ],
  },

  // ── 9. MedSense — Continuous glucose monitor algorithms ────────────
  {
    slug: 'medsense',
    firm: { name: 'Bayside Advisory', slug: 'bayside-advisory' },
    user: { name: 'Lakshmi Iyer', email: 'lakshmi@bayside.test' },
    claimant: { name: 'MedSense Devices Pty Ltd', abn: '90 123 456 789' },
    project: {
      name: 'Wearable CGM — sensor-drift compensation algorithms',
      summary:
        'Adaptive Kalman + neural drift-compensation for continuous glucose monitors. Hypoglycaemia detection sensitivity, fingerstick-free calibration window, low-power deployment.',
    },
    vendors: {
      rdCritical: [
        'Dexcom Components',
        'Abbott Diabetes Care R&D',
        'Maxim Integrated Healthcare',
        'Analog Devices Healthcare',
        'Texas Instruments MSP',
        'Espressif Systems',
        'Tektronix Instruments',
        'Keysight Technologies',
        'Bürkert Fluid Control',
      ],
      rdSupporting: [
        'AWS Australia Pty Ltd',
        'PyTorch Foundation',
        'GitHub Inc.',
        'Weights & Biases',
        'Sentry.io',
        'Datadog APM',
        'Roboflow',
      ],
      nonRd: ['Officeworks', 'Aon Insurance', 'Marsh', 'Webjet', 'KPMG Tax', 'Slack', 'Salesforce'],
    },
    themes: {
      hypothesis: [
        'Adaptive Kalman + neural drift compensation will reduce MARD to {mard}% vs the {ref}% baseline on the in-vivo dataset',
        'Hypoglycaemia detection sensitivity should reach {sens}% with FPR < {fpr}% on the held-out clinical trial subset',
        'Fingerstick-free calibration should hold to day {day} on >{pct}% of subjects',
      ],
      observation: [
        'Algorithm A{n} — MARD {mard}% across {n} subjects; sensor lifetime {days} days median',
        'Hypoglycaemia detection: sensitivity {sens}%, FPR {fpr}% on the held-out subset',
        'Calibration drift: {pct}% subjects within ±{tol}% at day {day}',
      ],
      experiment: [
        'Algorithm A{n} validation on the {nsub}-subject in-vivo dataset (paired with reference instrument)',
        'Adversarial drift injection — synthetic sensor-aging profile across {nseed} seeds',
        'Low-power deployment characterisation on the target MSP / ESP firmware',
      ],
      iteration: [
        'Switched from EKF to UKF after the non-Gaussian drift analysis on A{n}',
        'Reduced the neural-compensator width from {old} to {new} hidden units after the MCU memory budget',
        'Added a held-out subject pool to the trial after the FPR drift on the original split',
      ],
      uncertainty: [
        'Whether the MARD holds under high-glucose excursion patterns beyond the trial cohort is open',
        'Long-term sensor-aging characterisation (>14 days) is not in the current dataset',
        'Cross-patient generalisation of the neural compensator on paediatric subjects is unmeasured',
      ],
      newKnowledge: [
        'A{n} achieves MARD {mard}% — first reported result in this band for the adaptive Kalman + neural combo',
        'Hypoglycaemia sensitivity {sens}% at FPR {fpr}% — characterised the operating curve',
        'Calibration drift compensated to day {day} — opens the regulatory-submission branch',
      ],
      timeLog: [
        '{hours} h on A{n} algorithm validation + paired analysis',
        '{hours} h on hypoglycaemia ROC + threshold tuning',
        '{hours} h on MSP / ESP firmware deployment + power profiling',
      ],
      associateFlag: [
        'Standup: A{n} ships behind a flag; clinical-trial subset hold-out documented',
        'TGA pre-submission call: evidence chain supports the algorithmic-change classification',
        'IP counsel: drift-compensation method ready for international filing',
      ],
    },
    imageSubjects: [
      'in-vivo trace overlay vs reference',
      'MARD distribution per subject',
      'hypoglycaemia ROC curve',
      'sensor-aging synthetic-drift plot',
      'firmware power profile (oscilloscope)',
      'whiteboard sketch — Kalman + neural pipeline',
      'wearable device on volunteer',
      'CGM data dashboard screenshot',
      'breadboard with MSP + sensor rig',
      'lab book p.{n} — A{n} eval log',
    ],
    pdfTitles: [
      'In-vivo trial protocol — TGA-aligned',
      'Maxim healthcare component datasheet',
      'IP provisional — drift-compensation method',
      'TGA pre-submission meeting minutes',
      'Firmware deployment SOP',
    ],
    voiceNoteTopics: [
      'A{n} MARD finding memo',
      'paediatric cohort planning note',
      'TGA submission strategy debrief',
    ],
  },

  // ── 10. Pangaea Air — Autonomous drone BVLOS navigation ────────────
  {
    slug: 'pangaea-air',
    firm: { name: 'Karri Forest Consulting', slug: 'karri-forest' },
    user: { name: 'Tom Brennan', email: 'tom@karri.test' },
    claimant: { name: 'Pangaea Air Pty Ltd', abn: '01 234 567 890' },
    project: {
      name: 'BVLOS drone navigation — sense-and-avoid + corridor routing',
      summary:
        'Beyond-visual-line-of-sight quadcopter platform for remote-area infrastructure inspection. Radar-camera fusion for sense-and-avoid, dynamic corridor routing under wind, autonomous return-to-base.',
    },
    vendors: {
      rdCritical: [
        'Echodyne Radar',
        'FLIR Systems',
        'Sony Spresense',
        'Pixhawk Cube',
        'Velodyne LiDAR',
        'Ouster Inc.',
        'Holybro PX4',
        'CUAV Components',
        'NVIDIA Jetson',
        'u-blox GNSS',
      ],
      rdSupporting: [
        'AWS Australia Pty Ltd',
        'PX4 Foundation',
        'Foxglove Studio',
        'GitHub Inc.',
        'PyTorch Foundation',
        'Weights & Biases',
        'Sentry.io',
      ],
      nonRd: [
        'Officeworks',
        'BP Fuel',
        'Aon Aviation Insurance',
        'CASA Permit Fees',
        'Marsh Aviation',
        'PwC Tax',
        'Webjet',
        'Telstra',
      ],
    },
    themes: {
      hypothesis: [
        'Radar-camera fusion will hold sense-and-avoid detection range to >{range} m at closing speed {speed} m/s with FPR < {fpr}%',
        'Dynamic corridor routing should hold the BVLOS waypoint envelope within ±{tol} m under {wind} m/s gusts',
        'Autonomous return-to-base should activate within {ms} ms of link loss with >{pct}% successful recovery in the test envelope',
      ],
      observation: [
        'Flight F{n}: sense-and-avoid detection at {range} m across {n} intrusions; no missed detections, {fp} false positives',
        'Corridor envelope held to ±{tol} m under measured gust {wind} m/s; trajectory rejoin within {ms} ms',
        'RTB activation latency {ms} ms median across {n} link-loss simulations; recovery {pct}%',
      ],
      experiment: [
        'Sense-and-avoid characterisation flight F{n} with controlled intruder targets',
        'Wind-envelope test on the corridor router across measured gust profiles',
        'Link-loss recovery simulation — {n} synthetic outages across the corridor',
      ],
      iteration: [
        'Switched FOV mode on the Echodyne radar from {old}° to {new}° after the false-positive analysis',
        'Tuned the corridor-router gain from {old} to {new} after the wind-envelope test',
        'Rewrote the RTB trigger from edge-detection to state-machine after the {ms} ms latency regression',
      ],
      uncertainty: [
        'Whether the sense-and-avoid envelope holds at sub-1 km altitude over reflective terrain (water, sand) is open',
        'Long-range corridor routing in mixed-traffic airspace is not characterised',
        'GNSS-denied navigation fallback duration is unmeasured beyond {min} min',
      ],
      newKnowledge: [
        'Radar-camera fusion holds detection at {range} m with FPR < {fpr}% — first measured result for this airframe class',
        'Corridor router stays within ±{tol} m under {wind} m/s gusts — characterised the wind envelope',
        'RTB activates in {ms} ms with {pct}% recovery — opens the CASA permit submission for the FY27 corridor',
      ],
      timeLog: [
        '{hours} h on flight F{n} planning + site setup + flight ops',
        '{hours} h on corridor-router tuning + simulation regression',
        '{hours} h on sense-and-avoid dataset capture + labelling',
      ],
      associateFlag: [
        'Standup: F{n} confirms the radar fusion; archive the camera-only branch',
        'CASA pre-app meeting: evidence chain supports the BVLOS permit submission',
        'Insurance review: contemporaneous flight evidence improves the hull-and-liability premium tier',
      ],
    },
    imageSubjects: [
      'flight F{n} ground-station screen',
      'sense-and-avoid radar overlay',
      'corridor envelope trajectory plot',
      'gust profile vs envelope chart',
      'wireframe drone on the launch pad',
      'whiteboard sketch — RTB state machine',
      'on-site setup with Jetson + Echodyne',
      'lab book p.{n} — F{n} mission log',
      'link-loss recovery simulation screenshot',
      'GNSS receiver log overlay',
    ],
    pdfTitles: [
      'CASA BVLOS permit application — corridor C{n}',
      'Echodyne radar supply contract',
      'Aviation insurance schedule — hull + liability',
      'Pixhawk Cube firmware release notes',
      'Test-corridor access agreement — Pilbara region',
    ],
    voiceNoteTopics: [
      'F{n} sense-and-avoid post-flight memo',
      'corridor-router tuning result',
      'CASA permit submission planning',
    ],
  },
];
