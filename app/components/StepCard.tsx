import { ReactNode, useEffect, useMemo, useState } from 'react';
import StatusPill from './StatusPill';

export type StepState = 'done' | 'active' | 'locked' | 'optional';

type StepCardProps = {
  number: number;
  title: string;
  description: string;
  state: StepState;
  children: ReactNode;
  collapsible?: boolean;
};

const stateLabel: Record<StepState, { text: string; tone: 'success' | 'warning' | 'info' | 'neutral' }> = {
  done: { text: 'Complete', tone: 'success' },
  active: { text: 'Current', tone: 'info' },
  locked: { text: 'Locked', tone: 'neutral' },
  optional: { text: 'Optional', tone: 'warning' },
};

export default function StepCard({
  number,
  title,
  description,
  state,
  children,
  collapsible = true,
}: StepCardProps) {
  const label = stateLabel[state];
  const defaultOpen = useMemo(() => state !== 'locked', [state]);
  const [isOpen, setIsOpen] = useState(defaultOpen);

  useEffect(() => {
    if (state !== 'locked') setIsOpen(true);
  }, [state]);

  return (
    <section
      className={`step-card step-${state} transition-all duration-300 ${collapsible ? 'step-collapsible' : ''
        } ${isOpen ? 'step-open' : 'step-closed'}`}
    >
      <div className="step-card-header">
        <div className="flex items-center gap-4">
          <div className="step-card-index">{number}</div>
          <div className="step-card-title-wrap">
            <p className="step-card-kicker">Step {number}</p>
            <h2 className="step-card-title">{title}</h2>
            <p className="step-card-description">{description}</p>
          </div>
        </div>
        <div className="step-card-actions">
          <div className="step-card-status">
            <StatusPill tone={label.tone}>{label.text}</StatusPill>
          </div>
          {collapsible ? (
            <button
              type="button"
              className="step-card-toggle"
              onClick={() => setIsOpen((prev) => !prev)}
              aria-expanded={isOpen}
            >
              {isOpen ? 'Collapse' : 'Expand'}
            </button>
          ) : null}
        </div>
      </div>
      <div className="step-card-body" aria-hidden={!isOpen}>
        <div className="step-card-panel">
          <div className="step-card-flow">{children}</div>
        </div>
      </div>
    </section>
  );
}
