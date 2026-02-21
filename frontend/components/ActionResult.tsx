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

export default function ActionResult({ kind, children }: ActionResultProps) {
  return <div className={`action-result ${kindClass[kind]}`}>{children}</div>;
}
