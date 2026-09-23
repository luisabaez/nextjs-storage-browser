"""
certifications.py — agencies certify the files published to them, commit to the
path forward of the validations reported to them, and sign off the cycle.

What must be certified comes from the validation team's own setup table,
SETUP_DATA_CLEANSE_FILE_LOCATION_<MOCK> WHERE CertificationRequired = 'Y'. One
row is one expected certification: Module + File Type + Entity of a party. The
party is always Source + Agency, never the agency alone (RHUM serves dozens of
agencies); a row with no Agency is certified at source level. BU is shown to
the user and never part of the key.

A certification answers with one of the three comments of the team's form
(RESPONSES). The "issues" answer needs every issue reported separately, each
with its own supporting document. When every expected record is certified and
every reported validation has a commitment, the party signs off once; after
that its records are locked until a super user revokes the sign-off.

Validations reported to a party come from the Data Cleanse Log
(LOG_DATA_CLEANSE_DETAIL counted by Validation_Code / Source / BU) for the
rules the catalog marks AgencyReports = 'Y' (a party with an agency) or
Sourcereports = 'Y' (a source-level party). Only counts are read from the log;
no record-level column is ever selected.

Everything is stored in the application's own tables (history is kept: a
re-certification retires the previous row and inserts a new one):

  DATA_CLEANSE_CERT_FILE        one expected record: response, agency resource,
                                notes, certified by
  DATA_CLEANSE_CERT_ISSUE       issues reported on a record
  DATA_CLEANSE_CERT_VALIDATION  commitment to a validation's path forward:
                                reviewed, target date, notes
  DATA_CLEANSE_CERT_SIGNOFF     the party's final signature for the cycle
  DATA_CLEANSE_CERT_ATTACHMENT  documents attached to a record, a validation
                                or an issue

Roles: an agency user acts only for their own parties; a certification
reviewer reads everything and generates the status report; a super user does
everything, including revoking.
"""
import io
import json
import re
import time
import uuid
from datetime import datetime

import pyodbc

import api_util
import authz
import validation_seed
from api_util import ApiError

ACTIONS = {
    "cert_expected", "cert_validations", "cert_issues", "cert_records", "cert_certify_validation",
    "cert_certify_file", "cert_issue_save", "cert_issue_delete", "cert_signoff",
    "cert_upload_url", "cert_attachment_add", "cert_attachments", "cert_download_url",
    "cert_attachment_delete", "cert_status", "cert_status_report", "cert_revoke", "cert_validation_rows",
}

DB = validation_seed.TARGET_DB
SOURCE = validation_seed.SOURCE_DB

LOCATION_PREFIX = "SETUP_DATA_CLEANSE_FILE_LOCATION_"
LOG_TABLE = "LOG_DATA_CLEANSE_DETAIL"
CATALOG_TABLE = "SETUP_ERROR_MESSAGES_SOURCE"
T_VALIDATION = "DATA_CLEANSE_CERT_VALIDATION"
T_FILE = "DATA_CLEANSE_CERT_FILE"
T_ISSUE = "DATA_CLEANSE_CERT_ISSUE"
T_SIGNOFF = "DATA_CLEANSE_CERT_SIGNOFF"
T_ATTACHMENT = "DATA_CLEANSE_CERT_ATTACHMENT"

# Private root: not reachable with the browser's storage rights, only through
# links this module signs after the role check.
ATTACHMENT_PREFIX = f"{api_util.PRIVATE_ROOT}/Certifications"
REPORT_PREFIX = f"{api_util.PRIVATE_ROOT}/Reports"
MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
MAX_KEY_LENGTH = 600
MAX_ISSUE_LENGTH = 4000
CERT_TYPES = ("FILE", "VALIDATION", "ISSUE")
REVOKE_TYPES = ("FILE", "VALIDATION", "SIGNOFF")

# The comments of the team's certification form, word for word from the user
# guide. Which ones a record offers depends on its file type (responses_for).
RESPONSES = {
    "NO_ERRORS": "Se verificó la data y no contiene errores.",
    "AGREE": ("Estoy de acuerdo con los errores presentados y se estarán corrigiendo los mismos, de lo contrario "
              "las transacciones asociadas a estos errores se convertirán en error."),
    "NO_EXCLUSIONS": "Se verificó la data y no contiene exclusiones.",
    "AGREE_EXCLUSIONS": ("Se confirma que el usuario está de acuerdo con la exclusión de los datos y que se tomará "
                         "acción para que aquellos récords que deben ser convertidos se realicen las correcciones "
                         "aplicables a los sistemas de origen."),
    "ISSUES": ("Se verificó la data y la misma está parcial o completamente incorrecta. Se incluye un anejo con "
               "documentación de soporte."),
}


def responses_for(file_type):
    """The response codes a record's file type offers: recon reports ask about
    exclusions, converted files only whether the data is right, validations
    the three comments of the form."""
    kind = _s(file_type).upper()
    if "RECON" in kind:
        return ("NO_EXCLUSIONS", "AGREE_EXCLUSIONS", "ISSUES")
    if "CONVERTED" in kind:
        return ("NO_ERRORS", "ISSUES")
    return ("NO_ERRORS", "AGREE", "ISSUES")
SIGNOFF_STATEMENT = ("Certifico que la agencia completó la revisión de todos los archivos y validaciones del ciclo "
                     "{mock} y que las respuestas registradas representan la posición oficial de la agencia.")

# Cycles outside the usual MOCKnn[HCM][PRE] shape that have a setup table.
_EXTRA_MOCKS = ("MOCK14DV",)
_LOCATION = re.compile(r"^SETUP_DATA_CLEANSE_FILE_LOCATION_(MOCK\d{1,2}(HCM)?(PRE\d*)?|MOCK14DV)$", re.I)

_REVOKE_DDL = "[Revoked_By] NVARCHAR(200) NULL, [Revoked_DTTM] DATETIME NULL, [Revoke_Reason] NVARCHAR(MAX) NULL"
_DDL = {
    T_VALIDATION: (
        "[ID] INT IDENTITY(1,1) PRIMARY KEY, [MOCK] VARCHAR(20) NOT NULL, [Source] VARCHAR(50) NOT NULL, "
        "[Agency] VARCHAR(100) NOT NULL, [BU] VARCHAR(100) NOT NULL, [Validation_Code] NVARCHAR(50) NOT NULL, "
        "[Path_Forward] NVARCHAR(MAX) NULL, [Notes] NVARCHAR(MAX) NULL, [Error_Count] INT NULL, "
        "[Certified_By] NVARCHAR(200) NULL, [Certified_DTTM] DATETIME NULL, "
        f"[Is_Current] BIT NOT NULL DEFAULT 1, {_REVOKE_DDL}, [Reviewed] BIT NULL, [Target_Date] DATE NULL"),
    T_FILE: (
        "[ID] INT IDENTITY(1,1) PRIMARY KEY, [MOCK] VARCHAR(20) NOT NULL, [Source] VARCHAR(50) NOT NULL, "
        "[Agency] VARCHAR(100) NOT NULL, [BU] VARCHAR(100) NOT NULL, [Entity] VARCHAR(50) NOT NULL, "
        "[File_Type] VARCHAR(30) NOT NULL, [Notes] NVARCHAR(MAX) NULL, "
        "[Certified_By] NVARCHAR(200) NULL, [Certified_DTTM] DATETIME NULL, "
        f"[Is_Current] BIT NOT NULL DEFAULT 1, {_REVOKE_DDL}, [Module] VARCHAR(50) NULL, "
        "[Response_Code] VARCHAR(20) NULL, [Resource_Name] NVARCHAR(200) NULL"),
    T_ISSUE: (
        "[ID] INT IDENTITY(1,1) PRIMARY KEY, [MOCK] VARCHAR(20) NOT NULL, [Source] VARCHAR(50) NOT NULL, "
        "[Agency] VARCHAR(100) NOT NULL, [Module] VARCHAR(50) NOT NULL, [File_Type] VARCHAR(30) NOT NULL, "
        "[Entity] VARCHAR(50) NOT NULL, [Description] NVARCHAR(MAX) NOT NULL, "
        "[Reported_By] NVARCHAR(200) NULL, [Reported_DTTM] DATETIME NULL, [Deleted] BIT NOT NULL DEFAULT 0"),
    T_SIGNOFF: (
        "[ID] INT IDENTITY(1,1) PRIMARY KEY, [MOCK] VARCHAR(20) NOT NULL, [Source] VARCHAR(50) NOT NULL, "
        "[Agency] VARCHAR(100) NOT NULL, [Signer_Name] NVARCHAR(200) NOT NULL, [Signer_Title] NVARCHAR(200) NOT NULL, "
        "[Signed_By] NVARCHAR(200) NULL, [Signed_DTTM] DATETIME NULL, [Statement] NVARCHAR(MAX) NULL, "
        f"[Is_Current] BIT NOT NULL DEFAULT 1, {_REVOKE_DDL}"),
    T_ATTACHMENT: (
        "[ID] INT IDENTITY(1,1) PRIMARY KEY, [MOCK] VARCHAR(20) NOT NULL, [Source] VARCHAR(50) NOT NULL, "
        "[Agency] VARCHAR(100) NOT NULL, [BU] VARCHAR(100) NOT NULL, [Cert_Type] VARCHAR(20) NOT NULL, "
        "[Cert_Key] NVARCHAR(200) NOT NULL, [File_Name] NVARCHAR(300) NOT NULL, [S3_Key] NVARCHAR(600) NOT NULL, "
        "[Size_Bytes] BIGINT NULL, [Uploaded_By] NVARCHAR(200) NULL, [Uploaded_DTTM] DATETIME NULL, "
        "[Deleted] BIT NOT NULL DEFAULT 0"),
}


