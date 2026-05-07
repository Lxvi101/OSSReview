import { describe, expect, it } from 'vitest';
import { redactTokens } from './redact.js';

describe('redactTokens', () => {
  it('redacts Anthropic keys', () => {
    expect(redactTokens('key=sk-ant-api03-deadbeefdeadbeefdeadbeef')).not.toContain('deadbeef');
  });

  it('redacts GitHub PAT/OAuth/App/Refresh/User-to-server tokens', () => {
    expect(redactTokens('token: ghp_abcdefghijklmnopqrstuvwxyz123456')).toContain('[REDACTED]');
    expect(redactTokens('token: ghs_abcdefghijklmnopqrstuvwxyz123456')).toContain('[REDACTED]');
    expect(redactTokens('token: gho_abcdefghijklmnopqrstuvwxyz123456')).toContain('[REDACTED]');
    expect(redactTokens('token: ghr_abcdefghijklmnopqrstuvwxyz123456')).toContain('[REDACTED]');
    expect(redactTokens('token: ghu_abcdefghijklmnopqrstuvwxyz123456')).toContain('[REDACTED]');
  });

  it('redacts v1.<hex> installation tokens', () => {
    // Built from parts so the literal v1.<40-hex> shape never appears in source
    // (GitHub push protection flags that pattern even in obvious test fixtures).
    const fakeInstallationToken = 'v1.' + 'a'.repeat(40);
    expect(redactTokens(`Authorization: token ${fakeInstallationToken}`)).toContain('[REDACTED]');
  });

  it('redacts JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signaturevalueheresignaturevaluehere';
    expect(redactTokens(`auth: ${jwt}`)).not.toContain(jwt);
  });

  it('redacts a 64-char hex string (SECRETS_KEY shape)', () => {
    const key = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    expect(redactTokens(`SECRETS_KEY=${key}`)).toContain('[REDACTED]');
    expect(redactTokens(`SECRETS_KEY=${key}`)).not.toContain(key);
  });

  it('PRESERVES git commit SHAs (40 hex) — the previous "any long hex" rule was too aggressive', () => {
    const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f0192a3b4c5';
    expect(sha.length).toBe(40);
    expect(redactTokens(`commit ${sha}`)).toBe(`commit ${sha}`);
  });

  it('preserves a 32-char hex (could be many things; named-redact catches real secrets by field)', () => {
    const md5 = 'abcdef0123456789abcdef0123456789';
    expect(redactTokens(`hash: ${md5}`)).toBe(`hash: ${md5}`);
  });

  it('leaves benign strings alone', () => {
    expect(redactTokens('hello world, run id 42')).toBe('hello world, run id 42');
  });
});
