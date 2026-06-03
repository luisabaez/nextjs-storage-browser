/**
 * Large file upload helper for S3.
 *
 * Amplify's uploadData() handles multipart internally but becomes unreliable
 * when uploading batches of multi-GB files: it holds onto connection/memory
 * state between calls, and Cognito credentials can expire during long batch
 * runs. The result is that the first file uploads but the rest silently fail.
 *
 * This module drives multipart upload directly via aws-sdk v2 using the
 * Cognito Identity credentials Amplify provides. It runs entirely in the
 * browser with parallel parts, per-part retries, and proper abort cleanup,
 * mirroring the largeCopy.ts approach.
 */

import { fetchAuthSession } from 'aws-amplify/auth';

// Files at or above this size use the direct multipart path. Anything smaller
// goes through the simpler Amplify uploadData() — Amplify is fine for small
// files; it's only large/batched uploads where it falls over.
export const MULTIPART_UPLOAD_THRESHOLD_BYTES = 100 * 1024 * 1024; // 100 MB

// Multipart part size — 100 MB. Max 10,000 parts → 1 TB ceiling. For a
// 20 GB file that's 200 parts, well within limits.
const UPLOAD_PART_SIZE = 100 * 1024 * 1024;

// Upload up to 4 parts in parallel for throughput. Higher numbers can saturate
// the browser's per-origin connection budget (typically 6).
const PARALLEL_PARTS = 4;

// Retry settings for individual part uploads.
const PART_MAX_ATTEMPTS = 4;
const PART_RETRY_BASE_DELAY_MS = 1000;

interface UploadOptions {
  bucket: string;
  region: string;
  file: File;
  destKey: string;
  onProgress?: (bytesUploaded: number, totalBytes: number) => void;
  signal?: AbortSignal;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function multipartUploadLargeFile(opts: UploadOptions): Promise<void> {
  // Pull fresh credentials at the start of each file so a long-running batch
  // doesn't carry stale credentials across hours of uploads.
  const session = await fetchAuthSession({ forceRefresh: false });
  const credentials = session.credentials;
  if (!credentials) {
    throw new Error('No AWS credentials available — please re-sign in.');
  }

  // Lazy-import aws-sdk so it doesn't bloat the initial bundle.
  const AWSModule = await import('aws-sdk');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const AWS: any = (AWSModule as any).default || AWSModule;

  const s3 = new AWS.S3({
    region: opts.region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
    // Keep timeouts generous — single parts can take minutes on slow links.
    httpOptions: {
      timeout: 15 * 60 * 1000, // 15 minutes per request
      connectTimeout: 60 * 1000, // 1 minute
    },
    maxRetries: 3,
  });

  const fileSize = opts.file.size;
  const totalParts = Math.ceil(fileSize / UPLOAD_PART_SIZE);

  // Initiate multipart upload
  const createResp = await s3
    .createMultipartUpload({
      Bucket: opts.bucket,
      Key: opts.destKey,
      ContentType: opts.file.type || 'application/octet-stream',
    })
    .promise();
  const uploadId = createResp.UploadId;
  if (!uploadId) throw new Error('Failed to initiate multipart upload');

  const parts: { ETag: string; PartNumber: number }[] = [];
  // Track bytes uploaded per part so the progress callback is monotonic
  // even when parts complete out of order.
  const bytesPerPart = new Array<number>(totalParts).fill(0);

  const reportProgress = () => {
    if (!opts.onProgress) return;
    let total = 0;
    for (const b of bytesPerPart) total += b;
    opts.onProgress(total, fileSize);
  };

  const uploadOnePart = async (partIndex: number): Promise<void> => {
    if (opts.signal?.aborted) throw new Error('Upload aborted');

    const partNum = partIndex + 1;
    const start = partIndex * UPLOAD_PART_SIZE;
    const end = Math.min(start + UPLOAD_PART_SIZE, fileSize);
    const partSize = end - start;
    // Slicing the File gives us a Blob view backed by disk — no full-file
    // buffer in memory.
    const blob = opts.file.slice(start, end);

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt++;
      try {
        const resp = await s3
          .uploadPart({
            Bucket: opts.bucket,
            Key: opts.destKey,
            PartNumber: partNum,
            UploadId: uploadId,
            Body: blob,
            ContentLength: partSize,
          })
          .promise();

        const etag = resp.ETag;
        if (!etag) throw new Error(`Part ${partNum} missing ETag`);
        parts.push({ ETag: etag, PartNumber: partNum });
        bytesPerPart[partIndex] = partSize;
        reportProgress();
        return;
      } catch (err) {
        if (attempt >= PART_MAX_ATTEMPTS) {
          throw new Error(
            `Part ${partNum} failed after ${attempt} attempts: ${(err as Error)?.message || err}`
          );
        }
        // Exponential backoff with jitter
        const delay =
          PART_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 250);
        await sleep(delay);
      }
    }
  };

  try {
    // Process parts in parallel batches of PARALLEL_PARTS
    for (let batchStart = 0; batchStart < totalParts; batchStart += PARALLEL_PARTS) {
      if (opts.signal?.aborted) throw new Error('Upload aborted');
      const batchEnd = Math.min(batchStart + PARALLEL_PARTS, totalParts);
      const batch: Promise<void>[] = [];
      for (let i = batchStart; i < batchEnd; i++) {
        batch.push(uploadOnePart(i));
      }
      await Promise.all(batch);
    }

    // Parts must be sorted by PartNumber for CompleteMultipartUpload
    parts.sort((a, b) => a.PartNumber - b.PartNumber);

    await s3
      .completeMultipartUpload({
        Bucket: opts.bucket,
        Key: opts.destKey,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      })
      .promise();
  } catch (err) {
    // Best-effort abort to avoid leaving incomplete uploads (they cost money
    // and accumulate as orphaned data in the bucket).
    try {
      await s3
        .abortMultipartUpload({
          Bucket: opts.bucket,
          Key: opts.destKey,
          UploadId: uploadId,
        })
        .promise();
    } catch {
      // Swallow abort errors
    }
    throw err;
  }
}
