# Padloc RPC RED

## Changed

- `packages/worker/src/transport.ts` counts every decoded RPC as `padloc_rpc_total{method}` and errors as `padloc_rpc_error_total{method,code}`.
- Successful `getVault` and `updateVault` calls count `padloc_vault_sync_success_total`.
- `GET /metrics` exposes Prometheus text format, including HQ instrumentation degraded state.
- `packages/worker/test/worker-logging-redaction.ts` proves vault and attachment bodies do not reach structured log output.

No new log line emits request params, vault data, attachment data, credentials, or error bodies. Metrics contain method/code labels only.

## Observed proof

Local worker proof, `npm run test:metrics`:

```text
padloc_rpc_total{method="getVault"} 1
padloc_vault_sync_success_total 1
padloc_hq_instrumentation_degraded 0
padloc_hq_instrumentation_status{status="disabled"} 1
```

Redaction proof, `npm run test:logging-redaction`:

```text
Worker logging redaction: PASS
```

Transport proof, `npm run test:transport-roundtrip`:

```text
Valid POST / round-trip returns 200 with echoed method
Malformed JSON returns 400 with error shape
Oversized body (>25MB) returns 400 with max_request_size_exceeded
```

**UNKNOWN — production acceptance is not proven:** no production vault unlock was run in this lane, so no observed production Prometheus increment exists yet. No production `/metrics` scrape or alarm firing was observed. The deploy and scrape must happen before claiming production coverage.

## Ready-to-paste alarm rules

```yaml
- alert: PadlocRpcErrorsHigh
  expr: sum by (method, code) (rate(padloc_rpc_error_total[10m])) > 0
  for: 10m
  labels:
    severity: crit
  annotations:
    summary: Padloc RPC errors are occurring
    description: Padloc RPC errors by method and code exceed zero for 10m.

- alert: PadlocVaultSyncZeroWithDemand
  expr: increase(padloc_rpc_total[15m]) > 0 and increase(padloc_vault_sync_success_total[15m]) == 0
  for: 15m
  labels:
    severity: crit
  annotations:
    summary: Padloc vault sync has no successful outcome
    description: Padloc received RPC traffic but no vault sync succeeded for 15m.

- alert: PadlocHqInstrumentationDegraded
  expr: padloc_hq_instrumentation_degraded == 1 or padloc_hq_instrumentation_status{status="degraded"} == 1
  for: 5m
  labels:
    severity: crit
  annotations:
    summary: Padloc HQ instrumentation is degraded
    description: Padloc telemetry delivery is failing; metrics and error receipts may be incomplete.
```

## UNKNOWNs

- Production unlock → `padloc_vault_sync_success_total`: **UNKNOWN**.
- Prometheus scrape target and consuming-series receipt: **UNKNOWN**.
- Alert firing and Pushover receipt: **UNKNOWN**; alarm rules are not landed here by collision rule.
- Counter persistence across Worker isolates: **UNKNOWN** until the production scrape/exporter path confirms the intended aggregation behavior. Current implementation is process-local.
