"""
app_settings.py — application configuration super users can change.

The current Mock Cycle: every screen defaults to it, so moving the whole tool
from one cycle to the next (MOCK03HCM -> MOCK04HCM, MOCK14 -> MOCK15) is one
change made on the Configuration page, not a code change.

The Recon Report Tools address: the link the HCM portal opens for the
validation team. Empty until someone sets it.

The read also tells the pages who the caller is (role, administrator,
portal-only, parties), so they can decide where that user lands.

Stored in APP_SETTINGS (one row per key) with every change appended to
APP_SETTINGS_HISTORY, in the application's own database.
"""
import re

import pyodbc

import api_util
import authz
from api_util import ApiError

ACTIONS = {"app_config_get", "app_config_set"}

DEFAULT_MOCK = "MOCK03HCM"
SOURCE_DB = "Hacienda_ERP"
# Objects whose name carries a mock cycle: a cycle is "known" when the
# conversion database has a plan, a certification list or a data cleanse log
# view for it.
_CYCLE_OBJECTS = [
    ("tables", "SETUP_CONVERSION_PLAN_MOCK%", re.compile(r"^SETUP_CONVERSION_PLAN_(MOCK\d{1,2}(?:HCM)?(?:PRE\d*)?)$", re.I)),
    ("tables", "SETUP_DATA_CLEANSE_FILE_LOCATION_MOCK%",
     re.compile(r"^SETUP_DATA_CLEANSE_FILE_LOCATION_(MOCK\d{1,2}(?:HCM)?(?:PRE\d*)?)$", re.I)),
    ("views", "%DATA_CLEANSE%MOCK%_VW",
     re.compile(r"^(?:HCM_|FSCM_)?DATA_CLEANSE_(?:BY_BU_|HCM_|FSCM_)(MOCK\d{1,2}(?:HCM)?(?:PRE\d*)?)_VW$", re.I)),
]


def _ensure_tables(cur, conn):
    cur.execute("SELECT COUNT(*) FROM sys.tables WHERE name = 'APP_SETTINGS'")
    if cur.fetchone()[0] == 0:
        cur.execute(
            "CREATE TABLE [dbo].[APP_SETTINGS] ("
            "[Setting_Key] NVARCHAR(100) NOT NULL PRIMARY KEY, [Setting_Value] NVARCHAR(500) NULL, "
            "[Updated_By] NVARCHAR(200) NULL, [Updated_DTTM] DATETIME NULL)")
    cur.execute("SELECT COUNT(*) FROM sys.tables WHERE name = 'APP_SETTINGS_HISTORY'")
    if cur.fetchone()[0] == 0:
        cur.execute(
            "CREATE TABLE [dbo].[APP_SETTINGS_HISTORY] ("
            "[ID] INT IDENTITY(1,1) PRIMARY KEY, [Setting_Key] NVARCHAR(100) NOT NULL, "
            "[Old_Value] NVARCHAR(500) NULL, [New_Value] NVARCHAR(500) NULL, "
            "[Updated_By] NVARCHAR(200) NULL, [Updated_DTTM] DATETIME NULL)")
    conn.commit()


def get_setting(cur, key, default=None):
    cur.execute("SELECT [Setting_Value], [Updated_By], [Updated_DTTM] FROM [dbo].[APP_SETTINGS] WHERE [Setting_Key] = ?", (key,))
    row = cur.fetchone()
    if not row:
        return default, None, None
    return row[0], row[1], row[2]


def set_setting(cur, key, value, actor):
    """Store one setting and append the change to the history (nothing is
    written when the value is already the stored one). Returns the old value."""
    old, _, _ = get_setting(cur, key, None)
    if (old or "") == (value or ""):
        return old
    cur.execute(
        "MERGE [dbo].[APP_SETTINGS] AS t USING (SELECT ? AS k) AS s ON t.[Setting_Key] = s.k "
        "WHEN MATCHED THEN UPDATE SET [Setting_Value] = ?, [Updated_By] = ?, [Updated_DTTM] = GETDATE() "
        "WHEN NOT MATCHED THEN INSERT ([Setting_Key], [Setting_Value], [Updated_By], [Updated_DTTM]) "
        "VALUES (?, ?, ?, GETDATE());",
        (key, value, actor, key, value, actor))
    cur.execute(
        "INSERT INTO [dbo].[APP_SETTINGS_HISTORY] ([Setting_Key], [Old_Value], [New_Value], [Updated_By], [Updated_DTTM]) "
        "VALUES (?, ?, ?, ?, GETDATE())", (key, old, value, actor))
    return old


def clean_url(value):
    """The Recon Report Tools address: empty (not set) or an https address."""
    if value is not None and not isinstance(value, str):
        raise ApiError("recon_tool_url must be text")
    url = (value or "").strip()
    if url and (len(url) > 500 or not re.fullmatch(r"https://\S+", url, re.I)):
        raise ApiError("recon_tool_url must be empty or an https:// address of at most 500 characters without spaces")
    return url


