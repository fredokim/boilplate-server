import { ApiProperty } from '@nestjs/swagger';

/**
 * Matched to the frontend's `UserDto` in `src/features/user/dto/User.dto.ts`:
 * id, email, name, role — and nothing else.
 *
 * `role` is the role's name, not its id. That is what the client renders, and it
 * is why this is a response DTO rather than the Prisma row: the row carries a
 * `roleId`, a `passwordHash`, and timestamps that no caller asked for.
 */
export class UserResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ description: "The role's name, e.g. admin." }) role!: string;
}

export class UserListResponseDto {
  @ApiProperty({ type: [UserResponseDto] })
  items!: UserResponseDto[];
}
