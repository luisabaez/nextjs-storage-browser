/**
 * Large file copy helper for S3.
 *
 * The standard Amplify storage copy() uses S3 CopyObject which has a 5 GB
 * hard limit per request. For files larger than that, S3 requires multipart
 * copy (CreateMultipartUpload + UploadPartCopy + CompleteMultipartUpload).
 *
 * This module uses the aws-sdk v2 (already a project dependency) with the
 * Cognito Identity credentials Amplify provides, so it runs entirely in
 * the browser without any server-side hop.
 */

import { fetchAuthSession } from 'aws-amplify/auth';

// Single-request S3 CopyObject is capped at 5 GB. Use 4.5 GB as the
// threshold to leave a safety margin (encryption / metadata overhead).
export const SINGLE_COPY_LIMIT_BYTES = 4.5 * 1024 * 1024 * 1024;

// Multipart part size — 100 MB. Max 10,000 parts → 1 TB ceiling, plenty
// for current files (largest is ~11 GB).
const COPY_PART_SIZE = 100 * 1024 * 1024;

// Run up to 4 part copies in parallel for throughput.
const PARALLEL_PARTS = 4;

interface CopyOptions {
  bucket: string;
  region: string;
  sourceKey: string;
  destKey: string;
  fileSize: number;
  onProgress?: (partsCompleted: number, totalParts: number) => void;
}

export async function multipartCopyLargeFile(opts: CopyOptions): Promise<void> {
  const session = await fetchAuthSession();
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
  });

  // CopySource format: /bucket/key (with URL-encoded key, but slashes preserved)
  const copySource = `/${opts.bucket}/${opts.sourceKey
    .split('/')
    .map(seg => encodeURIComponent(seg))
    .join('/')}`;

  // Initiate multipart upload
  const createResp = await s3
    .createMultipartUpload({ Bucket: opts.bucket, Key: opts.destKey })
    .promise();
  const uploadId = createResp.UploadId;
  if (!uploadId) throw new Error('Failed to initiate multipart upload');

  const totalParts = Math.ceil(opts.fileSize / COPY_PART_SIZE);
  const parts: { ETag: string; PartNumber: number }[] = [];
  let completed = 0;

  try {
    // Process parts in parallel batches
    for (let batchStart = 0; batchStart < totalParts; batchStart += PARALLEL_PARTS) {
      const batchEnd = Math.min(batchStart + PARALLEL_PARTS, totalParts);
      const batch: Promise<void>[] = [];

      for (let i = batchStart; i < batchEnd; i++) {
        const partNum = i + 1;
        const start = i * COPY_PART_SIZE;
        const end = Math.min(start + COPY_PART_SIZE - 1, opts.fileSize - 1);

        batch.push(
          s3
            .uploadPartCopy({
              Bucket: opts.bucket,
              Key: opts.destKey,
              CopySource: copySource,
              PartNumber: partNum,
              UploadId: uploadId,
              CopySourceRange: `bytes=${start}-${end}`,
            })
            .promise()
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .then((res: any) => {
              const etag = res.CopyPartResult?.ETag;
              if (!etag) throw new Error(`Part ${partNum} missing ETag`);
              parts.push({ ETag: etag, PartNumber: partNum });
              completed++;
              opts.onProgress?.(completed, totalParts);
            })
        );
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
    // Best-effort abort to avoid leaving incomplete uploads (they cost money)
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
