import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../infrastructure/database.service';
import { RedisService } from '../infrastructure/redis.service';

const durationBuckets = [0.05, 0.1, 0.25, 0.5, 1, 2, 5] as const;

interface RouteMetric {
  buckets: number[];
  count: number;
  durationSeconds: number;
}

@Injectable()
export class MetricsService {
  private readonly cache = { bypass: 0, hit: 0, miss: 0 };
  private readonly routes = new Map<string, RouteMetric>();

  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  observeRequest(
    method: string,
    route: string,
    status: number,
    durationMs: number,
  ): void {
    const key = `${method}|${route}|${status}`;
    const metric = this.routes.get(key) ?? {
      buckets: durationBuckets.map(() => 0),
      count: 0,
      durationSeconds: 0,
    };
    const seconds = durationMs / 1_000;
    metric.count += 1;
    metric.durationSeconds += seconds;
    durationBuckets.forEach((boundary, index) => {
      if (seconds <= boundary)
        metric.buckets[index] = (metric.buckets[index] ?? 0) + 1;
    });
    this.routes.set(key, metric);
  }

  observeCache(status: 'bypass' | 'hit' | 'miss'): void {
    this.cache[status] += 1;
  }

  render(): string {
    const lines = [
      '# HELP analytics_api_requests_total Completed API requests.',
      '# TYPE analytics_api_requests_total counter',
    ];

    for (const [key, metric] of this.routes) {
      const [method = 'UNKNOWN', route = 'unknown', status = '0'] =
        key.split('|');
      const labels = `method="${escapeLabel(method)}",route="${escapeLabel(route)}",status="${status}"`;
      lines.push(`analytics_api_requests_total{${labels}} ${metric.count}`);
    }

    lines.push(
      '# HELP analytics_api_request_duration_seconds API request latency.',
      '# TYPE analytics_api_request_duration_seconds histogram',
    );
    for (const [key, metric] of this.routes) {
      const [method = 'UNKNOWN', route = 'unknown', status = '0'] =
        key.split('|');
      const labels = `method="${escapeLabel(method)}",route="${escapeLabel(route)}",status="${status}"`;
      durationBuckets.forEach((boundary, index) =>
        lines.push(
          `analytics_api_request_duration_seconds_bucket{${labels},le="${boundary}"} ${metric.buckets[index] ?? 0}`,
        ),
      );
      lines.push(
        `analytics_api_request_duration_seconds_bucket{${labels},le="+Inf"} ${metric.count}`,
        `analytics_api_request_duration_seconds_sum{${labels}} ${metric.durationSeconds}`,
        `analytics_api_request_duration_seconds_count{${labels}} ${metric.count}`,
      );
    }

    lines.push(
      '# HELP analytics_cache_requests_total Server-side cache outcomes.',
      '# TYPE analytics_cache_requests_total counter',
      ...Object.entries(this.cache).map(
        ([result, count]) =>
          `analytics_cache_requests_total{result="${result}"} ${count}`,
      ),
    );

    const pool = this.database.poolSnapshot();
    lines.push(
      '# HELP analytics_database_pool_connections Database pool state.',
      '# TYPE analytics_database_pool_connections gauge',
      `analytics_database_pool_connections{state="total"} ${pool.total}`,
      `analytics_database_pool_connections{state="idle"} ${pool.idle}`,
      `analytics_database_pool_connections{state="waiting"} ${pool.waiting}`,
      `analytics_database_pool_connections{state="max"} ${pool.max}`,
    );

    const circuit = this.redis.circuitSnapshot();
    lines.push(
      '# HELP analytics_dependency_circuit_open Whether a dependency circuit is open.',
      '# TYPE analytics_dependency_circuit_open gauge',
      `analytics_dependency_circuit_open{dependency="redis"} ${circuit.state === 'closed' ? 0 : 1}`,
      '# HELP analytics_process_uptime_seconds Process uptime.',
      '# TYPE analytics_process_uptime_seconds gauge',
      `analytics_process_uptime_seconds ${process.uptime()}`,
    );
    return `${lines.join('\n')}\n`;
  }
}

function escapeLabel(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n');
}
