import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a GitHub webhook signature.
 *
 * Why we use `node:crypto` directly instead of `@octokit/webhooks-methods`:
 *   - One fewer dep on the hot path.
 *   - We need to operate on the raw `Buffer` body before any JSON parse, and
 *     a tiny purpose-built function makes that contract explicit.
 *
 * Constant-time comparison via `timingSafeEqual`. Length mismatch returns
 * false without comparing.
 */

export interface VerifyArgs {
  readonly secret: string;
  readonly rawBody: Buffer;
  readonly signatureHeader: string | undefined; // X-Hub-Signature-256
}

export function verifyWebhookSignature({ secret, rawBody, signatureHeader }: VerifyArgs): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const provided = signatureHeader.slice('sha256='.length);

  const computed = createHmac('sha256', secret).update(rawBody).digest('hex');
  if (provided.length !== computed.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(computed, 'hex'));
  } catch {
    return false;
  }
}
