"""
authz.py — who may do what, checked on the server.

Roles (stored with the user's permissions by the user-approval handler, the
same store the admin screens edit):

  super_user              the validation team — configuration, rule edits,
                          every source, recon reports
  agency_user             certifies validations and files for the sources /
                          business units they are allowed
  certification_reviewer  read-only certification dashboards + status report

A user flagged isAdmin (or on the bootstrap list) is a super user. The
caller's identity is the e-mail the page sends; this is the same trust model
as the rest of the app's Lambda actions, enforced here so a page bug or a
hand-made request cannot skip the role rules.
"""
import json
import os
import time
import urllib.parse
import urllib.request

from api_util import ApiError

SUPER_USER = "super_user"
AGENCY_USER = "agency_user"
CERT_REVIEWER = "certification_reviewer"
ROLES = (SUPER_USER, AGENCY_USER, CERT_REVIEWER)

# Same bootstrap list as app/admin/types.ts ADMIN_EMAILS.
BOOTSTRAP_SUPER_USERS = {
    "mrichcreek@elitebco.com", "lbaez@elitebco.com",
    "jvelilla@elitebco.com", "flockwood@elitebco.com",
}

_PERMISSIONS_URL = os.environ.get(
    "PERMISSIONS_URL", "https://w47wliqar3ka27qsezzckqpoza0kkmbt.lambda-url.us-east-1.on.aws/")
_PERMISSIONS_TOKEN = os.environ.get("PERMISSIONS_TOKEN", "hacienda-erp-approval-2024")
_CACHE = {}
_TTL = 60  # seconds


def get_permissions(email):
    """The stored permission record for an e-mail ({} when none)."""
    email = (email or "").strip().lower()
    if not email:
        return {}
    hit = _CACHE.get(email)
    if hit and time.time() - hit[0] < _TTL:
        return hit[1]
    url = (f"{_PERMISSIONS_URL}?action=get_permissions&token={urllib.parse.quote(_PERMISSIONS_TOKEN)}"
           f"&email={urllib.parse.quote(email)}")
    perms = {}
    try:
        with urllib.request.urlopen(url, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            perms = data.get("permissions") or {}
    except Exception as e:  # noqa: BLE001 - an unreachable store means "no extra rights"
        print(f"  WARNING: permission lookup failed for {email}: {e}")
    _CACHE[email] = (time.time(), perms)
    return perms


def role_of(email):
    email = (email or "").strip().lower()
    if email in BOOTSTRAP_SUPER_USERS:
        return SUPER_USER
    perms = get_permissions(email)
    if perms.get("isAdmin"):
        return SUPER_USER
    role = (perms.get("role") or "").strip().lower()
    return role if role in ROLES else ""


def is_super_user(email):
    return role_of(email) == SUPER_USER


def require(email, *roles, what="this action"):
    """Raise 403 unless the caller holds one of `roles` (super users always pass)."""
    role = role_of(email)
    if role == SUPER_USER or role in roles:
        return role
    raise ApiError(f"{email or 'Anonymous user'} is not allowed to perform {what}", 403)


def _codes(values):
    return {str(v).strip().upper() for v in (values or []) if str(v).strip()}


def scope(email):
    """None = every source (super users / reviewers); otherwise
    (allowed sources, allowed business units) for an agency user, upper-cased."""
    role = role_of(email)
    if role in (SUPER_USER, CERT_REVIEWER):
        return None
    perms = get_permissions(email)
    return _codes(perms.get("allowedSources")), _codes(perms.get("allowedBusinessUnits"))


def can_act_on(email, *codes):
    """Whether an agency user may act on a row filed under these Source /
    Agency / BU codes. Several agencies share one source system (RHUM serves
    dozens), so a user who is limited to business units is matched on the
    business unit ALONE — their source would otherwise open every agency of
    that system. Only a user with no business-unit limit is matched by source."""
    limits = scope(email)
    if limits is None:
        return True
    sources, units = limits
    given = _codes(codes)
    if units:
        return bool(given & units)
    return bool(given & sources)
