export type BlogSection = {
  heading: string;
  paragraphs: string[];
};

export type BlogPost = {
  slug: string;
  title: string;
  description: string;
  eyebrow: string;
  date: string;
  readTime: string;
  sections: BlogSection[];
};

export const blogPosts: BlogPost[] = [
  {
    slug: 'contemporaneous-documentation-2026',
    title: 'What contemporaneous documentation looks like in 2026',
    description:
      'A practical reference guide for RDTI advisers who need evidence to survive review, not just fill a folder.',
    eyebrow: 'Evidence practice',
    date: '2026-06-03',
    readTime: '7 min read',
    sections: [
      {
        heading: 'The bar is shifting from storage to traceability',
        paragraphs: [
          'For software R&D claims, the question is rarely whether a client can produce documents. The harder question is whether those documents tell a credible story about uncertainty, experiment, decision, and result at the time the work happened.',
          'That is the practical difference between an archive and a review file. An archive preserves material. A review file shows why each item matters, who created it, what activity it supports, and how it connects to the claim position.',
        ],
      },
      {
        heading: 'What a reviewer should be able to see',
        paragraphs: [
          'A strong evidence file gives a reviewer a clean path through the claim. It connects the technical hypothesis to work records, source artefacts, activity descriptions, expenditure support, and the final narrative. It also preserves judgement calls, exclusions, and adviser review notes.',
          'The best files make chronology visible. They show when the uncertainty was identified, what alternatives were considered, what tests or development work were performed, and what the team learned. This does not need to be theatrical. It needs to be specific, consistent, and easy to inspect.',
        ],
      },
      {
        heading: 'The operating habit that changes the file',
        paragraphs: [
          'The highest leverage habit is capturing context while the work is still live. Meeting notes, tickets, commits, technical decisions, lab notes, architecture changes, and cost records are more useful when they are linked to the activity before memory becomes reconstruction.',
          'ArchiveOne is designed around that habit. It turns evidence intake, technical shaping, and consultant review into one chain of record so the review pack is assembled from work already captured, not rebuilt in a rush at lodgement time.',
        ],
      },
    ],
  },
  {
    slug: 'hypothesis-articulation-software-rd',
    title: 'Hypothesis articulation for software R&D: a working framework',
    description:
      'How advisers can help software teams express uncertainty, experiment, and technical learning without drifting into generic innovation language.',
    eyebrow: 'Claim design',
    date: '2026-06-10',
    readTime: '8 min read',
    sections: [
      {
        heading: 'A hypothesis is not a slogan',
        paragraphs: [
          'In software R&D, weak claims often begin with language that sounds impressive but does not identify the technical uncertainty. Phrases like "building an AI platform" or "creating a scalable system" can describe a product ambition without explaining what could not be resolved by standard practice.',
          'A useful hypothesis is narrower. It names the technical problem, the proposed approach, the observable test, and the learning expected from the work. It gives the adviser and the client a shared frame for what evidence should be collected.',
        ],
      },
      {
        heading: 'A four-part working frame',
        paragraphs: [
          'Start with the constraint: what technical limit, performance condition, integration issue, data quality problem, or system behaviour created uncertainty? Then state the proposed approach, including the mechanism the team believed might resolve it.',
          'Next, define what would count as evidence. That may include benchmark results, failed attempts, design alternatives, logs, code review notes, or architecture decisions. Finally, capture the learning. The outcome does not need to be success; it needs to show what the work established.',
        ],
      },
      {
        heading: 'Where advisers add value',
        paragraphs: [
          'Advisers are strongest when they translate technical work into a defensible claim structure without flattening the engineering reality. The goal is not to make every sentence sound legal. It is to preserve enough technical specificity that the claim can be reviewed on its merits.',
          'ArchiveOne gives teams a place to shape that logic progressively: intake records, hypothesis notes, reviewer comments, and exportable narratives remain connected to the underlying evidence.',
        ],
      },
    ],
  },
  {
    slug: 'documentation-as-workflow',
    title: 'Documentation as workflow: turning the review file into the byproduct',
    description:
      'The practical case for building RDTI evidence into daily consultant and client workflows instead of treating documentation as a final-season scramble.',
    eyebrow: 'Practice operations',
    date: '2026-06-17',
    readTime: '6 min read',
    sections: [
      {
        heading: 'The late file is always expensive',
        paragraphs: [
          'When documentation is left until the final weeks, teams pay twice. Consultants spend time reconstructing context, and clients spend time searching for artefacts that should already be mapped to the claim.',
          'The result is not only operational pressure. Late reconstruction can blur the link between activity, evidence, and expenditure. That makes review harder and pushes senior consultants into avoidable rework.',
        ],
      },
      {
        heading: 'Make evidence capture part of the motion',
        paragraphs: [
          'A better model is to capture the claim file as the work moves. Intake prompts, evidence links, activity mapping, reviewer notes, and expenditure support should sit in the same workflow. The file becomes a byproduct of doing the work properly.',
          'This is especially useful for firms with many clients or junior team members. Consistent workflows give managers earlier visibility into claim quality and give juniors clearer guidance on what a strong first draft looks like.',
        ],
      },
      {
        heading: 'What changes for the practice',
        paragraphs: [
          'The commercial benefit is not a promise of faster claims or guaranteed outcomes. It is a better operating system for judgement, review, and capacity. Partners can see risk earlier, managers can intervene sooner, and clients get clearer requests.',
          'ArchiveOne supports that operating model with traceable evidence records, activity registers, technical narratives, accounting source paths, and review pack assembly in one product surface.',
        ],
      },
    ],
  },
  {
    slug: 'registration-season-capacity',
    title: 'Registration season capacity planning for RDTI practices',
    description:
      'A tactical playbook for reducing bottlenecks, protecting review quality, and keeping adviser judgement visible during peak season.',
    eyebrow: 'Season operations',
    date: '2026-06-24',
    readTime: '7 min read',
    sections: [
      {
        heading: 'Capacity problems are usually visibility problems first',
        paragraphs: [
          'Peak season pressure rarely arrives as one clean bottleneck. It shows up as missing evidence, unclear activity boundaries, inconsistent drafts, partner review queues, and client follow-up that arrives too late.',
          'The earlier a firm can see those issues, the easier they are to manage. Capacity planning is not just a resourcing exercise. It is a quality control system for the claim file.',
        ],
      },
      {
        heading: 'Segment the portfolio by review need',
        paragraphs: [
          'A practical season plan separates claims by complexity, evidence maturity, adviser confidence, and client responsiveness. High-risk or immature files need senior attention early. Cleaner files can move through structured review with less friction.',
          'That segmentation should be visible in the workflow, not trapped in a manager spreadsheet. When claim status, evidence gaps, and review notes live together, the team can make better daily decisions.',
        ],
      },
      {
        heading: 'Protect judgement at scale',
        paragraphs: [
          'The point of workflow tooling is not to remove adviser judgement. It is to protect it from avoidable administration. Senior consultants should spend more time on uncertainty, eligibility, evidence quality, and risk, and less time chasing scattered materials.',
          'ArchiveOne is being built for that practice reality: one place to collect the file, shape the claim, record review decisions, and assemble the pack before the season becomes urgent.',
        ],
      },
    ],
  },
];

export function getBlogPost(slug: string): BlogPost | undefined {
  return blogPosts.find((post) => post.slug === slug);
}
