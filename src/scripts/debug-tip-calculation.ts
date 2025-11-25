/**
 * Debug Script: Tip Revenue Calculation Comparison
 *
 * This script compares 4 different tip calculation methods to identify
 * which one matches Monadexplorer's values.
 *
 * Usage: npx ts-node src/scripts/debug-tip-calculation.ts <validator_id> [hours]
 */

import { ethers } from 'ethers';
import { createClient } from '@clickhouse/client';
import * as dotenv from 'dotenv';

dotenv.config();

const WEI_PER_MON = BigInt('1000000000000000000');
const GWEI_PER_WEI = BigInt('1000000000');

interface BlockDebugData {
  blockNumber: number;
  baseFeePerGas: bigint;
  transactionCount: number;
  methodA: bigint;  // (effectiveGasPrice - baseFee) × gasLimit
  methodB: bigint;  // effectiveGasPrice × gasLimit
  methodC: bigint;  // (effectiveGasPrice - baseFee) × gasUsed
  methodD: bigint;  // effectiveGasPrice × gasUsed
}

interface TransactionDebugData {
  hash: string;
  effectiveGasPrice: bigint;
  baseFeePerGas: bigint;
  gasLimit: bigint;
  gasUsed: bigint;
  maxPriorityFeePerGas: bigint | null;
  tipA: bigint;
  tipB: bigint;
  tipC: bigint;
  tipD: bigint;
}

function weiToMon(wei: bigint): string {
  const mon = Number(wei) / Number(WEI_PER_MON);
  return mon.toFixed(6);
}

function weiToGwei(wei: bigint): string {
  const gwei = Number(wei) / Number(GWEI_PER_WEI);
  return gwei.toFixed(4);
}

async function getValidatorBlocks(
  clickhouse: any,
  validatorId: string,
  hours: number
): Promise<number[]> {
  const query = `
    SELECT DISTINCT seq_num
    FROM block_proposals
    WHERE validator_id = '${validatorId}'
      AND status = 'proposed'
      AND timestamp >= now() - INTERVAL ${hours} HOUR
    ORDER BY seq_num ASC
  `;

  const result = await clickhouse.query({
    query,
    format: 'JSONEachRow'
  });

  const rows = await result.json() as { seq_num: string | number }[];
  return rows.map(r => Number(r.seq_num));
}

async function fetchBlockData(
  provider: ethers.JsonRpcProvider,
  blockNumber: number
): Promise<BlockDebugData | null> {
  try {
    const block = await provider.getBlock(blockNumber, true);
    if (!block) return null;

    const baseFeePerGas = block.baseFeePerGas || BigInt(0);
    const transactionCount = block.prefetchedTransactions?.length || 0;

    let methodA = BigInt(0);
    let methodB = BigInt(0);
    let methodC = BigInt(0);
    let methodD = BigInt(0);

    if (block.prefetchedTransactions && block.prefetchedTransactions.length > 0) {
      const receiptPromises = block.prefetchedTransactions.map(tx =>
        provider.getTransactionReceipt(tx.hash)
      );
      const receipts = await Promise.all(receiptPromises);

      for (let i = 0; i < receipts.length; i++) {
        const receipt = receipts[i];
        const tx = block.prefetchedTransactions[i];

        if (!receipt) continue;

        const effectiveGasPrice = receipt.gasPrice ?? tx.gasPrice ?? BigInt(0);
        const gasLimit = tx.gasLimit;
        const gasUsed = receipt.gasUsed;

        const priorityFee = effectiveGasPrice > baseFeePerGas
          ? effectiveGasPrice - baseFeePerGas
          : BigInt(0);

        // Method A: (effectiveGasPrice - baseFee) × gasLimit
        methodA += priorityFee * gasLimit;

        // Method B: effectiveGasPrice × gasLimit
        methodB += effectiveGasPrice * gasLimit;

        // Method C: (effectiveGasPrice - baseFee) × gasUsed
        methodC += priorityFee * gasUsed;

        // Method D: effectiveGasPrice × gasUsed
        methodD += effectiveGasPrice * gasUsed;
      }
    }

    return {
      blockNumber,
      baseFeePerGas,
      transactionCount,
      methodA,
      methodB,
      methodC,
      methodD
    };
  } catch (error) {
    console.error(`Error fetching block ${blockNumber}:`, error);
    return null;
  }
}

