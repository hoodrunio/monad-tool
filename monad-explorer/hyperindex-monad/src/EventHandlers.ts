import { onBlock } from "generated";
import type { Block as BlockEntity, Transaction as TransactionEntity, ChainLog as ChainLogEntity } from "generated";
import { fetchBlockBundle } from "./hypersync";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MONAD_CHAIN_ID = 10143;

const normalizeBigInt = (
  value: bigint | number | string | null | undefined,
  fallback?: bigint
): bigint | undefined => {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return BigInt(value);
  }
  try {
    return BigInt(value);
  } catch {
    return fallback;
  }
};

const requireBigInt = (
  value: bigint | number | string | null | undefined,
  fallback: bigint
): bigint => normalizeBigInt(value, fallback) ?? fallback;

const toTimestamp = (seconds: number | bigint | null | undefined): Date => {
  const asNumber = Number(seconds ?? 0);
  return new Date(asNumber * 1000);
};

onBlock(
  {
    name: "MonadBlockIngestor",
    chain: MONAD_CHAIN_ID,
  },
  async ({ block, context }) => {
    const bundle = await context.effect(fetchBlockBundle, BigInt(block.number));

    if (context.isPreload) {
      return;
    }

    const [blockPayload] = bundle.blocks as Array<any>;

    if (!blockPayload) {
      context.log.warn("Missing block payload from Hypersync", {
        blockNumber: block.number,
      });
      return;
    }

    const blockHash = blockPayload.hash ?? `monad-${block.number}`;
    const blockTimestamp = toTimestamp(blockPayload.timestamp ?? 0);

    const blockEntity: BlockEntity = {
      id: blockHash,
      chainId: MONAD_CHAIN_ID,
      number: blockPayload.number ?? block.number,
      hash: blockHash,
      parentHash: blockPayload.parentHash ?? ZERO_ADDRESS,
      timestamp: blockTimestamp,
      size: normalizeBigInt(blockPayload.size),
      gasLimit: normalizeBigInt(blockPayload.gasLimit),
      gasUsed: normalizeBigInt(blockPayload.gasUsed),
      miner: blockPayload.miner ?? undefined,
      extraData: blockPayload.extraData ?? undefined,
      baseFeePerGas: normalizeBigInt(blockPayload.baseFeePerGas),
    };

    context.Block.set(blockEntity);

    const transactions = (bundle.transactions as Array<any>).filter(
      (tx) => Number(tx.blockNumber ?? block.number) === block.number
    );

    const seenTransactions = new Set<string>();

    for (const tx of transactions) {
      const txHash: string | undefined = tx.hash;
      if (!txHash) {
        continue;
      }

      const transactionEntity: TransactionEntity = {
        id: txHash,
        hash: txHash,
        chainId: MONAD_CHAIN_ID,
        block_id: blockHash,
        blockNumber: Number(tx.blockNumber ?? block.number),
        transactionIndex: tx.transactionIndex ?? 0,
        from: tx.from ?? ZERO_ADDRESS,
        to: tx.to ?? undefined,
        value: requireBigInt(tx.value, 0n),
        input: tx.input ?? undefined,
        nonce: normalizeBigInt(tx.nonce),
        status: tx.status ?? undefined,
        gas: normalizeBigInt(tx.gas),
        gasPrice: normalizeBigInt(tx.gasPrice),
        gasUsed: normalizeBigInt(tx.gasUsed),
        maxFeePerGas: normalizeBigInt(tx.maxFeePerGas),
        maxPriorityFeePerGas: normalizeBigInt(tx.maxPriorityFeePerGas),
        effectiveGasPrice: normalizeBigInt(tx.effectiveGasPrice),
        cumulativeGasUsed: normalizeBigInt(tx.cumulativeGasUsed),
        contractAddress: tx.contractAddress ?? undefined,
        kind: tx.kind ?? undefined,
        timestamp: blockTimestamp,
      };

      context.Transaction.set(transactionEntity);
      seenTransactions.add(txHash);
    }

    const logs = (bundle.logs as Array<any>).filter(
      (log) => Number(log.blockNumber ?? block.number) === block.number
    );

    for (const log of logs) {
      const txHash: string | undefined = log.transactionHash;
      if (!txHash || !seenTransactions.has(txHash)) {
        continue;
      }

      const logIndex = log.logIndex ?? 0;
      const topics: Array<string | null | undefined> = Array.isArray(log.topics)
        ? (log.topics as Array<string | null | undefined>)
        : [];

      const logEntity: ChainLogEntity = {
        id: `${txHash}-${logIndex}`,
        chainId: MONAD_CHAIN_ID,
        transaction_id: txHash,
        blockNumber: Number(log.blockNumber ?? block.number),
        logIndex,
        address: log.address ?? ZERO_ADDRESS,
        data: log.data ?? "0x",
        topic0: topics[0] ?? undefined,
        topic1: topics[1] ?? undefined,
        topic2: topics[2] ?? undefined,
        topic3: topics[3] ?? undefined,
        removed: log.removed ?? false,
      };

      context.ChainLog.set(logEntity);
    }
  }
);
