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

    @IntColumn_({nullable: false, name: "transaction_index"})
    transactionIndex!: number

    @Index_()
    @StringColumn_({nullable: false, name: "from_address"})
    fromAddress!: string

    @Index_()
    @StringColumn_({nullable: true, name: "to_address"})
    toAddress!: string | undefined | null

    @BigIntColumn_({nullable: false})
    value!: bigint

    @BigIntColumn_({nullable: false})
    gas!: bigint

    @BigIntColumn_({nullable: false, name: "gas_price"})
    gasPrice!: bigint

    @BigIntColumn_({nullable: true, name: "gas_used"})
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

    @BigIntColumn_({nullable: true, name: "effective_gas_price"})
    effectiveGasPrice!: bigint | undefined | null

    @BigIntColumn_({nullable: true, name: "max_fee_per_gas"})
    maxFeePerGas!: bigint | undefined | null

    @BigIntColumn_({nullable: true, name: "max_priority_fee_per_gas"})
    maxPriorityFeePerGas!: bigint | undefined | null

    @StringColumn_({nullable: true, name: "contract_address"})
    contractAddress!: string | undefined | null

    @BigIntColumn_({nullable: true, name: "cumulative_gas_used"})
    cumulativeGasUsed!: bigint | undefined | null

    @BigIntColumn_({nullable: true, name: "transaction_fee"})
    transactionFee!: bigint | undefined | null

    @StringColumn_({nullable: true, name: "method_name"})
    methodName!: string | undefined | null

    @StringColumn_({nullable: true, name: "method_id"})
    methodID!: string | undefined | null

    @StringColumn_({nullable: true, name: "input_decoded"})
    inputDecoded!: string | undefined | null

    @BooleanColumn_({nullable: false, name: "is_contract_interaction"})
    isContractInteraction!: boolean

    @BooleanColumn_({nullable: false, name: "is_contract_creation"})
    isContractCreation!: boolean
}
