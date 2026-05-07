import { Writable } from 'node:stream';
import { buildLogger } from '@gcr/observability';
import { describe, expect, it } from 'vitest';

const SENTINELS = [
  'sk-ant-api03-deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdead',
  'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'ghs_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
];

/**
 * No-leak invariant: with sensitive sentinels in the bag of values we log, the
 * bytes that reach stdout must contain none of them. The redactor is the
 * bouncer — this test is the audit.
 */
describe('logger never leaks known token shapes', () => {
  it('redacts every sentinel in arbitrary log positions', () => {
    const captured: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        captured.push(chunk.toString('utf8'));
        cb();
      },
    });
    const logger = buildLogger({ level: 'trace', stream: sink });

    for (const sentinel of SENTINELS) {
      logger.info({ msg: 'inline', token: sentinel });
      logger.info(`embedded leak: ${sentinel}`);
      logger.error(new Error(`error message: ${sentinel}`));
    }

    const output = captured.join('');
    for (const sentinel of SENTINELS) {
      expect(output, `sentinel must not appear: ${sentinel.slice(0, 20)}…`).not.toContain(
        sentinel,
      );
    }
  });
});
