-- Rollback Migration: Drop consolidated validator registry snapshot
-- Version: 003_rollback
-- Description: Removes validator_registry_latest table and its materialized view

DROP VIEW IF EXISTS validator_registry_latest_mv;
DROP TABLE IF EXISTS validator_registry_latest;
