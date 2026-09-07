import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * yt-dlp + ffmpeg extraction for the main app's admin hook editor.
 *
 * WHY THIS LIVES HERE AND NOT IN THE MAIN APP
 *
 * The hook editor decodes real audio so an admin can place Song.hookStartMs to
 * the millisecond — the YouTube IFrame API seeks to roughly ±50-250ms and hands
 * out no samples, so it cannot support the job. Producing that audio needs
 * yt-dlp, ffmpeg and a writable filesystem. A Vercel serverless function has
 * none of the three. This process has all three: Render's native Node runtime
 * ships ffmpeg, `scripts/install-yt-dlp.mjs` adds yt-dlp at build time, and
 * there is a normal disk.
 *
 * So the main app asks this service to extract, this service uploads the result
 * to the shared R2 bucket, and the main app serves it from there. This service
 * never talks to a browser — see routes.ts.
 *
 * MIRRORED FILE. The encode settings below are duplicated in the main repo's
 * src/lib/admin/source-audio.ts, which extracts the same way when run locally.
 * That is the same "mirrored files, not shared" convention this repo already
 * uses for schema.prisma and socket-handler.ts (see README). They MUST agree:
 * both write to the same R2 key, derived from the video id alone, so a drift in
 * sample rate or bit depth would mean the same key holding different bytes
 * depending on which machine got there first.
 *
 * ---------------------------------------------------------------------------
 * Format: mono FLAC, 32kHz, 16-bit — and why each part
 * ---------------------------------------------------------------------------
 *
 * Lossless, because a lossy codec answers "where does the audio start?" with its
 * own encoder delay folded in. MP3 prepends ~576 samples of decoder priming.
 * FLAC has no priming to argue about.
 *
 * Mono, because a hook onset is not a stereo phenomenon, and it halves both the
 * transfer and the browser's decode.
 *
 * 32kHz, because it already puts one sample at 0.031ms — thirty times finer than
 * the millisecond the UI exposes — while keeping ~16kHz of bandwidth so the
 * track still sounds like the track.
 *
 * 16-bit EXPLICITLY: ffmpeg does not default to it here. yt-dlp yields Opus or
 * AAC, both of which decode to float, and the flac encoder then picks 24-bit to
 * avoid discarding precision it assumes you want. On a real track that was 39MB
 * where s16 is 22MB, for eight bits of dynamic range that cannot affect where an
 * onset is.
 */

const SAMPLE_RATE = 32_000
const CHANNELS = 1
const SAMPLE_FORMAT = 's16'
const FLAC_COMPRESSION = 5

export const SOURCE_AUDIO_MIME = 'audio/flac'

/// Ceiling on one extraction. Past this it has failed in a way a longer wait
/// won't fix. Generous because a free Render instance shares CPU and the CDN
/// pull is the slow part.
const EXTRACT_TIMEOUT_MS = 240_000

/// A YouTube id is 11 characters of [A-Za-z0-9_-]. Anything else must not reach
/// a subprocess argv, an object key or a filesystem path.
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/

export function isVideoId(value: string): boolean {
  return VIDEO_ID_PATTERN.test(value)
}

export type ExtractErrorKind = 'toolchain' | 'extraction'

export class ExtractError extends Error {
  constructor(
    message: string,
    readonly kind: ExtractErrorKind,
  ) {
    super(message)
    this.name = 'ExtractError'
  }
}

/// Render's disk is ephemeral and shared with everything else on the instance,
/// so this is scratch space only — the durable copy is the R2 upload. Under
/// tmpdir rather than the repo because a Render deploy replaces the source tree.
const WORK_DIR = join(tmpdir(), 'sargam-admin-audio')

export function sourceAudioKey(videoId: string): string {
  return `admin-audio/${videoId}.flac`
}

function ytdlpBin(): string {
  return process.env.YTDLP_PATH ?? 'yt-dlp'
}

function ffmpegBin(): string {
  return process.env.FFMPEG_PATH ?? 'ffmpeg'
}

/**
 * yt-dlp arguments, including every hedge against YouTube's bot challenge.
 *
 * THE PROBLEM THIS IS FIGHTING. YouTube treats datacenter address ranges far
 * more harshly than residential ones, and Render is a datacenter. "Sign in to
 * confirm you're not a bot" is the common failure here and it is not a bug in
 * this code — it is YouTube declining to serve a cloud IP.
 *
 * The real mitigation isn't in this function: it's that the main app can extract
 * from a laptop on a home connection and upload to the same R2 cache, after
 * which production never asks YouTube for that song again. What's here are the
 * patches for when this service does have to do the pull itself.
 */
