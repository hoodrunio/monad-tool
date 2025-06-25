import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, ManyToOne as ManyToOne_, Index as Index_, IntColumn as IntColumn_, StringColumn as StringColumn_, BooleanColumn as BooleanColumn_} from "@subsquid/typeorm-store"
import {Transaction} from "./transaction.model"

@Entity_()
export class Log {
    constructor(props?: Partial<Log>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_()
    @ManyToOne_(() => Transaction, {nullable: true})
    transaction!: Transaction

    @IntColumn_({nullable: false})
    logIndex!: number

    @Index_()
    @StringColumn_({nullable: false})
    address!: string

    @StringColumn_({array: true, nullable: false})
    topics!: (string)[]

    @StringColumn_({nullable: false})
    data!: string

    @BooleanColumn_({nullable: true})
    removed!: boolean | undefined | null
}
