-- Monad Validator Analytics - Refactored Materialized Views
-- Focus: Separate Validator Metrics (Block Proposals + QC Participation)
-- Removes dependency on generic validator_events table

USE monad_analytics;

-- =============================================
-- 1. VALIDATOR METRICS AGGREGATION (Hourly)
-- =============================================

-- Aggregate block proposal metrics by hour
CREATE MATERIALIZED VIEW block_proposal_metrics_hourly_mv TO validator_metrics_hourly AS
SELECT
    toStartOfHour(timestamp) as hour,
    validator_id,
    
    -- Metric 1: Block Proposal Ratio
    COUNT(CASE WHEN status = 'proposed' THEN 1 END) as blocks_proposed,
    COUNT(CASE WHEN status = 'skipped' THEN 1 END) as blocks_skipped,
    CASE 
        WHEN (blocks_proposed + blocks_skipped) > 0 
        THEN blocks_proposed / (blocks_proposed + blocks_skipped) * 100 
        ELSE 0 
    END as block_proposal_ratio,
    
    -- QC metrics (will be filled by separate MV)
    0 as qc_participations,
    0 as total_qc_opportunities,
    0 as qc_participation_rate,
    
    -- Combined uptime score (will be calculated in final aggregation)
    0 as uptime_score,
    
    -- Infrastructure metadata
    any(provider) as provider,
    any(location) as location

FROM block_proposals
GROUP BY hour, validator_id;

-- Aggregate QC participation metrics by hour  
CREATE MATERIALIZED VIEW qc_participation_metrics_hourly_mv TO validator_metrics_hourly AS
SELECT
    toStartOfHour(timestamp) as hour,
    validator_id,
    
    -- Block proposal metrics (will be filled by separate MV)
    0 as blocks_proposed,
    0 as blocks_skipped,
    0 as block_proposal_ratio,
    
    -- Metric 2: QC Participation Rate
    COUNT(CASE WHEN participated = 1 THEN 1 END) as qc_participations,
    COUNT(*) as total_qc_opportunities,
    CASE 
        WHEN total_qc_opportunities > 0 
        THEN qc_participations / total_qc_opportunities * 100 
        ELSE 0 
    END as qc_participation_rate,
    
    -- Combined uptime score (will be calculated in final aggregation)
    0 as uptime_score,
    
    -- Infrastructure metadata
    any(provider) as provider,
    any(location) as location

FROM qc_participation
GROUP BY hour, validator_id;

-- =============================================
-- 2. VALIDATOR RANKINGS CACHE (Real-time)
-- =============================================

-- 1-hour validator rankings
CREATE MATERIALIZED VIEW validator_rankings_1h_mv TO validator_rankings_cache AS
SELECT
    '1h' as time_window,
    row_number() OVER (ORDER BY avg_uptime_score DESC, validator_id) as rank,
    validator_id,
    
    -- Separate metrics
    AVG(block_proposal_ratio) as avg_block_proposal_ratio,
    AVG(qc_participation_rate) as avg_qc_participation_rate,
    AVG(CASE 
        WHEN block_proposal_ratio > 0 AND qc_participation_rate > 0
        THEN block_proposal_ratio * 0.3 + qc_participation_rate * 0.7
        ELSE GREATEST(block_proposal_ratio, qc_participation_rate)
    END) as avg_uptime_score,
    
    -- Supporting data  
    SUM(blocks_proposed + blocks_skipped) as total_block_opportunities,
    SUM(total_qc_opportunities) as total_qc_opportunities,
    SUM(blocks_proposed) as blocks_proposed,
    SUM(blocks_skipped) as blocks_skipped,
    SUM(qc_participations) as qc_participations,
    
    -- Infrastructure
    any(provider) as provider,
    any(location) as location,
    
    -- Metadata
    MAX(hour) as last_activity

FROM validator_metrics_hourly
WHERE hour >= now() - INTERVAL 1 HOUR
GROUP BY validator_id;