# ── small pure helpers ───────────────────────────────────────────────────────

def _s(value):
    return str(value if value is not None else "").strip()


def _k(*parts):
    """Case- and padding-insensitive key for matching rows across tables."""
    return tuple(_s(p).upper() for p in parts)


def _mock(value):
    token = _s(value).upper()
    return token if token in _EXTRA_MOCKS else api_util.mock(value)


def party_name(source, agency):
    """The certifying party as shown: the Agency, or the Source when there is none."""
    return _s(agency) or _s(source)


# A certification stored before the module was part of the record.
_ANY_MODULE = "*"


def record_key(source, agency, module, file_type, entity):
    """One expected certification of a cycle."""
    return authz.party_key(source, agency) + _k(module, file_type, entity)


def _row_key(r):
    return record_key(r["source"], r["agency"], r["module"], r["file_type"], r["entity"])


def file_cert_key(entity, file_type):
    return f"{_s(entity)}|{_s(file_type)}"


def party_prefix(mock, source, agency, bu):
    """S3 folder that holds one party's certification documents."""
    seg = "_".join([api_util.safe_segment(source, "NA"), api_util.safe_segment(agency or "NA", "NA"),
                    api_util.safe_segment(bu or "NA", "NA")])
    return f"{ATTACHMENT_PREFIX}/{mock}/{seg}/"


def cert_prefix(mock, source, agency, bu, cert_type, cert_key):
    return f"{party_prefix(mock, source, agency, bu)}{cert_type}/{api_util.safe_segment(cert_key)}/"


def attachment_key(mock, source, agency, bu, cert_type, cert_key, file_name, when=None):
    when = when or datetime.now()
    return (cert_prefix(mock, source, agency, bu, cert_type, cert_key)
            + f"{when.strftime('%Y%m%d-%H%M%S')}_{api_util.safe_segment(file_name, 'file')}")


def report_key(mock, when=None):
    when = when or datetime.now()
    name = f"Certification_Status_{mock}_{when.strftime('%Y.%m.%d-%H.%M.%S')}.xlsx"
    # The object name is unique per request: a report is filtered to its
    # caller, so two requests must never share (and overwrite) one key.
    return f"{REPORT_PREFIX}/{mock}/Certification/{name[:-5]}_{uuid.uuid4().hex[:8]}.xlsx", name


def sort_mocks(tokens):
    """HCM phase-2 cycles first, newest first within each family."""
    def key(tok):
        return (0 if "HCM" in tok else 1, -int(re.search(r"\d+", tok).group()), tok)
    return sorted(set(tokens), key=key)


def validations_for(reported, catalog, source, agency):
    """{code: count} of what the log reports to one party. A party with an
    agency gets the rules reported to agencies, counted over the BUs that
    start with its agency number; a source-level party gets the rules
    reported to sources, over the whole source."""
    source, number = authz.party_key(source, agency)
    flag = "to_agency" if number else "to_source"
    out = {}
    for log_bu, codes in reported.get(source, {}).items():
        if number and log_bu != number:
            continue
        for code, n in codes.items():
            if catalog.get(code.upper(), {}).get(flag):
                out[code] = out.get(code, 0) + n
    return out


def status_of(done, total):
    if total and done >= total:
        return "Complete"
    return "In progress" if done else "Not started"


def portal_status(signed, done, total):
    """The party's progress as the portal words it."""
    if signed:
        return "Signed off"
    status = status_of(done, total)
    return "Ready to sign" if status == "Complete" else status


def _pct(done, total):
    return round(100.0 * done / total, 1) if total else 0.0


def _flag(value):
    return value is True or _s(value).lower() in ("true", "1", "y", "yes")


def _date(value, label):
    text = _s(value)
    if not text:
        return None
    try:
        return datetime.strptime(text[:10], "%Y-%m-%d").date()
    except ValueError:
        raise ApiError(f"{label} must be a date (YYYY-MM-DD)")


