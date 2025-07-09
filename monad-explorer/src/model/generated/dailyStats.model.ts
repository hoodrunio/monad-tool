import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, DateTimeColumn as DateTimeColumn_, Index as Index_, IntColumn as IntColumn_, BigIntColumn as BigIntColumn_} from "@subsquid/typeorm-store"

@Entity_()
export class DailyStats {
    constructor(props?: Partial<DailyStats>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_({unique: true})
    @DateTimeColumn_({nullable: false})
    date!: Date

    @IntColumn_({nullable: false, name: 'block_count'})
    blockCount!: number

    @IntColumn_({nullable: false, name: 'transaction_count'})
    transactionCount!: number

    @IntColumn_({nullable: false, name: 'unique_addresses'})
    uniqueAddresses!: number

    @BigIntColumn_({nullable: false, name: 'total_gas_used'})
    totalGasUsed!: bigint

    @BigIntColumn_({nullable: false, name: 'average_gas_price'})
    averageGasPrice!: bigint

    @BigIntColumn_({nullable: false, name: 'total_value'})
    totalValue!: bigint
}
