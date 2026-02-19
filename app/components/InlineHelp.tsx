import { ReactNode } from 'react';

type InlineHelpProps = {
  children: ReactNode;
};

export default function InlineHelp({ children }: InlineHelpProps) {
  return <p className="inline-help">Need help? {children}</p>;
}
