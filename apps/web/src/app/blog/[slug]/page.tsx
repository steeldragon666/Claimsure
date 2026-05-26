import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { blogPosts, getBlogPost } from '@/lib/blog';

type BlogPostPageProps = {
  params: Promise<{ slug: string }>;
};

export function generateStaticParams() {
  return blogPosts.map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({ params }: BlogPostPageProps): Promise<Metadata> {
  const { slug } = await params;
  const post = getBlogPost(slug);

  if (!post) {
    return {
      title: 'ArchiveOne Blog',
    };
  }

  return {
    title: `${post.title} | ArchiveOne`,
    description: post.description,
  };
}

function Mark({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-block h-3 w-3 rotate-45 border border-[#d8b15f] bg-[#d8b15f]/20 ${className}`}
      aria-hidden="true"
    />
  );
}

export default async function BlogPostPage({ params }: BlogPostPageProps) {
  const { slug } = await params;
  const post = getBlogPost(slug);

  if (!post) notFound();

  return (
    <main className="min-h-screen bg-[#10130f] text-[#f7f1e4]">
      <article>
        <header className="relative isolate overflow-hidden border-b border-[#f7f1e4]/10">
          <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(247,241,228,0.055)_1px,transparent_1px),linear-gradient(to_bottom,rgba(247,241,228,0.055)_1px,transparent_1px)] bg-[size:72px_72px] [mask-image:linear-gradient(to_bottom,#000_10%,transparent_92%)]" />
          <nav className="relative z-10 mx-auto flex max-w-[1120px] items-center justify-between px-5 py-5 sm:px-8">
            <Link href="/" className="flex items-center gap-3">
              <Mark className="shadow-[0_0_22px_rgba(216,177,95,0.55)]" />
              <span className="font-display text-2xl font-semibold tracking-tight">ArchiveOne</span>
            </Link>
            <Link
              href="/blog"
              className="border border-[#f7f1e4]/16 px-4 py-3 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-[#cfc5b3] hover:border-[#f7f1e4]/35 hover:text-[#f7f1e4]"
            >
              Blog
            </Link>
          </nav>

          <div className="relative z-10 mx-auto max-w-[1120px] px-5 pb-16 pt-14 sm:px-8">
            <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8d8476]">
              <span>{post.eyebrow}</span>
              <span className="h-px w-8 bg-[#d8b15f]" />
              <time dateTime={post.date}>{post.date}</time>
              <span className="h-px w-8 bg-[#d8b15f]" />
              <span>{post.readTime}</span>
            </div>
            <h1 className="mt-8 max-w-5xl font-display text-5xl font-light leading-tight tracking-tight sm:text-7xl">
              {post.title}
            </h1>
            <p className="mt-8 max-w-3xl font-body text-lg leading-8 text-[#cfc5b3]">
              {post.description}
            </p>
          </div>
        </header>

        <div className="bg-[#f3ebdd] text-[#181a16]">
          <div className="mx-auto grid max-w-[1120px] gap-12 px-5 py-16 sm:px-8 lg:grid-cols-[220px_1fr]">
            <aside className="hidden lg:block">
              <div className="sticky top-8 border-l border-[#181a16]/15 pl-5">
                <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8d8476]">
                  In this article
                </p>
                <div className="mt-5 space-y-3">
                  {post.sections.map((section) => (
                    <p key={section.heading} className="font-body text-sm leading-6 text-[#5f5a50]">
                      {section.heading}
                    </p>
                  ))}
                </div>
              </div>
            </aside>

            <div className="space-y-12">
              {post.sections.map((section) => (
                <section key={section.heading}>
                  <h2 className="font-display text-4xl font-light leading-tight">
                    {section.heading}
                  </h2>
                  <div className="mt-5 space-y-5">
                    {section.paragraphs.map((paragraph) => (
                      <p key={paragraph} className="font-body text-base leading-8 text-[#4d4941]">
                        {paragraph}
                      </p>
                    ))}
                  </div>
                </section>
              ))}

              <div className="border border-[#181a16]/15 bg-white p-6">
                <p className="font-display text-3xl font-light">
                  Build the file while work happens.
                </p>
                <p className="mt-4 font-body text-sm leading-7 text-[#5f5a50]">
                  ArchiveOne is opening pilot access for RDTI practices that want traceable evidence
                  capture, structured review, and cleaner claim pack assembly.
                </p>
                <Link
                  href="/signup"
                  className="mt-6 inline-flex bg-[#d8b15f] px-5 py-4 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-[#10130f] transition hover:bg-[#f0c96f]"
                >
                  Request access
                </Link>
              </div>
            </div>
          </div>
        </div>
      </article>
    </main>
  );
}
