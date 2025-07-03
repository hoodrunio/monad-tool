import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, StringColumn as StringColumn_, Index as Index_, ManyToOne as ManyToOne_, DateTimeColumn as DateTimeColumn_, BooleanColumn as BooleanColumn_} from "@subsquid/typeorm-store"
import {Transaction} from "./transaction.model"

@Entity_()
export class Contract {
    constructor(props?: Partial<Contract>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_({unique: true})
    @StringColumn_({nullable: false})
    address!: string

    @Index_()
    @StringColumn_({nullable: true})
    creator!: string | undefined | null

    @Index_()
    @StringColumn_({nullable: true})
    owner!: string | undefined | null

    @Index_()
    @ManyToOne_(() => Transaction, {nullable: true})
    creationTransaction!: Transaction

    @Index_()
    @DateTimeColumn_({nullable: false})
    createdAt!: Date

    @StringColumn_({nullable: true})
    bytecode!: string | undefined | null

    @StringColumn_({nullable: true})
    sourceCode!: string | undefined | null

    @Index_()
    @BooleanColumn_({nullable: false})
    isVerified!: boolean

    @StringColumn_({nullable: true})
    name!: string | undefined | null

    @StringColumn_({nullable: true})
    compilerVersion!: string | undefined | null
}
