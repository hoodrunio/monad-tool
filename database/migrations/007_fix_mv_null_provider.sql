-- Migration: Fix NULL provider/location in materialized views
-- Date: 2025-11-07
-- Issue: QC participation and block proposal data cannot be inserted because
--        materialized views don't handle NULL provider/location values properly

-- Drop existing materialized views
DROP VIEW IF EXISTS block_proposal_metrics_hourly_mv;
DROP VIEW IF EXISTS qc_participation_metrics_hourly_mv;

-- Recreate block_proposal_metrics_hourly_mv with COALESCE for NULL handling
CREATE MATERIALIZED VIEW block_proposal_metrics_hourly_mv TO validator_metrics_hourly AS
SELECT
    toStartOfHour(bp.timestamp) as hour,
    bp.validator_id,

    -- Metric 1: Block Proposal Ratio
    COUNT(CASE WHEN bp.status = 'proposed' THEN 1 END) as blocks_proposed,
    COUNT(CASE WHEN bp.status = 'skipped' THEN 1 END) as blocks_skipped,
    CASE
        WHEN (COUNT(CASE WHEN bp.status = 'proposed' THEN 1 END) + COUNT(CASE WHEN bp.status = 'skipped' THEN 1 END)) > 0
        THEN COUNT(CASE WHEN bp.status = 'proposed' THEN 1 END) / (COUNT(CASE WHEN bp.status = 'proposed' THEN 1 END) + COUNT(CASE WHEN bp.status = 'skipped' THEN 1 END)) * 100
        ELSE 0
    END as block_proposal_ratio,

    -- QC metrics (will be filled by separate MV)
    0 as qc_participations,
    0 as total_qc_opportunities,
    0 as qc_participation_rate,

    -- Combined uptime score (will be calculated in final aggregation)
    0 as uptime_score,

    -- Infrastructure metadata from validator_registry
    -- Use COALESCE to handle NULL values from validators without provider/location
    COALESCE(any(vr.provider), 'unknown') as provider,
    COALESCE(any(vr.location), 'unknown') as location

FROM block_proposals bp
LEFT JOIN validator_registry_latest vr ON bp.validator_id = vr.validator_id
GROUP BY hour, bp.validator_id;

-- Recreate qc_participation_metrics_hourly_mv with COALESCE for NULL handling
CREATE MATERIALIZED VIEW qc_participation_metrics_hourly_mv TO validator_metrics_hourly AS
SELECT
    toStartOfHour(qc.timestamp) as hour,
    qc.validator_id,

    -- Block proposal metrics (will be filled by separate MV)
    0 as blocks_proposed,
    0 as blocks_skipped,
    0 as block_proposal_ratio,

    -- Metric 2: QC Participation Rate
    COUNT(CASE WHEN qc.participated = 1 THEN 1 END) as qc_participations,
    COUNT(*) as total_qc_opportunities,
    CASE
        WHEN COUNT(*) > 0
        THEN COUNT(CASE WHEN qc.participated = 1 THEN 1 END) / COUNT(*) * 100
        ELSE 0
    END as qc_participation_rate,

    -- Combined uptime score (will be calculated in final aggregation)
    0 as uptime_score,

    -- Infrastructure metadata from validator_registry
    -- Use COALESCE to handle NULL values from validators without provider/location
    COALESCE(any(vr.provider), 'unknown') as provider,
    COALESCE(any(vr.location), 'unknown') as location

FROM qc_participation qc
LEFT JOIN validator_registry_latest vr ON qc.validator_id = vr.validator_id
GROUP BY hour, qc.validator_id;
