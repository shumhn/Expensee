export const COPY = {
  nav: {
    home: 'Home',
    company: 'Company Payroll',
    worker: 'Worker Portal',
    bridge: 'Bridge',
    ops: 'Operations',
  },
  home: {
    eyebrow: 'Real-time · Agentic · Private Payroll on Solana',
    title: 'Stop managing payroll. Hire an Agent.',
    subtitle:
      'OnyxFii is the world\'s first Autonomous Payroll Agent. Tell it who to pay. It handles the privacy, the math, and the movement of money.',
    companiesTitle: 'For Companies',
    companiesText:
      'Chat with the OnyxFii Agent to set up encrypted payroll streams. No forms, no spreadsheets — just tell the Agent your intent.',
    workersTitle: 'For Workers',
    workersText:
      'Watch your earnings tick up in real-time. Cash out whenever you want. Your salary stays fully private on-chain.',
  },
  employer: {
    title: 'OnyxFii Agent',
    subtitle: 'Your autonomous payroll assistant',
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