export function ytdlpArgs(videoId: string): string[] {
  const args = ['--quiet', '--no-warnings', '--no-playlist', '-f', 'bestaudio/best', '-o', '-']

  // A Netscape-format cookie jar from a signed-in (throwaway) account. The most
  // effective single answer, because it is literally what the challenge asks
  // for. See writeCookieFile() in cookies.ts for how the env var becomes a file.
  const cookieFile = process.env.YTDLP_COOKIES_FILE?.trim()
  if (cookieFile) args.unshift('--cookies', cookieFile)

  // Forcing the mobile players sometimes sidesteps the check entirely. Left
  // unset by default rather than hardcoded: which clients work changes with what
  // YouTube ships, so this is a dial to turn when it breaks, not a fixed answer
  // baked into a deploy. Try "android,ios" first.
  const clients = process.env.YTDLP_PLAYER_CLIENTS?.trim()
  if (clients) args.push('--extractor-args', `youtube:player_client=${clients}`)

  // `--` so an id starting with "-" is an argument rather than a flag. isVideoId
  // already forbids it; this makes that a second line of defence.
  args.push('--', videoId)
  return args
}

function ffmpegArgs(outputPath: string): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    'pipe:0',
    // Drop the video stream — music videos and static-art uploads both carry
    // one, and decoding it is pure waste for an audio-only editor.
    '-vn',
    '-ac',
    String(CHANNELS),
    '-ar',
    String(SAMPLE_RATE),
    '-sample_fmt',
    SAMPLE_FORMAT,
    '-c:a',
    'flac',
    '-compression_level',
    String(FLAC_COMPRESSION),
    // Container stated explicitly: ffmpeg infers it from the output extension,
    // and the temp file's is ".partial" — without this it fails with "Error
    // initializing the muxer ... Invalid argument".
    '-f',
    'flac',
    '-y',
    outputPath,
  ]
}

/**
 * Pull the track and transcode it, resolving to the encoded bytes.
 *
 * Piped rather than run in two steps: letting ffmpeg open its own HTTP
 * connection to the CDN produced a consistent ~5s of phantom leading silence,
 * which on a tool whose entire output is "where does the audio start" would be
 * catastrophic rather than merely wrong. (The main app's detect-hook has the
 * same note for the same reason.)
 *
 * ffmpeg writes to a temp FILE rather than stdout because a FLAC STREAMINFO
 * block carries the total sample count and an MD5 of the audio, and both are
 * only known once the last sample is written. Over a pipe ffmpeg cannot seek
 * back to fill them in and leaves them zeroed; browsers cope, but a real
 * STREAMINFO gives the browser's decodeAudioData an exact length rather than one
 * inferred from frames.
 */
export async function extractAudio(videoId: string): Promise<{ bytes: Uint8Array; path: string }> {
  if (!isVideoId(videoId)) {
    throw new ExtractError(`"${videoId}" is not a YouTube video id.`, 'extraction')
  }

  await mkdir(WORK_DIR, { recursive: true })

  const destination = join(WORK_DIR, `${videoId}.flac`)
  const tempPath = `${destination}.${process.pid}.partial`

  const ytdlp = spawn(ytdlpBin(), ytdlpArgs(videoId), { stdio: ['ignore', 'pipe', 'pipe'] })
  const ffmpeg = spawn(ffmpegBin(), ffmpegArgs(tempPath), { stdio: ['pipe', 'ignore', 'pipe'] })

  ytdlp.stdout.pipe(ffmpeg.stdin)

  // Both sides of the pipe can legitimately break: if ffmpeg exits first (bad
  // input, killed by the timeout) yt-dlp's next write gets EPIPE, which Node
  // turns into an unhandled 'error' event and a crash unless caught. This
  // process also holds live multiplayer rooms, so an uncaught throw here would
  // drop every socket on the instance.
  ytdlp.stdout.on('error', () => {})
  ffmpeg.stdin.on('error', () => {})

  let ytdlpErr = ''
  let ffmpegErr = ''
  ytdlp.stderr.on('data', (chunk: Buffer) => {
    ytdlpErr += chunk.toString()
  })
  ffmpeg.stderr.on('data', (chunk: Buffer) => {
    ffmpegErr += chunk.toString()
  })

  // A missing binary surfaces as a spawn 'error', not a non-zero exit, and is
  // worth reporting differently: "yt-dlp didn't install" is an operator problem,
  // "YouTube refused this video" is not.
  const spawnFailures = new Map<string, NodeJS.ErrnoException>()
  ytdlp.on('error', (error: NodeJS.ErrnoException) => spawnFailures.set('yt-dlp', error))
  ffmpeg.on('error', (error: NodeJS.ErrnoException) => spawnFailures.set('ffmpeg', error))

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ytdlp.kill('SIGKILL')
    ffmpeg.kill('SIGKILL')
  }, EXTRACT_TIMEOUT_MS)

  const ffmpegExit = await new Promise<number | null>((resolve) => {
    ffmpeg.on('close', resolve)
  })
  clearTimeout(timer)
  try {
    ytdlp.kill('SIGKILL')
  } catch {
    /* already gone */
  }

  const cleanup = () => rm(tempPath, { force: true }).catch(() => {})

  for (const [name, error] of spawnFailures) {
    if (error.code === 'ENOENT') {
      await cleanup()
      throw new ExtractError(
        `${name} is not installed or not on PATH on the audio service. ` +
          `ffmpeg ships with Render's native Node runtime; yt-dlp is installed by ` +
          `scripts/install-yt-dlp.mjs during the build — check the build log.`,
        'toolchain',
      )
    }
  }

  if (timedOut) {
    await cleanup()
    throw new ExtractError(`Extraction timed out after ${EXTRACT_TIMEOUT_MS / 1000}s.`, 'extraction')
  }

  if (ffmpegExit !== 0) {
    await cleanup()
    throw new ExtractError(describeFailure(videoId, ytdlpErr, ffmpegErr), 'extraction')
  }

  const info = await stat(tempPath).catch(() => null)
  if (!info || info.size === 0) {
    await cleanup()
    throw new ExtractError(`Extraction produced no audio for ${videoId}.`, 'extraction')
  }

  await rename(tempPath, destination)
  return { bytes: await readFile(destination), path: destination }
}

