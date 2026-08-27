import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/prisma/client'

// Mirrors the main app's src/lib/db.ts pool tuning — see that file for the
// reasoning. Same database, same connection-cost concerns.
const pool = {
  connectionString: process.env.DATABASE_URL!,
  min: Number.parseInt(process.env.DB_POOL_MIN ?? '2', 10),
  max: Number.parseInt(process.env.DB_POOL_MAX ?? '10', 10),
  idleTimeoutMillis: 360_000,
  connectionTimeoutMillis: 10_000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
}

const adapter = new PrismaPg(pool)

export const prisma = new PrismaClient({ adapter })
