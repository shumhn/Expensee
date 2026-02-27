import Link from 'next/link';
import dynamic from 'next/dynamic';
import { ReactNode } from 'react';

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

export default function PageShell({ icon = '◈', title, subtitle, navItems = [], children }: PageShellProps) {
  const primaryNav = navItems.filter((item) => !item.advanced);
  const advancedNav = navItems.filter((item) => item.advanced);

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900 font-sans selection:bg-indigo-100 selection:text-indigo-700">
      {/* Dynamic Background */}
      <div className="fixed inset-0 pointer-events-none z-[-1] overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-indigo-500/5 blur-[120px] rounded-full"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-500/5 blur-[120px] rounded-full"></div>
      </div>

      <header className="sticky top-0 z-50 bg-white/70 backdrop-blur-xl border-b border-slate-200/60 shadow-sm">
        <div className="max-w-[1400px] mx-auto px-6 h-20 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-slate-900 flex items-center justify-center text-white text-xl shadow-lg">
              {icon}
            </div>
            <div>
              <Link href="/" className="text-lg font-black tracking-tight text-slate-900 hover:text-indigo-600 transition-colors">
                {title}
              </Link>
              {subtitle ? <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{subtitle}</p> : null}
            </div>
          </div>

          <div className="flex items-center gap-8">
            {navItems.length > 0 && (
              <nav className="hidden md:flex items-center gap-6" aria-label="Primary navigation">
                {primaryNav.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="text-xs font-bold text-slate-500 hover:text-slate-900 uppercase tracking-widest transition-colors"
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
            )}
            <WalletButton />
          </div>
        </div>

        {navItems.length > 0 && advancedNav.length > 0 && (
          <div className="max-w-[1400px] mx-auto px-6 h-10 border-t border-slate-100 flex items-center">
            <details className="relative group">
              <summary className="list-none cursor-pointer flex items-center gap-2 text-[10px] font-bold text-slate-400 hover:text-slate-600 uppercase tracking-widest transition-colors">
                <span>Advanced Controls</span>
                <svg className="w-3 h-3 transition-transform group-open:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 9l-7 7-7-7" />
                </svg>
              </summary>
              <div className="absolute top-full left-0 mt-2 p-2 bg-white rounded-xl shadow-2xl border border-slate-100 flex flex-col min-w-[200px] z-50">
                {advancedNav.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="px-4 py-2 rounded-lg text-xs font-bold text-slate-600 hover:bg-slate-50 hover:text-slate-900 transition-all"
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

      <footer className="max-w-[1400px] mx-auto px-6 py-12 border-t border-slate-200/40 flex flex-col md:flex-row items-center justify-between gap-6">
        <div className="text-[11px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2">
          <span>OnyxFii</span>
          <span className="w-1 h-1 rounded-full bg-slate-200"></span>
          <span>Autonomous Payroll Intelligence</span>
        </div>
        <div className="flex items-center gap-6">
          <span className="text-[10px] font-bold text-slate-300 uppercase tracking-widest">© 2026 Devnet Proof-of-Concept</span>
        </div>
      </footer>
    </div>
  );
}
