#!/usr/bin/env npx tsx

/**
 * Add Validator By Precompile ID
 *
 * Usage:
 *   npm run tsx -- scripts/add-validator.ts <validatorId>
 *   or make the script executable and run: ./scripts/add-validator.ts <validatorId>
 *
 * The script:
 *   1. Fetches validator details from the staking precompile using the supplied ID
 *   2. Determines whether the validator is currently in the consensus set
 *   3. Inserts a placeholder record into validator_registry if one does not already exist
 */

import { ethers } from 'ethers';
import { MonadClickHouseClient } from '../src/database/clickhouse-client';
import { StakingService } from '../src/services/staking/StakingService';
import { logger } from '../src/utils/logger';
import dotenv from 'dotenv';
dotenv.config();

function formatDate(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

async function ensureValidator(args: string[]) {
  const validatorIdInput = args[0];
  if (!validatorIdInput) {
    console.error('❌ Validator ID is required. Example: npm run tsx -- scripts/add-validator.ts 162');
    process.exit(1);
  }

  if (!/^\d+$/.test(validatorIdInput)) {
    console.error('❌ Validator ID must be a numeric value (e.g., 1, 42, 162).');
    process.exit(1);
  }

  const rpcUrl = process.env.MONAD_RPC_URL || 'http://localhost:8080';

  const clickhouseConfig = {
    host: process.env.CLICKHOUSE_HOST || 'localhost',
    port: parseInt(process.env.CLICKHOUSE_PORT || '8123'),
    database: process.env.CLICKHOUSE_DB || process.env.CLICKHOUSE_DATABASE || 'monad_analytics',
    username: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
    max_open_connections: 10,
    max_query_timeout: 30000,
    compression: true,
  };

  const clickhouseClient = new MonadClickHouseClient(clickhouseConfig);
  const stakingService = new StakingService(rpcUrl);

  try {
    await clickhouseClient.ensureValidatorRegistryAuthColumns();

    console.log(`🔗 Connecting to staking precompile via ${rpcUrl}...`);
    await stakingService.initialize();
    await stakingService.refreshStakingInfo();

    const validatorInfo = await stakingService.getValidatorInfo(validatorIdInput);
    if (!validatorInfo || !validatorInfo.secpPubkey) {
      console.error(`❌ Validator ${validatorIdInput} could not be fetched from the precompile.`);
      process.exit(1);
    }

    const secpHex = typeof validatorInfo.secpPubkey === 'string'
      ? validatorInfo.secpPubkey
      : ethers.hexlify(validatorInfo.secpPubkey);

    const validatorAddress = secpHex.startsWith('0x') ? secpHex.slice(2) : secpHex;

    if (!validatorAddress || validatorAddress.length === 0) {
      console.error(`❌ Validator ${validatorIdInput} does not expose a secp public key.`);
      process.exit(1);
    }

    console.log(`🔎 Validator address: 0x${validatorAddress}`);

    // Check if validator already exists in registry
    const existingRows = await clickhouseClient.executeRawQuery(`
      SELECT validator_id, precompile_validator_id, last_updated
      FROM validator_registry
      WHERE precompile_validator_id = '${validatorIdInput}'
         OR validator_id = '${validatorAddress}'
      ORDER BY last_updated DESC
      LIMIT 1
    `);

    if (existingRows.length > 0) {
      console.log('ℹ️  Validator already exists in validator_registry:');
      console.table(existingRows);
      return;
    }

    const stakingInfo = stakingService.getStakingInfo();
    const currentEpoch = stakingInfo?.currentEpoch ?? await stakingService.getCurrentEpoch();
    const isConsensus = stakingService.isValidatorInConsensus(validatorIdInput);

    const stakeWei = validatorInfo.stake?.toString?.() || '0';
    const timestamp = formatDate(new Date());
    const rawAuthAddress = typeof validatorInfo.authAddress === 'string'
      ? validatorInfo.authAddress.trim().toLowerCase()
      : '';
    const authAddress = rawAuthAddress
      ? (rawAuthAddress.startsWith('0x') ? rawAuthAddress : `0x${rawAuthAddress}`)
      : '';

    const row = {
      validator_id: validatorAddress,
      node_id: validatorAddress,
      auth_address: authAddress,
      precompile_validator_id: validatorIdInput,
      epoch: Number(currentEpoch),
      stake: stakeWei,
      position: 0,
      is_active: isConsensus ? 1 : 0,
      is_staking_active: isConsensus ? 1 : 0,
      real_time_stake_wei: stakeWei,
      dns_address: '',
      dns_host: '',
      dns_port: 8000,
      validator_name: 'unknown',
      keybase_id: '',
      keybase_logo_url: '',
      provider: 'unknown',
      location: 'unknown',
      country: 'unknown',
      datacenter: 'unknown',
      first_seen: timestamp,
      last_updated: timestamp,
    };

    console.log('📝 Prepared row for insertion:');
    console.table([row]);

    await clickhouseClient.insertRows('validator_registry', [row]);
    console.log('✅ Validator inserted into validator_registry');

  } catch (error) {
    logger.error('Failed to add validator:', error);
    process.exitCode = 1;
  } finally {
    await clickhouseClient.close();
  }
}

ensureValidator(process.argv.slice(2));
