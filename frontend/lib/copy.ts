export const COPY = {
  nav: {
    home: 'Home',
    company: 'Company Payroll',
    worker: 'Worker Portal',
    bridge: 'Bridge',
    ops: 'Operations',
  },
  home: {
    eyebrow: 'Private, live payroll on Solana',
    title: 'Pay your team continuously. Keep pay details private.',
    subtitle:
      'Set up company payroll once, start live earnings, and let workers cash out when they need it. Built for simple demos and real operations.',
    companiesTitle: 'For Companies',
    companiesText:
      'Set up your company payroll wallet, add workers, choose pay plans, and turn on high-speed mode.',
    workersTitle: 'For Workers',
    workersText:
      'Find your payroll record, view live earnings, request payout, and share a verified earnings statement.',
  },
  employer: {
    title: 'Company Payroll',
    subtitle: 'Guided setup for live private payroll',
    step1: {
      title: 'Company setup',
      description: 'Create your company profile and payroll wallet.',
    },
    step2: {
      title: 'Add payroll funds',
      description: 'Move payroll funds into your company payroll wallet.',
    },
    step3: {
      title: 'Add worker and pay plan',
      description: 'Create a worker payroll record and set the earning plan.',
    },
    step4: {
      title: 'Enable high-speed mode (optional)',
      description: 'Use high-speed processing for faster delegated execution.',
    },
    step5: {
      title: 'Go live and monitor',
      description: 'Track readiness and payroll status before demoing payouts.',
    },
  },
  employee: {
    title: 'Worker Portal',
    subtitle: 'View earnings and request payout',
    sectionA: 'Find my payroll stream',
    sectionB: 'Live earnings',
    sectionC: 'Withdraw payout',
    sectionD: 'Share verified earnings statement',
  },
} as const;
