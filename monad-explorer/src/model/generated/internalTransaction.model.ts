import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, ManyToOne as ManyToOne_, Index as Index_, IntColumn as IntColumn_, StringColumn as StringColumn_, BigIntColumn as BigIntColumn_} from "@subsquid/typeorm-store"
import {Transaction} from "./transaction.model"

@Entity_()
export class InternalTransaction {
    constructor(props?: Partial<InternalTransaction>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_()
    @ManyToOne_(() => Transaction, {nullable: true})
    transaction!: Transaction

    @IntColumn_({nullable: false})
    traceIndex!: number

    @StringColumn_({nullable: false})
    type!: string

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
    gasUsed!: bigint

    @StringColumn_({nullable: true})
    input!: string | undefined | null

    @StringColumn_({nullable: true})
    output!: string | undefined | null

    @StringColumn_({nullable: true})
    error!: string | undefined | null

    @Index_()
    @ManyToOne_(() => InternalTransaction, {nullable: true})
    parentTrace!: InternalTransaction | undefined | null
}