def _id(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        raise ApiError("id must be a number")


# ── database helpers ─────────────────────────────────────────────────────────

def _existing(cur, db, names):
    marks = ", ".join("?" for _ in names)
    cur.execute(f"SELECT name FROM [{db}].sys.objects WHERE name IN ({marks})", tuple(names))
    return {r[0].upper() for r in cur.fetchall()}


def _columns(cur, table):
    cur.execute(f"SELECT COLUMN_NAME FROM [{DB}].INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ?", (table,))
    return {r[0].upper() for r in cur.fetchall()}


_REVOKE_COLUMNS = (("Revoked_By", "NVARCHAR(200)"), ("Revoked_DTTM", "DATETIME"), ("Revoke_Reason", "NVARCHAR(MAX)"))
# Columns added after the tables first went out.
_ADDED_COLUMNS = {
    T_VALIDATION: _REVOKE_COLUMNS + (("Reviewed", "BIT"), ("Target_Date", "DATE")),
    T_FILE: _REVOKE_COLUMNS + (("Module", "VARCHAR(50)"), ("Response_Code", "VARCHAR(20)"),
                               ("Resource_Name", "NVARCHAR(200)")),
}
_TABLES_READY = False


def _ensure_tables(cur, conn):
    """Create the certification tables on first use (once per container) and
    add the newer columns to tables created before they existed."""
    global _TABLES_READY
    if _TABLES_READY:
        return
    have = _existing(cur, DB, list(_DDL))
    for name, ddl in _DDL.items():
        if name.upper() not in have:
            cur.execute(f"CREATE TABLE [{DB}].dbo.[{name}] ({ddl})")
    for table, added in _ADDED_COLUMNS.items():
        cols = _columns(cur, table)
        for col, sql_type in added:
            if col.upper() not in cols:
                cur.execute(f"ALTER TABLE [{DB}].dbo.[{table}] ADD [{col}] {sql_type} NULL")
    conn.commit()
    _TABLES_READY = True


def _ensure_team_objects(conn, cur, names, warnings):
    """Names (upper-cased) that exist in the application database. In a test
    database a missing one is cloned from the definitions of record; in
    production the team's objects are never created here."""
    have = _existing(cur, DB, names)
    missing = [n for n in names if n.upper() not in have]
    if not missing or not validation_seed.is_test_target():
        return have
    try:
        seeder = validation_seed.Seeder(conn)
        for name in missing:
            seeder.ensure(name)
        warnings.extend(f"Could not prepare {msg}" for msg in seeder.report["failed"])
    except Exception as e:  # noqa: BLE001 - reported to the caller as a warning
        conn.rollback()
        warnings.append(f"Could not prepare {', '.join(missing)} in {DB}: {str(e)[:200]}")
    return _existing(cur, DB, names)


def mocks_with_table(cur):
    cur.execute(f"SELECT name FROM [{SOURCE}].sys.tables WHERE name LIKE '{LOCATION_PREFIX}MOCK%'")
    return sort_mocks(m.group(1).upper() for m in (_LOCATION.match(r[0]) for r in cur.fetchall()) if m)


def _location_table(conn, cur, mock, warnings):
    """((table name, its column names), None) when the cycle has certifications
    set up, otherwise (None, payload for a friendly 'not available' answer)."""
    table = f"{LOCATION_PREFIX}{mock}"
    cycles = mocks_with_table(cur)
    if table.upper() in _existing(cur, DB, [table]) or (
            mock in cycles and table.upper() in _ensure_team_objects(conn, cur, [table], warnings)):
        have = _columns(cur, table)
        if "CERTIFICATIONREQUIRED" in have:
            return (table, have), None
        message = f"{table} has no CertificationRequired column, so nothing can be certified for {mock}."
    else:
        message = (f"Certifications are not set up for {mock} yet: {table} does not exist. "
                   "The validation team creates it when the cycle's expected files are defined.")
    return None, {"available": False, "mock": mock, "db": DB, "message": message,
                  "mocks_with_table": cycles, "warnings": warnings}


_LOCATION_COLUMNS = ["Pillar", "Source", "Agency", "BU", "File_Type", "Entity", "MODULE", "File_Path", "Response",
                     "CertificationApplicable"]


def _required_rows(cur, location):
    """Rows of the setup table that require a certification, one per record."""
    table, have = location
    select = ", ".join(f"[{c}]" if c.upper() in have else f"NULL AS [{c}]" for c in _LOCATION_COLUMNS)
    cur.execute(
        f"SELECT {select} FROM [{DB}].dbo.[{table}] "
        "WHERE UPPER(LTRIM(RTRIM(ISNULL([CertificationRequired], '')))) = 'Y'")
    rows, seen = [], set()
    for r in cur.fetchall():
        row = {"pillar": _s(r[0]), "source": _s(r[1]), "agency": _s(r[2]), "bu": _s(r[3]),
               "file_type": _s(r[4]), "entity": _s(r[5]), "module": _s(r[6]), "file_path": _s(r[7]),
               "response": _s(r[8]), "certification_applicable": _s(r[9])}
        if _row_key(row) not in seen:
            seen.add(_row_key(row))
            rows.append(row)
    rows.sort(key=lambda r: _k(party_name(r["source"], r["agency"]), r["source"], r["module"], r["file_type"],
                               r["entity"]))
    return rows


def _parties(rows):
    """The parties of these rows; BU is the first one the setup table gives."""
    out = {}
    for r in rows:
        p = out.setdefault(authz.party_key(r["source"], r["agency"]), {
            "source": r["source"], "agency": r["agency"], "bu": r["bu"],
            "party": party_name(r["source"], r["agency"])})
        p["bu"] = p["bu"] or r["bu"]
    return sorted(out.values(), key=lambda p: (p["party"].upper(), p["source"].upper()))


def _file_certs(cur, mock):
    """Current file certifications by record key. A row stored without a
    module answers for any module of its file type + entity."""
    cur.execute(
        f"SELECT [Source], [Agency], [Module], [File_Type], [Entity], [Response_Code], [Resource_Name], [Notes], "
        f"[Certified_By], [Certified_DTTM] FROM [{DB}].dbo.[{T_FILE}] WHERE [MOCK] = ? AND [Is_Current] = 1 "
        "ORDER BY [ID]", (mock,))
    return {record_key(r[0], r[1], _ANY_MODULE if r[2] is None else r[2], r[3], r[4]): {
        "response_code": r[5], "resource_name": r[6], "notes": r[7], "certified_by": r[8], "certified_at": r[9]}
        for r in cur.fetchall()}


def _cert_of(certs, r):
    return certs.get(_row_key(r)) or certs.get(
        record_key(r["source"], r["agency"], _ANY_MODULE, r["file_type"], r["entity"]))


def _validation_certs(cur, mock):
    cur.execute(
        f"SELECT [Source], [Agency], [Validation_Code], [Path_Forward], [Notes], [Error_Count], [Reviewed], "
        f"[Target_Date], [Certified_By], [Certified_DTTM] FROM [{DB}].dbo.[{T_VALIDATION}] "
        "WHERE [MOCK] = ? AND [Is_Current] = 1 ORDER BY [ID]", (mock,))
    return {authz.party_key(r[0], r[1]) + _k(r[2]): {
        "committed_path_forward": r[3], "notes": r[4], "committed_count": r[5], "reviewed": bool(r[6]),
        "target_date": r[7], "committed_by": r[8], "committed_at": r[9]} for r in cur.fetchall()}


def _attachment_counts(cur, mock):
    cur.execute(
        f"SELECT [Source], [Agency], [Cert_Type], [Cert_Key], COUNT(*) FROM [{DB}].dbo.[{T_ATTACHMENT}] "
        "WHERE [MOCK] = ? AND [Deleted] = 0 GROUP BY [Source], [Agency], [Cert_Type], [Cert_Key]", (mock,))
    counts = {}
    for r in cur.fetchall():
        key = authz.party_key(r[0], r[1]) + _k(r[2], r[3])
        counts[key] = counts.get(key, 0) + r[4]
    return counts


def _issues(cur, mock):
    cur.execute(
        f"SELECT [ID], [Source], [Agency], [Module], [File_Type], [Entity], [Description], [Reported_By], "
        f"[Reported_DTTM] FROM [{DB}].dbo.[{T_ISSUE}] WHERE [MOCK] = ? AND [Deleted] = 0 ORDER BY [ID]", (mock,))
    return [{"id": r[0], "source": _s(r[1]), "agency": _s(r[2]), "module": _s(r[3]), "file_type": _s(r[4]),
             "entity": _s(r[5]), "description": r[6], "reported_by": r[7], "reported_at": r[8]}
            for r in cur.fetchall()]


def _issue_row(cur, raw_id):
    cur.execute(
        f"SELECT [ID], [MOCK], [Source], [Agency], [Module], [File_Type], [Entity], [Reported_By] "
        f"FROM [{DB}].dbo.[{T_ISSUE}] WHERE [ID] = ? AND [Deleted] = 0", (_id(raw_id),))
    r = cur.fetchone()
    if not r:
        raise ApiError("Issue not found", 404)
    return {"id": r[0], "mock": _s(r[1]), "source": _s(r[2]), "agency": _s(r[3]), "module": _s(r[4]),
            "file_type": _s(r[5]), "entity": _s(r[6]), "reported_by": _s(r[7])}


def _issue_attachments(cur, mock):
    """{issue id as text: its documents}."""
    cur.execute(
        f"SELECT [Cert_Key], [ID], [File_Name], [Size_Bytes], [Uploaded_By], [Uploaded_DTTM] "
        f"FROM [{DB}].dbo.[{T_ATTACHMENT}] WHERE [MOCK] = ? AND [Cert_Type] = 'ISSUE' AND [Deleted] = 0 "
        "ORDER BY [ID]", (mock,))
    out = {}
    for r in cur.fetchall():
        out.setdefault(_s(r[0]), []).append(
            {"id": r[1], "file_name": r[2], "size": r[3], "uploaded_by": r[4], "uploaded_at": r[5]})
    return out


def _signoffs(cur, mock):
    cur.execute(
        f"SELECT [Source], [Agency], [Signer_Name], [Signer_Title], [Signed_By], [Signed_DTTM] "
        f"FROM [{DB}].dbo.[{T_SIGNOFF}] WHERE [MOCK] = ? AND [Is_Current] = 1 ORDER BY [ID]", (mock,))
    return {authz.party_key(r[0], r[1]): {"name": r[2], "title": r[3], "by": r[4], "at": r[5]}
            for r in cur.fetchall()}


def _check_open(cur, mock, source, agency):
    """409 while the party's sign-off stands: what was signed must not change."""
    if authz.party_key(source, agency) in _signoffs(cur, mock):
        raise ApiError(f"{party_name(source, agency)} has signed off {mock}. A super user must revoke the "
                       "sign-off before anything can change.", 409)


# The aggregate over the log takes seconds and every portal page asks for it,
# while the log only changes when validations are run: keep it briefly.
_COUNTS_TTL = 120
_counts_cache = {}


def _log_counts(cur, db, mock, flags, source):
    key = (db, mock, flags, _s(source).upper())
    hit = _counts_cache.get(key)
    if hit and time.time() - hit[0] < _COUNTS_TTL:
        return hit[1]
    whole = _counts_cache.get((db, mock, flags, ""))
    if source and whole and time.time() - whole[0] < _COUNTS_TTL:
        return [r for r in whole[1] if _s(r[0]).upper() == key[3]]
    where, args = "d.[MOCK] = ?", [mock]
    if source:
        where += " AND d.[Source] = ?"
        args.append(source)
    cur.execute(
        f"SELECT d.[Source], LEFT(LTRIM(ISNULL(d.[BU], '')), 3), d.[Validation_Code], COUNT(*) "
        f"FROM [{db}].dbo.[{LOG_TABLE}] d WHERE {where} "
        f"AND EXISTS (SELECT 1 FROM [{db}].dbo.[{CATALOG_TABLE}] e "
        f"WHERE e.[VALIDATION_CODE] = d.[Validation_Code] AND ({flags})) "
        "GROUP BY d.[Source], LEFT(LTRIM(ISNULL(d.[BU], '')), 3), d.[Validation_Code]", tuple(args))
    rows = [tuple(r) for r in cur.fetchall()]
    _counts_cache[key] = (time.time(), rows)
    return rows


def _log_db(cur, mock, have, warnings):
    """The database whose detail log answers for the cycle: a test database
    starts with an empty log, so until a cycle's rows exist there the main
    database is read. None when there is no log at all."""
    if validation_seed.is_test_target():
        empty = LOG_TABLE not in have
        if not empty:
            cur.execute(f"SELECT TOP 1 1 FROM [{DB}].dbo.[{LOG_TABLE}] WHERE [MOCK] = ?", (mock,))
            empty = cur.fetchone() is None
        if empty:
            warnings.append(f"The Data Cleanse Log in {DB} has no rows for {mock}; the validation "
                            f"results were read from {SOURCE}.")
            return SOURCE
        return DB
    if LOG_TABLE not in have:
        warnings.append(f"{LOG_TABLE} does not exist in {DB}; no validations are reported.")
        return None
    return DB


def _reported(conn, cur, mock, warnings, source=None):
    """({SOURCE: {BU3: {code: count}}}, {CODE: catalog entry}) for the rules the
    catalog reports to agencies or to sources. Counts only — one aggregate
    over the log."""
    have = _ensure_team_objects(conn, cur, [LOG_TABLE, CATALOG_TABLE], warnings)
    if CATALOG_TABLE not in have:
        warnings.append(f"{CATALOG_TABLE} does not exist in {DB}; no validations can be listed.")
        return {}, {}
    cat_cols = _columns(cur, CATALOG_TABLE)
    if "AGENCYREPORTS" not in cat_cols:
        warnings.append(f"{CATALOG_TABLE} in {DB} has no AgencyReports column; no validations can be listed.")
        return {}, {}
    to_source = "SOURCEREPORTS" in cat_cols
    flags = "e.[AgencyReports] = 'Y'" + (" OR e.[Sourcereports] = 'Y'" if to_source else "")
    cur.execute(
        f"SELECT e.[VALIDATION_CODE], e.[ERROR_MESSAGE], e.[ERROR_MESSAGE_SPA], e.[ENTITY], e.[VALIDATION_TYPE], "
        f"e.[Severity], {'e.[PATH_FORWARD]' if 'PATH_FORWARD' in cat_cols else 'NULL'}, e.[AgencyReports], "
        f"{'e.[Sourcereports]' if to_source else 'NULL'} FROM [{DB}].dbo.[{CATALOG_TABLE}] e WHERE {flags}")
    catalog = {}
    for r in cur.fetchall():
        entry = catalog.setdefault(_s(r[0]).upper(), {
            "message": r[1], "message_spa": r[2], "entity": r[3], "type": r[4], "severity": r[5],
            "path_forward": r[6], "to_agency": False, "to_source": False})
        # A code can be listed more than once; one of its rows may carry the text.
        if not _s(entry["path_forward"]):
            entry["path_forward"] = r[6]
        entry["to_agency"] |= _s(r[7]).upper() == "Y"
        entry["to_source"] |= _s(r[8]).upper() == "Y"

    read_db = _log_db(cur, mock, have, warnings)
    if read_db is None:
        return {}, catalog

    reported = {}
    for src, bu3, code, n in _log_counts(cur, read_db, mock, flags, source):
        codes = reported.setdefault(_s(src).upper(), {}).setdefault(_s(bu3).upper(), {})
        codes[_s(code)] = codes.get(_s(code), 0) + n
    return reported, catalog


# ── access ───────────────────────────────────────────────────────────────────

class _Access:
    """What one caller may see or certify."""

    def __init__(self, email, *roles, what):
        self.email = _s(email)
        self.role = authz.require(self.email, *roles, what=what)
        self._memo = {}

    def party(self, source, agency, bu):
        if self.role != authz.AGENCY_USER:
            return True
        key = _k(source, agency, bu)
        if key not in self._memo:
            # A source-level party is matched on the party alone: a BU on its
            # rows must not open it to that agency's users.
            self._memo[key] = authz.can_act_on_party(self.email, source, agency, bu if _s(agency) else "")
        return self._memo[key]

    def check(self, source, agency, bu):
        if not self.party(source, agency, bu):
            raise ApiError(f"{self.email} is not allowed to act for {party_name(source, agency)}", 403)

    def owns(self, author):
        """Only the author of an issue or a document, or a super user, changes it."""
        return self.role == authz.SUPER_USER or _s(author).lower() == self.email.lower()


def _reader(email, what="viewing certifications"):
    return _Access(email, authz.AGENCY_USER, authz.CERT_REVIEWER, what=what)


def _certifier(email, what="certifying"):
    return _Access(email, authz.AGENCY_USER, what=what)


def _required_party(rows, source, agency):
    """(source, agency, bu) of the party as the setup table spells it (404
    when nothing is required from it)."""
    wanted = authz.party_key(source, agency)
    for p in _parties(rows):
        if authz.party_key(p["source"], p["agency"]) == wanted:
            return p["source"], p["agency"], p["bu"]
    raise ApiError(f"No certification is required from {party_name(source, agency)}", 404)


def _resolve_party(conn, cur, access, mock, source, agency, warnings):
    """(setup rows, source, agency, bu) of a request's party. The caller is
    authorised on a party that really exists in the cycle's certification
    list, never on the free-text values of the request."""
    location, unavailable = _location_table(conn, cur, mock, warnings)
    if not location:
        raise ApiError(unavailable["message"], 404)
    rows = _required_rows(cur, location)
    source, agency, bu = _required_party(rows, source, agency)
    access.check(source, agency, bu)
    return rows, source, agency, bu


def _required_record(rows, mock, source, agency, data):
    """The expected record a request names, as the setup table spells it."""
    file_type, entity = _need(data, "file_type", "File type", 30), _need(data, "entity", "Entity", 50)
    wanted = record_key(source, agency, data.get("module"), file_type, entity)
    for r in rows:
        if _row_key(r) == wanted:
            return r
    raise ApiError(f"{entity} ({file_type}) does not require a certification from "
                   f"{party_name(source, agency)} for {mock}", 404)


def _need(data, field, label=None, limit=None):
    value = _s(data.get(field))
    if not value:
        raise ApiError(f"{label or field} is required")
    if limit and len(value) > limit:
        raise ApiError(f"{label or field} is longer than {limit} characters")
    return value


def _cert_target(data, types=CERT_TYPES):
    cert_type = _s(data.get("cert_type")).upper()
    if cert_type not in types:
        raise ApiError(f"cert_type must be one of {', '.join(types)}")
    return cert_type, _need(data, "cert_key", limit=200)


def _attach_target(cur, data, mock, source, agency):
    """(cert_type, cert_key) a document is attached to. A document for an
    issue goes to an issue of this same party."""
    cert_type, cert_key = _cert_target(data)
    if cert_type == "ISSUE":
        issue = _issue_row(cur, cert_key)
        party = authz.party_key(issue["source"], issue["agency"])
        if issue["mock"] != mock or party != authz.party_key(source, agency):
            raise ApiError("Issue not found", 404)
        cert_key = str(issue["id"])
    return cert_type, cert_key


def _conflict(headers, message, **extra):
    """A 409 that also tells the page what is missing."""
    return {"statusCode": 409, "headers": headers,
            "body": json.dumps({"ok": False, "error": message, **extra}, default=str)}


# ── status snapshot (pages, dashboard and report) ────────────────────────────

def _file_rows(cur, mock, rows):
    """The expected records with their certification, issues and documents."""
    certs, attachments = _file_certs(cur, mock), _attachment_counts(cur, mock)
    issues = {}
    for i in _issues(cur, mock):
        issues[_row_key(i)] = issues.get(_row_key(i), 0) + 1
    out = []
    for r in rows:
        cert = _cert_of(certs, r) or {}
        documents = authz.party_key(r["source"], r["agency"]) + _k("FILE", file_cert_key(r["entity"], r["file_type"]))
        out.append({**r, "party": party_name(r["source"], r["agency"]), "certified": bool(cert),
                    "response_code": cert.get("response_code"), "resource_name": cert.get("resource_name"),
                    "notes": cert.get("notes"), "certified_by": cert.get("certified_by"),
                    "certified_at": cert.get("certified_at"), "issues": issues.get(_row_key(r), 0),
                    "attachments": attachments.get(documents, 0)})
    return out


def _validation_rows(codes, catalog, certs, party):
    """What the log reports to one party, with the party's commitments."""
    out = []
    for code in sorted(codes):
        info = catalog.get(code.upper(), {})
        cert = certs.get(party + _k(code)) or {}
        out.append({"validation_code": code, "count": codes[code], "message": info.get("message"),
                    "message_spa": info.get("message_spa"), "entity": info.get("entity"), "type": info.get("type"),
                    "severity": info.get("severity"), "path_forward": info.get("path_forward"),
                    "committed": bool(cert), "reviewed": bool(cert.get("reviewed")),
                    "target_date": cert.get("target_date"), "notes": cert.get("notes"),
                    "committed_by": cert.get("committed_by"), "committed_at": cert.get("committed_at"),
                    "committed_path_forward": cert.get("committed_path_forward"),
                    "committed_count": cert.get("committed_count")})
    return out


def _snapshot(conn, cur, mock, location, access, warnings):
    rows = [r for r in _required_rows(cur, location) if access.party(r["source"], r["agency"], r["bu"])]
    files = _file_rows(cur, mock, rows)
    validation_certs, signoffs = _validation_certs(cur, mock), _signoffs(cur, mock)
    reported, catalog = _reported(conn, cur, mock, warnings)
    by_party = {}
    for f in files:
        by_party.setdefault(authz.party_key(f["source"], f["agency"]), []).append(f)

    validations, parties = [], []
    for p in _parties(rows):
        key = authz.party_key(p["source"], p["agency"])
        mine = by_party[key]
        certified = [f for f in mine if f["certified"]]
        reported_here = _validation_rows(validations_for(reported, catalog, p["source"], p["agency"]),
                                         catalog, validation_certs, key)
        committed = [v for v in reported_here if v["committed"]]
        validations.extend({**p, **v} for v in reported_here)
        stamps = [f["certified_at"] for f in certified] + [v["committed_at"] for v in committed]
        done, total = len(certified) + len(committed), len(mine) + len(reported_here)
        parties.append({**p, "files_required": len(mine), "files_certified": len(certified),
                        "with_issues": sum(1 for f in certified if f["response_code"] == "ISSUES"),
                        "validations_reported": len(reported_here), "validations_certified": len(committed),
                        "pct": _pct(done, total), "last_activity": max(filter(None, stamps), default=None),
                        "status": status_of(done, total), "signoff": signoffs.get(key)})

    sums = {f: sum(p[f] for p in parties) for f in
            ("files_required", "files_certified", "with_issues", "validations_reported", "validations_certified")}
    totals = {"parties": len(parties), **sums, "signed_off": sum(1 for p in parties if p["signoff"]),
              "pct_complete": _pct(sums["files_certified"] + sums["validations_certified"],
                                   sums["files_required"] + sums["validations_reported"])}
    return {"totals": totals, "parties": parties, "files": files, "validations": validations}


# ── status report workbook ───────────────────────────────────────────────────

def _xl(ws, value):
    if value is None:
        return ""
    if isinstance(value, datetime):
        value = value.strftime("%Y-%m-%d %H:%M:%S")
    return api_util.xlsx_value(ws, value)


def _sheet(ws, header, records, widths):
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
    ws.append(header)
    for c in range(1, len(header) + 1):
        cell = ws.cell(row=1, column=c)
        cell.fill = PatternFill("solid", fgColor="1F4E79")
        cell.font = Font(bold=True, color="FFFFFF")
        cell.alignment = Alignment(vertical="center", wrap_text=True)
    for rec in records:
        ws.append([_xl(ws, v) for v in rec])
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(header))}{max(2, len(records) + 1)}"
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w


