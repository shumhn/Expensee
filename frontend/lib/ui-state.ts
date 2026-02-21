import { StepState } from '../components/StepCard';

export type EmployerWizardState = {
  businessReady: boolean;
  vaultReady: boolean;
  vaultFunded: boolean;
  configReady: boolean;
  hasWorkerRecord: boolean;
  highSpeedOn: boolean;
};

export function getEmployerStepStates(state: EmployerWizardState): Record<number, StepState> {
  const step1: StepState = state.businessReady && state.vaultReady ? 'done' : 'active';
  const step2: StepState = state.vaultFunded ? 'done' : state.businessReady && state.vaultReady ? 'active' : 'locked';
  const step3: StepState = state.hasWorkerRecord ? 'done' : state.vaultReady && state.configReady ? 'active' : 'locked';
  const step4: StepState = state.highSpeedOn ? 'done' : state.hasWorkerRecord ? 'optional' : 'locked';
  const step5: StepState = state.hasWorkerRecord ? 'active' : 'locked';
  return { 1: step1, 2: step2, 3: step3, 4: step4, 5: step5 };
}

export function toBooleanFlag(value: boolean | null | undefined): boolean {
  return Boolean(value);
}
