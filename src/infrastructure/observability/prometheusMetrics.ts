import type { CounterName, GaugeName, Metrics } from '../../domain/ports.js';

const HELP: Readonly<Record<CounterName | GaugeName, string>> = {
  cosync_ops_applied_total: 'CRDT operations integrated and persisted',
  cosync_ops_duplicate_total: 'Operations received more than once and ignored',
  cosync_messages_rejected_total: 'Client messages rejected, by reason',
  cosync_backpressure_disconnects_total: 'Connections dropped because the client could not keep up',
  cosync_presence_dropped_total: 'Presence updates skipped for slow connections',
  cosync_snapshots_total: 'Document snapshots written',
  cosync_tombstones_collected_total: 'Tombstones removed by garbage collection',
  cosync_documents_loaded_total: 'Documents loaded into memory',
  cosync_documents_unloaded_total: 'Documents unloaded after being idle',
  cosync_presence_timeouts_total: 'Sessions dropped for missing heartbeats',
  cosync_connections: 'Open WebSocket connections',
  cosync_documents_open: 'Documents currently held in memory',
  cosync_sessions: 'Client sessions currently active',
};

function labelKey(labels: Readonly<Record<string, string>> | undefined): string {
  if (!labels) return '';
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`);
  return parts.length > 0 ? `{${parts.join(',')}}` : '';
}

/** Minimal Prometheus text exposition; enough for a handful of counters without a dependency. */
export class PrometheusMetrics implements Metrics {
  private readonly counters = new Map<CounterName, Map<string, number>>();
  private readonly gauges = new Map<GaugeName, number>();

  increment(name: CounterName, value = 1, labels?: Readonly<Record<string, string>>): void {
    let series = this.counters.get(name);
    if (!series) {
      series = new Map();
      this.counters.set(name, series);
    }
    const key = labelKey(labels);
    series.set(key, (series.get(key) ?? 0) + value);
  }

  gauge(name: GaugeName, value: number): void {
    this.gauges.set(name, value);
  }

  counterValue(name: CounterName, labels?: Readonly<Record<string, string>>): number {
    return this.counters.get(name)?.get(labelKey(labels)) ?? 0;
  }

  render(): string {
    const lines: string[] = [];
    for (const name of Object.keys(HELP) as (CounterName | GaugeName)[]) {
      const isCounter = name.endsWith('_total');
      lines.push(`# HELP ${name} ${HELP[name]}`, `# TYPE ${name} ${isCounter ? 'counter' : 'gauge'}`);
      if (isCounter) {
        const series = this.counters.get(name as CounterName);
        if (!series || series.size === 0) lines.push(`${name} 0`);
        else for (const [labels, value] of series) lines.push(`${name}${labels} ${value}`);
      } else {
        lines.push(`${name} ${this.gauges.get(name as GaugeName) ?? 0}`);
      }
    }
    const mem = process.memoryUsage();
    lines.push(
      '# HELP process_resident_memory_bytes Resident memory size in bytes',
      '# TYPE process_resident_memory_bytes gauge',
      `process_resident_memory_bytes ${mem.rss}`,
    );
    return `${lines.join('\n')}\n`;
  }
}
