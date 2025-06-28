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

    @IntColumn_({nullable: false, name: "transaction_count"})
    transactionCount!: number

    @Index_()
    @BooleanColumn_({nullable: false, name: "is_contract"})
    isContract!: boolean

    @StringColumn_({nullable: true, name: "contract_code"})
    contractCode!: string | undefined | null

    @DateTimeColumn_({nullable: true, name: "created_at"})
    createdAt!: Date | undefined | null

    @StringColumn_({nullable: true, name: "contract_type"})
    contractType!: string | undefined | null

    @BooleanColumn_({nullable: true, name: "is_verified"})
    isVerified!: boolean | undefined | null

    @StringColumn_({nullable: true, name: "contract_name"})
    contractName!: string | undefined | null

    @StringColumn_({nullable: true, name: "ens_name"})
    ensName!: string | undefined | null
}
