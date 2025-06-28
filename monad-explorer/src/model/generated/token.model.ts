import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, StringColumn as StringColumn_, Index as Index_, IntColumn as IntColumn_, BigIntColumn as BigIntColumn_, DateTimeColumn as DateTimeColumn_} from "@subsquid/typeorm-store"
import {TokenType} from "./_tokenType"

@Entity_()
export class Token {
    constructor(props?: Partial<Token>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_({unique: true})
    @StringColumn_({nullable: false})
    address!: string

    @StringColumn_({nullable: true})
    name!: string | undefined | null

    @Index_()
    @StringColumn_({nullable: true})
    symbol!: string | undefined | null

    @IntColumn_({nullable: true})
    decimals!: number | undefined | null

    @BigIntColumn_({nullable: true, name: "total_supply"})
    totalSupply!: bigint | undefined | null

    @Index_()
    @Column_("varchar", {length: 7, nullable: false, name: "token_type"})
    tokenType!: TokenType

    @DateTimeColumn_({nullable: false, name: "created_at"})
    createdAt!: Date
}
