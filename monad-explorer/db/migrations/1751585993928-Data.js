module.exports = class Data1751585993928 {
    name = 'Data1751585993928'

    async up(db) {
        await db.query(`ALTER TABLE "contract" ADD "owner" text`)
        await db.query(`ALTER TABLE "contract" ALTER COLUMN "creator" DROP NOT NULL`)
        await db.query(`CREATE INDEX "IDX_39f5ebd8814abb1bf9f2fef20e" ON "contract" ("owner") `)
    }

    async down(db) {
        await db.query(`ALTER TABLE "contract" DROP COLUMN "owner"`)
        await db.query(`ALTER TABLE "contract" ALTER COLUMN "creator" SET NOT NULL`)
        await db.query(`DROP INDEX "public"."IDX_39f5ebd8814abb1bf9f2fef20e"`)
    }
}
