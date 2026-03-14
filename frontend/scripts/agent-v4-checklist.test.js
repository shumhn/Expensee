const { deriveV4Checklist } = require('../lib/agentV4Checklist');

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function runTest(name, fn) {
    try {
        fn();
        console.log(`PASS: ${name}`);
    } catch (err) {
        console.error(`FAIL: ${name}`);
        console.error(err.message || err);
        process.exitCode = 1;
    }
}

runTest('no checklist', () => {
    const out = deriveV4Checklist({});
    assert(out.checklistNextStep === 'No Checklist Available', 'expected no checklist');
});

runTest('current step index ignores refresh-state', () => {
    const status = {
        executionSteps: [
            { key: 'refresh-state', label: 'Refresh', status: 'pending' },
            { key: 'init-master-vault', label: 'Init master vault', status: 'done', required: true, risk: 'high_risk', requiresSignature: true },
            { key: 'register-business', label: 'Register business', status: 'pending', required: true, risk: 'high_risk', requiresSignature: true },
        ],
        currentlyActiveStep: { key: 'register-business', label: 'Register business', status: 'pending' },
    };
    const out = deriveV4Checklist(status);
    assert(out.checklistNextStep === 'Step 2 - Register business', 'expected step 2');
});

runTest('missing inputs for deposit', () => {
    const status = {
        executionSteps: [
            { key: 'deposit-funds', label: 'Deposit funds', status: 'pending', required: true, risk: 'review', requiresSignature: true },
        ],
        depositorTokenAccount: '',
        depositAmount: '',
    };
    const out = deriveV4Checklist(status);
    assert(out.missingInputs.includes('depositor token account'), 'missing depositor token account');
    assert(out.missingInputs.includes('deposit amount'), 'missing deposit amount');
});

runTest('missing inputs for worker record', () => {
    const status = {
        executionSteps: [
            { key: 'create-worker-record', label: 'Create worker record', status: 'pending', required: true, risk: 'review', requiresSignature: true },
        ],
        employeeWallet: '',
    };
    const out = deriveV4Checklist(status);
    assert(out.missingInputs.includes('employee wallet address'), 'missing employee wallet');
});