-- 24-hour validator rankings
CREATE MATERIALIZED VIEW validator_rankings_24h_mv TO validator_rankings_cache AS
SELECT
    '24h' as time_window,
    row_number() OVER (ORDER BY avg_uptime_score DESC, validator_id) as rank,
    validator_id,
    
    -- Separate metrics
    AVG(block_proposal_ratio) as avg_block_proposal_ratio,
    AVG(qc_participation_rate) as avg_qc_participation_rate,
    AVG(CASE 
        WHEN block_proposal_ratio > 0 AND qc_participation_rate > 0
        THEN block_proposal_ratio * 0.3 + qc_participation_rate * 0.7
        ELSE GREATEST(block_proposal_ratio, qc_participation_rate)
    END) as avg_uptime_score,
    
    -- Supporting data
    SUM(blocks_proposed + blocks_skipped) as total_block_opportunities,
    SUM(total_qc_opportunities) as total_qc_opportunities,
    SUM(blocks_proposed) as blocks_proposed,
    SUM(blocks_skipped) as blocks_skipped,
    SUM(qc_participations) as qc_participations,
    
    -- Infrastructure
    any(provider) as provider,
    any(location) as location,
    
    -- Metadata
    MAX(hour) as last_activity

FROM validator_metrics_hourly
WHERE hour >= now() - INTERVAL 24 HOUR
GROUP BY validator_id;

-- 7-day validator rankings
CREATE MATERIALIZED VIEW validator_rankings_7d_mv TO validator_rankings_cache AS
SELECT
    '7d' as time_window,
    row_number() OVER (ORDER BY avg_uptime_score DESC, validator_id) as rank,
    validator_id,
    
    -- Separate metrics
    AVG(block_proposal_ratio) as avg_block_proposal_ratio,
    AVG(qc_participation_rate) as avg_qc_participation_rate,
    AVG(CASE 
        WHEN block_proposal_ratio > 0 AND qc_participation_rate > 0
        THEN block_proposal_ratio * 0.3 + qc_participation_rate * 0.7
        ELSE GREATEST(block_proposal_ratio, qc_participation_rate)
    END) as avg_uptime_score,
    
    -- Supporting data
    SUM(blocks_proposed + blocks_skipped) as total_block_opportunities,
    SUM(total_qc_opportunities) as total_qc_opportunities,
    SUM(blocks_proposed) as blocks_proposed,
    SUM(blocks_skipped) as blocks_skipped,
    SUM(qc_participations) as qc_participations,
    
    -- Infrastructure
    any(provider) as provider,
    any(location) as location,
    
    -- Metadata
    MAX(hour) as last_activity

FROM validator_metrics_hourly
WHERE hour >= now() - INTERVAL 7 DAY
GROUP BY validator_id;

-- =============================================
-- 3. NETWORK HEALTH MONITORING (Hourly)
-- =============================================

CREATE MATERIALIZED VIEW network_health_hourly_mv TO network_health_hourly AS
SELECT
    toStartOfHour(timestamp) as hour,
    
    -- Consensus health (from QC participation data)
    COUNT(DISTINCT round) as total_rounds,
    COUNT(DISTINCT CASE WHEN participation_rate >= 67 THEN round END) as successful_rounds,
    AVG(participation_rate) as consensus_efficiency,
    AVG(participation_rate) as avg_qc_participation,
    
    -- Block production (from block proposal data)
    COUNT(DISTINCT seq_num) as total_blocks,
    0 as total_proposals, -- Will be filled by block proposals
    0 as total_skips,     -- Will be filled by block proposals  
    0 as proposal_success_rate, -- Will be calculated
    
    -- Network participation
    COUNT(DISTINCT validator_id) as active_validators,
    0 as total_registered_validators, -- Will be filled from registry
    0 as validator_participation_rate, -- Will be calculated
    
    -- Geographic distribution
    COUNT(DISTINCT location) as active_locations,
    COUNT(DISTINCT provider) as active_providers,
    
    -- Performance (placeholder - would need timing data)
    0 as avg_round_time_ms,
    0 as p95_round_time_ms

