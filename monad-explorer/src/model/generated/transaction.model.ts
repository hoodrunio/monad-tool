import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, StringColumn as StringColumn_, Index as Index_, ManyToOne as ManyToOne_, IntColumn as IntColumn_, BigIntColumn as BigIntColumn_, DateTimeColumn as DateTimeColumn_, BooleanColumn as BooleanColumn_} from "@subsquid/typeorm-store"
import {Block} from "./block.model"

@Entity_()
export class Transaction {
    constructor(props?: Partial<Transaction>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_({unique: true})
    @StringColumn_({nullable: false})
    hash!: string

    @Index_()
    @ManyToOne_(() => Block, {nullable: true})
    block!: Block

    @IntColumn_({nullable: false})
    transactionIndex!: number

    @Index_()
    @StringColumn_({nullable: false})
    fromAddress!: string

    @Index_()
    @StringColumn_({nullable: true})
    toAddress!: string | undefined | null

    @BigIntColumn_({nullable: false})
    value!: bigint

    @BigIntColumn_({nullable: false})
    gas!: bigint

    @BigIntColumn_({nullable: false})
    gasPrice!: bigint

    @BigIntColumn_({nullable: true})
    gasUsed!: bigint | undefined | null

    @StringColumn_({nullable: true})
    input!: string | undefined | null

    @IntColumn_({nullable: true})
    status!: number | undefined | null

    @Index_()
    @DateTimeColumn_({nullable: false})
    timestamp!: Date

    @BigIntColumn_({nullable: true})
    nonce!: bigint | undefined | null

    @IntColumn_({nullable: true})
    type!: number | undefined | null

    @BigIntColumn_({nullable: true})
    effectiveGasPrice!: bigint | undefined | null

    @BigIntColumn_({nullable: true})
    maxFeePerGas!: bigint | undefined | null

    @BigIntColumn_({nullable: true})
    maxPriorityFeePerGas!: bigint | undefined | null

    @StringColumn_({nullable: true})
    contractAddress!: string | undefined | null

    @BigIntColumn_({nullable: true})
    cumulativeGasUsed!: bigint | undefined | null

    @BigIntColumn_({nullable: true})
    transactionFee!: bigint | undefined | null

    @StringColumn_({nullable: true})
    methodName!: string | undefined | null

    @StringColumn_({nullable: true})
    methodID!: string | undefined | null

    @StringColumn_({nullable: true})
    inputDecoded!: string | undefined | null

    @BooleanColumn_({nullable: false})
    isContractInteraction!: boolean

    @BooleanColumn_({nullable: false})
    isContractCreation!: boolean
}
