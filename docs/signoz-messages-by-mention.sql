-- Panel: Incoming messages checked for mentions, split by mentioned boolean.
-- Existing dashboard variables: bucket, chat_type, mode.
-- Add a multi-select mentioned variable: __all__ (default), true, false.
-- __all__ includes both series; sum them for total incoming message volume.
-- One event per incoming message reaching the chat handler, before album selection.
-- mentioned uses the existing leading bot username / agent name matcher.
-- false includes ignored messages, but also direct replies and guest messages
-- that can be handled without a mention. It is not an exact dropped-message count.
-- status and tools do not apply to this pre-LLM event.
WITH
    arrayFlatten([$chat_type]) AS selected_chat_types,
    arrayFlatten([$mode]) AS selected_modes,
    arrayFlatten([$mentioned]) AS selected_mentions,
    if(attributes_bool['mentioned'], 'true', 'false') AS mention_label,
    __resource_filter AS
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
    mention_label AS __name__,
    toFloat64(count()) AS value
FROM signoz_logs.distributed_logs_v2
WHERE resource_fingerprint GLOBAL IN (
    SELECT fingerprint FROM __resource_filter
)
  AND timestamp BETWEEN $start_timestamp_nano AND $end_timestamp_nano
  AND ts_bucket_start BETWEEN $start_timestamp - 1800 AND $end_timestamp
  AND scope_name = 'grammyjs-opentelemetry'
  AND mapContains(attributes_string, 'chat_type')
  AND mapContains(attributes_string, 'mode')
  AND mapContains(attributes_bool, 'mentioned')
  AND (
      '__all__' IN selected_chat_types
      OR attributes_string['chat_type'] IN selected_chat_types
  )
  AND (
      '__all__' IN selected_modes
      OR attributes_string['mode'] IN selected_modes
  )
  AND (
      '__all__' IN selected_mentions
      OR mention_label IN selected_mentions
  )
GROUP BY
    dateTrunc($bucket, fromUnixTimestamp64Nano(timestamp)),
    mention_label
ORDER BY ts ASC, __name__ ASC
SETTINGS log_comment = 'signoz-writing-clickhouse-queries skill | 2026-09-20';