FROM qc_participation
GROUP BY hour;

-- Supplement network health with block proposal data
CREATE MATERIALIZED VIEW network_health_proposals_mv TO network_health_hourly AS
SELECT
    toStartOfHour(timestamp) as hour,
    
    -- Consensus health (will be filled by QC data)
    0 as total_rounds,
    0 as successful_rounds, 
    0 as consensus_efficiency,
    0 as avg_qc_participation,
    
    -- Block production
    COUNT(DISTINCT seq_num) as total_blocks,
    COUNT(CASE WHEN status = 'proposed' THEN 1 END) as total_proposals,
    COUNT(CASE WHEN status = 'skipped' THEN 1 END) as total_skips,
    CASE 
        WHEN (total_proposals + total_skips) > 0
        THEN total_proposals / (total_proposals + total_skips) * 100
        ELSE 0
    END as proposal_success_rate,
    
    -- Network participation
    COUNT(DISTINCT validator_id) as active_validators,
    0 as total_registered_validators,
    0 as validator_participation_rate,
    
    -- Geographic distribution  
    COUNT(DISTINCT location) as active_locations,
    COUNT(DISTINCT provider) as active_providers,
    
    -- Performance
    0 as avg_round_time_ms,
    0 as p95_round_time_ms

FROM block_proposals  
GROUP BY hour;

-- =============================================
-- 4. GEOGRAPHIC ANALYTICS (Hourly)
-- =============================================

-- Geographic metrics from block proposals
CREATE MATERIALIZED VIEW geographic_block_metrics_mv TO geographic_metrics_hourly AS
SELECT
    toStartOfHour(timestamp) as hour,
    location,
    provider,
    
    -- Validator counts
    COUNT(DISTINCT validator_id) as active_validators,
    COUNT(DISTINCT validator_id) as total_validators, -- Same for now
    
    -- Performance metrics (block proposals only)
    AVG(CASE 
        WHEN status = 'proposed' THEN 100.0 
        ELSE 0.0 
    END) as avg_block_proposal_ratio,
    0 as avg_qc_participation_rate, -- Will be filled by QC metrics
    0 as avg_uptime_score, -- Will be calculated
    
    -- Activity metrics
    COUNT(CASE WHEN status = 'proposed' THEN 1 END) as total_block_proposals,
    0 as total_qc_participations -- Will be filled by QC metrics

FROM block_proposals
WHERE location != 'unknown'
GROUP BY hour, location, provider;

-- Geographic metrics from QC participation
CREATE MATERIALIZED VIEW geographic_qc_metrics_mv TO geographic_metrics_hourly AS
SELECT
    toStartOfHour(timestamp) as hour,
    location,
    provider,
    
    -- Validator counts
    COUNT(DISTINCT validator_id) as active_validators,
    COUNT(DISTINCT validator_id) as total_validators,
    
    -- Performance metrics (QC participation only)
    0 as avg_block_proposal_ratio, -- Will be filled by block metrics
    AVG(CASE WHEN participated = 1 THEN 100.0 ELSE 0.0 END) as avg_qc_participation_rate,
    0 as avg_uptime_score, -- Will be calculated
    
    -- Activity metrics
    0 as total_block_proposals, -- Will be filled by block metrics
    COUNT(CASE WHEN participated = 1 THEN 1 END) as total_qc_participations

FROM qc_participation
WHERE location != 'unknown'
GROUP BY hour, location, provider;

-- =============================================
-- 5. PERFORMANCE MONITORING VIEWS
-- =============================================

