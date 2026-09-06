-- Panel: LLM calls by chat type. Legend: {{__name__}}.
-- Existing dashboard variables: bucket, chat_type, mode, status, tools.
WITH
    arrayFlatten([$chat_type]) AS selected_chat_types,
    arrayFlatten([$mode]) AS selected_modes,
    arrayFlatten([$status]) AS selected_statuses,
    arrayFlatten([$tools]) AS selected_tools,
    if(
        mapContains(attributes_string, 'tools'),
        JSONExtract(attributes_string['tools'], 'Array(String)'),
        CAST([], 'Array(String)')
    ) AS event_tools,
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
    attributes_string['chat_type'] AS __name__,
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
  AND mapContains(attributes_string, 'status')
  AND (
      '__all__' IN selected_chat_types
      OR attributes_string['chat_type'] IN selected_chat_types
  )
  AND (
      '__all__' IN selected_modes
      OR attributes_string['mode'] IN selected_modes
  )
  AND (
      '__all__' IN selected_statuses
      OR attributes_string['status'] IN selected_statuses
  )
  AND (
      '__all__' IN selected_tools
      OR ('__none__' IN selected_tools AND empty(event_tools))
      OR hasAny(
          event_tools,
          arrayFilter(tool -> tool NOT IN ('__all__', '__none__'), selected_tools)
      )
  )
GROUP BY
    dateTrunc($bucket, fromUnixTimestamp64Nano(timestamp)),
    attributes_string['chat_type']
ORDER BY ts ASC, __name__ ASC
SETTINGS log_comment = 'signoz-writing-clickhouse-queries skill | 2026-09-06';
