import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from './webhookVerify.js';

const SECRET = 'test-secret';

function sign(body: Buffer): string {
  return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

describe('verifyWebhookSignature', () => {
  it('accepts a valid signature', () => {
    const body = Buffer.from('{"hello":"world"}', 'utf8');
    expect(
      verifyWebhookSignature({ secret: SECRET, rawBody: body, signatureHeader: sign(body) }),
    ).toBe(true);
  });

  it('rejects a tampered body', () => {
    const body = Buffer.from('{"hello":"world"}', 'utf8');
    const sig = sign(body);
    const tampered = Buffer.from('{"hello":"hacker"}', 'utf8');
    expect(
      verifyWebhookSignature({ secret: SECRET, rawBody: tampered, signatureHeader: sig }),
    ).toBe(false);
  });

  it('rejects missing header', () => {
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        rawBody: Buffer.from(''),
        signatureHeader: undefined,
      }),
    ).toBe(false);
  });

  it('rejects malformed prefix', () => {
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        rawBody: Buffer.from(''),
        signatureHeader: 'md5=abc',
      }),
    ).toBe(false);
  });

  it('rejects wrong secret', () => {
    const body = Buffer.from('hi');
    const wrongSig = `sha256=${createHmac('sha256', 'wrong').update(body).digest('hex')}`;
    expect(
      verifyWebhookSignature({ secret: SECRET, rawBody: body, signatureHeader: wrongSig }),
    ).toBe(false);
  });
});
