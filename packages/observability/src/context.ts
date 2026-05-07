import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Correlation context propagated through the request/job lifecycle so log
 * lines from any depth in the call graph carry the same trace ids.
 *
 * The context is read by the logger (see logger.ts mixin) and the OTel
 * tracer. Setting a field overwrites any existing value with the same name in
 * the current scope.
 */

export interface CorrelationContext {
  readonly traceId?: string;
  readonly deliveryId?: string;
  readonly jobId?: number;
  readonly reviewRunId?: number;
  readonly repo?: string; // "owner/name"
  readonly prNumber?: number;
}

const als = new AsyncLocalStorage<CorrelationContext>();

export function getContext(): CorrelationContext {
  return als.getStore() ?? {};
}

/** Run `fn` with the given context overlaid on the parent context. */
export function withContext<T>(ctx: Partial<CorrelationContext>, fn: () => T): T {
  const merged = { ...getContext(), ...ctx };
  return als.run(merged, fn);
}

/** Async-friendly variant. */
export async function withContextAsync<T>(
  ctx: Partial<CorrelationContext>,
  fn: () => Promise<T>,
): Promise<T> {
  const merged = { ...getContext(), ...ctx };
  return als.run(merged, fn);
}
