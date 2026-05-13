import type { BootEnv } from '@gcr/config';
import type { Logger } from '@gcr/observability';
import type { DB } from '@gcr/storage';
import { betterAuth } from 'better-auth';
import type { Kysely } from 'kysely';

/**
 * Single Better Auth instance for the server.
 *
 * Email/password only. Signup is open at the library level; we gate it to
 * "first user wins" in the Fastify pre-handler (see fastify.ts) so the
 * operator can sign up exactly once at first boot and no one else can
 * after.
 *
 * Better Auth manages the user/session/account/verification tables via its
 * own Kysely instance. We pass the same connection so everything lives in
 * the one SQLite file.
 */
export interface BuildAuthDeps {
  readonly env: BootEnv;
  readonly db: Kysely<DB>;
  readonly logger: Logger;
}

export function buildAuth(deps: BuildAuthDeps) {
  return betterAuth({
    appName: 'gcr',
    secret: deps.env.SESSION_SECRET,
    baseURL: deps.env.PUBLIC_URL,
    trustedOrigins: [deps.env.PUBLIC_URL],
    database: {
      db: deps.db,
      type: 'sqlite',
    },
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      minPasswordLength: 12,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
  });
}

export type AuthInstance = ReturnType<typeof buildAuth>;