def build_status_workbook(mock, snapshot, generated_by, when=None):
    """Workbook bytes: Summary, File Certifications, Validation Certifications."""
    from openpyxl import Workbook
    from openpyxl.styles import Font
    when = when or datetime.now()
    wb = Workbook()

    ws = wb.active
    ws.title = "Summary"
    header = ["Party", "Source", "Agency", "BU", "Files Required", "Files Certified", "With Issues",
              "Validations Reported", "Validations Certified", "% Complete", "Status", "Signed Off", "Signer",
              "Signer Title", "Signed By", "Signed At", "Last Activity"]
    records = []
    for p in snapshot["parties"]:
        signed = p["signoff"] or {}
        records.append([p["party"], p["source"], p["agency"], p["bu"], p["files_required"], p["files_certified"],
                        p["with_issues"], p["validations_reported"], p["validations_certified"], p["pct"],
                        p["status"], "Yes" if signed else "No", signed.get("name"), signed.get("title"),
                        signed.get("by"), signed.get("at"), p["last_activity"]])
    _sheet(ws, header, records, [34, 14, 34, 10, 14, 14, 12, 18, 18, 12, 14, 12, 30, 30, 30, 20, 20])
    t = snapshot["totals"]
    ws.append([])
    ws.append([_xl(ws, v) for v in (
        f"Total ({t['parties']} parties)", "", "", "", t["files_required"], t["files_certified"], t["with_issues"],
        t["validations_reported"], t["validations_certified"], t["pct_complete"], "", t["signed_off"])])
    for cell in ws[ws.max_row]:
        cell.font = Font(bold=True)
    ws.append([_xl(ws, f"Certification status for {mock} generated {when.strftime('%Y-%m-%d %H:%M:%S')} "
                       f"by {generated_by}")])

    header = ["Party", "Source", "Agency", "BU", "Pillar", "Module", "Entity", "File Type", "Response",
              "Certification Applicable", "Status", "Certification Response", "Agency Resource", "Issues",
              "Certified By", "Certified At", "Notes", "Attachments"]
    _sheet(wb.create_sheet("File Certifications"), header,
           [[f["party"], f["source"], f["agency"], f["bu"], f["pillar"], f["module"], f["entity"], f["file_type"],
             f["response"], f["certification_applicable"], "Certified" if f["certified"] else "Pending",
             f["response_code"], f["resource_name"], f["issues"], f["certified_by"], f["certified_at"], f["notes"],
             f["attachments"]]
            for f in snapshot["files"]], [34, 14, 34, 10, 12, 24, 26, 26, 18, 14, 12, 18, 30, 10, 30, 20, 60, 12])

    header = ["Party", "Source", "Agency", "BU", "Validation Code", "Error Message", "Entity", "Validation Type",
              "Severity", "Error Count", "Status", "Path Forward", "Reviewed", "Target Date", "Notes",
              "Committed By", "Committed At", "Path Forward When Committed", "Error Count When Committed"]
    _sheet(wb.create_sheet("Validation Certifications"), header,
           [[v["party"], v["source"], v["agency"], v["bu"], v["validation_code"], v["message"], v["entity"],
             v["type"], v["severity"], v["count"], "Committed" if v["committed"] else "Pending", v["path_forward"],
             "Yes" if v["reviewed"] else "", v["target_date"], v["notes"], v["committed_by"], v["committed_at"],
             v["committed_path_forward"], v["committed_count"]]
            for v in snapshot["validations"]],
           [34, 14, 34, 10, 18, 60, 20, 16, 12, 12, 12, 50, 10, 14, 50, 30, 20, 50, 14])

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# ── actions ──────────────────────────────────────────────────────────────────

