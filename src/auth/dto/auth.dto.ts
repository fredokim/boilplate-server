import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Mirrors the frontend's `LoginRequestDto` in `src/features/auth/dto/Auth.dto.ts`
 * and the Zod schema beside it, including the 8-character minimum. A server that
 * accepted less would let a client bypass a rule the UI states.
 */
export class LoginRequestDto {
  /**
   * Normalised here rather than in the service, so every path into the DTO gets
   * the same value. The unique constraint is on the stored lowercase form, so a
   * lookup that skipped this would miss a real account.
   */
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(320)
  @ApiProperty({ example: 'demo@example.com' })
  email!: string;

  /**
   * The upper bound matters: Argon2 hashes whatever it is given, so an unbounded
   * password field is a way to make the server do arbitrary work per request.
   */
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  @ApiProperty({ example: 'correct horse battery staple', minLength: 8 })
  password!: string;
}

/** Exactly the shape the frontend's `AuthUserDto` validates. */
export class AuthUserResponseDto {
  @ApiProperty({ example: 'a3f1c2e4-...' })
  id!: string;

  @ApiProperty({ example: 'demo@example.com' })
  email!: string;

  @ApiProperty({ example: 'Demo Maker' })
  name!: string;

  @ApiProperty({ example: ['dashboard:read', 'user:read'], type: [String] })
  permissions!: string[];
}

/** Matches the frontend's `LoginResultDto`. */
export class LoginResponseDto {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty({ type: AuthUserResponseDto })
  user!: AuthUserResponseDto;
}

/** Matches the frontend's `SessionDto`. */
export class SessionResponseDto {
  @ApiProperty({ type: AuthUserResponseDto })
  user!: AuthUserResponseDto;
}

export class LogoutResponseDto {
  @ApiProperty({
    example: true,
    description: 'False when there was no live session to end. Logout is idempotent either way.',
  })
  revoked!: boolean;
}
