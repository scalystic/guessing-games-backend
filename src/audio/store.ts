import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

/**
 * The R2 bucket this service uploads extracted audio into.
 *
 * A deliberately minimal mirror of the main app's src/lib/storage.ts — head and
 * put, nothing else, because uploading is all this service does with storage.
 * Reads are the main app's job: the browser never talks to this service (see
 * routes.ts), so nothing here ever serves bytes.
 *
 * Same bucket and same credentials as the main app. That is the whole point of
 * the arrangement: whoever manages to extract a song — this service, or a
 * developer's laptop on a home connection — puts it here, and every environment
 * can then serve it.
 */

type StorageConfig = {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

function readConfig(): StorageConfig | null {
  const endpoint = process.env.S3_ENDPOINT
  const bucket = process.env.S3_BUCKET
  const accessKeyId = process.env.S3_ACCESS_KEY_ID
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null

  return {
    endpoint,
    region: process.env.S3_REGION ?? 'auto',
    bucket,
    accessKeyId,
    secretAccessKey,
  }
}

/// Lazily constructed and memoised. Lazy so a missing configuration is a
/// degraded audio endpoint rather than a service that won't boot — this process
/// mainly serves multiplayer sockets, which do not need storage at all.
let cached: { client: S3Client; config: StorageConfig } | null = null

function storage(): { client: S3Client; config: StorageConfig } | null {
  if (cached) return cached

  const config = readConfig()
  if (!config) return null

  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // Since v3.729 the SDK attaches a CRC32 checksum to every request and
    // validates one on every response unless told otherwise. R2 rejects the
    // unsolicited request checksums outright. Same setting, same reason, as the
    // main app's storage client.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })

  cached = { client, config }
  return cached
}

export function isStorageConfigured(): boolean {
  return readConfig() !== null
}

/// Size of a stored object, or null if it isn't there (or storage isn't set up).
export async function objectSize(key: string): Promise<number | null> {
  const store = storage()
  if (!store) return null

  try {
    const result = await store.client.send(
      new HeadObjectCommand({ Bucket: store.config.bucket, Key: key }),
    )
    return result.ContentLength ?? null
  } catch (error) {
    const name = (error as { name?: string }).name
    if (name === 'NotFound' || name === 'NoSuchKey') return null
    throw error
  }
}

export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
  const store = storage()
  if (!store) throw new Error('object storage is not configured on the audio service')

  await store.client.send(
    new PutObjectCommand({
      Bucket: store.config.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  )
}