_ROW_FIELDS = ("source", "agency", "bu", "party", "module", "file_type", "entity", "file_path", "certified",
               "response_code", "resource_name", "notes", "certified_by", "certified_at", "issues", "attachments")
_RECORD_FIELDS = ("source", "agency", "party", "module", "file_type", "entity", "response_code", "resource_name",
                  "certified_by", "certified_at", "issues")
_VALIDATION_FIELDS = ("validation_code", "count", "message", "message_spa", "entity", "type", "severity",
                      "path_forward", "committed", "reviewed", "target_date", "notes", "committed_by", "committed_at")
_RECORD_STATES = {
    "pending": lambda f: not f["certified"],
    "completed": lambda f: f["certified"],
    "issues": lambda f: f["certified"] and f["response_code"] == "ISSUES",
}


def _expected(conn, cur, p, headers):
    mock = _mock(p.get("mock"))
    access = _reader(p.get("email"))
    warnings = []
    location, unavailable = _location_table(conn, cur, mock, warnings)
    if not location:
        return api_util.ok(headers, unavailable)
    snap = _snapshot(conn, cur, mock, location, access, warnings)
    parties = [{"source": s["source"], "agency": s["agency"], "bu": s["bu"], "party": s["party"],
                "required": s["files_required"], "certified": s["files_certified"], "with_issues": s["with_issues"],
                "validations_reported": s["validations_reported"],
                "validations_committed": s["validations_certified"], "signed_off": s["signoff"],
                "status": portal_status(s["signoff"], s["files_certified"] + s["validations_certified"],
                                        s["files_required"] + s["validations_reported"])}
               for s in snap["parties"]]
    return api_util.ok(headers, {
        "available": True, "mock": mock, "responses": [{"code": c, "label": t} for c, t in RESPONSES.items()],
        "parties": parties,
        "rows": [{**{f: r[f] for f in _ROW_FIELDS}, "response_codes": list(responses_for(r["file_type"]))}
                 for r in snap["files"]],
        "warnings": warnings})


