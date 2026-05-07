import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Eta } from 'eta';

/**
 * Tiny template renderer.
 *
 * Why Eta over Handlebars/Pug/EJS:
 *   - Tiny (≤30kb), zero deps, has stayed stable for years.
 *   - Familiar `<%= %>` / `<%~ %>` syntax with autoescape on by default.
 *   - Layouts are a single function call, no plugin maze.
 *
 * Templates live in `src/templates/**` (mirrored to `dist/templates/**` by
 * the build). Resolved relative to *this* file so the package works regardless
 * of the consuming app's cwd.
 */

const here = dirname(fileURLToPath(import.meta.url));
const templatesDir = resolve(here, 'templates');

export interface PageContext {
  readonly title: string;
  readonly currentPath: string;
  readonly user?: { readonly name: string } | undefined;
  /** CSRF token to embed in mutating forms. */
  readonly csrfToken?: string | undefined;
}

export class WebRenderer {
  private readonly eta: Eta;

  constructor() {
    this.eta = new Eta({ views: templatesDir, cache: true, autoEscape: true });
  }

  render(template: string, data: Record<string, unknown>): string {
    return this.eta.render(template, data) as string;
  }

  /** Render a body template inside the standard layout. */
  page(template: string, data: { readonly ctx: PageContext } & Record<string, unknown>): string {
    const body = this.eta.render(template, data) as string;
    return this.eta.render('layout.eta', { ...data, body }) as string;
  }
}

export const STATIC_DIR = resolve(here, 'static');
export { templatesDir as TEMPLATES_DIR };
export { join };
