import { hqInstrumentationStatus } from "./hq-instrumentation";

const counters = new Map<string, number>();

export function incrementMetric(name: string, labels: Record<string, string> = {}): void {
    const key = metricKey(name, labels);
    counters.set(key, (counters.get(key) || 0) + 1);
}

export function renderMetrics(): string {
    const lines = [
        "# HELP padloc_rpc_total Total Padloc RPC requests.",
        "# TYPE padloc_rpc_total counter",
        ...renderCounter("padloc_rpc_total"),
        "# HELP padloc_rpc_error_total Total Padloc RPC errors.",
        "# TYPE padloc_rpc_error_total counter",
        ...renderCounter("padloc_rpc_error_total"),
        "# HELP padloc_vault_sync_success_total Total successful vault synchronization RPCs.",
        "# TYPE padloc_vault_sync_success_total counter",
        ...renderCounter("padloc_vault_sync_success_total"),
        "# HELP padloc_hq_instrumentation_degraded Whether HQ instrumentation is degraded.",
        "# TYPE padloc_hq_instrumentation_degraded gauge",
        `padloc_hq_instrumentation_degraded ${hqInstrumentationStatus() === "degraded" ? 1 : 0}`,
        "# HELP padloc_hq_instrumentation_status Current HQ instrumentation status.",
        "# TYPE padloc_hq_instrumentation_status gauge",
        ...["disabled", "ready", "degraded"].map(
            (status) => `padloc_hq_instrumentation_status{status="${status}"} ${hqInstrumentationStatus() === status ? 1 : 0}`
        ),
    ];
    return `${lines.join("\n")}\n`;
}

function renderCounter(name: string): string[] {
    return [...counters.entries()]
        .filter(([key]) => key.startsWith(`${name}|`))
        .map(([key, value]) => {
            const [, encodedLabels] = key.split("|", 2);
            return `${name}${encodedLabels ? `{${encodedLabels}}` : ""} ${value}`;
        });
}

function metricKey(name: string, labels: Record<string, string>): string {
    const encoded = Object.entries(labels)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
        .join(",");
    return `${name}|${encoded}`;
}

function escapeLabel(value: string): string {
    return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

export function resetMetricsForTests(): void {
    counters.clear();
}
