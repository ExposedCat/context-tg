-- Table: one row per full LLM call, with its own Azure progress statistics.
-- Variables: chat_type, mode, status, tools; uses the dashboard's selected time range.
-- All duration columns are seconds. No-progress calls have NULL progress statistics.
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
    fromUnixTimestamp64Nano(timestamp) AS call_time,
    id AS call_id,
    attributes_string['chat_type'] AS chat_type,
    attributes_string['mode'] AS mode,
    attributes_string['status'] AS status,
    event_tools AS tools,
    attributes_number['duration_ms'] / 1000 AS duration_seconds,
    attributes_number['progress_count'] AS progress_count,
    if(progress_count > 0, attributes_number['progress_total_ms'] / 1000, NULL) AS progress_total_seconds,
    if(progress_count > 0, attributes_number['progress_median_ms'] / 1000, NULL) AS progress_median_seconds,
    if(progress_count > 0, attributes_number['progress_min_ms'] / 1000, NULL) AS progress_min_seconds,
    if(progress_count > 0, attributes_number['progress_max_ms'] / 1000, NULL) AS progress_max_seconds
FROM signoz_logs.distributed_logs_v2
WHERE resource_fingerprint GLOBAL IN (
    SELECT fingerprint FROM __resource_filter
)
  AND timestamp BETWEEN $start_timestamp_nano AND $end_timestamp_nano
  AND ts_bucket_start BETWEEN $start_timestamp - 1800 AND $end_timestamp
  AND scope_name = 'grammyjs-opentelemetry'
  AND mapContains(attributes_number, 'duration_ms')
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
ORDER BY call_time DESC, call_id ASC
SETTINGS log_comment = 'signoz-writing-clickhouse-queries skill | 2026-10-14';
