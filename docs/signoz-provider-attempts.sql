-- Time series: count of primary and fallback API attempts by service.
-- Uses the selected time range and the bucket dashboard variable.
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
    dateTrunc($bucket, fromUnixTimestamp64Nano(timestamp)) AS ts,
    concat(attributes_string['service'], ' / ', attributes_string['api']) AS __name__,
    toFloat64(count()) AS value
FROM signoz_logs.distributed_logs_v2
WHERE resource_fingerprint GLOBAL IN (SELECT fingerprint FROM __resource_filter)
  AND timestamp BETWEEN $start_timestamp_nano AND $end_timestamp_nano
  AND ts_bucket_start BETWEEN $start_timestamp - 1800 AND $end_timestamp
  AND scope_name = 'context-tg.provider'
  AND body = 'llm_provider_attempt'
GROUP BY ts, __name__
ORDER BY ts ASC, __name__ ASC;
