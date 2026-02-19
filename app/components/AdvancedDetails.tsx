import { ReactNode } from 'react';

type AdvancedDetailsProps = {
  title?: string;
  children: ReactNode;
  defaultOpen?: boolean;
};

export default function AdvancedDetails({
  title = 'Advanced details',
  children,
  defaultOpen = false,
}: AdvancedDetailsProps) {
  return (
    <details className="advanced-details" open={defaultOpen}>
      <summary>{title}</summary>
      <div className="advanced-details-body">{children}</div>
    </details>
  );
}
