import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, StringColumn as StringColumn_, Index as Index_, BigIntColumn as BigIntColumn_, IntColumn as IntColumn_, BooleanColumn as BooleanColumn_, DateTimeColumn as DateTimeColumn_} from "@subsquid/typeorm-store"

@Entity_()
export class Account {
    constructor(props?: Partial<Account>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_({unique: true})
    @StringColumn_({nullable: false})
    address!: string

    @BigIntColumn_({nullable: false})
    balance!: bigint

    @IntColumn_({nullable: false})
    transactionCount!: number

    @Index_()
    @BooleanColumn_({nullable: false})
    isContract!: boolean

    @StringColumn_({nullable: true})
    contractCode!: string | undefined | null

    @DateTimeColumn_({nullable: true})
    createdAt!: Date | undefined | null

    @StringColumn_({nullable: true})
    contractType!: string | undefined | null

    @BooleanColumn_({nullable: true})
    isVerified!: boolean | undefined | null

    @StringColumn_({nullable: true})
    contractName!: string | undefined | null

    @StringColumn_({nullable: true})
    ensName!: string | undefined | null
}
