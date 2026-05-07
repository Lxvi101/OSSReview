/**
 * Test helpers — fakes for the ports defined in src/ports/*.
 *
 * Importable as `@gcr/core/testing` from any other package's test suite. They
 * MUST stay pure (no I/O) so adapter tests can substitute them without
 * pulling in extra deps.
 */

export * from './clock.js';
export * from './ids.js';
