import { HttpStatus, Injectable } from '@nestjs/common';
import { ErrorCode } from '../common/contracts/errorCode';
import { AppException } from '../common/exceptions/appException';
import { PrismaService } from '../database/prisma.service';
import type { UserResponseDto } from './dto/user.dto';

/** A page cap, so the list cannot become an unbounded response. */
const MAX_USERS = 200;

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<UserResponseDto[]> {
    const rows = await this.prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      take: MAX_USERS,
      include: { role: { select: { name: true } } },
    });

    return rows.map(toResponse);
  }

  async findOne(id: string): Promise<UserResponseDto> {
    const row = await this.prisma.user.findUnique({
      where: { id },
      include: { role: { select: { name: true } } },
    });

    if (!row) {
      throw new AppException({
        status: HttpStatus.NOT_FOUND,
        code: ErrorCode.NOT_FOUND,
        message: 'User not found.',
      });
    }

    return toResponse(row);
  }
}

/**
 * The mapping that keeps `passwordHash` out of a response.
 *
 * The client-level `omit` in PrismaService already withholds it, so this is the
 * second of two independent guards rather than the only one — and it is the one
 * that also drops `roleId`, `isActive`, and the timestamps the contract does not
 * include.
 */
function toResponse(row: { id: string; email: string; name: string; role?: { name: string } | null }): UserResponseDto {
  return { id: row.id, email: row.email, name: row.name, role: row.role?.name ?? 'unknown' };
}
