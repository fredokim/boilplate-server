import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsObject, IsOptional, IsString, Length, Min } from 'class-validator';

/**
 * `definition` and `presets` are typed as plain objects here on purpose.
 *
 * class-validator cannot express a discriminated union whose `config` differs per
 * variant without one DTO class per widget type. The pipe therefore checks that
 * these are objects, and `dashboardSchema.ts` does the structural work — one
 * validator for the shape, in one place, used on both the write and the read.
 */

export class DashboardResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() ownerId!: string;
  @ApiProperty({ enum: ['private', 'shared'] }) visibility!: 'private' | 'shared';
  @ApiProperty({ description: 'Schema version of the stored definition.' }) schemaVersion!: number;
  @ApiProperty({ description: 'Optimistic lock. Send this back when writing.' }) version!: number;
  @ApiProperty({ type: Object, description: 'Validated dashboard definition.' }) definition!: unknown;
  @ApiProperty() updatedAt!: string;
}

export class PersonalizationResponseDto {
  @ApiProperty() dashboardId!: string;
  @ApiProperty() userId!: string;
  @ApiProperty() schemaVersion!: number;
  @ApiProperty({ description: 'Optimistic lock. Send this back when writing.' }) version!: number;
  @ApiProperty() activePresetId!: string;
  @ApiProperty({ type: [Object] }) presets!: unknown[];
  @ApiProperty() updatedAt!: string;
}

export class SavePersonalizationDto {
  /**
   * The version the client last read. Omitting it is not allowed: a blind write
   * is exactly the case optimistic locking exists to catch.
   */
  @IsInt()
  @Min(1)
  @ApiProperty({ description: 'The version last read. A mismatch answers 409.' })
  expectedVersion!: number;

  @IsString()
  @Length(1, 64)
  @ApiProperty()
  activePresetId!: string;

  /**
   * `@Type(() => Object)` is load-bearing, not decoration. The global pipe runs
   * with `enableImplicitConversion`, and for an array whose item type it cannot
   * infer, class-transformer coerces the elements — the objects arrived at the
   * service as non-objects and every save answered 422. Naming the item type
   * stops the conversion.
   */
  @IsArray()
  @Type(() => Object)
  @ApiProperty({ type: [Object] })
  presets!: unknown[];
}

export class CreatePresetDto {
  @IsString()
  @Length(1, 80)
  @ApiProperty({ example: 'Incident review' })
  name!: string;

  @IsInt()
  @Min(1)
  @ApiProperty()
  expectedVersion!: number;

  /** Omitted means "start from the active preset", which is what the UI does. */
  @IsOptional()
  @IsString()
  @Length(1, 64)
  @ApiPropertyOptional({ description: 'Preset to copy. Defaults to the active one.' })
  copyFromPresetId?: string;
}

export class RenamePresetDto {
  @IsString()
  @Length(1, 80)
  @ApiProperty()
  name!: string;

  @IsInt()
  @Min(1)
  @ApiProperty()
  expectedVersion!: number;
}

export class SelectPresetDto {
  @IsInt()
  @Min(1)
  @ApiProperty()
  expectedVersion!: number;
}

export class DeletePresetDto {
  @IsInt()
  @Min(1)
  @ApiProperty()
  expectedVersion!: number;
}

export class SaveDashboardDefinitionDto {
  @IsInt()
  @Min(1)
  @ApiProperty()
  expectedVersion!: number;

  @IsObject()
  @Type(() => Object)
  @ApiProperty({ type: Object })
  definition!: unknown;
}
