import { Prisma } from "@/generated/prisma/client";

/// Deliberately its own file, not exported only from selection.ts: selection.ts
/// is `import "server-only"`, which Next's bundler enforces but a plain Node
/// process (socket-handler.ts, loaded by tsx outside that bundler) does not —
/// there it just throws on load. This is pure SQL-fragment logic with no
/// business being gated behind that guard in the first place, so both the
/// solo run's puzzle sampler (selection.ts) and the multiplayer room's
/// upfront puzzle picker (socket-handler.ts) import it from here.

export type DecadeFilter = "NINETIES" | "TWO_THOUSANDS";

/// Song.decade stores the decade-start year (e.g. 1990), so "the 90s and
/// earlier" and "2000 onward" are each a range of decade-start values, not a
/// single one. TWO_THOUSANDS has no upper bound — the catalog never has
/// decade values ahead of the current one.
export function decadeClause(filter: DecadeFilter | null | undefined) {
  if (filter === "NINETIES") return Prisma.sql`AND s.decade BETWEEN 1960 AND 1990`;
  if (filter === "TWO_THOUSANDS") return Prisma.sql`AND s.decade >= 2000`;
  return Prisma.empty;
}
