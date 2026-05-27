import type { Metadata } from 'next';
import Link from 'next/link';
import { blogPosts } from '@/lib/blog';

export const metadata: Metadata = {
  title: 'ArchiveOne Blog | RDTI evidence, workflow, and review readiness',
  description:
    'Practical writing for Australian RDTI advisers on evidence capture, software R&D claims, practice operations, and review-ready documentation.',
};

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

export default function BlogIndexPage() {
  const featured = blogPosts[0];
  const posts = blogPosts.slice(1);

  if (!featured) return null;

  return (
    <main className="min-h-screen bg-[#10130f] text-[#f7f1e4]">
      <section className="relative isolate overflow-hidden border-b border-[#f7f1e4]/10">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(247,241,228,0.055)_1px,transparent_1px),linear-gradient(to_bottom,rgba(247,241,228,0.055)_1px,transparent_1px)] bg-[size:72px_72px] [mask-image:linear-gradient(to_bottom,#000_10%,transparent_92%)]" />
        <nav className="relative z-10 mx-auto flex max-w-[1420px] items-center justify-between px-5 py-5 sm:px-8 lg:px-12">
          <Link href="/" className="flex items-center gap-3">
            <Mark className="shadow-[0_0_22px_rgba(216,177,95,0.55)]" />
            <span className="font-display text-2xl font-semibold tracking-tight">ArchiveOne</span>
          </Link>
          <Link
            href="/signup"
            className="bg-[#d8b15f] px-4 py-3 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-[#10130f] transition hover:bg-[#f0c96f]"
          >
            Request access
          </Link>
        </nav>

        <div className="relative z-10 mx-auto grid max-w-[1420px] gap-12 px-5 pb-20 pt-14 sm:px-8 lg:grid-cols-[0.9fr_1.1fr] lg:px-12">
          <div>
            <SectionLabel>ArchiveOne field notes</SectionLabel>
            <h1 className="mt-8 max-w-4xl font-display text-6xl font-light leading-[0.94] tracking-tight sm:text-7xl lg:text-8xl">
              Practical notes for review-ready R&D claims.
            </h1>
            <p className="mt-8 max-w-2xl font-body text-lg leading-8 text-[#cfc5b3]">
              Evidence capture, software R&D claim structure, practice operations, and season
              planning for Australian RDTI advisers.
            </p>
          </div>

          <Link
            href={`/blog/${featured.slug}`}
            className="group self-end border border-[#f7f1e4]/14 bg-[#161a14]/90 p-6 transition hover:border-[#d8b15f]/70"
          >
            <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-[#d8b15f]">
              Featured
            </p>
            <h2 className="mt-8 font-display text-5xl font-light leading-tight tracking-tight text-[#f7f1e4]">
              {featured.title}
            </h2>
            <p className="mt-5 font-body text-base leading-8 text-[#cfc5b3]">
              {featured.description}
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3 font-mono text-[11px] uppercase tracking-[0.16em] text-[#8d8476]">
              <span>{featured.eyebrow}</span>
              <span className="h-px w-8 bg-[#d8b15f]" />
              <span>{featured.readTime}</span>
            </div>
          </Link>
        </div>
      </section>

      <section className="bg-[#f3ebdd] text-[#181a16]">
        <div className="mx-auto max-w-[1420px] px-5 py-20 sm:px-8 lg:px-12">
          <div className="grid gap-4 md:grid-cols-3">
            {posts.map((post) => (
              <Link
                key={post.slug}
                href={`/blog/${post.slug}`}
                className="group border border-[#181a16]/15 bg-white p-6 transition hover:border-[#181a16]/40"
              >
                <Mark />
                <p className="mt-8 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-[#8d8476]">
                  {post.eyebrow}
                </p>
                <h2 className="mt-4 font-display text-3xl font-light leading-tight">
                  {post.title}
                </h2>
                <p className="mt-5 font-body text-sm leading-7 text-[#5f5a50]">
                  {post.description}
                </p>
                <p className="mt-8 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-[#181a16]">
                  Read article
                </p>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
