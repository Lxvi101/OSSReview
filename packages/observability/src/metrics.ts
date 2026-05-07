import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Centralized metrics registry. The composition root in apps/* creates one
 * `Metrics` instance and passes it down. Tests can build their own and read
 * `metrics.registry.getSingleMetric(...)`.
 */

export class Metrics {
  readonly registry: Registry;

  readonly webhookDeliveriesTotal: Counter<'event' | 'outcome'>;
  readonly webhookInvalidSignatureTotal: Counter<string>;

  readonly reviewRunsTotal: Counter<'state' | 'trigger'>;
  readonly reviewRunDurationSeconds: Histogram<'state'>;
  readonly reviewCostUsd: Counter<'model'>;

  readonly jobsInFlight: Gauge<'name'>;
  readonly jobsDlq: Gauge<'name'>;

  readonly githubApiErrorsTotal: Counter<'endpoint' | 'status'>;
  readonly githubRateLimitRemaining: Gauge<'resource'>;

  readonly sandboxActive: Gauge<string>;

  constructor() {
    this.registry = new Registry();
    this.registry.setDefaultLabels({ app: 'gcr' });
    collectDefaultMetrics({ register: this.registry });

    this.webhookDeliveriesTotal = new Counter({
      name: 'gcr_webhook_deliveries_total',
      help: 'GitHub webhook deliveries received, by event and outcome',
      labelNames: ['event', 'outcome'],
      registers: [this.registry],
    });

    this.webhookInvalidSignatureTotal = new Counter({
      name: 'gcr_webhook_invalid_signature_total',
      help: 'Webhook deliveries that failed HMAC verification',
      registers: [this.registry],
    });

    this.reviewRunsTotal = new Counter({
      name: 'gcr_review_runs_total',
      help: 'Review runs by terminal state and trigger',
      labelNames: ['state', 'trigger'],
      registers: [this.registry],
    });

    this.reviewRunDurationSeconds = new Histogram({
      name: 'gcr_review_run_duration_seconds',
      help: 'Wall-clock duration of a review run, by terminal state',
      labelNames: ['state'],
      // Buckets cover quick failures (1-5s) through long-tail reviews (~30 min).
      buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1200, 1800],
      registers: [this.registry],
    });

    this.reviewCostUsd = new Counter({
      name: 'gcr_review_cost_usd',
      help: 'Cumulative LLM cost in USD by model',
      labelNames: ['model'],
      registers: [this.registry],
    });

    this.jobsInFlight = new Gauge({
      name: 'gcr_jobs_in_flight',
      help: 'Currently running jobs by name',
      labelNames: ['name'],
      registers: [this.registry],
    });

    this.jobsDlq = new Gauge({
      name: 'gcr_jobs_dlq',
      help: 'Jobs sitting in failed terminal state by name',
      labelNames: ['name'],
      registers: [this.registry],
    });

    this.githubApiErrorsTotal = new Counter({
      name: 'gcr_github_api_errors_total',
      help: 'GitHub API errors by endpoint and status',
      labelNames: ['endpoint', 'status'],
      registers: [this.registry],
    });

    this.githubRateLimitRemaining = new Gauge({
      name: 'gcr_github_rate_limit_remaining',
      help: 'Remaining GitHub API quota by resource (core, search, ...)',
      labelNames: ['resource'],
      registers: [this.registry],
    });

    this.sandboxActive = new Gauge({
      name: 'gcr_sandbox_active',
      help: 'Currently running sandbox containers',
      registers: [this.registry],
    });
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}
