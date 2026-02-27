import { ReactNode } from 'react';

type ActionResultProps = {
  kind: 'success' | 'error' | 'info' | 'warning';
  children: ReactNode;
};

const kindClass = {
  success: 'result-success',
  error: 'result-error',
  info: 'result-info',
  warning: 'result-warning',
};

const kindIcon = {
  success: '✓',
  error: '⚠',
  info: 'ℹ',
  warning: '⚡',
};

export default function ActionResult({ kind, children }: ActionResultProps) {
  return (
    <div className={`action-result ${kindClass[kind]} mt-4 flex items-start gap-3 border border-transparent transition-all duration-300`}>
      <span className="flex-shrink-0 flex h-5 w-5 items-center justify-center rounded-full bg-white/20 text-xs font-bold">
        {kindIcon[kind]}
      </span>
      <div className="font-medium">{children}</div>
    </div>
  );
}
