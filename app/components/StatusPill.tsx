import { ReactNode } from 'react';

export type PillTone = 'success' | 'warning' | 'info' | 'neutral';

const toneClass: Record<PillTone, string> = {
  success: 'pill-success',
  warning: 'pill-warning',
  info: 'pill-info',
  neutral: 'pill-neutral',
};

type StatusPillProps = {
  tone?: PillTone;
  children: ReactNode;
};

export default function StatusPill({ tone = 'neutral', children }: StatusPillProps) {
  return <span className={`status-pill ${toneClass[tone]}`}>{children}</span>;
}
