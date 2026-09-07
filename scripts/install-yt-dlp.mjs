// Fetch the yt-dlp binary into ./bin at build time.
//
// WHY THIS SCRIPT EXISTS
//
// Render's native Node runtime ships ffmpeg but not yt-dlp, and there is no root
// or apt access to install one. yt-dlp's Linux release is a single
// self-contained executable (PyInstaller, with its own Python inside), so
// downloading it and marking it executable is the whole installation — no
// package manager, no privileges.
//
// WHY LATEST BY DEFAULT, NOT A PIN
//
// Normally pinning wins. Not here: yt-dlp's entire job is tracking a site that
// actively changes to break it, and an old yt-dlp is the single most common
// cause of "Sign in to confirm you're not a bot" and of silent extraction
// failures. A build that quietly keeps a six-month-old binary is a build that
// stops working. Set YTDLP_VERSION to a release tag when you need
// reproducibility for a specific deploy.
//
// FAILING SOFT
//
// A GitHub outage must not fail the deploy. This service's main job is holding
// multiplayer sockets open; audio extraction is a secondary endpoint that will
// report a named 503 if the binary is missing. So a download failure logs loudly
// and exits 0.

import { chmod, mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const BIN_DIR = join(process.cwd(), 'bin')
const BIN_PATH = join(BIN_DIR, 'yt-dlp')

const version = process.env.YTDLP_VERSION?.trim()
const url = version
  ? `https://github.com/yt-dlp/yt-dlp/releases/download/${version}/yt-dlp_linux`
  : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux'

async function main() {
  // Render caches node_modules between builds but not arbitrary directories, so
  // this normally runs every deploy. Skipping when present keeps local rebuilds
  // fast and makes the script safe to run by hand.
  const existing = await stat(BIN_PATH).catch(() => null)
  if (existing?.isFile() && existing.size > 0) {
    console.log(`[install-yt-dlp] already present at ${BIN_PATH} (${existing.size} bytes)`)
    return
  }

  console.log(`[install-yt-dlp] downloading ${url}`)

  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status} ${response.statusText}`)
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  // The release asset is ~30MB. Anything tiny is an error page that followed a
  // redirect with a 200, which would otherwise install as a "binary" that fails
  // with an exec-format error at the least helpful possible moment.
  if (bytes.byteLength < 1_000_000) {
    throw new Error(`downloaded file is only ${bytes.byteLength} bytes — not the yt-dlp binary`)
  }

  await mkdir(BIN_DIR, { recursive: true })
  await writeFile(BIN_PATH, bytes)
  await chmod(BIN_PATH, 0o755)

  console.log(
    `[install-yt-dlp] installed ${(bytes.byteLength / 1e6).toFixed(1)}MB to ${BIN_PATH}\n` +
      `[install-yt-dlp] set YTDLP_PATH=${BIN_PATH} (render.yaml already does)`,
  )
}

main().catch((error) => {
  console.error(
    `[install-yt-dlp] FAILED: ${error instanceof Error ? error.message : error}\n` +
      `[install-yt-dlp] The service will still start; /audio/* will report a 503 until this succeeds.`,
  )
  // Exit 0 on purpose — see "failing soft" above.
  process.exit(0)
})
