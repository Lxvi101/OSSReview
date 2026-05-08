import type { Clock } from '@gcr/core';
import type { Kysely } from 'kysely';
import type { DB } from '../schema.js';
import type { SecretBox } from '../secrets/secretBox.js';
import { AuditLogRepository } from './auditLog.js';
import { PullRequestRepository } from './pullRequests.js';
import { RepositoryRepository } from './repositories.js';
import { ReviewEventRepository } from './reviewEvents.js';
import { ReviewRunRepository } from './reviewRuns.js';
import { SettingsRepository } from './settings.js';
import { WebhookDeliveryRepository } from './webhookDeliveries.js';

export interface Repositories {
  readonly repositories: RepositoryRepository;
  readonly pullRequests: PullRequestRepository;
  readonly reviewRuns: ReviewRunRepository;
  readonly reviewEvents: ReviewEventRepository;
  readonly webhookDeliveries: WebhookDeliveryRepository;
  readonly auditLog: AuditLogRepository;
  readonly settings: SettingsRepository;
}

export interface RepositoriesDeps {
  readonly clock: Clock;
  readonly secretBox: SecretBox;
}

/** Composition root helper — wire one set per process. */
export function makeRepositories(db: Kysely<DB>, deps: RepositoriesDeps): Repositories {
  return {
    repositories: new RepositoryRepository(db, deps.clock),
    pullRequests: new PullRequestRepository(db, deps.clock),
    reviewRuns: new ReviewRunRepository(db, deps.clock),
    reviewEvents: new ReviewEventRepository(db, deps.clock),
    webhookDeliveries: new WebhookDeliveryRepository(db, deps.clock),
    auditLog: new AuditLogRepository(db, deps.clock),
    settings: new SettingsRepository(db, deps.clock, deps.secretBox),
  };
}

export {
  RepositoryRepository,
  PullRequestRepository,
  ReviewRunRepository,
  ReviewEventRepository,
  WebhookDeliveryRepository,
  AuditLogRepository,
  SettingsRepository,
};
