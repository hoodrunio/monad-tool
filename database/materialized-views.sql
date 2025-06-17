-- Monad Validator Analytics - Materialized Views for Real-time Aggregation
-- Phase 2: Advanced Analytics & Real-time Processing
-- Supports sub-100ms query performance for dashboards

USE monad_analytics;

-- =============================================
-- 1. REAL-TIME NETWORK CONSENSUS HEALTH (1-minute)
-- =============================================

-- Network consensus health monitoring with 1-minute granularity
CREATE MATERIALIZED VIEW network_consensus_health_1m_mv TO network_metrics_agg AS
SELECT 
    toStartOfMinute(timestamp) as timestamp,
    '1m' as time_window,
    
    -- Round progression metrics
    uniqState(round_number) as total_rounds,
    countIfState(event_type = 'qc_commit_triggered') as successful_rounds,
    avgState(CASE WHEN event_type = 'qc_commit_triggered' THEN processing_delay_ms END) as avg_round_time,
    
    -- QC participation efficiency
    avgState(participation_rate) as avg_qc_participation_rate,
    
    -- Block metrics
    countIfState(event_type IN ('block_proposal', 'block_committed')) as total_blocks,
    avgState(CASE WHEN event_type = 'block_committed' THEN processing_delay_ms END) as avg_block_time,
    avgState(processing_delay_ms) as avg_processing_delay,
    
    -- Validator activity
    uniqState(validator_id) as active_validators,
    uniqState(geographic_region) as active_regions,
    uniqState(infrastructure_provider) as active_providers,
    
    -- Performance indicators
    avgState(CASE WHEN event_type = 'qc_commit_triggered' THEN participation_rate * 100 END) as consensus_efficiency,
    quantileState(0.95)(processing_delay_ms) as network_latency_p95
FROM validator_events
WHERE event_type IN ('qc_commit_triggered', 'block_proposal', 'block_committed', 'vote_created')
  AND timestamp >= now() - INTERVAL 2 HOUR -- Process recent data
GROUP BY timestamp;

-- =============================================
-- 2. VALIDATOR PERFORMANCE SCORING (1-hour)
-- =============================================

-- Validator performance aggregation with 1-hour granularity
CREATE MATERIALIZED VIEW validator_performance_1h_mv TO validator_performance_agg AS
SELECT 
    toStartOfHour(timestamp) as timestamp,
    '1h' as time_window,
    validator_id,
    
    -- Block performance
    countIfState(event_type = 'block_proposal') as blocks_proposed,
    countIfState(event_type = 'block_committed') as blocks_committed,
    countIfState(event_type = 'block_skipped') as blocks_skipped,
    avgState(CASE WHEN event_type IN ('block_proposal', 'block_committed') THEN processing_delay_ms END) as avg_proposal_delay,
    
    -- Voting performance
    countIfState(event_type = 'vote_attempt') as votes_attempted,
    countIfState(event_type = 'vote_result' AND is_successful = 1) as votes_successful,
    avgState(CASE WHEN event_type IN ('vote_attempt', 'vote_result') THEN processing_delay_ms END) as avg_vote_latency,
    
    -- QC participation
    countIfState(event_type = 'qc_commit_triggered') as qc_participations,
    avgState(participation_rate) as avg_qc_participation_rate,
    
    -- Leadership metrics
    countIfState(event_type = 'vote_created') as leadership_rounds,
    avgState(CASE WHEN event_type = 'vote_created' THEN processing_delay_ms END) as avg_leadership_latency
FROM validator_events
WHERE timestamp >= now() - INTERVAL 25 HOUR -- Process last 25 hours to ensure completeness
GROUP BY timestamp, validator_id;

-- 1-minute validator performance for real-time monitoring
CREATE MATERIALIZED VIEW validator_performance_1m_mv TO validator_performance_agg AS
SELECT 
    toStartOfMinute(timestamp) as timestamp,
    '1m' as time_window,
    validator_id,
    
    -- Block performance
    countIfState(event_type = 'block_proposal') as blocks_proposed,
    countIfState(event_type = 'block_committed') as blocks_committed,
    countIfState(event_type = 'block_skipped') as blocks_skipped,
    avgState(CASE WHEN event_type IN ('block_proposal', 'block_committed') THEN processing_delay_ms END) as avg_proposal_delay,
    
    -- Voting performance
    countIfState(event_type = 'vote_attempt') as votes_attempted,
    countIfState(event_type = 'vote_result' AND is_successful = 1) as votes_successful,
    avgState(CASE WHEN event_type IN ('vote_attempt', 'vote_result') THEN processing_delay_ms END) as avg_vote_latency,
    
    -- QC participation
    countIfState(event_type = 'qc_commit_triggered') as qc_participations,
    avgState(participation_rate) as avg_qc_participation_rate,
    
    -- Leadership metrics
    countIfState(event_type = 'vote_created') as leadership_rounds,
    avgState(CASE WHEN event_type = 'vote_created' THEN processing_delay_ms END) as avg_leadership_latency
