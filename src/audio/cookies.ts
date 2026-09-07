import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Materialise YouTube cookies from an env var onto disk, once at boot.
 *
 * yt-dlp's `--cookies` takes a FILE, and Render's free plan has no secret-files
 * feature — only environment variables. So the cookie jar travels as one
 * variable and gets written to a real path here.
 *
 * WHY COOKIES AT ALL. YouTube challenges datacenter IPs ("Sign in to confirm
 * you're not a bot") far more readily than home connections, and this service
 * runs in a datacenter. A cookie jar from a signed-in account is what the
 * challenge is literally asking for, and is the most reliable thing that fits in
 * a deployment.
 *
 * USE A THROWAWAY ACCOUNT. These cookies are full session credentials for
 * whatever account exported them. Anything holding them can act as that account.
 * Never use a personal or business Google account here.
 *
 * They also expire, and YouTube invalidates them faster when it sees them used
 * from a datacenter — so treat this as something that needs re-pasting
 * occasionally, not set-and-forget. The far better play is to review songs from
 * a machine on a home connection: the main app uploads to the same R2 bucket, so
 * production gets the audio without this service ever calling YouTube.
 *
 * Accepts either the raw Netscape cookies.txt contents or the same thing
 * base64-encoded, because Render's dashboard is a single-line input and pasting
 * a multi-line tab-separated file into it does not survive reliably.
 */

const COOKIE_DIR = join(tmpdir(), 'sargam-admin-audio')
const COOKIE_PATH = join(COOKIE_DIR, 'youtube-cookies.txt')

/// Netscape cookie jars start with this comment line. Used to tell a raw jar
/// from a base64 blob without guessing at the encoding.
const NETSCAPE_HEADER = '# Netscape HTTP Cookie File'

/**
 * Write the jar if one is configured, and point YTDLP_COOKIES_FILE at it.
 *
 * Setting the env var here rather than returning a path keeps extract.ts free of
 * any cookie handling — it just reads YTDLP_COOKIES_FILE, which also lets a
 * local developer set that variable directly and skip this entirely.
 *
 * Returns a short status string for the boot log. Never throws: bad cookies
 * should degrade to "extraction may be challenged", not stop a service whose
 * main job is multiplayer sockets from starting.
 */
export async function installYoutubeCookies(): Promise<string> {
  // An explicit path wins — a local dev or a paid plan with secret files has a
  // real file already and does not need this.
  if (process.env.YTDLP_COOKIES_FILE?.trim()) {
    return `using YTDLP_COOKIES_FILE at ${process.env.YTDLP_COOKIES_FILE}`
  }

  const raw = process.env.YTDLP_COOKIES?.trim()
  if (!raw) return 'no YouTube cookies configured (extraction may hit bot checks)'

  let contents = raw
  if (!raw.startsWith(NETSCAPE_HEADER) && !raw.includes('\t')) {
    try {
      contents = Buffer.from(raw, 'base64').toString('utf8')
    } catch {
      return 'YTDLP_COOKIES is neither a cookies.txt nor valid base64 — ignoring'
    }
  }

  if (!contents.includes('\t')) {
    // Every real Netscape jar is tab-separated. Without a tab this is almost
    // certainly a value mangled by a copy-paste, and yt-dlp's error for it is
    // opaque — better to say so at boot than to fail one extraction at a time.
    return 'YTDLP_COOKIES does not look like a Netscape cookies.txt (no tabs) — ignoring'
  }

  try {
    await mkdir(COOKIE_DIR, { recursive: true })
    // 0600: this is a session credential sitting on a shared instance.
    await writeFile(COOKIE_PATH, contents, { mode: 0o600 })
    process.env.YTDLP_COOKIES_FILE = COOKIE_PATH
    const lines = contents.split('\n').filter((l) => l.includes('\t')).length
    return `wrote ${lines} YouTube cookies to ${COOKIE_PATH}`
  } catch (error) {
    return `could not write YouTube cookies: ${error instanceof Error ? error.message : 'unknown error'}`
  }
}
