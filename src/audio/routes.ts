import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  ExtractError,
  SOURCE_AUDIO_MIME,
  detectFirstAudibleMs,
  extractAudio,
  isVideoId,
  sourceAudioKey,
} from './extract'
import { isStorageConfigured, objectSize, putObject } from './store'

/**
 * HTTP endpoints for the main app's admin hook editor.
 *
 *   GET  /audio/health              toolchain + storage readiness
 *   GET  /audio/status/:videoId     { state, byteSize? }
 *   POST /audio/extract/:videoId    begin extraction, return immediately
 *   POST /audio/detect-hook/:videoId  { hookStartMs } — blocks on real work
 *
 * ---------------------------------------------------------------------------
 * These are SERVER-TO-SERVER ONLY
 * ---------------------------------------------------------------------------
 *
 * No browser ever calls them. The main app's admin route is the only client, and
 * it authenticates with a bearer secret. Two consequences worth stating, because
 * both look like omissions otherwise:
 *
 *   • There is no CORS handling here and there should not be. Nothing in a
 *     browser is permitted to reach this.
 *   • Extracted audio is never served from this process. It goes into R2, and
 *     the main app streams it from there behind the admin session. That keeps
 *     ONE auth gate on the audio rather than two, keeps Render's bandwidth out
 *     of the picture, and means a song extracted anywhere is available
 *     everywhere.
 *
 * ---------------------------------------------------------------------------
 * Extraction is a background job, not a request
 * ---------------------------------------------------------------------------
 *
 * A cold pull is tens of seconds to a couple of minutes. /extract starts it and
 * answers immediately; the caller polls /status. That is what keeps the main
 * app's serverless function inside its duration limit, and it means a dropped
 * connection doesn't kill work that was nearly done.
 *
 * /detect-hook is the exception and blocks, because its answer is one number
 * rather than a file and its caller is a batch that already tolerates per-song
 * failures.
 */

// ---------------------------------------------------------------------------
// Job state
// ---------------------------------------------------------------------------

type Job =
  | { state: 'extracting'; startedAt: number }
  | { state: 'error'; kind: 'toolchain' | 'extraction'; message: string; at: number }

/// In-process, like the multiplayer room state next door, and acceptable for the
/// same reason: render.yaml pins this service to one instance. It is also only a
/// cache of "what happened recently" — the durable answer is whether the object
/// exists in R2, which status() checks first.
const jobs = new Map<string, Job>()

/// Local file paths of completed extractions, so detect-hook can reuse audio
/// this process already pulled instead of downloading it again.
const localFiles = new Map<string, string>()

/// Forget failures after this so a transient YouTube refusal doesn't pin a song
/// into a permanent error state until the next deploy.
const ERROR_TTL_MS = 5 * 60_000

