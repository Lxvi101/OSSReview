import {
  type GithubInstallationId,
  type InstallationToken,
  RetryableError,
} from '@gcr/core';
import { createAppAuth } from '@octokit/auth-app';

/**
 * GitHub App authentication: installation-token cache.
 *
 * Every installation gets a short-lived (1 h) token. We cache them and refresh
 * 60 s before expiry. Token rotation under our feet is fine — the worst case
 * is one extra exchange.
 *
 * The auth function is created once with the App's `appId` and `privateKey`;
 * each `installationToken(id)` call asks Octokit to mint or refresh a token
 * scoped to that installation.
 */

export interface AppAuthConfig {
  readonly appId: number;
  readonly privateKey: string; // PEM
}

interface CacheEntry {
  readonly token: InstallationToken;
  readonly fetchedAt: number;
}

export class InstallationTokenCache {
  private readonly auth: ReturnType<typeof createAppAuth>;
  private readonly cache = new Map<number, CacheEntry>();
  private readonly refreshLeadMs = 60_000;

  constructor(cfg: AppAuthConfig) {
    this.auth = createAppAuth({ appId: cfg.appId, privateKey: cfg.privateKey });
  }

  async get(installationId: GithubInstallationId): Promise<InstallationToken> {
    const entry = this.cache.get(installationId as number);
    if (entry && new Date(entry.token.expiresAt).getTime() - Date.now() > this.refreshLeadMs) {
      return entry.token;
    }
    return this.refresh(installationId);
  }

  async refresh(installationId: GithubInstallationId): Promise<InstallationToken> {
    try {
      const result = await this.auth({
        type: 'installation',
        installationId: installationId as number,
      });
      const token: InstallationToken = {
        token: result.token,
        expiresAt: result.expiresAt,
      };
      this.cache.set(installationId as number, { token, fetchedAt: Date.now() });
      return token;
    } catch (err) {
      throw new RetryableError(
        'github.token_exchange_failed',
        'failed to mint installation token',
        { cause: err, delayMs: 5_000 },
      );
    }
  }
}