def _validations(conn, cur, p, headers):
    mock = _mock(p.get("mock"))
    access = _reader(p.get("email"))
    warnings = []
    _, source, agency, bu = _resolve_party(conn, cur, access, mock, _need(p, "source"), _s(p.get("agency")), warnings)
    reported, catalog = _reported(conn, cur, mock, warnings, source=source)
    rows = _validation_rows(validations_for(reported, catalog, source, agency), catalog,
                            _validation_certs(cur, mock), authz.party_key(source, agency))
    return api_util.ok(headers, {"mock": mock, "source": source, "agency": agency, "bu": bu,
                                 "party": party_name(source, agency),
                                 "validations": [{f: v[f] for f in _VALIDATION_FIELDS} for v in rows],
                                 "warnings": warnings})


# What an agency sees of a failing record: who it concerns, where it came
# from and the values the rule flagged (the team's Column 1..30).
_DETAIL_SHOWN = ["PersonNumber", "BU", "Source", "Entity", "File"] + [f"Col{i}" for i in range(1, 31)]
_DETAIL_LABELS = {"PersonNumber": "Person number"}
RECORDS_PAGE, RECORDS_PAGE_MAX = 200, 500


def _validation_records(conn, cur, p, headers):
    """The failing records behind one validation, for one party (an agency
    user or anyone reading as one) or, for the validation team, for a source
    and optionally a BU. Paged."""
    mock = _mock(p.get("mock"))
    code = _need(p, "validation_code", "Validation code", 50)
    email = _s(p.get("email"))
    source, agency, bu = _need(p, "source"), _s(p.get("agency")), _s(p.get("bu"))
    warnings = []
    if not agency and authz.role_of(email) in (authz.SUPER_USER, authz.CERT_REVIEWER):
        authz.require(email, authz.CERT_REVIEWER, what="viewing validation records")
        number = authz.agency_code(bu)[:3] if bu else ""
        party = " · ".join(v for v in (source, bu) if v)
    else:
        access = _reader(email, "viewing validation records")
        _, source, agency, bu = _resolve_party(conn, cur, access, mock, source, agency, warnings)
        reported, catalog = _reported(conn, cur, mock, warnings, source=source)
        if code.upper() not in {c.upper() for c in validations_for(reported, catalog, source, agency)}:
            raise ApiError(f"{code} is not reported to {party_name(source, agency)} for {mock}", 404)
        number = authz.party_key(source, agency)[1]
        party = party_name(source, agency)
    try:
        offset = max(0, int(p.get("offset") or 0))
        limit = min(RECORDS_PAGE_MAX, max(1, int(p.get("limit") or RECORDS_PAGE)))
    except ValueError:
        raise ApiError("offset and limit must be numbers")
    empty = {"mock": mock, "validation_code": code, "source": source, "agency": agency, "bu": bu, "party": party,
             "columns": [], "rows": [], "total": 0, "offset": offset, "limit": limit, "warnings": warnings}
    have = _ensure_team_objects(conn, cur, [LOG_TABLE], warnings)
    read_db = _log_db(cur, mock, have, warnings)
    if read_db is None:
        return api_util.ok(headers, empty)
    cur.execute(f"SELECT COLUMN_NAME FROM [{read_db}].INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ?", (LOG_TABLE,))
    present = {r[0].upper() for r in cur.fetchall()}
    shown = [c for c in _DETAIL_SHOWN if c.upper() in present]
    where, args = ["d.[MOCK] = ?", "d.[Validation_Code] = ?", "d.[Source] = ?"], [mock, code, source]
    if number:
        where.append("LEFT(LTRIM(ISNULL(d.[BU], '')), 3) = ?")
        args.append(number)
    clause = " AND ".join(where)
    cur.execute(f"SELECT COUNT(*) FROM [{read_db}].dbo.[{LOG_TABLE}] d WHERE {clause}", tuple(args))
    total = cur.fetchone()[0]
    cur.execute(
        f"SELECT {', '.join(f'd.[{c}]' for c in shown)} FROM [{read_db}].dbo.[{LOG_TABLE}] d WHERE {clause} "
        "ORDER BY d.[PersonNumber], d.[Col1], d.[Col2] OFFSET ? ROWS FETCH NEXT ? ROWS ONLY",
        tuple(args) + (offset, limit))
    rows = [[None if v is None else str(v).strip() for v in r] for r in cur.fetchall()]
    return api_util.ok(headers, {**empty, "columns": [{"name": c, "label": _DETAIL_LABELS.get(c, c)} for c in shown],
                                 "rows": rows, "total": total})


def _issues_list(conn, cur, p, headers):
    mock = _mock(p.get("mock"))
    access = _reader(p.get("email"), "viewing reported issues")
    issues = _issues(cur, mock)
    if _s(p.get("source")):
        _, source, agency, _ = _resolve_party(conn, cur, access, mock, _s(p.get("source")), _s(p.get("agency")), [])
        party = authz.party_key(source, agency)
        issues = [i for i in issues if authz.party_key(i["source"], i["agency"]) == party]
    elif access.role == authz.AGENCY_USER:
        raise ApiError("source is required")
    for field in ("module", "file_type", "entity"):
        if _s(p.get(field)):
            issues = [i for i in issues if _k(i[field]) == _k(p.get(field))]
    certs, attachments = _file_certs(cur, mock), _issue_attachments(cur, mock)
    return api_util.ok(headers, {"issues": [
        {**i, "party": party_name(i["source"], i["agency"]), "certified": bool(_cert_of(certs, i)),
         "attachments": attachments.get(str(i["id"]), [])} for i in issues]})


def _records(conn, cur, p, headers):
    mock = _mock(p.get("mock"))
    access = _reader(p.get("email"))
    state = _s(p.get("state")).lower()
    if state not in _RECORD_STATES:
        raise ApiError(f"state must be one of {', '.join(_RECORD_STATES)}")
    location, unavailable = _location_table(conn, cur, mock, [])
    if not location:
        return api_util.ok(headers, {**unavailable, "records": []})
    rows = [r for r in _required_rows(cur, location) if access.party(r["source"], r["agency"], r["bu"])]
    return api_util.ok(headers, {"mock": mock, "state": state, "records": [
        {f: r[f] for f in _RECORD_FIELDS} for r in _file_rows(cur, mock, rows) if _RECORD_STATES[state](r)]})


def _writable_party(conn, cur, data, what, locked=True):
    """(access, mock, table rows, source, agency, bu) for a change: the caller
    may certify, the cycle is set up, the party is one that must certify and
    (for anything but a new document) it has not signed off."""
    access = _certifier(data.get("actor"), what)
    mock = _mock(data.get("mock"))
    rows, source, agency, bu = _resolve_party(conn, cur, access, mock, _need(data, "source"),
                                              _s(data.get("agency")), [])
    if locked:
        _check_open(cur, mock, source, agency)
    return access, mock, rows, source, agency, bu


def _certify_validation(conn, cur, data, headers):
    access, mock, _, source, agency, bu = _writable_party(conn, cur, data, "committing to a path forward")
    code = _need(data, "validation_code", "Validation code", 50)
    reviewed = _flag(data.get("reviewed"))
    target_date = _date(data.get("target_date"), "Target date")
    notes = _s(data.get("notes")) or None
    if not (reviewed or target_date or notes):
        raise ApiError("Confirm the path forward was reviewed, or give a target date or a note")
    warnings = []
    reported, catalog = _reported(conn, cur, mock, warnings, source=source)
    counts = {c.upper(): (c, n) for c, n in validations_for(reported, catalog, source, agency).items()}
    if code.upper() not in counts:
        raise ApiError(f"{code} is not reported to {party_name(source, agency)} for {mock}", 404)
    code, count = counts[code.upper()]
    # The path forward is kept as the rule worded it on the day of the commitment.
    path_forward = catalog.get(code.upper(), {}).get("path_forward")
    cur.execute(
        f"UPDATE [{DB}].dbo.[{T_VALIDATION}] SET [Is_Current] = 0 WHERE [MOCK] = ? AND [Source] = ? "
        "AND [Agency] = ? AND [Validation_Code] = ? AND [Is_Current] = 1", (mock, source, agency, code))
    cur.execute(
        f"INSERT INTO [{DB}].dbo.[{T_VALIDATION}] ([MOCK], [Source], [Agency], [BU], [Validation_Code], "
        "[Path_Forward], [Notes], [Error_Count], [Reviewed], [Target_Date], [Certified_By], [Certified_DTTM], "
        "[Is_Current]) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, GETDATE(), 1)",
        (mock, source, agency, bu, code, path_forward, notes, count, reviewed, target_date, access.email))
    conn.commit()
    return api_util.ok(headers, {"mock": mock, "source": source, "agency": agency, "bu": bu,
                                 "validation_code": code, "error_count": count, "reviewed": reviewed,
                                 "target_date": target_date, "committed_by": access.email})


