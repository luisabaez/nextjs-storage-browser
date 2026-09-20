"""
app_settings.py — application configuration super users can change.

Today: the current Mock Cycle. Every screen defaults to it, so moving the
whole tool from one cycle to the next (MOCK03HCM -> MOCK04HCM, MOCK14 ->
MOCK15) is one change made on the Configuration page, not a code change.

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
                value, by, at = get_setting(cur, "current_mock", DEFAULT_MOCK)
                cur.execute(
                    "SELECT TOP 20 [Setting_Key], [Old_Value], [New_Value], [Updated_By], [Updated_DTTM] "
                    "FROM [dbo].[APP_SETTINGS_HISTORY] ORDER BY [ID] DESC")
                history = [{"key": r[0], "old": r[1], "new": r[2], "by": r[3], "at": r[4]} for r in cur.fetchall()]
                email = p.get("email") or ""
                return api_util.ok(headers, {
                    "current_mock": value or DEFAULT_MOCK, "default_mock": DEFAULT_MOCK,
                    "updated_by": by, "updated_at": at,
                    "available_mocks": available_mocks(cur), "history": history,
                    "role": authz.role_of(email) if email else "",
                })

            body = api_util.body(event)
            actor = (body.get("actor") or "").strip()
            authz.require(actor, what="changing the configuration")
            new_mock = api_util.mock(body.get("current_mock"))
            if new_mock not in available_mocks(cur) and not body.get("force"):
                raise ApiError(f"{new_mock} is not a cycle {SOURCE_DB} knows yet (no plan, certification list or "
                               f"data cleanse log view); pass force to set it anyway")
            old, _, _ = get_setting(cur, "current_mock", None)
            cur.execute(
                "MERGE [dbo].[APP_SETTINGS] AS t USING (SELECT ? AS k) AS s ON t.[Setting_Key] = s.k "
                "WHEN MATCHED THEN UPDATE SET [Setting_Value] = ?, [Updated_By] = ?, [Updated_DTTM] = GETDATE() "
                "WHEN NOT MATCHED THEN INSERT ([Setting_Key], [Setting_Value], [Updated_By], [Updated_DTTM]) "
                "VALUES (?, ?, ?, GETDATE());",
                ("current_mock", new_mock, actor, "current_mock", new_mock, actor))
            cur.execute(
                "INSERT INTO [dbo].[APP_SETTINGS_HISTORY] ([Setting_Key], [Old_Value], [New_Value], [Updated_By], [Updated_DTTM]) "
                "VALUES (?, ?, ?, ?, GETDATE())", ("current_mock", old, new_mock, actor))
            conn.commit()
            return api_util.ok(headers, {"current_mock": new_mock, "previous": old})

    return api_util.guarded(run, headers)
