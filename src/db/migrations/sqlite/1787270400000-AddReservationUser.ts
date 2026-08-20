import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddReservationUser1787270400000 implements MigrationInterface {
    name = 'AddReservationUser1787270400000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "reserve" ADD "reservationUser" text`);
        await queryRunner.query(`ALTER TABLE "recorded" ADD "reservationUser" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "recorded" DROP COLUMN "reservationUser"`);
        await queryRunner.query(`ALTER TABLE "reserve" DROP COLUMN "reservationUser"`);
    }
}
