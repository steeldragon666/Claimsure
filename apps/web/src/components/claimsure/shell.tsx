'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { COMPANY, NAV_ITEMS } from '@/lib/claimsure-data';
import { CsAvatar } from './primitives';

// ── SideNav ───────────────────────────────────────────────────────────────────
interface SideNavProps {
  onAtlasToggle: () => void;
  atlasOpen: boolean;
}

export function SideNav({ onAtlasToggle, atlasOpen }: SideNavProps) {
  const pathname = usePathname();

  return (
    <aside
      className="fixed inset-y-0 left-0 z-40 flex flex-col"
      style={{
        width: 260,
        background: 'var(--cs-surface-container-lowest)',
        borderRight: '1px solid var(--cs-glass-border)',
      }}
    >
      {/* Logo */}
      <div
        className="px-6 pt-6 pb-4 flex items-center gap-3"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        <div
          className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{
            background: 'linear-gradient(135deg, var(--cs-primary), var(--cs-primary-container))',
          }}
        >
          <span
            className="material-symbols-outlined text-white"
            style={{ fontSize: 20, fontVariationSettings: "'FILL' 1" }}
          >
            shield_with_heart
          </span>
        </div>
        <div>
          <div
            className="font-jakarta font-extrabold text-[15px] tracking-tight"
            style={{ color: 'var(--cs-on-surface)' }}
          >
            ArchiveOne
          </div>
          <div
            className="text-[10px] uppercase tracking-widest opacity-40"
            style={{ color: 'var(--cs-on-surface-variant)' }}
          >
            R&D Tax Intelligence
          </div>
        </div>
      </div>

      {/* Company card */}
      <div className="mx-4 mt-4 mb-3 rounded-xl p-3 cs-glass">
        <div
          className="text-[10px] uppercase tracking-widest opacity-50 mb-1"
          style={{ color: 'var(--cs-on-surface-variant)' }}
        >
          Active entity
        </div>
        <div
          className="font-semibold text-[13px] leading-tight"
          style={{ color: 'var(--cs-on-surface)' }}
        >
          {COMPANY.name}
        </div>
        <div
          className="text-[11px] opacity-50 mt-0.5"
          style={{ color: 'var(--cs-on-surface-variant)' }}
        >
          ABN {COMPANY.abn} · {COMPANY.fy}
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 space-y-0.5 overflow-y-auto py-2">
        {NAV_ITEMS.map((item) => {
          const href = `/${item.id}`;
          const active = pathname === href || pathname.startsWith(href + '/');
          return (
            <Link
              key={item.id}
              href={href}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-xl text-[12px] font-semibold uppercase tracking-wider transition-all group',
                active
                  ? 'text-[var(--cs-primary-fixed-dim)]'
                  : 'text-[var(--cs-on-surface-variant)] hover:text-[var(--cs-on-surface)] hover:bg-white/5',
              )}
              style={
                active
                  ? {
                      background: 'rgba(70,72,212,0.15)',
                      border: '1px solid rgba(70,72,212,0.25)',
                    }
                  : {}
              }
            >
              <span
                className="material-symbols-outlined transition-all"
                style={{
                  fontSize: 18,
                  fontVariationSettings: active ? "'FILL' 1" : "'FILL' 0",
                  color: active ? 'var(--cs-primary-fixed-dim)' : undefined,
                }}
              >
                {item.icon}
              </span>
              {item.label}
              {active && (
                <span
                  className="ml-auto w-1.5 h-1.5 rounded-full"
                  style={{ background: 'var(--cs-primary-fixed-dim)' }}
                />
              )}
            </Link>
          );
        })}
      </nav>

      {/* Submit CTA */}
      <div className="px-4 py-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <Link
          href="/submit"
          className="flex items-center justify-center gap-2 w-full rounded-xl py-3 text-[11px] font-bold uppercase tracking-widest text-white transition-all hover:-translate-y-0.5"
          style={{
            background: 'linear-gradient(135deg, var(--cs-primary), var(--cs-primary-container))',
            boxShadow: '0 8px 24px -6px rgba(70,72,212,0.5)',
          }}
        >
          <span
            className="material-symbols-outlined"
            style={{ fontSize: 16, fontVariationSettings: "'FILL' 1" }}
          >
            send
          </span>
          Submit Claim
        </Link>
      </div>

      {/* Atlas toggle */}
      <div className="px-4 pb-5">
        <button
          onClick={onAtlasToggle}
          className={cn(
            'flex items-center gap-2.5 w-full rounded-xl px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider transition-all',
            atlasOpen
              ? 'text-[var(--cs-primary-fixed-dim)] cs-ai-glow'
              : 'text-[var(--cs-on-surface-variant)] hover:text-[var(--cs-on-surface)] hover:bg-white/5',
          )}
        >
          <span
            className="relative w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0"
            style={{ background: 'rgba(70,72,212,0.25)' }}
          >
            <span
              className="absolute inset-0 rounded-full cs-ai-pulse"
              style={{ background: 'rgba(70,72,212,0.4)' }}
            />
            <span
              className="material-symbols-outlined relative z-10"
              style={{
                fontSize: 12,
                fontVariationSettings: "'FILL' 1",
                color: 'var(--cs-primary-fixed-dim)',
              }}
            >
              auto_awesome
            </span>
          </span>
          Atlas AI Agent
          <span
            className="ml-auto text-[9px] px-1.5 py-0.5 rounded-full font-bold"
            style={{ background: 'rgba(70,72,212,0.20)', color: 'var(--cs-primary-fixed-dim)' }}
          >
            BETA
          </span>
        </button>
      </div>
    </aside>
  );
}

