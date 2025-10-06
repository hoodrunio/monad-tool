import { experimental_createEffect, S } from "envio";
import {
  HypersyncClient,
  BlockField,
  TransactionField,
  LogField,
  JoinMode,
  type Query,
} from "@envio-dev/hypersync-client";

const DEFAULT_MONAD_HYPERSYNC = "https://monad-testnet.hypersync.xyz";

const hypersyncClient = HypersyncClient.new({
  url: process.env.MONAD_HYPERSYNC_URL ?? DEFAULT_MONAD_HYPERSYNC,
  bearerToken: process.env.ENVIO_API_TOKEN,
  enableChecksumAddresses: true,
});

const blockQueryFields: Query["fieldSelection"] = {
  block: [
    BlockField.Number,
    BlockField.Hash,
    BlockField.ParentHash,
    BlockField.Timestamp,
    BlockField.GasLimit,
    BlockField.GasUsed,
    BlockField.Size,
    BlockField.BaseFeePerGas,
    BlockField.Miner,
    BlockField.ExtraData,
  ],
  transaction: [
    TransactionField.Hash,
    TransactionField.BlockNumber,
    TransactionField.TransactionIndex,
    TransactionField.From,
    TransactionField.To,
    TransactionField.Value,
    TransactionField.Input,
    TransactionField.Nonce,
    TransactionField.Status,
    TransactionField.Gas,
    TransactionField.GasPrice,
    TransactionField.MaxFeePerGas,
    TransactionField.MaxPriorityFeePerGas,
    TransactionField.GasUsed,
    TransactionField.EffectiveGasPrice,
    TransactionField.CumulativeGasUsed,
    TransactionField.ContractAddress,
    TransactionField.Kind,
  ],
  log: [
    LogField.BlockNumber,
    LogField.TransactionHash,
    LogField.LogIndex,
    LogField.Address,
    LogField.Data,
    LogField.Topic0,
    LogField.Topic1,
    LogField.Topic2,
    LogField.Topic3,
    LogField.Removed,
  ],
};

export const fetchBlockBundle = experimental_createEffect(
  {
    name: "fetchBlockBundle",
    input: S.bigint,
    output: S.schema({
      blocks: S.array(S.unknown),
      transactions: S.array(S.unknown),
      logs: S.array(S.unknown),
    }),
  },
  async ({ input, context }) => {
    const blockNumber = Number(input);

    const query: Query = {
      fromBlock: blockNumber,
      toBlock: blockNumber + 1,
      includeAllBlocks: true,
      fieldSelection: blockQueryFields,
      logs: [{}],
      transactions: [{}],
      joinMode: JoinMode.JoinAll,
      maxNumBlocks: 1,
      maxNumTransactions: 25000,
      maxNumLogs: 200000,
    };

    try {
      const response = await hypersyncClient.collect(query, {});
      return {
        blocks: response.data.blocks,
        transactions: response.data.transactions,
        logs: response.data.logs,
      };
    } catch (error) {
      context.log.error("Hypersync collect failed", {
        blockNumber,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
);
