import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddReservationUser1787270400001 implements MigrationInterface {
    name = 'AddReservationUser1787270400001';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`reserve\` ADD \`reservationUser\` text NULL`);
        await queryRunner.query(`ALTER TABLE \`recorded\` ADD \`reservationUser\` text NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`recorded\` DROP COLUMN \`reservationUser\``);
        await queryRunner.query(`ALTER TABLE \`reserve\` DROP COLUMN \`reservationUser\``);
    }
}
