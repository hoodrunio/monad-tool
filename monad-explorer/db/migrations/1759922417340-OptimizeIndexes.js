module.exports = class OptimizeIndexes1759922417340 {
    name = 'OptimizeIndexes1759922417340'

    async up(db) {
        // Add composite index for transaction (block_id, transaction_index)
        // This improves queries that filter by block and order by transaction_index
        await db.query(`CREATE INDEX "IDX_transaction_block_tx_index" ON "transaction" ("block_id", "transaction_index")`)

        // Add partial index for failed transactions (faster error analysis)
        await db.query(`CREATE INDEX "IDX_transaction_status_error" ON "transaction" ("status") WHERE status != 1`)

        // Add index for contract interactions (faster contract-related queries)
        await db.query(`CREATE INDEX "IDX_transaction_contract_interaction" ON "transaction" ("is_contract_interaction") WHERE is_contract_interaction = true`)
    }

    async down(db) {
        await db.query(`DROP INDEX "public"."IDX_transaction_block_tx_index"`)
        await db.query(`DROP INDEX "public"."IDX_transaction_status_error"`)
        await db.query(`DROP INDEX "public"."IDX_transaction_contract_interaction"`)
    }
}
