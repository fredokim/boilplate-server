import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global so feature modules inject `PrismaService` directly instead of each one
 * importing this module.
 *
 * There is no generic repository or base service here on purpose. Prisma is
 * already the data-access abstraction; wrapping it in another one before a
 * second data source exists would add indirection with nothing on the other
 * side of it.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class DatabaseModule {}
