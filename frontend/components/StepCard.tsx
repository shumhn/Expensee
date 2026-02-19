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
    <section className={`step-card step-${state}`}>
      <div className="step-card-head">
        <div>
          <div className="step-chip">Step {number}</div>
          <h2 className="step-title">{title}</h2>
          <p className="step-description">{description}</p>
        </div>
        <StatusPill tone={label.tone}>{label.text}</StatusPill>
      </div>
      <div className="step-card-body">{children}</div>
    </section>
  );
}
