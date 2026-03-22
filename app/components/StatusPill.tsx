import { ReactNode } from 'react';

export type PillTone = 'success' | 'warning' | 'info' | 'neutral';

const toneStyles: Record<PillTone, string> = {
  success: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  warning: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  info: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
  neutral: 'bg-[var(--app-surface-alt)] text-[var(--app-muted)] border-[var(--app-border)]',
};

const dotColors: Record<PillTone, string> = {
  success: 'bg-emerald-400',
  warning: 'bg-amber-400',
  info: 'bg-cyan-400',
  neutral: 'bg-[var(--app-muted)]',
};

type StatusPillProps = {
  tone?: PillTone;
  children: ReactNode;
};

export default function StatusPill({ tone = 'neutral', children }: StatusPillProps) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border ${toneStyles[tone]}`}>
      <span className={`w-1 h-1 rounded-full ${dotColors[tone]}`} />
      {children}
    </span>
  );
}
