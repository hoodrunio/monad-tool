import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, ManyToOne as ManyToOne_, Index as Index_, StringColumn as StringColumn_, BigIntColumn as BigIntColumn_, DateTimeColumn as DateTimeColumn_} from "@subsquid/typeorm-store"
import {Token} from "./token.model"
import {Transaction} from "./transaction.model"
import {Log} from "./log.model"

@Entity_()
export class TokenTransfer {
    constructor(props?: Partial<TokenTransfer>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_()
    @ManyToOne_(() => Token, {nullable: true})
    token!: Token

    @Index_()
    @ManyToOne_(() => Transaction, {nullable: true})
    transaction!: Transaction

    @Index_()
    @ManyToOne_(() => Log, {nullable: true})
    log!: Log

    @Index_()
    @StringColumn_({nullable: false, name: "from_address"})
    fromAddress!: string

    @Index_()
    @StringColumn_({nullable: false, name: "to_address"})
    toAddress!: string

    @BigIntColumn_({nullable: false})
    value!: bigint

    @Index_()
    @StringColumn_({nullable: false, name: "token_id"})
    tokenId!: string

    @Index_()
    @DateTimeColumn_({nullable: false})
    timestamp!: Date
}
