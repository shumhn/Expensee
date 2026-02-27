import { ReactNode } from 'react';
import StatusPill from './StatusPill';

export type StepState = 'done' | 'active' | 'locked' | 'optional';

type StepCardProps = {
  number: number;
  title: string;
  description: string;
  state: StepState;
  children: ReactNode;
};

const stateLabel: Record<StepState, { text: string; tone: 'success' | 'warning' | 'info' | 'neutral' }> = {
  done: { text: 'Complete', tone: 'success' },
  active: { text: 'Current', tone: 'info' },
  locked: { text: 'Locked', tone: 'neutral' },
  optional: { text: 'Optional', tone: 'warning' },
};

export default function StepCard({ number, title, description, state, children }: StepCardProps) {
  const label = stateLabel[state];
  return (
    <section className={`step-card step-${state} glass transition-all duration-300 hover:shadow-2xl`}>
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-white/10 pb-4 mb-6">
        <div className="flex items-center gap-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 text-sm font-bold text-white shadow-lg">
            {number}
          </div>
          <div>
            <h2 className="text-xl font-bold tracking-tight text-slate-900">{title}</h2>
            <p className="text-sm font-medium text-slate-500">{description}</p>
          </div>
        </div>
        <StatusPill tone={label.tone}>{label.text}</StatusPill>
      </div>
      <div className="step-card-body px-1">{children}</div>
    </section>
  );
}
