import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, StringColumn as StringColumn_, Index as Index_, BooleanColumn as BooleanColumn_} from "@subsquid/typeorm-store"

@Entity_()
export class MethodSignature {
    constructor(props?: Partial<MethodSignature>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_({unique: true})
    @StringColumn_({nullable: false})
    methodId!: string

    @StringColumn_({nullable: false})
    signature!: string

    @Index_()
    @StringColumn_({nullable: false})
    name!: string

    @BooleanColumn_({nullable: false})
    verified!: boolean

    @StringColumn_({nullable: true})
    source!: string | undefined | null
}
