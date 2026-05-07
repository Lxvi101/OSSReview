/**
 * @gcr/core — pure domain.
 *
 * No package in this directory may make network calls, touch the database,
 * or read the file system. Reading the wall clock is permitted and lives
 * behind the `Clock` port. The boundary plugin enforces this in CI. The
 * point is to make the domain easy to test without mocks and easy to read
 * in 2036.
 */

export * from './ids.js';
export * from './time.js';
export * from './errors.js';
export * from './clock.js';

// Aggregates
export * from './repository/aggregate.js';
export * from './pullRequest/aggregate.js';
export * from './reviewRun/state.js';
export * from './reviewRun/aggregate.js';
export * from './reviewRun/idempotency.js';
export * from './webhook/delivery.js';
export * from './webhook/triage.js';
export * from './audit/event.js';

// Domain services (pure)
export * from './policy/shouldReview.js';
export * from './policy/costGuards.js';
export * from './formatter/reviewBody.js';

// Ports — re-exported on the subpath for clarity but also on root for ergonomics.
export * from './ports/index.js';
