// Test selection/expectations only; never enables the production feature gate.
// Both profiles are run in CI. Pure money assertions belong to the restore run.
export const moneyEnabled = process.env.TEST_PROFILE !== 'job-memory'