function currentJob(videoId: string): Job | null {
  const job = jobs.get(videoId)
  if (!job) return null
  if (job.state === 'error' && Date.now() - job.at > ERROR_TTL_MS) {
    jobs.delete(videoId)
    return null
  }
  return job
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Bearer secret shared with the main app.
 *
 * Fails CLOSED when AUDIO_SERVICE_SECRET is unset: an unauthenticated endpoint
 * that spawns yt-dlp on demand is a free bandwidth-and-CPU faucet for anyone who
 * finds the URL, and this service's URL is not a secret. A misconfigured deploy
 * should be a broken admin screen, not an open one.
 */
function isAuthorized(req: IncomingMessage): boolean {
  const expected = process.env.AUDIO_SERVICE_SECRET
  if (!expected) return false

  const header = req.headers.authorization ?? ''
  const provided = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (provided.length === 0) return false

  // Length-independent compare: timingSafeEqual throws on a length mismatch, so
  // pad both sides into fixed-size buffers first.
  const a = Buffer.alloc(64)
  const b = Buffer.alloc(64)
  a.write(provided)
  b.write(expected)
  return timingSafeEqual(a, b)
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    // Nothing here is cacheable: it's all "what is true right now".
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

/**
 * Try to handle the request as an audio-service call.
 *
 * Returns false when the path isn't ours, so server.ts can fall through to the
 * health-check response the root path has always returned.
 */
export async function handleAudioRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (!url.pathname.startsWith('/audio/')) return false

  if (!isAuthorized(req)) {
    sendJson(res, 401, {
      state: 'error',
      kind: 'toolchain',
      message: process.env.AUDIO_SERVICE_SECRET
        ? 'Bad or missing bearer token.'
        : 'AUDIO_SERVICE_SECRET is not set on the audio service, so every request is refused.',
    })
    return true
  }

  const [, , action, videoId] = url.pathname.split('/')

  if (action === 'health') {
    sendJson(res, 200, await health())
    return true
  }

  if (!videoId || !isVideoId(videoId)) {
    sendJson(res, 400, {
      state: 'error',
      kind: 'extraction',
      message: `"${videoId ?? ''}" is not a YouTube video id.`,
    })
    return true
  }

  switch (`${req.method} ${action}`) {
    case 'GET status':
      sendJson(res, 200, await status(videoId))
      return true

    case 'POST extract':
      sendJson(res, 200, await startExtract(videoId, url.searchParams.get('force') === '1'))
      return true

    case 'POST detect-hook':
      await detectHook(videoId, res)
      return true

    default:
      sendJson(res, 404, { state: 'error', kind: 'extraction', message: 'Unknown audio endpoint.' })
      return true
  }
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

async function health() {
  const [ytdlp, ffmpeg] = await Promise.all([probeBinary('yt-dlp'), probeBinary('ffmpeg')])
  return {
    ok: ytdlp.ok && ffmpeg.ok && isStorageConfigured(),
    ytdlp,
    ffmpeg,
    storageConfigured: isStorageConfigured(),
    cookiesConfigured: Boolean(process.env.YTDLP_COOKIES_FILE),
    playerClients: process.env.YTDLP_PLAYER_CLIENTS ?? null,
    activeJobs: [...jobs.entries()].map(([videoId, job]) => ({ videoId, state: job.state })),
  }
}

async function probeBinary(name: 'yt-dlp' | 'ffmpeg') {
  const bin =
    name === 'yt-dlp' ? (process.env.YTDLP_PATH ?? 'yt-dlp') : (process.env.FFMPEG_PATH ?? 'ffmpeg')
  // ffmpeg predates the GNU convention and takes a SINGLE dash: `--version` is
  // an unrecognised option and exits non-zero, which reads as "ffmpeg is
  // missing" on a box where it is installed and fine.
  const flag = name === 'ffmpeg' ? '-version' : '--version'
  const { spawn } = await import('node:child_process')

  return new Promise<{ ok: boolean; version: string | null; path: string }>((resolve) => {
    const child = spawn(bin, [flag], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.on('error', () => resolve({ ok: false, version: null, path: bin }))
    child.on('close', (code) =>
      resolve({
        ok: code === 0,
        version: out.split('\n')[0]?.trim() ?? null,
        path: bin,
      }),
    )
  })
}

async function status(videoId: string) {
  // R2 first: an extraction that finished after the last poll, or one done on
  // somebody's laptop, both look the same from here and both mean "ready".
  const size = await objectSize(sourceAudioKey(videoId)).catch(() => null)
  if (size !== null && size > 0) return { state: 'ready' as const, byteSize: size }

  const job = currentJob(videoId)
  if (job?.state === 'extracting') return { state: 'extracting' as const }
  if (job?.state === 'error') {
    return { state: 'error' as const, kind: job.kind, message: job.message }
  }
  return { state: 'absent' as const }
}

async function startExtract(videoId: string, force: boolean) {
  if (!isStorageConfigured()) {
    return {
      state: 'error' as const,
      kind: 'toolchain' as const,
      message:
        'Object storage is not configured on the audio service (S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY). ' +
        'Without it there is nowhere to put the extracted audio.',
    }
  }

  if (!force) {
    const existing = await status(videoId)
    if (existing.state !== 'absent') return existing
  }

  const job = currentJob(videoId)
  if (job?.state === 'extracting') return { state: 'extracting' as const }

  jobs.set(videoId, { state: 'extracting', startedAt: Date.now() })

  // Deliberately not awaited — the caller gets an answer now and polls /status.
  void extractAudio(videoId)
    .then(async ({ bytes, path }) => {
      await putObject(sourceAudioKey(videoId), bytes, SOURCE_AUDIO_MIME)
      localFiles.set(videoId, path)
      jobs.delete(videoId)
      console.log(`[audio] extracted ${videoId} (${(bytes.byteLength / 1e6).toFixed(1)}MB) -> R2`)
    })
    .catch((error: unknown) => {
      const failure =
        error instanceof ExtractError
          ? { kind: error.kind, message: error.message }
          : {
              kind: 'extraction' as const,
              message: error instanceof Error ? error.message : 'Extraction failed.',
            }
      jobs.set(videoId, { state: 'error', ...failure, at: Date.now() })
      console.error(`[audio] ${videoId} failed: ${failure.message}`)
    })

  return { state: 'extracting' as const }
}

/**
 * First-audible detection. Blocks, unlike /extract — see the header note.
 *
 * Reuses a file this process already pulled when it can. On a cold song it has
 * to extract first, which is why the main app gives this call a long timeout and
 * why its caller (the list's batch "Detect") tolerates individual failures.
 */
async function detectHook(videoId: string, res: ServerResponse): Promise<void> {
  try {
    let path = localFiles.get(videoId)

    if (!path) {
      const { path: extracted, bytes } = await extractAudio(videoId)
      path = extracted
      localFiles.set(videoId, extracted)
      // Upload while we have it. Detection and the editor want the same bytes,
      // so a detect run doubles as a cache warm and the admin's later click on
      // "Set hook" opens instantly.
      if (isStorageConfigured()) {
        await putObject(sourceAudioKey(videoId), bytes, SOURCE_AUDIO_MIME).catch(
          (error: unknown) => {
            console.warn(`[audio] detect-hook extracted ${videoId} but upload failed:`, error)
          },
        )
      }
    }

    sendJson(res, 200, { hookStartMs: await detectFirstAudibleMs(path) })
  } catch (error) {
    const kind = error instanceof ExtractError ? error.kind : 'extraction'
    sendJson(res, kind === 'toolchain' ? 503 : 502, {
      kind,
      message: error instanceof Error ? error.message : 'Hook detection failed.',
    })
  }
}
