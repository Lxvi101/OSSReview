/**
 * @gcr/config — bootstrap configuration.
 *
 * The schema below is the *complete* list of what we read from the
 * environment. Everything else (GitHub App credentials, prompt customizations,
 * path filters) lives in the DB and is
 * configurable at runtime through the UI.
 *
 * Why so few env vars: the runtime-mutable settings need to be edited without
 * a deploy, and operators consistently underestimate how irritating
 * "redeploy to change a setting" gets.
 */

export * from './schema.js';
export * from './load.js';
