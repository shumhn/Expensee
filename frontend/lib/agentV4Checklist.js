function deriveV4Checklist(status) {
    const executionSteps = Array.isArray(status.executionSteps) ? status.executionSteps : [];
    const internalStepKeys = new Set(['refresh-state']);
    const visibleSteps = executionSteps.filter((s) => s && !internalStepKeys.has(s.key));
    const payloadStep = status.currentlyActiveStep;
    const currentFromPayload =
        payloadStep &&
        payloadStep.key &&
        !internalStepKeys.has(payloadStep.key)
            ? payloadStep
            : null;
    const runningStep = visibleSteps.find((s) => s.status === 'running');
    const pendingStep = visibleSteps.find((s) => s.status === 'pending');
    const currentStep = currentFromPayload || runningStep || pendingStep || null;
    const currentStepIndex = currentStep
        ? (visibleSteps.findIndex((s) => s.key === currentStep.key) >= 0
            ? visibleSteps.findIndex((s) => s.key === currentStep.key) + 1
            : 0)
        : 0;

    const checklistLines = visibleSteps.map((s, idx) => {
        const icon = s.status === 'done' ? '✅' : s.status === 'running' ? '⏳' : '⬜';
        const meta = [];
        if (s.required === false) meta.push('optional');
        if (s.requiresSignature === false) meta.push('no signature');
        if (s.risk) meta.push(`risk: ${s.risk}`);
        const metaLabel = meta.length ? ` (${meta.join(', ')})` : '';
        return `${icon} ${idx + 1}. ${s.label}${metaLabel}${s.detail ? ` — ${s.detail}` : ''}`;
    });

    let checklistNextStep = '';
    if (currentStep && currentStepIndex > 0) {
        checklistNextStep = `Step ${currentStepIndex} - ${currentStep.label}`;
    } else if (visibleSteps.length === 0) {
        checklistNextStep = 'No Checklist Available';
    } else {
        checklistNextStep = 'All Setup Steps Completed!';
    }

    const missingInputs = [];
    if (currentStep?.key === 'create-worker-record' && !status.employeeWallet) {
        missingInputs.push('employee wallet address');
    }
    if (currentStep?.key === 'enable-high-speed' && !status.employeeWallet) {
        missingInputs.push('employee wallet address');
    }
    if (currentStep?.key === 'deposit-funds') {
        if (!status.depositorTokenAccount) {
            missingInputs.push('depositor token account');
        }
        const amt = status.depositAmount;
        if (!amt || !Number.isFinite(Number(amt)) || Number(amt) <= 0) {
            missingInputs.push('deposit amount');
        }
    }

    return {
        visibleSteps,
        checklistLines,
        checklistNextStep,
        currentStep,
        currentStepIndex,
        missingInputs,
    };
}

module.exports = {
    deriveV4Checklist,
};
