import { describe, expect, it } from 'vitest';
import { parseBootEnv } from './load.js';

const valid = {
  PUBLIC_URL: 'http://localhost:3000',
  SESSION_SECRET: 'a'.repeat(48),
  SECRETS_KEY: '0'.repeat(64),
};

describe('parseBootEnv', () => {
  it('accepts a minimal valid env', () => {
    const result = parseBootEnv(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.PORT).toBe(3000);
      expect(result.value.LOG_LEVEL).toBe('info');
      expect(result.value.REVIEWER_PROVIDER).toBe('claude');
      expect(result.value.CLAUDE_CODE_BINARY).toBe('claude');
      expect(result.value.CODEX_BINARY).toBe('codex');
      expect(result.value.REVIEWER_TIMEOUT_MS).toBe(20 * 60 * 1000);
    }
  });

  it('rejects missing SECRETS_KEY', () => {
    const { SECRETS_KEY: _omit, ...rest } = valid;
    const result = parseBootEnv(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.find((e) => e.path === 'SECRETS_KEY')).toBeDefined();
  });

  it('rejects too-short SESSION_SECRET', () => {
    const result = parseBootEnv({ ...valid, SESSION_SECRET: 'tiny' });
    expect(result.ok).toBe(false);
  });

  it('rejects bad SECRETS_KEY hex length', () => {
    const result = parseBootEnv({ ...valid, SECRETS_KEY: 'abc' });
    expect(result.ok).toBe(false);
  });

  it('coerces PORT from string', () => {
    const result = parseBootEnv({ ...valid, PORT: '8080' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.PORT).toBe(8080);
  });
});
