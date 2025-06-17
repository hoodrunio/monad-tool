-- Query performance monitoring view for Monad Analytics
-- This must be executed AFTER ClickHouse has started and the query_log table exists
-- Run with: docker exec monad-clickhouse clickhouse-client --database=monad_analytics < scripts/create-query-performance-view.sql

-- Check if query_log table exists (it's created after first queries)
CREATE VIEW IF NOT EXISTS query_performance_monitor AS
SELECT 
    query_id,
    query_duration_ms,
    read_rows,
    read_bytes,
    formatReadableSize(read_bytes) as readable_bytes,
    result_rows,
    memory_usage,
    formatReadableSize(memory_usage) as readable_memory,
    substring(query, 1, 200) as query_snippet,
    event_time,
    type,
    exception,
    user,
    current_database
FROM system.query_log
WHERE event_time >= now() - INTERVAL 1 HOUR
  AND type IN ('QueryFinish', 'ExceptionWhileProcessing')
  AND (current_database = 'monad_analytics' OR has(databases, 'monad_analytics'))
ORDER BY query_duration_ms DESC
LIMIT 100;

-- Create a view for slow queries (> 1 second)
CREATE VIEW IF NOT EXISTS slow_queries_monitor AS
SELECT 
    query_id,
    query_duration_ms,
    formatReadableSize(memory_usage) as memory_used,
    substring(query, 1, 500) as query_text,
    event_time,
    user,
    exception
FROM system.query_log
WHERE event_time >= now() - INTERVAL 24 HOUR
  AND type IN ('QueryFinish', 'ExceptionWhileProcessing')
  AND query_duration_ms > 1000
  AND (current_database = 'monad_analytics' OR has(databases, 'monad_analytics'))
ORDER BY query_duration_ms DESC
LIMIT 50;

-- Create a view for query statistics by hour
CREATE VIEW IF NOT EXISTS query_stats_hourly AS
SELECT 
    toStartOfHour(event_time) as hour,
    count() as total_queries,
    avg(query_duration_ms) as avg_duration_ms,
    max(query_duration_ms) as max_duration_ms,
    sum(read_rows) as total_read_rows,
    formatReadableSize(sum(read_bytes)) as total_read_bytes,
    formatReadableSize(sum(memory_usage)) as total_memory_usage,
    count(CASE WHEN exception != '' THEN 1 END) as failed_queries
FROM system.query_log
WHERE event_time >= now() - INTERVAL 7 DAY
  AND type IN ('QueryFinish', 'ExceptionWhileProcessing')
  AND (current_database = 'monad_analytics' OR has(databases, 'monad_analytics'))
GROUP BY hour
ORDER BY hour DESC; 