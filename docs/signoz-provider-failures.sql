-- Table: failed API attempts by service, operation, deployment, and error.
-- Uses the dashboard's selected time range.
WITH __resource_filter AS
(
    SELECT fingerprint
    FROM signoz_logs.distributed_logs_v2_resource
    WHERE simpleJSONExtractString(labels, 'service.name') = 'context-tg'
      AND seen_at_ts_bucket_start
          BETWEEN $start_timestamp - 1800 AND $end_timestamp
    GROUP BY fingerprint
)
SELECT
    attributes_string['service'] AS service,
    attributes_string['operation'] AS operation,
    attributes_string['model'] AS model,
    attributes_string['api'] AS api,
    if(mapContains(attributes_number, 'http_status'), toUInt16(attributes_number['http_status']), NULL) AS http_status,
    attributes_string['error_code'] AS error_code,
    count() AS failed_attempts,
    countIf(attributes_bool['will_use_fallback']) AS switched_to_fallback,
    quantile(0.95)(attributes_number['duration_ms']) / 1000 AS p95_seconds
FROM signoz_logs.distributed_logs_v2
WHERE resource_fingerprint GLOBAL IN (SELECT fingerprint FROM __resource_filter)
  AND timestamp BETWEEN $start_timestamp_nano AND $end_timestamp_nano
  AND ts_bucket_start BETWEEN $start_timestamp - 1800 AND $end_timestamp
  AND scope_name = 'context-tg.provider'
  AND body = 'llm_provider_attempt'
  AND attributes_string['outcome'] = 'failed'
GROUP BY service, operation, model, api, http_status, error_code
ORDER BY failed_attempts DESC, service ASC, operation ASC, model ASC, api ASC, http_status ASC, error_code ASC;