async function fetchSampleTransaction(
  provider: ethers.JsonRpcProvider,
  blockNumber: number
): Promise<TransactionDebugData | null> {
  try {
    const block = await provider.getBlock(blockNumber, true);
    if (!block || !block.prefetchedTransactions || block.prefetchedTransactions.length === 0) {
      return null;
    }

    const baseFeePerGas = block.baseFeePerGas || BigInt(0);
    const tx = block.prefetchedTransactions[0];
    const receipt = await provider.getTransactionReceipt(tx.hash);

    if (!receipt) return null;

    const effectiveGasPrice = receipt.gasPrice ?? tx.gasPrice ?? BigInt(0);
    const gasLimit = tx.gasLimit;
    const gasUsed = receipt.gasUsed;
    const maxPriorityFeePerGas = tx.maxPriorityFeePerGas ?? null;

    const priorityFee = effectiveGasPrice > baseFeePerGas
      ? effectiveGasPrice - baseFeePerGas
      : BigInt(0);

    return {
      hash: tx.hash,
      effectiveGasPrice,
      baseFeePerGas,
      gasLimit,
      gasUsed,
      maxPriorityFeePerGas,
      tipA: priorityFee * gasLimit,
      tipB: effectiveGasPrice * gasLimit,
      tipC: priorityFee * gasUsed,
      tipD: effectiveGasPrice * gasUsed
    };
  } catch (error) {
    console.error('Error fetching sample transaction:', error);
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log('Usage: npx ts-node src/scripts/debug-tip-calculation.ts <validator_id> [hours]');
    console.log('Example: npx ts-node src/scripts/debug-tip-calculation.ts 024a7c84... 1');
    process.exit(1);
  }

  const validatorId = args[0];
  const hours = parseInt(args[1] || '1', 10);

  // Check environment variables
  const rpcUrl = process.env.RPC_URL;
  const clickhouseHost = process.env.CLICKHOUSE_HOST || 'localhost';
  const clickhousePort = process.env.CLICKHOUSE_PORT || '8123';
  const clickhouseUser = process.env.CLICKHOUSE_USER || 'default';
  const clickhousePassword = process.env.CLICKHOUSE_PASSWORD || '';
  const clickhouseDatabase = process.env.CLICKHOUSE_DATABASE || 'monad';

  if (!rpcUrl) {
    console.error('ERROR: RPC_URL environment variable is not set');
    process.exit(1);
  }

  console.log('\n=== TIP CALCULATION DEBUG ===');
  console.log(`Validator: ${validatorId}`);
  console.log(`Time Range: Last ${hours} hour(s)`);
  console.log(`RPC URL: ${rpcUrl.substring(0, 30)}...`);
  console.log('');

  // Initialize connections
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const clickhouse = createClient({
    host: `http://${clickhouseHost}:${clickhousePort}`,
    username: clickhouseUser,
    password: clickhousePassword,
    database: clickhouseDatabase
  });

  try {
    // Get validator's blocks from database
    console.log('Fetching validator blocks from database...');
    const blockNumbers = await getValidatorBlocks(clickhouse, validatorId, hours);

    if (blockNumbers.length === 0) {
      console.log('No blocks found for this validator in the specified time range.');
      console.log('Checking if validator exists...');

      // Check if validator exists at all
      const checkQuery = `
        SELECT count() as cnt FROM block_proposals
        WHERE validator_id = '${validatorId}'
      `;
      const checkResult = await clickhouse.query({ query: checkQuery, format: 'JSONEachRow' });
      const checkRows = await checkResult.json() as { cnt: string }[];
      console.log(`Total blocks for this validator: ${checkRows[0]?.cnt || 0}`);

      await clickhouse.close();
      process.exit(0);
    }

    console.log(`Found ${blockNumbers.length} blocks to analyze`);
    console.log(`Block range: ${blockNumbers[0]} - ${blockNumbers[blockNumbers.length - 1]}`);
    console.log('');

    // Fetch and calculate tips for each block
    console.log('Fetching block data from RPC (this may take a while)...');

    let totalMethodA = BigInt(0);
    let totalMethodB = BigInt(0);
    let totalMethodC = BigInt(0);
    let totalMethodD = BigInt(0);
    let totalTransactions = 0;
    let processedBlocks = 0;
    let sampleTx: TransactionDebugData | null = null;

    // Process in batches
    const batchSize = 5;
    for (let i = 0; i < blockNumbers.length; i += batchSize) {
      const batch = blockNumbers.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(bn => fetchBlockData(provider, bn)));

      for (const result of results) {
        if (result) {
          totalMethodA += result.methodA;
          totalMethodB += result.methodB;
          totalMethodC += result.methodC;
          totalMethodD += result.methodD;
          totalTransactions += result.transactionCount;
          processedBlocks++;

          // Get sample transaction from first block with transactions
          if (!sampleTx && result.transactionCount > 0) {
            sampleTx = await fetchSampleTransaction(provider, result.blockNumber);
          }
        }
      }

      // Progress indicator
      const progress = Math.min(100, Math.round(((i + batchSize) / blockNumbers.length) * 100));
      process.stdout.write(`\rProgress: ${progress}%`);
    }

    console.log('\n');

    // Print results
    console.log('=== RESULTS ===');
    console.log(`Blocks Analyzed: ${processedBlocks}`);
    console.log(`Total Transactions: ${totalTransactions}`);
    console.log('');

    console.log('Calculation Methods Comparison:');
    console.log('─'.repeat(70));
    console.log(`Method A (priority × gasLimit): ${weiToMon(totalMethodA)} MON  [CURRENT]`);
    console.log(`Method B (total × gasLimit):    ${weiToMon(totalMethodB)} MON`);
    console.log(`Method C (priority × gasUsed):  ${weiToMon(totalMethodC)} MON`);
    console.log(`Method D (total × gasUsed):     ${weiToMon(totalMethodD)} MON`);
    console.log('─'.repeat(70));

    // Calculate ratios
    if (totalMethodA > BigInt(0)) {
      console.log('\nRatios (relative to Method A):');
      console.log(`B/A = ${(Number(totalMethodB) / Number(totalMethodA)).toFixed(2)}x`);
      console.log(`C/A = ${(Number(totalMethodC) / Number(totalMethodA)).toFixed(2)}x`);
      console.log(`D/A = ${(Number(totalMethodD) / Number(totalMethodA)).toFixed(2)}x`);
    }

    // Print sample transaction
    if (sampleTx) {
      console.log('\n=== SAMPLE TRANSACTION ===');
      console.log(`TX Hash: ${sampleTx.hash}`);
      console.log(`effectiveGasPrice: ${weiToGwei(sampleTx.effectiveGasPrice)} gwei`);
      console.log(`baseFeePerGas: ${weiToGwei(sampleTx.baseFeePerGas)} gwei`);
      console.log(`priorityFee: ${weiToGwei(sampleTx.effectiveGasPrice - sampleTx.baseFeePerGas)} gwei`);
      console.log(`gasLimit: ${sampleTx.gasLimit.toString()}`);
      console.log(`gasUsed: ${sampleTx.gasUsed.toString()}`);
      console.log(`gasUsed/gasLimit ratio: ${(Number(sampleTx.gasUsed) / Number(sampleTx.gasLimit) * 100).toFixed(2)}%`);
      if (sampleTx.maxPriorityFeePerGas) {
        console.log(`maxPriorityFeePerGas: ${weiToGwei(sampleTx.maxPriorityFeePerGas)} gwei`);
      }
    }

    // Analysis hint
    console.log('\n=== ANALYSIS ===');
    console.log('Expected Monadexplorer value: ~129 MON');

    const methods = [
      { name: 'A', value: totalMethodA },
      { name: 'B', value: totalMethodB },
      { name: 'C', value: totalMethodC },
      { name: 'D', value: totalMethodD }
    ];

    const targetMon = 129; // Approximate expected value
    let closestMethod = methods[0];
    let closestDiff = Math.abs(Number(weiToMon(methods[0].value)) - targetMon);

    for (const method of methods) {
      const diff = Math.abs(Number(weiToMon(method.value)) - targetMon);
      if (diff < closestDiff) {
        closestDiff = diff;
        closestMethod = method;
      }
    }

    console.log(`Closest to Monadexplorer: Method ${closestMethod.name} (${weiToMon(closestMethod.value)} MON)`);

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await clickhouse.close();
  }
}

main().catch(console.error);
