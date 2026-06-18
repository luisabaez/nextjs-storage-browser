"""
zip_builder.py
==============
Builds a ZIP archive from a list of S3 paths and uploads it to a temp
S3 location so the dashboard can hand the user a single presigned URL.

This is the server-side fix for the "browser blocks rapid-fire pop-ups"
multi-file download issue. The dashboard calls this when:
  - The selection includes any folder (the spec for what "download a
    folder" means is "give me a zip of every object under that prefix")
  - Multiple files are selected AND total size is over the size limit
    (currently 2 GB — under that we stagger individual downloads in
    the browser instead, which works for small selections)
  - The user explicitly picks "Download as Zip" from the dropdown

Implementation:
  1. Resolve each path. Anything ending in "/" is treated as a folder
     prefix and expanded to every object under it (with subfolder
     paths preserved in the zip).
  2. Stream each S3 object's body into the zipfile writer; uses
     /tmp on disk (the Lambda's /tmp is sized to 5 GB).
  3. Upload the finished zip to s3://hacienda-erp-dev/_downloads/{uuid}/
  4. Return a presigned GET URL with Content-Disposition: attachment
     so the browser saves it with the requested filename.

S3 cleanup: the bucket's _downloads/ prefix should have a lifecycle
rule auto-deleting objects after 24 hours; that keeps the temp space
from accumulating.
"""
import os
import uuid
import zipfile
from urllib.parse import quote

import boto3

# Streaming chunk size for the S3-to-zip copy. 8 MB balances throughput
# and memory — keeps the Lambda well below the 3 GB heap ceiling.
CHUNK_SIZE = 8 * 1024 * 1024

# Hard cap on how much data we'll zip in one request. Lambda /tmp is
# 5 GB; we leave headroom so the working file + the zip itself fit.
MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024  # 4 GB

# How many objects in one selection we'll process.
MAX_OBJECT_COUNT = 5000

# Where the temp zips land in the bucket.
DOWNLOAD_PREFIX = "_downloads/"

# Presigned URL TTL — generous because the client may have a slow
# connection and we don't want to time-out a 2 GB download mid-stream.
URL_TTL_SECONDS = 3600


def _list_under_prefix(s3, bucket, prefix):
    """Yield all object keys under a prefix, skipping folder markers."""
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if key.endswith("/"):
                continue
            yield key, obj.get("Size", 0)


def _resolve_paths(s3, bucket, paths):
    """
    Expand each path to a list of (s3_key, archive_name, size) tuples.

    Folder paths (ending with /) are recursed; the archive_name preserves
    everything under that prefix so the zip mirrors the bucket's layout.
    Single-file paths get their basename as the archive_name unless they
    share a parent folder, in which case the parent is preserved too.
    """
    resolved = []
    for raw in paths:
        p = raw.strip().lstrip("/")
        if not p:
            continue
        if p.endswith("/"):
            # Folder prefix — keep last segment in the archive so the
            # user sees the folder name when they open the zip.
            base = p.rstrip("/").split("/")[-1] or "root"
            for key, size in _list_under_prefix(s3, bucket, p):
                rel = key[len(p):]
                resolved.append((key, f"{base}/{rel}", size))
        else:
            # Single file — just use its name.
            resolved.append((p, p.split("/")[-1], 0))
    return resolved


def build_download_zip(s3, bucket, paths, filename=None, actor=""):
    """
    Build a zip from the supplied paths, upload to a temp S3 key, return
    a JSON-ready dict with the presigned URL.
    """
    if not paths:
        return {"ok": False, "error": "No paths supplied"}

    # 1. Resolve folders + validate count
    objects = _resolve_paths(s3, bucket, paths)
    if not objects:
        return {"ok": False, "error":
                "No files found at the supplied paths "
                "(folders may be empty)"}
    if len(objects) > MAX_OBJECT_COUNT:
        return {"ok": False, "error":
                f"Too many files in selection ({len(objects)}). "
                f"Limit is {MAX_OBJECT_COUNT}."}

    # 2. Total size check — needed so we don't blow Lambda /tmp
    # We may not know sizes for individually-selected single files yet.
    # HEAD each one to fill the size in. (Folders we got via LIST so
    # those sizes are already populated.)
    total_bytes = 0
    populated = []
    for key, arc_name, size in objects:
        if not size:
            try:
                head = s3.head_object(Bucket=bucket, Key=key)
                size = head.get("ContentLength", 0)
            except Exception as e:
                return {"ok": False, "error":
                        f"Failed to read {key}: {str(e)[:200]}"}
        total_bytes += size
        populated.append((key, arc_name, size))
        if total_bytes > MAX_TOTAL_BYTES:
            return {"ok": False, "error":
                    f"Total selection size exceeds {MAX_TOTAL_BYTES // (1024**3)} GB. "
                    f"Split the selection into smaller batches."}

    # 3. Build zip in /tmp
    download_id = str(uuid.uuid4())
    safe_name = (filename or f"download_{download_id[:8]}.zip").strip()
    if not safe_name.lower().endswith(".zip"):
        safe_name = safe_name + ".zip"
    local_zip = f"/tmp/{download_id}.zip"

    try:
        with zipfile.ZipFile(local_zip, mode="w",
                             compression=zipfile.ZIP_STORED,
                             allowZip64=True) as zf:
            for key, arc_name, _size in populated:
                # ZipFile.open(..., 'w') gives us a writeable file-like
                # object backed by the zip — perfect for streaming.
                with zf.open(arc_name, mode="w") as dest:
                    resp = s3.get_object(Bucket=bucket, Key=key)
                    body = resp["Body"]
                    while True:
                        chunk = body.read(CHUNK_SIZE)
                        if not chunk:
                            break
                        dest.write(chunk)

        # 4. Upload zip to S3 with multipart so 2 GB+ works cleanly
        output_key = f"{DOWNLOAD_PREFIX}{download_id}/{safe_name}"
        s3.upload_file(
            Filename=local_zip,
            Bucket=bucket,
            Key=output_key,
            ExtraArgs={
                "ContentType": "application/zip",
                "Metadata": {
                    "actor": actor or "dashboard",
                    "file-count": str(len(populated)),
                    "source-bytes": str(total_bytes),
                },
            },
        )

        # 5. Presigned URL with Content-Disposition so the browser
        # downloads with the user's chosen filename instead of the UUID.
        url = s3.generate_presigned_url(
            "get_object",
            Params={
                "Bucket": bucket,
                "Key": output_key,
                "ResponseContentDisposition":
                    f'attachment; filename="{quote(safe_name)}"',
                "ResponseContentType": "application/zip",
            },
            ExpiresIn=URL_TTL_SECONDS,
        )

        return {
            "ok": True,
            "download_url": url,
            "filename": safe_name,
            "file_count": len(populated),
            "total_source_bytes": total_bytes,
            "expires_in_seconds": URL_TTL_SECONDS,
            "s3_key": output_key,
        }
    finally:
        # Clean up local working file even on errors — /tmp is shared
        # with subsequent invocations of the same Lambda container.
        try:
            if os.path.exists(local_zip):
                os.remove(local_zip)
        except OSError:
            pass
