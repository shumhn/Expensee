import Link from 'next/link';
import dynamic from 'next/dynamic';
import { ReactNode } from 'react';
import { useRouter } from 'next/router';

const WalletButton = dynamic(() => import('./WalletButton'), {
  ssr: false,
});

type ExpenseeShellProps = {
  title: string;
  subtitle: string;
  children: ReactNode;
  actions?: ReactNode;
};

export default function ExpenseeShell({ title, subtitle, children, actions }: ExpenseeShellProps) {
  const router = useRouter();
  const isEmployer = router.pathname.includes('employer');
  const isEmployee = router.pathname.includes('employee');
  const isActive = (path: string) => router.asPath.startsWith(path);
  return (
    <div className="expensee-shell">
      <div className="expensee-layout">
        <aside className="expensee-sidebar">
          <div className="expensee-brand">
            <div className="expensee-brand-icon">◎</div>
            <div className="expensee-brand-text">Expensee</div>
          </div>

          <div className="expensee-role-toggle">
            <Link className={`expensee-role ${isEmployer ? 'active' : ''}`} href="/employer">
              Employer
            </Link>
            <Link className={`expensee-role ${isEmployee ? 'active' : ''}`} href="/employee">
              Employee
            </Link>
          </div>

          <div className="expensee-search">
            <input placeholder="Search..." />
            <span>⌘ K</span>
          </div>

          <nav className="expensee-nav">
            <Link className={`expensee-nav-link ${isActive('/dashboard') ? 'active' : ''}`} href="/employer?mode=dashboard" as="/dashboard" shallow={true}>
              Home
            </Link>
            <Link className={`expensee-nav-link ${isActive('/setup') ? 'active' : ''}`} href="/employer?mode=setup" as="/setup" shallow={true}>
              Setup
            </Link>
            <Link className={`expensee-nav-link ${isActive('/employees') ? 'active' : ''}`} href="/employer?mode=employees" as="/employees" shallow={true}>
              Employees
            </Link>
            <Link className={`expensee-nav-link ${isActive('/history') ? 'active' : ''}`} href="/employer?mode=history" as="/history" shallow={true}>
              History
            </Link>
            <Link className={`expensee-nav-link ${isActive('/agent') ? 'active' : ''}`} href="/employer?mode=agent" as="/agent" shallow={true}>
              Agent
            </Link>
          </nav>

          <div className="expensee-wallet">
            <WalletButton />
          </div>
        </aside>

        <div className="expensee-main">
          <header className="expensee-topbar">
            <div>
              <h1>{title}</h1>
              <p>{subtitle}</p>
            </div>
            <div className="expensee-actions">
              {actions}
              <Link className="expensee-action-btn outline" href="/employer?mode=setup" as="/setup" shallow={true}>
                Start Setup
              </Link>
              <Link className="expensee-action-btn" href="/employer?mode=agent" as="/agent" shallow={true}>
                Agent
              </Link>
              <div className="expensee-icon-btn">🔔</div>
            </div>
          </header>

          <main className="expensee-content">{children}</main>
        </div>
      </div>
    </div>
  );
}