// ── TopNav ────────────────────────────────────────────────────────────────────
interface TopNavProps {
  onAtlasToggle: () => void;
}

export function TopNav({ onAtlasToggle }: TopNavProps) {
  return (
    <header
      className="fixed top-0 right-0 z-30 flex items-center gap-4 px-6"
      style={{
        left: 260,
        height: 64,
        background: 'rgba(10,13,20,0.80)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderBottom: '1px solid rgba(255,255,255,0.07)',
      }}
    >
      {/* Search */}
      <div className="flex-1 max-w-sm">
        <div
          className="flex items-center gap-2 px-3 py-2 rounded-xl text-[12px]"
          style={{
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.08)',
            color: 'var(--cs-on-surface-variant)',
          }}
        >
          <span className="material-symbols-outlined opacity-50" style={{ fontSize: 16 }}>
            search
          </span>
          <span className="opacity-50">Search projects, evidence, engineers…</span>
          <kbd
            className="ml-auto text-[10px] px-1.5 py-0.5 rounded"
            style={{ background: 'rgba(255,255,255,0.08)' }}
          >
            ⌘K
          </kbd>
        </div>
      </div>

      <div className="flex items-center gap-2 ml-auto">
        {/* Run automation */}
        <button
          onClick={onAtlasToggle}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-[11px] font-bold uppercase tracking-widest transition-all hover:-translate-y-0.5"
          style={{
            background: 'rgba(70,72,212,0.15)',
            border: '1px solid rgba(70,72,212,0.30)',
            color: 'var(--cs-primary-fixed-dim)',
          }}
        >
          <span
            className="material-symbols-outlined"
            style={{ fontSize: 14, fontVariationSettings: "'FILL' 1" }}
          >
            auto_awesome
          </span>
          Run Automation
        </button>

        {/* Notifications */}
        <button
          className="w-9 h-9 rounded-xl flex items-center justify-center relative transition-all hover:bg-white/5"
          style={{ color: 'var(--cs-on-surface-variant)' }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 20 }}>
            notifications
          </span>
          <span
            className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full"
            style={{ background: 'var(--cs-error)' }}
          />
        </button>

        {/* Settings */}
        <button
          className="w-9 h-9 rounded-xl flex items-center justify-center transition-all hover:bg-white/5"
          style={{ color: 'var(--cs-on-surface-variant)' }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 20 }}>
            settings
          </span>
        </button>

        <CsAvatar name="Jordan Blake" size={36} />
      </div>
    </header>
  );
}

// ── PageShell ─────────────────────────────────────────────────────────────────
interface PageShellProps {
  children: React.ReactNode;
  atlasOpen?: boolean;
}

export function PageShell({ children, atlasOpen }: PageShellProps) {
  return (
    <main
      className="min-h-screen transition-all duration-300"
      style={{
        marginLeft: 260,
        paddingTop: 64,
        marginRight: atlasOpen ? 400 : 0,
        background: 'var(--cs-surface)',
      }}
    >
      <div className="p-8 cs-page-in">{children}</div>
    </main>
  );
}