def _certify_file(conn, cur, data, headers):
    access, mock, rows, source, agency, bu = _writable_party(conn, cur, data, "certifying a file")
    record = _required_record(rows, mock, source, agency, data)
    module, file_type, entity = record["module"], record["file_type"], record["entity"]
    response_code = _s(data.get("response_code")).upper()
    if response_code not in responses_for(file_type):
        raise ApiError(f"For {file_type} the response must be one of {', '.join(responses_for(file_type))}")
    resource_name = _need(data, "resource_name", "Agency resource", 200)
    notes = _s(data.get("notes")) or None
    if response_code == "ISSUES":
        issues = [i for i in _issues(cur, mock) if _row_key(i) == _row_key(record)]
        if not issues:
            raise ApiError("Report at least one issue on this record before certifying it with issues")
        documents = _issue_attachments(cur, mock)
        bare = [_s(i["description"])[:60] for i in issues if not documents.get(str(i["id"]))]
        if bare:
            raise ApiError("Every issue needs a supporting document. Missing on: " + "; ".join(bare))
    cur.execute(
        f"UPDATE [{DB}].dbo.[{T_FILE}] SET [Is_Current] = 0 WHERE [MOCK] = ? AND [Source] = ? AND [Agency] = ? "
        "AND [Entity] = ? AND [File_Type] = ? AND ([Module] = ? OR [Module] IS NULL) AND [Is_Current] = 1",
        (mock, source, agency, entity, file_type, module))
    cur.execute(
        f"INSERT INTO [{DB}].dbo.[{T_FILE}] ([MOCK], [Source], [Agency], [BU], [Module], [Entity], [File_Type], "
        "[Response_Code], [Resource_Name], [Notes], [Certified_By], [Certified_DTTM], [Is_Current]) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, GETDATE(), 1)",
        (mock, source, agency, bu, module, entity, file_type, response_code, resource_name, notes, access.email))
    conn.commit()
    return api_util.ok(headers, {"mock": mock, "source": source, "agency": agency, "bu": bu, "module": module,
                                 "file_type": file_type, "entity": entity, "response_code": response_code,
                                 "resource_name": resource_name, "certified_by": access.email})


def _issue_save(conn, cur, data, headers):
    access, mock, rows, source, agency, _ = _writable_party(conn, cur, data, "reporting an issue")
    record = _required_record(rows, mock, source, agency, data)
    description = _need(data, "description", "Description", MAX_ISSUE_LENGTH)
    if _s(data.get("id")):
        issue = _issue_row(cur, data.get("id"))
        if issue["mock"] != mock or _row_key(issue) != _row_key(record):
            raise ApiError("Issue not found", 404)
        if not access.owns(issue["reported_by"]):
            raise ApiError("Only the person who reported an issue, or a super user, can change it", 403)
        cur.execute(f"UPDATE [{DB}].dbo.[{T_ISSUE}] SET [Description] = ? WHERE [ID] = ?",
                    (description, issue["id"]))
        issue_id = issue["id"]
    else:
        cur.execute(
            f"INSERT INTO [{DB}].dbo.[{T_ISSUE}] ([MOCK], [Source], [Agency], [Module], [File_Type], [Entity], "
            "[Description], [Reported_By], [Reported_DTTM], [Deleted]) OUTPUT INSERTED.[ID] "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, GETDATE(), 0)",
            (mock, source, agency, record["module"], record["file_type"], record["entity"], description,
             access.email))
        issue_id = cur.fetchone()[0]
    conn.commit()
    return api_util.ok(headers, {"id": issue_id})


def _issue_delete(conn, cur, data, headers):
    access = _certifier(data.get("actor"), "removing an issue")
    issue = _issue_row(cur, data.get("id"))
    if not access.owns(issue["reported_by"]):
        raise ApiError("Only the person who reported an issue, or a super user, can remove it", 403)
    _check_open(cur, issue["mock"], issue["source"], issue["agency"])
    cur.execute(f"UPDATE [{DB}].dbo.[{T_ISSUE}] SET [Deleted] = 1 WHERE [ID] = ?", (issue["id"],))
    conn.commit()
    return api_util.ok(headers, {"id": issue["id"], "deleted": True})


def _signoff(conn, cur, data, headers):
    access, mock, rows, source, agency, bu = _writable_party(conn, cur, data, "signing off the certification")
    signer_name = _need(data, "signer_name", "Name", 200)
    signer_title = _need(data, "signer_title", "Title", 200)
    party = authz.party_key(source, agency)
    mine = [r for r in rows if authz.party_key(r["source"], r["agency"]) == party]
    # An "issues" response whose issues or documents were removed afterwards
    # no longer stands, so it counts as not certified.
    documents = _issue_attachments(cur, mock)
    issues = _issues(cur, mock)
    backed = ({_row_key(i) for i in issues}
              - {_row_key(i) for i in issues if not documents.get(str(i["id"]))})
    missing_records = [{"module": f["module"], "file_type": f["file_type"], "entity": f["entity"]}
                       for f in _file_rows(cur, mock, mine)
                       if not f["certified"] or (f["response_code"] == "ISSUES" and _row_key(f) not in backed)]
    warnings = []
    reported, catalog = _reported(conn, cur, mock, warnings, source=source)
    committed = _validation_certs(cur, mock)
    missing_validations = sorted(code for code in validations_for(reported, catalog, source, agency)
                                 if party + _k(code) not in committed)
    if missing_records or missing_validations:
        return _conflict(headers, f"{party_name(source, agency)} cannot sign off {mock} yet: "
                                  f"{len(missing_records)} record(s) are not certified and "
                                  f"{len(missing_validations)} validation(s) have no commitment.",
                         missing_records=missing_records, missing_validations=missing_validations)
    statement = SIGNOFF_STATEMENT.format(mock=mock)
    cur.execute(
        f"INSERT INTO [{DB}].dbo.[{T_SIGNOFF}] ([MOCK], [Source], [Agency], [Signer_Name], [Signer_Title], "
        "[Signed_By], [Signed_DTTM], [Statement], [Is_Current]) OUTPUT INSERTED.[ID], INSERTED.[Signed_DTTM] "
        "VALUES (?, ?, ?, ?, ?, ?, GETDATE(), ?, 1)",
        (mock, source, agency, signer_name, signer_title, access.email, statement))
    new_id, signed_at = cur.fetchone()
    conn.commit()
    return api_util.ok(headers, {"id": new_id, "mock": mock, "source": source, "agency": agency, "bu": bu,
                                 "signer_name": signer_name, "signer_title": signer_title,
                                 "signed_by": access.email, "signed_at": signed_at, "statement": statement,
                                 "warnings": warnings})


def _revoke(conn, cur, data, headers):
    """Withdraw the current certification of a file or a validation, or a
    party's sign-off (super users only). The row stays as history, stamped
    with who revoked it and why."""
    actor = _s(data.get("actor"))
    authz.require(actor, what="revoking a certification")
    mock = _mock(data.get("mock"))
    source, agency = _need(data, "source"), _s(data.get("agency"))
    cert_type = _s(data.get("cert_type")).upper()
    reason = _need(data, "reason", "Reason")
    if cert_type == "SIGNOFF":
        table, cert_key, where, params = T_SIGNOFF, "", "1 = 1", ()
    else:
        cert_type, cert_key = _cert_target(data, REVOKE_TYPES)
        _check_open(cur, mock, source, agency)
        if cert_type == "VALIDATION":
            table, where, params = T_VALIDATION, "[Validation_Code] = ?", (cert_key,)
        else:
            entity, _, file_type = cert_key.partition("|")
            table, where, params = T_FILE, "[Entity] = ? AND [File_Type] = ?", (entity, file_type)
    cur.execute(f"SELECT [ID], [Source], [Agency] FROM [{DB}].dbo.[{table}] "
                f"WHERE [MOCK] = ? AND [Is_Current] = 1 AND {where}", (mock,) + params)
    party = authz.party_key(source, agency)
    ids = [r[0] for r in cur.fetchall() if authz.party_key(r[1], r[2]) == party]
    if not ids:
        raise ApiError("There is no current certification to revoke", 404)
    cur.execute(
        f"UPDATE [{DB}].dbo.[{table}] SET [Is_Current] = 0, [Revoked_By] = ?, [Revoked_DTTM] = GETDATE(), "
        f"[Revoke_Reason] = ? WHERE [ID] IN ({', '.join('?' for _ in ids)})", (actor, reason) + tuple(ids))
    conn.commit()
    return api_util.ok(headers, {"revoked": len(ids), "cert_type": cert_type, "cert_key": cert_key})


