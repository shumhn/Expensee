import { ReactNode } from 'react';

export type PillTone = 'success' | 'warning' | 'info' | 'neutral';

const toneStyles: Record<PillTone, string> = {
  success: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  warning: 'bg-amber-50 text-amber-700 border-amber-100',
  info: 'bg-indigo-50 text-indigo-700 border-indigo-100',
  neutral: 'bg-slate-100 text-slate-600 border-slate-200',
};

const dotColors: Record<PillTone, string> = {
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  info: 'bg-indigo-500',
  neutral: 'bg-slate-400',
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