-- Real-time performance summary for dashboards
CREATE VIEW validator_performance_summary AS
SELECT 
    validator_id,
    
    -- Latest metrics (last hour)
    any(uptime_score) as current_uptime_score,
    any(block_proposal_ratio) as current_block_ratio,
    any(qc_participation_rate) as current_qc_rate,
    
    -- 24-hour averages
    AVG(uptime_score) as avg_24h_uptime,
    AVG(block_proposal_ratio) as avg_24h_block_ratio,
    AVG(qc_participation_rate) as avg_24h_qc_rate,
    
    -- Activity summary
    SUM(blocks_proposed) as total_blocks_proposed_24h,
    SUM(blocks_skipped) as total_blocks_skipped_24h,
    SUM(qc_participations) as total_qc_participations_24h,
    SUM(total_qc_opportunities) as total_qc_opportunities_24h,
    
    -- Infrastructure
    any(provider) as provider,
    any(location) as location,
    
    -- Last activity
    MAX(hour) as last_activity

FROM validator_metrics_hourly
WHERE hour >= now() - INTERVAL 24 HOUR
GROUP BY validator_id
ORDER BY current_uptime_score DESC;

-- Network health summary for monitoring
CREATE VIEW network_health_summary AS
SELECT 
    -- Latest hour metrics
    consensus_efficiency as current_consensus_efficiency,
    proposal_success_rate as current_proposal_success_rate,
    active_validators as current_active_validators,
    
    -- 24-hour trends
    AVG(consensus_efficiency) as avg_24h_consensus_efficiency,
    AVG(proposal_success_rate) as avg_24h_proposal_success,
    AVG(active_validators) as avg_24h_active_validators,
    
    -- Geographic distribution
    MAX(active_locations) as total_active_locations,
    MAX(active_providers) as total_active_providers,
    
    -- Last update
    MAX(hour) as last_updated

FROM network_health_hourly
WHERE hour >= now() - INTERVAL 24 HOUR;

-- =============================================
-- 6. MONITORING AND ALERTING PREPARATION
-- =============================================

-- Validator health alerts (for validators with poor performance)
CREATE VIEW validator_health_alerts AS
SELECT 
    validator_id,
    current_uptime_score,
    current_block_ratio,
    current_qc_rate,
    provider,
    location,
    CASE 
        WHEN current_uptime_score < 50 THEN 'critical'
        WHEN current_uptime_score < 80 THEN 'warning'
        ELSE 'normal'
    END as alert_level,
    CASE 
        WHEN current_uptime_score < 50 THEN 'Validator critically underperforming'
        WHEN current_uptime_score < 80 THEN 'Validator performance degraded'
        ELSE 'Validator performing normally'
    END as alert_message
FROM validator_performance_summary
WHERE current_uptime_score < 80
ORDER BY current_uptime_score ASC;

-- Network health alerts
CREATE VIEW network_health_alerts AS
SELECT 
    current_consensus_efficiency,
    current_proposal_success_rate,
    current_active_validators,
    CASE 
        WHEN current_consensus_efficiency < 50 THEN 'critical'
        WHEN current_consensus_efficiency < 80 THEN 'warning'
        WHEN current_proposal_success_rate < 70 THEN 'warning'
        WHEN current_active_validators < 10 THEN 'warning'
        ELSE 'normal'
    END as alert_level,
    CASE 
        WHEN current_consensus_efficiency < 50 THEN 'Network consensus critically low'
        WHEN current_consensus_efficiency < 80 THEN 'Network consensus degraded'
        WHEN current_proposal_success_rate < 70 THEN 'High block skip rate'
        WHEN current_active_validators < 10 THEN 'Low validator participation'
        ELSE 'Network healthy'
    END as alert_message
FROM network_health_summary;

-- =============================================
-- 7. MATERIALIZED VIEW COMMENTS
-- =============================================

ALTER TABLE validator_metrics_hourly MODIFY COMMENT 'Hourly aggregated validator metrics (block proposals + QC participation)';
ALTER TABLE validator_rankings_cache MODIFY COMMENT 'Pre-computed validator rankings for fast API responses';
ALTER TABLE network_health_hourly MODIFY COMMENT 'Network-wide health metrics aggregated hourly';
ALTER TABLE geographic_metrics_hourly MODIFY COMMENT 'Geographic distribution and performance analytics';

-- =============================================
-- 8. SYSTEM OPTIMIZATION
-- =============================================

-- Reload configuration to apply any changes
SYSTEM RELOAD CONFIG; 