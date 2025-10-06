import assert from "assert";
import { TestHelpers, Block, Transaction, ChainLog } from "generated";

const { MockDb } = TestHelpers;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

describe("Schema smoke test", () => {
  it("persists block, transaction, and log entities", () => {
    const mockDb = MockDb.createMockDb();

    const block: Block = {
      id: "block-1",
      chainId: 10143,
      number: 1,
      hash: "0x01",
      parentHash: "0x00",
      timestamp: new Date(0),
      size: 0n,
      gasLimit: 0n,
      gasUsed: 0n,
      miner: ZERO_ADDRESS,
      extraData: undefined,
      baseFeePerGas: undefined,
    };

    const dbWithBlock = mockDb.entities.Block.set(block);

    const transaction: Transaction = {
      id: "tx-1",
      hash: "0x02",
      chainId: 10143,
      block_id: block.id,
      blockNumber: 1,
      transactionIndex: 0,
      from: ZERO_ADDRESS,
      to: undefined,
      value: 0n,
      input: undefined,
      nonce: 0n,
      status: undefined,
      gas: 0n,
      gasPrice: undefined,
      gasUsed: undefined,
      maxFeePerGas: undefined,
      maxPriorityFeePerGas: undefined,
      effectiveGasPrice: undefined,
      cumulativeGasUsed: undefined,
      contractAddress: undefined,
      kind: undefined,
      timestamp: block.timestamp,
    };

    const dbWithTx = dbWithBlock.entities.Transaction.set(transaction);

    const log: ChainLog = {
      id: "log-1",
      chainId: 10143,
      transaction_id: transaction.id,
      blockNumber: 1,
      logIndex: 0,
      address: ZERO_ADDRESS,
      data: "0x",
      topic0: undefined,
      topic1: undefined,
      topic2: undefined,
      topic3: undefined,
      removed: false,
    };

    const dbWithLog = dbWithTx.entities.ChainLog.set(log);

    assert.deepEqual(dbWithLog.entities.Block.get(block.id), block);
    assert.deepEqual(dbWithLog.entities.Transaction.get(transaction.id), transaction);
    assert.deepEqual(dbWithLog.entities.ChainLog.get(log.id), log);
  });
});
