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

    @IntColumn_({nullable: false})
    blockCount!: number

    @IntColumn_({nullable: false})
    transactionCount!: number

    @IntColumn_({nullable: false})
    uniqueAddresses!: number

    @BigIntColumn_({nullable: false})
    totalGasUsed!: bigint

    @BigIntColumn_({nullable: false})
    averageGasPrice!: bigint

    @BigIntColumn_({nullable: false})
    totalValue!: bigint
}
