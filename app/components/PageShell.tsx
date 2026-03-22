import Link from 'next/link';
import dynamic from 'next/dynamic';
import { ReactNode } from 'react';
import { Logo } from './Logo';

const WalletButton = dynamic(() => import('./WalletButton'), {
  ssr: false,
});

type NavItem = {
  href: string;
  label: string;
  advanced?: boolean;
};

type PageShellProps = {
  icon?: string;
  title: string;
  subtitle?: string;
  navItems?: NavItem[];
  children: ReactNode;
};

export default function PageShell({ icon = '', title, subtitle, navItems = [], children }: PageShellProps) {
  const primaryNav = navItems.filter((item) => !item.advanced);
  const advancedNav = navItems.filter((item) => item.advanced);
  const rpcUrl =
    process.env.NEXT_PUBLIC_SOLANA_READ_RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL || '';
  const networkLabel = rpcUrl.includes('mainnet')
    ? 'Mainnet'
    : rpcUrl.includes('devnet')
      ? 'Devnet'
      : rpcUrl
        ? 'Custom'
        : 'Devnet';

  return (
    <div className="min-h-screen bg-[var(--app-bg)] text-[var(--app-ink)] font-sans selection:bg-cyan-500/20 selection:text-cyan-600 dark:selection:text-cyan-300 transition-colors duration-500">
      {/* Soft Background Accents */}
      <div className="fixed inset-0 pointer-events-none z-[-1] overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-cyan-500/[0.04] dark:bg-cyan-500/5 blur-[120px] rounded-full"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-teal-500/[0.04] dark:bg-teal-500/5 blur-[120px] rounded-full"></div>
      </div>

      <header className="sticky top-0 z-50 bg-[var(--glass-bg)] backdrop-blur-xl border-b border-[var(--app-border)] shadow-sm dark:shadow-lg dark:shadow-black/20 transition-all">
        <div className="max-w-[1400px] mx-auto px-6 h-20 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-teal-500 flex items-center justify-center text-white text-xl shadow-lg shadow-cyan-500/20">
              {icon ? icon : <Logo className="w-6 h-6 text-[#05334a]" />}
            </div>
            <div>
              <Link href="/" className="text-lg font-black tracking-tight text-[var(--app-ink)] hover:text-cyan-600 dark:hover:text-cyan-400 transition-colors">
                {title}
              </Link>
              {subtitle ? <p className="text-[10px] font-bold text-[var(--app-muted)] uppercase tracking-widest">{subtitle}</p> : null}
            </div>
          </div>

          <div className="flex items-center gap-4 md:gap-8">
            {navItems.length > 0 && (
              <nav className="hidden md:flex items-center gap-6" aria-label="Primary navigation">
                {primaryNav.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="text-xs font-bold text-[var(--app-muted)] hover:text-cyan-600 dark:hover:text-cyan-400 uppercase tracking-widest transition-colors"
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
            )}
            <div className="flex items-center gap-3">
              <span className="expensee-pill">{networkLabel}</span>
              <WalletButton />
            </div>
          </div>
        </div>

        {navItems.length > 0 && advancedNav.length > 0 && (
          <div className="max-w-[1400px] mx-auto px-6 h-10 border-t border-[var(--app-border)] flex items-center">
            <details className="relative group">
              <summary className="list-none cursor-pointer flex items-center gap-2 text-[10px] font-bold text-[var(--app-muted)] hover:text-cyan-600 dark:hover:text-cyan-400 uppercase tracking-widest transition-colors">
                <span>Advanced Controls</span>
                <svg className="w-3 h-3 transition-transform group-open:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 9l-7 7-7-7" />
                </svg>
              </summary>
              <div className="absolute top-full left-0 mt-2 p-2 bg-[var(--app-surface)] rounded-xl shadow-2xl border border-[var(--app-border)] flex flex-col min-w-[200px] z-50">
                {advancedNav.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="px-4 py-2 rounded-lg text-xs font-bold text-[var(--app-muted)] hover:bg-[var(--app-surface-alt)] hover:text-cyan-600 dark:hover:text-cyan-400 transition-all"
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            </details>
          </div>
        )}
      </header>

      <main className="max-w-[1400px] mx-auto px-6 py-12">
        {children}
      </main>

      <footer className="max-w-[1400px] mx-auto px-6 py-12 border-t border-[var(--app-border)] flex flex-col md:flex-row items-center justify-between gap-6">
        <div className="text-[11px] font-bold text-[var(--app-muted)] uppercase tracking-widest flex items-center gap-2">
          <span>Expensee</span>
          <span className="w-1 h-1 rounded-full bg-[var(--app-border)]"></span>
          <span>Private Realtime Payroll</span>
        </div>
        <div className="flex items-center gap-6">
          <span className="text-[10px] font-bold text-[var(--app-muted)] uppercase tracking-widest">&copy; 2026 Devnet Proof-of-Concept</span>
        </div>
      </footer>
    </div>
  );
}
