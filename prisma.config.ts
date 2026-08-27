// Prisma 7 config. Only `prisma generate` ever runs from this repo — no
// migrations, no seeding. The main app owns the schema's migration history.
import 'dotenv/config'
import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
})