def _upload_url(conn, cur, data, bucket, headers):
    _, mock, _, source, agency, bu = _writable_party(conn, cur, data, "attaching a document", locked=False)
    cert_type, cert_key = _attach_target(cur, data, mock, source, agency)
    file_name = _need(data, "file_name", "File name", 300)
    content_type = _s(data.get("content_type")) or "application/octet-stream"
    try:
        size = int(data.get("size") or 0)
    except (TypeError, ValueError):
        raise ApiError("size must be a number of bytes")
    if size <= 0:
        raise ApiError(f"{file_name} is empty")
    if size > MAX_ATTACHMENT_BYTES:
        raise ApiError(f"{file_name} is larger than the {MAX_ATTACHMENT_BYTES // (1024 * 1024)} MB limit")
    key = attachment_key(mock, source, agency, bu, cert_type, cert_key, file_name)
    if len(key) > MAX_KEY_LENGTH:
        raise ApiError("The file name is too long")
    return api_util.ok(headers, {"key": key, "content_type": content_type,
                                 "url": api_util.presign_put(bucket, key, content_type)})


def _attachment_add(conn, cur, data, bucket, headers):
    access, mock, _, source, agency, bu = _writable_party(conn, cur, data, "attaching a document", locked=False)
    cert_type, cert_key = _attach_target(cur, data, mock, source, agency)
    key = _need(data, "key", limit=MAX_KEY_LENGTH)
    file_name = _need(data, "file_name", "File name", 300)
    prefix = cert_prefix(mock, source, agency, bu, cert_type, cert_key)
    if not key.startswith(prefix) or "/" in key[len(prefix):]:
        raise ApiError("The uploaded object does not belong to this certification", 403)
    size = api_util.object_size(bucket, key)
    if size is None:
        raise ApiError(f"{file_name} was not uploaded", 404)
    if size > MAX_ATTACHMENT_BYTES:
        raise ApiError(f"{file_name} is larger than the {MAX_ATTACHMENT_BYTES // (1024 * 1024)} MB limit")
    cur.execute(f"SELECT COUNT(*) FROM [{DB}].dbo.[{T_ATTACHMENT}] WHERE [S3_Key] = ? AND [Deleted] = 0", (key,))
    if cur.fetchone()[0]:
        raise ApiError(f"{file_name} is already attached", 409)
    cur.execute(
        f"INSERT INTO [{DB}].dbo.[{T_ATTACHMENT}] ([MOCK], [Source], [Agency], [BU], [Cert_Type], [Cert_Key], "
        "[File_Name], [S3_Key], [Size_Bytes], [Uploaded_By], [Uploaded_DTTM], [Deleted]) "
        "OUTPUT INSERTED.[ID] VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, GETDATE(), 0)",
        (mock, source, agency, bu, cert_type, cert_key, file_name, key, size, access.email))
    new_id = cur.fetchone()[0]
    conn.commit()
    return api_util.ok(headers, {"id": new_id, "file_name": file_name, "size": size})


def _attachments(conn, cur, p, headers):
    mock = _mock(p.get("mock"))
    access = _reader(p.get("email"))
    _, source, agency, _ = _resolve_party(conn, cur, access, mock, _need(p, "source"), _s(p.get("agency")), [])
    cert_type, cert_key = _cert_target(p)
    cur.execute(
        f"SELECT [ID], [File_Name], [Size_Bytes], [Uploaded_By], [Uploaded_DTTM] FROM [{DB}].dbo.[{T_ATTACHMENT}] "
        "WHERE [MOCK] = ? AND [Source] = ? AND [Agency] = ? AND [Cert_Type] = ? AND [Cert_Key] = ? "
        "AND [Deleted] = 0 ORDER BY [ID]", (mock, source, agency, cert_type, cert_key))
    items = [{"id": r[0], "file_name": r[1], "size": r[2], "uploaded_by": r[3], "uploaded_at": r[4]}
             for r in cur.fetchall()]
    return api_util.ok(headers, {"attachments": items})


def _attachment_row(cur, raw_id):
    cur.execute(
        f"SELECT [ID], [Source], [Agency], [BU], [File_Name], [S3_Key], [Uploaded_By], [MOCK] "
        f"FROM [{DB}].dbo.[{T_ATTACHMENT}] WHERE [ID] = ? AND [Deleted] = 0", (_id(raw_id),))
    row = cur.fetchone()
    if not row:
        raise ApiError("Attachment not found", 404)
    return row


def _download_url(cur, p, bucket, headers):
    access = _reader(p.get("email"), "downloading a certification document")
    row = _attachment_row(cur, p.get("id"))
    access.check(row[1], row[2], row[3])
    return api_util.ok(headers, {"id": row[0], "file_name": row[4],
                                 "url": api_util.presign_get(bucket, row[5], row[4])})


def _attachment_delete(conn, cur, data, headers):
    access = _certifier(data.get("actor"), "removing a certification document")
    row = _attachment_row(cur, data.get("id"))
    if not access.owns(row[6]):
        raise ApiError("Only the person who uploaded a document, or a super user, can remove it", 403)
    _check_open(cur, _s(row[7]), row[1], row[2])
    cur.execute(f"UPDATE [{DB}].dbo.[{T_ATTACHMENT}] SET [Deleted] = 1 WHERE [ID] = ?", (row[0],))
    conn.commit()
    return api_util.ok(headers, {"id": row[0], "deleted": True})


def _status_party(p):
    signed = p["signoff"] or {}
    return {**{k: v for k, v in p.items() if k != "signoff"}, "signed_off": bool(signed),
            "signed_by": signed.get("by"), "signed_at": signed.get("at")}


def _status(conn, cur, p, headers):
    mock = _mock(p.get("mock"))
    access = _reader(p.get("email"), "viewing the certification status")
    warnings = []
    location, unavailable = _location_table(conn, cur, mock, warnings)
    if not location:
        return api_util.ok(headers, unavailable)
    snap = _snapshot(conn, cur, mock, location, access, warnings)
    return api_util.ok(headers, {"available": True, "mock": mock, "db": DB, "totals": snap["totals"],
                                 "parties": [_status_party(s) for s in snap["parties"]], "warnings": warnings})


def _status_report(conn, cur, data, bucket, headers):
    mock = _mock(data.get("mock"))
    access = _reader(data.get("actor"), "generating the certification status report")
    warnings = []
    location, unavailable = _location_table(conn, cur, mock, warnings)
    if not location:
        raise ApiError(unavailable["message"], 404)
    snap = _snapshot(conn, cur, mock, location, access, warnings)
    content = build_status_workbook(mock, snap, access.email)
    key, name = report_key(mock)
    import validation_report
    validation_report.write_report(bucket, key, content)
    return api_util.ok(headers, {"key": key, "name": name, "url": api_util.presign_get(bucket, key, name),
                                 "parties": snap["totals"]["parties"], "warnings": warnings})


def handle(action, event, bucket, headers, conn_str):
    def run():
        with pyodbc.connect(conn_str, autocommit=False) as conn:
            cur = conn.cursor()
            _ensure_tables(cur, conn)
            if action == "cert_expected":
                return _expected(conn, cur, api_util.params(event), headers)
            if action == "cert_validations":
                return _validations(conn, cur, api_util.params(event), headers)
            if action == "cert_validation_rows":
                return _validation_records(conn, cur, api_util.params(event), headers)
            if action == "cert_issues":
                return _issues_list(conn, cur, api_util.params(event), headers)
            if action == "cert_records":
                return _records(conn, cur, api_util.params(event), headers)
            if action == "cert_attachments":
                return _attachments(conn, cur, api_util.params(event), headers)
            if action == "cert_download_url":
                return _download_url(cur, api_util.params(event), bucket, headers)
            if action == "cert_status":
                return _status(conn, cur, api_util.params(event), headers)

            data = api_util.body(event)
            if action == "cert_certify_validation":
                return _certify_validation(conn, cur, data, headers)
            if action == "cert_certify_file":
                return _certify_file(conn, cur, data, headers)
            if action == "cert_issue_save":
                return _issue_save(conn, cur, data, headers)
            if action == "cert_issue_delete":
                return _issue_delete(conn, cur, data, headers)
            if action == "cert_signoff":
                return _signoff(conn, cur, data, headers)
            if action == "cert_upload_url":
                return _upload_url(conn, cur, data, bucket, headers)
            if action == "cert_attachment_add":
                return _attachment_add(conn, cur, data, bucket, headers)
            if action == "cert_attachment_delete":
                return _attachment_delete(conn, cur, data, headers)
            if action == "cert_status_report":
                return _status_report(conn, cur, data, bucket, headers)
            if action == "cert_revoke":
                return _revoke(conn, cur, data, headers)
            raise ApiError(f"Unknown action: {action}", 404)

    return api_util.guarded(run, headers)
