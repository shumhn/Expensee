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
    <div className="min-h-screen bg-app-bg text-app-ink">
      <header className="app-header">
        <div className="app-container app-header-row">
          <div className="app-brand">
            <span className="app-brand-icon" aria-hidden>
              {icon}
            </span>
            <div>
              <Link href="/" className="app-brand-title">
                {title}
              </Link>
              {subtitle ? <p className="app-brand-subtitle">{subtitle}</p> : null}
            </div>
          </div>
          <WalletButton />
        </div>
        {navItems.length > 0 ? (
          <div className="app-container app-nav-row">
            <nav className="app-nav" aria-label="Primary navigation">
              {primaryNav.map((item) => (
                <Link key={item.href} href={item.href} className="app-nav-link">
                  {item.label}
                </Link>
              ))}
            </nav>
            {advancedNav.length > 0 ? (
              <details className="advanced-menu">
                <summary>Advanced</summary>
                <div className="advanced-menu-panel">
                  {advancedNav.map((item) => (
                    <Link key={item.href} href={item.href} className="advanced-menu-link">
                      {item.label}
                    </Link>
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        ) : null}
      </header>

      <main className="app-container app-main">{children}</main>
    </div>
  );
}
