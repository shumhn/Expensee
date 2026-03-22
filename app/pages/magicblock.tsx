import Head from 'next/head';
import Link from 'next/link';
import ExpenseeShell from '../components/ExpenseeShell';

const runtimeSteps = [
  'Delegate employee stream to a MagicBlock validator',
  'Schedule the autonomous crank through the MagicBlock router',
  'Accrue salary inside the delegated TEE / ER environment',
  'Commit back to Solana base layer when settlement is needed',
  'Redelegate so real-time payroll resumes',
];

const codeMap = [
  {
    path: 'app/lib/magicblock/index.ts',
    label: 'Canonical app entrypoint',
    note: 'Start here to see the public MagicBlock surface used by the app.',
  },
  {
    path: 'app/lib/payroll-client.ts',
    label: 'Runtime payroll lifecycle',
    note: 'Contains the v4 delegate, schedule, commit, and redelegate calls.',
  },
  {
    path: 'app/pages/employer.tsx',
    label: 'Employer operator flow',
    note: 'Shows delegation controls, validator selection, and crank lifecycle actions.',
  },
  {
    path: 'app/pages/employee.tsx',
    label: 'Employee TEE flow',
    note: 'Shows TEE auth requirements and high-speed withdrawal flow.',
  },
  {
    path: 'app/pages/api/magicblock/delegation-status.ts',
    label: 'Live router status probe',
    note: 'Queries delegation state through the router with shared endpoint validation.',
  },
  {
    path: 'programs/payroll/src/lib.rs',
    label: 'On-chain proof',
    note: 'Contains `delegate_stream_v4`, `schedule_crank_v4`, `crank_settle_v4`, and redelegation logic.',
  },
];

const proofPoints = [
  'MagicBlock has a dedicated module in `app/lib/magicblock/`.',
  'The README has a first-class MagicBlock integration section.',
  'There is a dedicated `docs/MAGICBLOCK.md` walkthrough for judges and reviewers.',
  'Both MagicBlock API routes share one endpoint normalizer instead of duplicating host checks.',
];

export default function MagicBlockPage() {
  return (
    <>
      <Head>
        <title>Expensee | MagicBlock Integration</title>
        <meta
          name="description"
          content="Judge-facing walkthrough of how Expensee uses MagicBlock for real-time payroll streaming."
        />
      </Head>

      <ExpenseeShell
        title="MagicBlock Integration"
        subtitle="One page to review the runtime flow, code ownership, and proof points for Expensee's MagicBlock usage."
        actions={
          <Link className="expensee-action-btn outline" href="/employee">
            See Employee Flow
          </Link>
        }
      >
        <section className="grid gap-4 lg:grid-cols-[1.25fr_0.85fr]">
          <div className="rounded-3xl border border-[var(--app-border)] bg-[var(--app-surface)] p-6 shadow-[var(--premium-shadow)]">
            <div className="mb-4 inline-flex items-center rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">
              Judge View
            </div>
            <h2 className="text-3xl font-black tracking-tight text-[var(--app-ink)]">
              Expensee uses MagicBlock as the real-time execution layer for v4 payroll streams.
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--app-muted)]">
              This is not a placeholder integration. Streams are delegated, scheduled, executed in the
              TEE / ER environment, committed back to Solana when needed, and redelegated so live payroll
              continues.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link className="premium-btn premium-btn-primary" href="/employer">
                Open Employer Controls
              </Link>
              <Link className="premium-btn premium-btn-secondary" href="/employee">
                Open Employee Flow
              </Link>
            </div>
          </div>

          <div className="rounded-3xl border border-[var(--app-border)] bg-[var(--app-surface-alt)] p-6">
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--app-muted)]">
              Fast Review
            </div>
            <div className="mt-4 space-y-3">
              {proofPoints.map((point) => (
                <div
                  key={point}
                  className="rounded-2xl border border-white/6 bg-black/10 px-4 py-3 text-sm text-[var(--app-ink)]"
                >
                  {point}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mt-6 grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="rounded-3xl border border-[var(--app-border)] bg-[var(--app-surface)] p-6">
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--app-muted)]">
              Runtime Loop
            </div>
            <div className="mt-4 space-y-3">
              {runtimeSteps.map((step, index) => (
                <div key={step} className="flex gap-3 rounded-2xl border border-white/6 bg-black/10 p-4">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-cyan-400/12 text-sm font-bold text-cyan-300">
                    {index + 1}
                  </div>
                  <div className="text-sm leading-6 text-[var(--app-ink)]">{step}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-3xl border border-[var(--app-border)] bg-[var(--app-surface)] p-6">
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--app-muted)]">
              Code Map
            </div>
            <div className="mt-4 space-y-3">
              {codeMap.map((entry) => (
                <div key={entry.path} className="rounded-2xl border border-white/6 bg-black/10 p-4">
                  <div className="text-xs font-semibold uppercase tracking-[0.14em] text-cyan-300">
                    {entry.label}
                  </div>
                  <div className="mt-2 font-mono text-sm text-[var(--app-ink)]">{entry.path}</div>
                  <div className="mt-2 text-sm leading-6 text-[var(--app-muted)]">{entry.note}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mt-6 rounded-3xl border border-[var(--app-border)] bg-[var(--app-surface)] p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--app-muted)]">
                Repo Guides
              </div>
              <p className="mt-2 text-sm text-[var(--app-muted)]">
                For source review, start with the repo docs first, then inspect the employer and employee flows.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <span className="rounded-full border border-white/10 bg-black/10 px-3 py-2 font-mono text-xs text-[var(--app-ink)]">
                README.md
              </span>
              <span className="rounded-full border border-white/10 bg-black/10 px-3 py-2 font-mono text-xs text-[var(--app-ink)]">
                docs/MAGICBLOCK.md
              </span>
              <span className="rounded-full border border-white/10 bg-black/10 px-3 py-2 font-mono text-xs text-[var(--app-ink)]">
                app/lib/magicblock/
              </span>
            </div>
          </div>
        </section>
      </ExpenseeShell>
    </>
  );
}
