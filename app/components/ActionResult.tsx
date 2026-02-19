import { ReactNode } from 'react';

type ActionResultProps = {
  kind: 'success' | 'error' | 'info';
  children: ReactNode;
};

const kindClass = {
  success: 'result-success',
  error: 'result-error',
  info: 'result-info',
};

export default function ActionResult({ kind, children }: ActionResultProps) {
  return <div className={`action-result ${kindClass[kind]}`}>{children}</div>;
}