FROM validator_events
WHERE timestamp >= now() - INTERVAL 2 HOUR
GROUP BY timestamp, validator_id;

-- =============================================
-- 3. GEOGRAPHIC PERFORMANCE TRACKING (5-minute)
-- =============================================

-- Geographic intelligence with 5-minute granularity
CREATE MATERIALIZED VIEW geographic_performance_5m_mv TO geographic_metrics AS
SELECT 
    toStartOfInterval(timestamp, INTERVAL 5 MINUTE) as timestamp,
    '5m' as time_window,
    geographic_region,
    
    -- Validator metrics
    uniqState(validator_id) as active_validators,
    uniqState(infrastructure_provider) as infrastructure_providers,
    
    -- Performance metrics
    countIfState(event_type = 'block_proposal') as total_proposals,
    countIfState(event_type = 'block_committed') as successful_commits,
    avgState(processing_delay_ms) as avg_latency,
    
    -- Network contribution
    avgState(participation_rate) as qc_participation_rate,
    countIfState(event_type = 'vote_created') as leadership_assignments,
    
    -- Risk metrics (concentration and diversity)
    maxState(CASE WHEN event_type = 'block_proposal' THEN 1.0 END) as validator_concentration,
    uniqState(infrastructure_provider) as provider_diversity
FROM validator_events
WHERE geographic_region != ''
  AND timestamp >= now() - INTERVAL 6 HOUR
GROUP BY timestamp, geographic_region;

-- =============================================
-- 4. QC PARTICIPATION REAL-TIME ANALYTICS
-- =============================================

-- QC participation summary for real-time monitoring
CREATE MATERIALIZED VIEW qc_participation_summary_mv 
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (timestamp, round_number)
AS SELECT 
    timestamp,
    round_number,
    qc_vote_id,
    epoch_number,
    total_validators,
    participating_validators,
    participation_rate,
    consensus_latency_ms,
    proposer_id,
    1 as count
FROM qc_participation;

-- =============================================
-- 5. VALIDATOR REGISTRY UPDATES
-- =============================================

-- Materialized view to update validator registry with latest activity
CREATE MATERIALIZED VIEW validator_registry_updates_mv 
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY validator_id
AS SELECT 
    validator_id,
    max(timestamp) as last_active,
    countIf(event_type = 'block_proposal') as total_proposals,
    countIf(event_type = 'block_committed') as successful_proposals,
    countIf(event_type IN ('vote_attempt', 'vote_result')) as total_votes,
    countIf(event_type = 'vote_result' AND is_successful = 1) as successful_votes,
    avg(processing_delay_ms) as avg_response_latency_ms,
    any(geographic_region) as geographic_region,
    any(infrastructure_provider) as infrastructure_provider,
    any(validator_dns) as dns_name,
    1 as is_active,
    now() as updated_at,
    toUnixTimestamp(now()) as version
FROM validator_events
WHERE timestamp >= now() - INTERVAL 24 HOUR
GROUP BY validator_id;

-- =============================================
-- 6. NETWORK HEALTH ALERTS PREPARATION
-- =============================================

-- Real-time network health indicators for alerting
CREATE MATERIALIZED VIEW network_health_alerts_mv
ENGINE = ReplacingMergeTree(timestamp)
ORDER BY (alert_type, timestamp)
AS SELECT 
    toStartOfMinute(timestamp) as timestamp,
    'consensus_efficiency' as alert_type,
    avg(participation_rate) as metric_value,
    CASE 
        WHEN avg(participation_rate) < 0.8 THEN 'critical'
        WHEN avg(participation_rate) < 0.9 THEN 'warning'
        ELSE 'normal'
    END as alert_level,
    count() as sample_count
FROM validator_events
WHERE event_type = 'qc_commit_triggered'
  AND timestamp >= now() - INTERVAL 1 HOUR
GROUP BY timestamp

UNION ALL

SELECT 
    toStartOfMinute(timestamp) as timestamp,
    'round_time' as alert_type,
    avg(processing_delay_ms) as metric_value,
    CASE 
        WHEN avg(processing_delay_ms) > 5000 THEN 'critical'
        WHEN avg(processing_delay_ms) > 3000 THEN 'warning'
        ELSE 'normal'
    END as alert_level,
    count() as sample_count
FROM validator_events
WHERE event_type = 'qc_commit_triggered'
  AND timestamp >= now() - INTERVAL 1 HOUR
GROUP BY timestamp;

