/**
 * Port interfaces — contracts the domain depends on.
 *
 * Each interface is implemented by exactly one adapter package today. The
 * domain is allowed to know an interface exists; it is not allowed to know
 * which adapter satisfies it. The composition root in `apps/*` does the wiring.
 */

export * from './clock.js';
export * from './ids.js';
export * from './audit.js';
export * from './repositories.js';
export * from './github.js';