/**
 * First audible millisecond, via ffmpeg's silencedetect over a local file.
 *
 * Mirrors the thresholds in the main app's lib/catalog/detect-hook.ts, which
 * answers the same question by piping yt-dlp straight into ffmpeg. This runs
 * against audio already on disk, so it is a second or two rather than a minute.
 *
 * -50dB rather than -35dB: quiet intros (soft strings, tabla taps, whispered
 * lyrics) sit above -35dB and would make the detector conclude there is no
 * leading silence at all. 20ms minimum duration filters single-frame codec noise
 * while still reporting a silence that ends after one audio frame.
 */
export async function detectFirstAudibleMs(filePath: string): Promise<number> {
  const ffmpeg = spawn(
    ffmpegBin(),
    [
      '-hide_banner',
      '-i',
      filePath,
      '-t',
      '30',
      '-af',
      'silencedetect=n=-50dB:d=0.02',
      '-f',
      'null',
      '-',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )

  let stderr = ''
  ffmpeg.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })

  await new Promise<void>((resolve) => ffmpeg.on('close', () => resolve()))

  const ends: number[] = []
  for (const match of stderr.matchAll(/silence_end:\s*([\d.]+)/g)) {
    ends.push(Number.parseFloat(match[1]!))
  }

  // No leading silence found — the track starts with audio immediately. 500ms is
  // the same fallback the main app uses: not zero, because a hook at zero puts
  // stage 1 on whatever pre-roll the upload happens to carry.
  if (ends.length === 0) return 500

  // A tiny floor absorbs single-sample codec pre-roll without masking real
  // onset times.
  return Math.max(Math.round(ends[0]! * 1000), 50)
}

/// Turn subprocess stderr into something an admin can act on.
///
/// yt-dlp's stderr is the useful half almost every time (age gate, region block,
/// removed video, bot challenge); ffmpeg's is usually just "pipe:0: Invalid
/// data" downstream of it. The bot-challenge case is named explicitly because
/// its raw text does not suggest the fix, and the fix is configuration rather
/// than a retry.
function describeFailure(videoId: string, ytdlpErr: string, ffmpegErr: string): string {
  const combined = `${ytdlpErr}\n${ffmpegErr}`

  if (/confirm you'?re not a bot|Sign in to confirm/i.test(combined)) {
    return (
      `YouTube is challenging this request as a bot, which it does far more often to ` +
      `datacenter IPs (like this service's) than to home connections. Either review this song ` +
      `from a machine on a home connection — it uploads to the same shared storage, so ` +
      `production picks it up — or set YTDLP_COOKIES on this service.`
    )
  }

  if (/Video unavailable|Private video|removed by the uploader/i.test(combined)) {
    return `YouTube says this video is unavailable (${videoId}). The id may be wrong or the upload gone.`
  }

  const detail = (ytdlpErr || ffmpegErr).trim().split('\n').slice(-3).join(' ')
  return `Could not extract audio for ${videoId}.${detail ? ` ${detail}` : ''}`
}
