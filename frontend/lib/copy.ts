export const COPY = {
  nav: {
    home: 'Home',
    company: 'Company Payroll',
    worker: 'Employee Portal',
    bridge: 'Bridge',
    ops: 'Operations',
  },
  home: {
    eyebrow: 'Realtime Private Payroll on Solana',
    title: 'Private Payroll for Realtime Teams',
    subtitle:
      'Encrypt salary data, run continuous earnings, and settle payouts on demand with automation built in.',
    companiesTitle: 'For Companies',
    companiesText:
      'Set up private payroll records, fund your vault, and run payout operations with guided automation.',
    workersTitle: 'For Employees',
    workersText:
      'Track live earnings, request payout when needed, and claim securely while salary amounts stay encrypted.',
  },
  employer: {
    title: 'Expensee Payroll Console',
    subtitle: 'Operate private realtime payroll with guided automation',
    step1: {
      title: 'Company setup',
      description: 'Create your company profile and payroll wallet.',
    },
    step2: {
      title: 'Add payroll funds',
      description: 'Move payroll funds into your company payroll wallet.',
    },
    step3: {
      title: 'Set employee auth and pay plan',
      description: 'Create a private payroll record and set the earning plan.',
    },
    step4: {
      title: 'Enable high-speed mode (required)',
      description: 'MagicBlock delegation is required for real-time payroll while keeping Inco amounts encrypted.',
    },
    step5: {
      title: 'Go live and monitor',
      description: 'Track readiness and payroll status before live payouts.',
    },
  },
  employee: {
    title: 'Employee Portal',
    subtitle: 'Track encrypted earnings and request payout anytime',
    sectionA: 'Find my payroll stream',
    sectionB: 'Live earnings',
    sectionC: 'Payout journey',
    sectionD: 'Share verified earnings statement',
  },
} as const;
