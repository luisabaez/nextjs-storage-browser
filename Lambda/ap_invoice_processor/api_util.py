"""Small helpers shared by the feature modules that plug into lambda_handler.

A feature module exposes ACTIONS (a set of action names) and
handle(action, event, bucket, headers, conn_str) -> Lambda response dict.
"""
import json
import re
import traceback

_IDENT = re.compile(r"^[A-Za-z0-9_]+$")
# MOCK14, MOCK13PRE, MOCK14PRE2, MOCK03HCM, MOCK05HCMPRE
_MOCK = re.compile(r"^MOCK\d{1,2}(HCM)?(PRE\d*)?$")


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def params(event):
    return event.get("queryStringParameters") or {}


def body(event):
    raw = event.get("body")
    if not raw:
        return {}
    if event.get("isBase64Encoded"):
        import base64
        raw = base64.b64decode(raw).decode("utf-8")
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        raise ApiError("Request body is not valid JSON")
    if not isinstance(data, dict):
        raise ApiError("Request body must be a JSON object")
    return data


def ok(headers, data=None, status=200):
    payload = {"ok": True}
    payload.update(data or {})
    return {"statusCode": status, "headers": headers, "body": json.dumps(payload, default=str)}


def fail(headers, message, status=400):
    return {"statusCode": status, "headers": headers,
            "body": json.dumps({"ok": False, "error": str(message)})}


def ident(value, what="identifier"):
    value = (value or "").strip()
    if not _IDENT.match(value):
        raise ApiError(f"Invalid {what}: {value!r}")
    return value


def mock(value):
    """A mock-cycle token, upper-cased and validated (it is spliced into table
    and view names, so nothing but the known shapes is accepted)."""
    value = (value or "").strip().upper()
    if not _MOCK.match(value):
        raise ApiError(f"Invalid mock cycle: {value!r}")
    return value


def is_hcm_mock(mock_token):
    """Phase-2 HCM mock cycles are named MOCKnnHCM[PRE]."""
    return "HCM" in (mock_token or "").upper()


# Generated workbooks and certification attachments carry agency- and
# person-level data. They live under a root that the browser's storage rights
# do NOT cover, so the only way to one is a link this service signs after
# checking the caller's role.
PRIVATE_ROOT = "SymphonyPrivate"

_XML_ILLEGAL = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f]")


def xlsx_value(ws, value):
    """A value safe to append to an openpyxl sheet: control characters the XML
    cannot hold are dropped, and text that starts with '=' is written as TEXT
    (a text cell), never as a live formula."""
    if not isinstance(value, str):
        return value
    value = _XML_ILLEGAL.sub("", value)
    if value.startswith("="):
        from openpyxl.cell import WriteOnlyCell
        cell = WriteOnlyCell(ws, value=value)
        cell.data_type = "s"
        return cell
    return value


def safe_segment(value, fallback="item"):
    """A string safe to use as one S3 key segment."""
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value or "")).strip("._")
    return cleaned[:120] or fallback


def _s3():
    import boto3
    from botocore.config import Config
    return boto3.client("s3", region_name="us-east-1",
                        config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}))


def presign_get(bucket, key, file_name=None, expires=900):
    """Time-limited download link. The browser never needs storage rights of
    its own, so the server decides who may fetch what."""
    p = {"Bucket": bucket, "Key": key}
    if file_name:
        p["ResponseContentDisposition"] = f'attachment; filename="{safe_segment(file_name)}"'
    return _s3().generate_presigned_url("get_object", Params=p, ExpiresIn=expires)


def presign_put(bucket, key, content_type="application/octet-stream", expires=900):
    """Time-limited upload link (the browser PUTs the file with this exact
    Content-Type header)."""
    return _s3().generate_presigned_url(
        "put_object", Params={"Bucket": bucket, "Key": key, "ContentType": content_type}, ExpiresIn=expires)


def object_size(bucket, key):
    """Size in bytes, or None when the object does not exist."""
    try:
        return _s3().head_object(Bucket=bucket, Key=key)["ContentLength"]
    except Exception:  # noqa: BLE001
        return None


def guarded(fn, headers):
    """Run a handler body; ApiError -> its status, anything else -> 500."""
    try:
        return fn()
    except ApiError as e:
        return fail(headers, str(e), e.status)
    except Exception as e:  # noqa: BLE001 - surfaced to the caller as a 500
        traceback.print_exc()
        return fail(headers, str(e), 500)