-- =============================================
-- 7. DAILY AGGREGATIONS FOR HISTORICAL ANALYSIS
-- =============================================

-- Daily validator performance for historical trends
CREATE MATERIALIZED VIEW validator_performance_24h_mv TO validator_performance_agg AS
SELECT 
    toStartOfDay(timestamp) as timestamp,
    '24h' as time_window,
    validator_id,
    
    -- Block performance
    countIfState(event_type = 'block_proposal') as blocks_proposed,
    countIfState(event_type = 'block_committed') as blocks_committed,
    countIfState(event_type = 'block_skipped') as blocks_skipped,
    avgState(CASE WHEN event_type IN ('block_proposal', 'block_committed') THEN processing_delay_ms END) as avg_proposal_delay,
    
    -- Voting performance
    countIfState(event_type = 'vote_attempt') as votes_attempted,
    countIfState(event_type = 'vote_result' AND is_successful = 1) as votes_successful,
    avgState(CASE WHEN event_type IN ('vote_attempt', 'vote_result') THEN processing_delay_ms END) as avg_vote_latency,
    
    -- QC participation
    countIfState(event_type = 'qc_commit_triggered') as qc_participations,
    avgState(participation_rate) as avg_qc_participation_rate,
    
    -- Leadership metrics
    countIfState(event_type = 'vote_created') as leadership_rounds,
    avgState(CASE WHEN event_type = 'vote_created' THEN processing_delay_ms END) as avg_leadership_latency
FROM validator_events
WHERE timestamp >= now() - INTERVAL 25 HOUR
GROUP BY timestamp, validator_id;

-- Daily network metrics
CREATE MATERIALIZED VIEW network_metrics_24h_mv TO network_metrics_agg AS
SELECT 
    toStartOfDay(timestamp) as timestamp,
    '24h' as time_window,
    
    -- Consensus metrics
    uniqState(round_number) as total_rounds,
    countIfState(event_type = 'qc_commit_triggered') as successful_rounds,
    avgState(CASE WHEN event_type = 'qc_commit_triggered' THEN processing_delay_ms END) as avg_round_time,
    avgState(participation_rate) as avg_qc_participation_rate,
    
    -- Block metrics
    countIfState(event_type IN ('block_proposal', 'block_committed')) as total_blocks,
    avgState(CASE WHEN event_type = 'block_committed' THEN processing_delay_ms END) as avg_block_time,
    avgState(processing_delay_ms) as avg_processing_delay,
    
    -- Validator metrics
    uniqState(validator_id) as active_validators,
    uniqState(geographic_region) as active_regions,
    uniqState(infrastructure_provider) as active_providers,
    
    -- Performance indicators
    avgState(CASE WHEN event_type = 'qc_commit_triggered' THEN participation_rate * 100 END) as consensus_efficiency,
    quantileState(0.95)(processing_delay_ms) as network_latency_p95
FROM validator_events
WHERE timestamp >= now() - INTERVAL 25 HOUR
GROUP BY timestamp;

-- =============================================
-- 8. PERFORMANCE MONITORING VIEWS
-- =============================================

-- View for monitoring materialized view performance
CREATE VIEW mv_performance_monitor AS
SELECT 
    database,
    table,
    engine,
    total_rows,
    total_bytes,
    formatReadableSize(total_bytes) as readable_size,
    data_compressed_bytes,
    formatReadableSize(data_compressed_bytes) as compressed_size,
    compression_ratio,
    primary_key_bytes_in_memory,
    formatReadableSize(primary_key_bytes_in_memory) as pk_memory
FROM system.tables
WHERE database = 'monad_analytics' 
  AND engine LIKE '%MergeTree%'
ORDER BY total_bytes DESC;

-- View for monitoring query performance
CREATE VIEW query_performance_monitor AS
SELECT 
    query_id,
    query_duration_ms,
    read_rows,
    read_bytes,
    formatReadableSize(read_bytes) as readable_bytes,
    result_rows,
    memory_usage,
    formatReadableSize(memory_usage) as readable_memory,
    query,
    event_time
FROM system.query_log
WHERE event_time >= now() - INTERVAL 1 HOUR
  AND type = 'QueryFinish'
  AND databases HAS 'monad_analytics'
ORDER BY query_duration_ms DESC
LIMIT 100;

-- =============================================
-- 9. MATERIALIZED VIEW COMMENTS
-- =============================================

-- Add comments for documentation
ALTER TABLE network_metrics_agg COMMENT 'Real-time network consensus health with 1m/1h/24h aggregations';
ALTER TABLE validator_performance_agg COMMENT 'Validator performance metrics with multiple time windows';
ALTER TABLE geographic_metrics COMMENT 'Geographic distribution and performance analytics';

-- Optimization settings for materialized views
SYSTEM RELOAD CONFIG; 