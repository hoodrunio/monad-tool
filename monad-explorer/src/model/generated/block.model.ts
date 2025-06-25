import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, IntColumn as IntColumn_, Index as Index_, StringColumn as StringColumn_, DateTimeColumn as DateTimeColumn_, BigIntColumn as BigIntColumn_} from "@subsquid/typeorm-store"

@Entity_()
export class Block {
    constructor(props?: Partial<Block>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_()
    @IntColumn_({nullable: false})
    number!: number

    @Index_({unique: true})
    @StringColumn_({nullable: false})
    hash!: string

    @StringColumn_({nullable: false})
    parentHash!: string

    @Index_()
    @DateTimeColumn_({nullable: false})
    timestamp!: Date

    @BigIntColumn_({nullable: true})
    size!: bigint | undefined | null

    @BigIntColumn_({nullable: false})
    gasLimit!: bigint

    @BigIntColumn_({nullable: false})
    gasUsed!: bigint

    @IntColumn_({nullable: false})
    transactionCount!: number
}