def caller(email):
    """What the pages need to know about the signed-in user. An administrator
    keeps the whole application; anyone else who holds a role is sent to the
    HCM portal and sees nothing but it."""
    email = (email or "").strip().lower()
    if not email:
        return {"role": "", "is_admin": False, "portal_only": False, "parties": []}
    perms = authz.get_permissions(email)
    role = authz.role_of(email)
    is_admin = email in authz.BOOTSTRAP_SUPER_USERS or bool(perms.get("isAdmin"))
    parties = []
    if role == authz.AGENCY_USER:
        # Stored as "SOURCE|AGENCY"; a blank agency is the source-level party.
        for party in perms.get("parties") or []:
            source, _, agency = str(party).partition("|")
            if source.strip():
                parties.append({"source": source.strip().upper(), "agency": agency.strip().upper()})
    return {"role": role, "is_admin": is_admin, "portal_only": bool(role) and not is_admin, "parties": parties}


def current_mock(conn_str):
    """The configured current Mock Cycle (DEFAULT_MOCK until someone sets it)."""
    with pyodbc.connect(conn_str) as conn:
        cur = conn.cursor()
        _ensure_tables(cur, conn)
        value, _, _ = get_setting(cur, "current_mock", DEFAULT_MOCK)
        return value or DEFAULT_MOCK


def available_mocks(cur):
    """Mock cycles the conversion database knows, newest first (HCM phase-2
    cycles and the FSCM cycles sort within their own family)."""
    found = {DEFAULT_MOCK}
    for catalog, like, pattern in _CYCLE_OBJECTS:
        cur.execute(f"SELECT name FROM [{SOURCE_DB}].sys.{catalog} WHERE name LIKE ?", (like,))
        for (name,) in cur.fetchall():
            m = pattern.match(name)
            if m:
                found.add(m.group(1).upper())

    def sort_key(tok):
        num = int(re.search(r"\d+", tok).group())
        return (0 if "HCM" in tok else 1, -num, tok)

    return sorted(found, key=sort_key)


def handle(action, event, bucket, headers, conn_str):
    def run():
        with pyodbc.connect(conn_str) as conn:
            cur = conn.cursor()
            _ensure_tables(cur, conn)
            if action == "app_config_get":
                p = api_util.params(event)
                who = caller(p.get("email"))
                # The recon tools are the validation team's: nobody else gets
                # their address, here or through the change history.
                team = who["role"] in (authz.SUPER_USER, authz.CERT_REVIEWER)
                value, by, at = get_setting(cur, "current_mock", DEFAULT_MOCK)
                recon_url, _, _ = get_setting(cur, "recon_tool_url", "")
                cur.execute(
                    "SELECT TOP 20 [Setting_Key], [Old_Value], [New_Value], [Updated_By], [Updated_DTTM] "
                    "FROM [dbo].[APP_SETTINGS_HISTORY] ORDER BY [ID] DESC")
                history = [{"key": r[0], "old": r[1], "new": r[2], "by": r[3], "at": r[4]} for r in cur.fetchall()
                           if team or r[0] != "recon_tool_url"]
                return api_util.ok(headers, {
                    "current_mock": value or DEFAULT_MOCK, "default_mock": DEFAULT_MOCK,
                    "updated_by": by, "updated_at": at,
                    "available_mocks": available_mocks(cur), "history": history,
                    "recon_tool_url": (recon_url or "") if team else "",
                    **who,
                })

            body = api_util.body(event)
            actor = (body.get("actor") or "").strip()
            authz.require(actor, what="changing the configuration")
            if "current_mock" not in body and "recon_tool_url" not in body:
                raise ApiError("Nothing to change: send current_mock, recon_tool_url or both")
            # Both values are checked before either is stored.
            changes = {}
            if "current_mock" in body:
                new_mock = api_util.mock(body.get("current_mock"))
                if new_mock not in available_mocks(cur) and not body.get("force"):
                    raise ApiError(f"{new_mock} is not a cycle {SOURCE_DB} knows yet (no plan, certification list or "
                                   f"data cleanse log view); pass force to set it anyway")
                changes["current_mock"] = new_mock
            if "recon_tool_url" in body:
                changes["recon_tool_url"] = clean_url(body.get("recon_tool_url"))
            previous = {key: set_setting(cur, key, value, actor) for key, value in changes.items()}
            conn.commit()
            result = {"current_mock": get_setting(cur, "current_mock", DEFAULT_MOCK)[0] or DEFAULT_MOCK,
                      "recon_tool_url": get_setting(cur, "recon_tool_url", "")[0] or ""}
            if "current_mock" in changes:
                result["previous"] = previous["current_mock"]
            return api_util.ok(headers, result)

    return api_util.guarded(run, headers)
