import Head from 'next/head';
import Link from 'next/link';
import PageShell from '../components/PageShell';
import StatusPill from '../components/StatusPill';
import { COPY } from '../lib/copy';

export default function HomePage() {
  return (
    <PageShell
      icon="◈"
      title="Expensee"
      subtitle="Realtime private payroll for modern teams"
      navItems={[
        { href: '/', label: COPY.nav.home },
        { href: '/employer', label: COPY.nav.company },
        { href: '/employee', label: COPY.nav.worker },
        { href: '/bridge', label: COPY.nav.bridge, advanced: true },
      ]}
    >
      <Head>
        <title>Expensee | Realtime Private Payroll</title>
        <meta
          name="description"
          content="Realtime private payroll with encrypted salary amounts and privacy-preserving payout routing."
        />
      </Head>

      <section className="hero-card">
        <p className="hero-eyebrow">{COPY.home.eyebrow}</p>
        <h1 className="hero-title">{COPY.home.title}</h1>
        <p className="hero-subtitle">{COPY.home.subtitle}</p>

        <div className="hero-actions">
          <Link href="/employer" className="premium-btn premium-btn-primary">
            Start Company Setup
          </Link>
          <Link href="/employee" className="premium-btn premium-btn-secondary">
            Open Employee Portal
          </Link>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <StatusPill tone="success">Live earnings updates</StatusPill>
          <StatusPill tone="info">On-demand payout</StatusPill>
          <StatusPill tone="warning">Encrypted salary data</StatusPill>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <article className="panel-card">
          <h2 className="text-xl font-bold">{COPY.home.companiesTitle}</h2>
          <p className="mt-2 text-sm text-slate-600">{COPY.home.companiesText}</p>
          <ul className="mt-3 space-y-2 text-sm text-slate-700">
            <li>1. Create payroll wallet</li>
            <li>2. Add payroll funds</li>
            <li>3. Add employees and pay plans</li>
            <li>4. Turn on high-speed mode (optional)</li>
          </ul>
          <Link href="/employer" className="mt-4 inline-flex premium-btn premium-btn-primary">
            Go to Company Payroll
          </Link>
        </article>

        <article className="panel-card">
          <h2 className="text-xl font-bold">{COPY.home.workersTitle}</h2>
          <p className="mt-2 text-sm text-slate-600">{COPY.home.workersText}</p>
          <ul className="mt-3 space-y-2 text-sm text-slate-700">
            <li>1. Load payroll record</li>
            <li>2. Reveal live earnings</li>
            <li>3. Request payout</li>
            <li>4. Share verified earnings statement</li>
          </ul>
          <Link href="/employee" className="mt-4 inline-flex premium-btn premium-btn-secondary">
            Go to Employee Portal
          </Link>
        </article>
      </section>

      <section className="panel-card">
        <h3 className="text-lg font-bold">Why Expensee</h3>
        <p className="mt-2 text-sm text-slate-600">
          Expensee combines encrypted payroll amounts with private payout routing to reduce who-paid-whom exposure on-chain.
        </p>
        <ul className="mt-3 space-y-2 text-sm text-slate-700">
          <li>1. Amount privacy: salaries, accruals, and payouts stay encrypted.</li>
          <li>2. Realtime experience: earnings update continuously with on-demand payout requests.</li>
          <li>3. Linkability reduction: shielded routing breaks direct employer-to-employee payout traces.</li>
        </ul>
        <p className="mt-3 text-sm text-slate-600">
          Advanced tools are available for judges and operator review.
        </p>
        <div className="mt-3">
          <Link href="/bridge" className="text-sm underline">
            Open Bridge (Advanced)
          </Link>
        </div>
      </section>
    </PageShell>
  );
}
