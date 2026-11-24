import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.config.js'

// The full suite remains the money restore-contract run. This second profile
// exercises memory, evidence, auth, Workshop and support with the gate UNSET.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      env: { TEST_PROFILE: 'job-memory' },
      exclude: [
        '**/node_modules/**',
        'tests/budget*.test.ts',
        'tests/money.http.test.ts',
        'tests/cross-job-money.http.test.ts',
        'tests/labour-people*.test.ts',
        'tests/labour-budget*.test.ts',
        'tests/paid-labour*.test.ts',
        'tests/payments.http.test.ts',
        'tests/supplier-*.test.ts',
        'tests/memory-budget-category-reassignment.http.test.ts',
        'tests/memory-view/memory-view.cost-summary.http.test.ts',
        // The old labourHoursSummary wire contract exists only on restoration.
        // Current memoryView.hours is covered by the real-DB job-memory suite.
        'tests/memory-view/memory-view.labour-hours.http.test.ts',
        'tests/review-queue/review-queue.costs.http.test.ts',
        'tests/review-queue/review-queue.budget-category.http.test.ts',
        'tests/receipts.http.test.ts',
      ],
    },
  }),
)