// ── ClaimsureShell ─────────────────────────────────────────────────────────────
// Composes SideNav + TopNav + PageShell with shared atlas open state
export function ClaimsureShell({ children }: { children: React.ReactNode }) {
  const [atlasOpen, setAtlasOpen] = useState(false);

  return (
    <>
      <SideNav onAtlasToggle={() => setAtlasOpen((o) => !o)} atlasOpen={atlasOpen} />
      <TopNav onAtlasToggle={() => setAtlasOpen((o) => !o)} />
      <PageShell atlasOpen={atlasOpen}>{children}</PageShell>
      {atlasOpen && <AtlasSidebar onClose={() => setAtlasOpen(false)} />}
    </>
  );
}

// ── AtlasSidebar (inline, simple version) ────────────────────────────────────
import { AI_MESSAGES, QUICK_PROMPTS } from '@/lib/claimsure-data';
import { AIThinking } from './primitives';

function AtlasSidebar({ onClose }: { onClose: () => void }) {
  const [messages, setMessages] = useState(AI_MESSAGES);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);

  function sendMessage(content: string) {
    if (!content.trim()) return;
    setMessages((m) => [
      ...m,
      {
        role: 'user',
        time: new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' }),
        content,
      },
    ]);
    setInput('');
    setThinking(true);
    setTimeout(() => {
      setThinking(false);
      setMessages((m) => [
        ...m,
        {
          role: 'agent',
          time: new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' }),
          content:
            "I'm analysing your R&D evidence records. Based on the contemporaneous documentation across all four projects, I can provide detailed guidance on that question. Would you like me to generate a detailed breakdown?",
          actions: [{ label: 'Generate breakdown', action: 'breakdown' }],
        },
      ]);
    }, 2200);
  }

  return (
    <aside
      className="fixed inset-y-0 right-0 z-40 flex flex-col cs-page-in"
      style={{
        width: 400,
        background: 'var(--cs-surface-container-lowest)',
        borderLeft: '1px solid rgba(70,72,212,0.25)',
        boxShadow: '-20px 0 60px rgba(70,72,212,0.10)',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-3 px-5 py-4"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}
      >
        <div
          className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ background: 'rgba(70,72,212,0.20)', border: '1px solid rgba(70,72,212,0.30)' }}
        >
          <span
            className="material-symbols-outlined"
            style={{
              fontSize: 16,
              fontVariationSettings: "'FILL' 1",
              color: 'var(--cs-primary-fixed-dim)',
            }}
          >
            auto_awesome
          </span>
        </div>
        <div>
          <div
            className="font-jakarta font-bold text-[14px]"
            style={{ color: 'var(--cs-on-surface)' }}
          >
            Atlas
          </div>
          <div
            className="text-[10px] uppercase tracking-widest opacity-50"
            style={{ color: 'var(--cs-on-surface-variant)' }}
          >
            R&D AI Agent · FY24-25
          </div>
        </div>
        <button
          onClick={onClose}
          className="ml-auto w-8 h-8 rounded-lg flex items-center justify-center transition-all hover:bg-white/10"
          style={{ color: 'var(--cs-on-surface-variant)' }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
            close
          </span>
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.map((msg, i) => (
          <div
            key={i}
            className={cn('flex gap-3', msg.role === 'user' ? 'justify-end' : 'justify-start')}
          >
            {msg.role !== 'user' && (
              <div
                className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
                style={{ background: 'rgba(70,72,212,0.20)' }}
              >
                <span
                  className="material-symbols-outlined"
                  style={{
                    fontSize: 14,
                    fontVariationSettings: "'FILL' 1",
                    color: 'var(--cs-primary-fixed-dim)',
                  }}
                >
                  auto_awesome
                </span>
              </div>
            )}
            <div
              className={cn(
                'max-w-[80%] space-y-2',
                msg.role === 'user' ? 'items-end' : 'items-start',
              )}
            >
              <div
                className="rounded-2xl px-4 py-3 text-[13px] leading-relaxed"
                style={
                  msg.role === 'user'
                    ? {
                        background: 'rgba(70,72,212,0.18)',
                        border: '1px solid rgba(70,72,212,0.25)',
                        color: 'var(--cs-on-surface)',
                        borderBottomRightRadius: 4,
                      }
                    : {
                        background: 'var(--cs-surface-container)',
                        border: '1px solid rgba(255,255,255,0.07)',
                        color: 'var(--cs-on-surface)',
                        borderBottomLeftRadius: 4,
                      }
                }
              >
                {msg.content}
              </div>
              {msg.citations && (
                <div className="space-y-1.5">
                  {msg.citations.map((c, ci) => (
                    <div
                      key={ci}
                      className="flex items-center gap-2 px-3 py-2 rounded-xl text-[11px]"
                      style={{
                        background: 'var(--cs-surface-container)',
                        border: '1px solid rgba(255,255,255,0.07)',
                      }}
                    >
                      <span
                        className="material-symbols-outlined"
                        style={{
                          fontSize: 12,
                          color: 'var(--cs-primary-fixed-dim)',
                          fontVariationSettings: "'FILL' 1",
                        }}
                      >
                        {c.kind === 'evidence' ? 'attachment' : 'description'}
                      </span>
                      <span style={{ color: 'var(--cs-on-surface-variant)' }}>{c.label}</span>
                      <span
                        className="ml-auto font-mono font-semibold"
                        style={{
                          color: c.confidence >= 85 ? 'var(--cs-success)' : 'var(--cs-warn)',
                        }}
                      >
                        {c.confidence}%
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {msg.actions && (
                <div className="flex flex-wrap gap-2">
                  {msg.actions.map((a, ai) => (
                    <button
                      key={ai}
                      className="px-3 py-1.5 rounded-lg text-[11px] font-semibold uppercase tracking-wider transition-all hover:opacity-80"
                      style={{
                        background: 'rgba(70,72,212,0.12)',
                        border: '1px solid rgba(70,72,212,0.25)',
                        color: 'var(--cs-primary-fixed-dim)',
                      }}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              )}
              <div
                className="text-[10px] opacity-40"
                style={{ color: 'var(--cs-on-surface-variant)' }}
              >
                {msg.time}
              </div>
            </div>
          </div>
        ))}
        {thinking && (
          <div className="flex gap-3">
            <div
              className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{ background: 'rgba(70,72,212,0.20)' }}
            >
              <span
                className="material-symbols-outlined"
                style={{
                  fontSize: 14,
                  fontVariationSettings: "'FILL' 1",
                  color: 'var(--cs-primary-fixed-dim)',
                }}
              >
                auto_awesome
              </span>
            </div>
            <AIThinking />
          </div>
        )}
      </div>

      {/* Quick prompts */}
      <div className="px-4 py-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <div
          className="text-[10px] uppercase tracking-widest opacity-40 mb-2"
          style={{ color: 'var(--cs-on-surface-variant)' }}
        >
          Quick prompts
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {QUICK_PROMPTS.map((p) => (
            <button
              key={p}
              onClick={() => sendMessage(p)}
              className="text-left px-3 py-2 rounded-lg text-[11px] leading-tight transition-all hover:opacity-80"
              style={{
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                color: 'var(--cs-on-surface-variant)',
              }}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {/* Input */}
      <div className="px-4 pb-5 pt-3">
        <div
          className="flex items-end gap-2 rounded-2xl p-3"
          style={{
            background: 'var(--cs-surface-container)',
            border: '1px solid rgba(255,255,255,0.09)',
          }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage(input);
              }
            }}
            rows={2}
            placeholder="Ask Atlas about your R&D claim…"
            className="flex-1 bg-transparent resize-none text-[13px] outline-none leading-relaxed placeholder:opacity-40"
            style={{ color: 'var(--cs-on-surface)' }}
          />
          <button
            onClick={() => sendMessage(input)}
            disabled={!input.trim()}
            className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 transition-all disabled:opacity-30"
            style={{
              background: input.trim() ? 'var(--cs-primary)' : 'rgba(255,255,255,0.08)',
              color: 'white',
            }}
          >
            <span
              className="material-symbols-outlined"
              style={{ fontSize: 16, fontVariationSettings: "'FILL' 1" }}
            >
              send
            </span>
          </button>
        </div>
      </div>
    </aside>
  );
}
