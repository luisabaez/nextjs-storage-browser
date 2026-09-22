"""
portal_files.py — the files the validation team publishes to agencies, and
each mock cycle's user guides.

Where a file goes is the team's own publishing rule, read from their setup
tables for the cycle:

  SETUP_DATA_CLEANSE_FILE_DISTRIBUTION_<MOCK>  FileName is a file-name prefix;
        the longest one a file's name starts with gives File_Type, entity,
        Agency and source (a blank Agency is a source-level file)
  SETUP_DATA_CLEANSE_FILE_LOCATION_<MOCK>      the folders of every party; the
        row with the same Source, Agency, File_Type and Entity gives MODULE
        and BU. MultipleLocations = 'Y' publishes to every location row of
        that Source, File_Type and Entity.

A party is Source + Agency (authz.party_key). Its folder structure comes from
all of its location rows, so a folder shows before anything is published to it.

Published files are recorded in the application's own table,
DATA_CLEANSE_PUBLISHED_FILE (publishing a name again to the same folder
retires the earlier row). The objects live under the private root, reached
only through links signed after the party check. User guides are listed
straight from their S3 folder.

Roles: super users publish, delete and manage guides; agency users see the
files of their own parties; certification reviewers see every party.
"""
import uuid
from datetime import datetime

import boto3
import pyodbc

import api_util
import authz
import validation_seed
from api_util import ApiError

ACTIONS = {
    "pub_parties", "pub_tree", "pub_download_url", "guide_list", "guide_url",
    "pub_preview", "pub_upload_urls", "pub_publish", "pub_publish_report", "pub_delete",
    "guide_upload_url", "guide_delete",
}
_READS = {"pub_parties", "pub_tree", "pub_download_url", "guide_list", "guide_url"}

DB = validation_seed.TARGET_DB
SOURCE = validation_seed.SOURCE_DB

DISTRIBUTION_PREFIX = "SETUP_DATA_CLEANSE_FILE_DISTRIBUTION_"
LOCATION_PREFIX = "SETUP_DATA_CLEANSE_FILE_LOCATION_"
T_PUBLISHED = "DATA_CLEANSE_PUBLISHED_FILE"
T_CERT_FILE = "DATA_CLEANSE_CERT_FILE"

PUBLISHED_PREFIX = f"{api_util.PRIVATE_ROOT}/Published"
INBOX_PREFIX = f"{api_util.PRIVATE_ROOT}/PublishInbox"
GUIDE_PREFIX = f"{api_util.PRIVATE_ROOT}/UserDocs"
REPORT_PREFIX = f"{api_util.PRIVATE_ROOT}/Reports/"
SOURCE_LEVEL = "_SOURCE"      # agency folder of a source-level party

MAX_FILE_BYTES = 200 * 1024 * 1024
MAX_GUIDE_BYTES = 50 * 1024 * 1024
MAX_UPLOADS = 50
MAX_PUBLISH = 25
MAX_PREVIEW = 5000
MAX_NAME_LENGTH = 300
MAX_BATCH_LENGTH = 60
_SEGMENT = 120                # what api_util.safe_segment keeps of one segment
_ANY_MODULE = "*"             # a certification stored before records carried a module

# S3_Key: six segments of at most 120 characters under the prefix and the mock.
_DDL = (
    "[ID] INT IDENTITY(1,1) PRIMARY KEY, [MOCK] VARCHAR(20) NOT NULL, [Source] VARCHAR(50) NOT NULL, "
    "[Agency] VARCHAR(100) NOT NULL, [BU] VARCHAR(100) NOT NULL, [Module] VARCHAR(100) NOT NULL, "
    "[File_Type] VARCHAR(100) NOT NULL, [Entity] VARCHAR(100) NOT NULL, [File_Name] NVARCHAR(300) NOT NULL, "
    "[S3_Key] NVARCHAR(800) NOT NULL, [Size_Bytes] BIGINT NULL, "
    "[Published_By] NVARCHAR(200) NULL, [Published_DTTM] DATETIME NULL, "
    "[Deleted] BIT NOT NULL DEFAULT 0, [Deleted_By] NVARCHAR(200) NULL, [Deleted_DTTM] DATETIME NULL")

# Row key -> column of the team's table.
_DISTRIBUTION = {"file_name": "FileName", "source": "source", "agency": "Agency", "file_type": "File_Type",
                 "entity": "entity", "multiple": "MultipleLocations"}
_LOCATION = {"source": "Source", "agency": "Agency", "bu": "BU", "module": "MODULE", "file_type": "File_Type",
             "entity": "Entity", "required": "CertificationRequired"}
_TARGET_FIELDS = ("source", "agency", "party", "module", "file_type", "entity")


# ── small pure helpers ───────────────────────────────────────────────────────

def _s(value):
    return str(value if value is not None else "").strip()


def _k(*parts):
    """Case- and padding-insensitive key for matching rows across tables."""
    return tuple(_s(p).upper() for p in parts)


def party_name(source, agency):
    """The party as people know it: the Agency, or the Source when there is none."""
    return _s(agency) or _s(source)


def name_problem(name):
    """Why a file name cannot be accepted (it becomes part of an S3 key), or None."""
    if not name.strip():
        return "The file name is empty"
    if len(name) > MAX_NAME_LENGTH:
        return f"The file name is longer than {MAX_NAME_LENGTH} characters"
    if "/" in name or "\\" in name or ".." in name:
        return "A file name cannot contain /, \\ or .."
    return None


def new_batch(when=None):
    when = when or datetime.now()
    return f"{when.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"


def file_segment(file_name):
    """The file name as one key segment (and as the name of a download). A
    name longer than a segment is cut in the middle, so it keeps its start,
    its time stamp and its extension."""
    if len(file_name) > _SEGMENT:
        file_name = file_name[:_SEGMENT // 2] + file_name[-(_SEGMENT // 2):]
    return api_util.safe_segment(file_name, "file")


def inbox_key(mock, batch, file_name):
    return f"{INBOX_PREFIX}/{mock}/{batch}/{file_segment(file_name)}"


def guide_key(mock, file_name):
    return f"{GUIDE_PREFIX}/{mock}/{file_segment(file_name)}"


def published_key(mock, target, file_name):
    """Where one published file lives. The party folders use the party key, so
    a different spelling of the same agency never makes a second folder."""
    source, agency = authz.party_key(target["source"], target["agency"])
    folders = [api_util.safe_segment(source, "NA"), api_util.safe_segment(agency, "NA") if agency else SOURCE_LEVEL]
    folders += [api_util.safe_segment(target[f], "NA") for f in ("module", "file_type", "entity")]
    return f"{PUBLISHED_PREFIX}/{mock}/{'/'.join(folders)}/{file_segment(file_name)}"


def resolver(distribution, locations):
    """The team's publishing rule over one cycle's setup rows: a function
    file name -> (targets, reason). `reason` says why there are no targets."""
    rules = sorted(((d["file_name"].lower(), d) for d in distribution if d["file_name"]),
                   key=lambda rule: -len(rule[0]))
    by_record = {}
    for loc in locations:
        by_record.setdefault(_k(loc["source"], loc["file_type"], loc["entity"]), []).append(loc)

    def resolve(name):
        problem = name_problem(name)
        if problem:
            return [], problem
        lowered = name.lower()
        # Longest prefix wins; rows that share that prefix all apply.
        matched, longest = [], 0
        for prefix, d in rules:
            if len(prefix) < longest:
                break
            if lowered.startswith(prefix):
                matched.append(d)
                longest = len(prefix)
        if not matched:
            return [], "No distribution rule matches this file name"
        targets, seen = [], set()
        for d in matched:
            everywhere = d["multiple"].upper() == "Y"
            for loc in by_record.get(_k(d["source"], d["file_type"], d["entity"]), []):
                if not everywhere and _k(loc["agency"]) != _k(d["agency"]):
                    continue
                key = _k(loc["source"], loc["agency"], loc["module"], loc["file_type"], loc["entity"])
                if key not in seen:
                    seen.add(key)
                    targets.append({"source": loc["source"], "agency": loc["agency"], "bu": loc["bu"],
                                    "party": party_name(loc["source"], loc["agency"]), "module": loc["module"],
                                    "file_type": loc["file_type"], "entity": loc["entity"]})
        if targets:
            return targets, ""
        d = matched[0]
        return [], (f"The distribution rule {d['file_name']} points to {d['source']} / "
                    f"{d['agency'] or 'source level'} / {d['file_type']} / {d['entity']}, "
                    "which has no folder in the cycle's file locations")

    return resolve


def is_certified(certified, record):
    """The response of a record key's current certification (it ends with
    module, file type, entity), or None. One stored without a module answers
    for any module of its file type + entity."""
    for key in (record, record[:-3] + (_ANY_MODULE,) + record[-2:]):
        if key in certified:
            return certified[key] or "CERTIFIED"
    return None


# Setup rows the team keeps for the agency's certification and user guide
# folders; in the portal those are pages of their own, not file folders.
PORTAL_PAGES = ("CERTIFICATION", "USER GUIDE")


def build_tree(locations, files, certified):
    """One party's folders: modules -> file types -> entities, each entity with
    its published files. `certified` holds the _k(module, file_type, entity)
    keys that have a current certification."""
    folders = {}

    def folder(row):
        return folders.setdefault(_k(row["module"], row["file_type"], row["entity"]), {
            "module": row["module"], "file_type": row["file_type"], "entity": row["entity"],
            "required": False, "files": []})

    for loc in locations:
        if loc["file_type"].strip().upper() in PORTAL_PAGES:
            continue
        entry = folder(loc)
        entry["required"] = entry["required"] or loc["required"].upper() == "Y"
    for f in files:
        folder(f)["files"].append({"id": f["id"], "name": f["name"], "size": f["size"],
                                   "published_by": f["published_by"], "published_at": f["published_at"]})
    modules = []
    for key in sorted(folders):
        f = folders[key]
        if not modules or _k(modules[-1]["module"]) != key[:1]:
            modules.append({"module": f["module"], "file_types": []})
        types = modules[-1]["file_types"]
        if not types or _k(types[-1]["file_type"]) != key[1:2]:
            types.append({"file_type": f["file_type"], "entities": []})
        response = is_certified(certified, key)
        types[-1]["entities"].append({"entity": f["entity"], "certification_required": f["required"],
                                      "certified": response is not None,
                                      "response_code": None if response == "CERTIFIED" else response,
                                      "files": f["files"]})
    return modules


def _size(name, raw, limit):
    try:
        size = int(raw or 0)
    except (TypeError, ValueError):
        raise ApiError("size must be a number of bytes")
    if size <= 0:
        raise ApiError(f"{name} is empty")
    if size > limit:
        raise ApiError(f"{name} is larger than the {limit // (1024 * 1024)} MB limit")
    return size


def _file_name(value):
    name = value if isinstance(value, str) else ""
    problem = name_problem(name)
    if problem:
        raise ApiError(f"{name or 'File name'}: {problem}")
    return name


# ── database helpers ─────────────────────────────────────────────────────────

def _find_table(cur, db, name):
    """The table as `db` spells it (the team's names vary in case, e.g.
    ..._Mock03HCM), or None."""
    cur.execute(f"SELECT name FROM [{db}].sys.tables WHERE UPPER(name) = ?", (name.upper(),))
    row = cur.fetchone()
    return api_util.ident(row[0], "table name") if row else None


def _columns(cur, table):
    cur.execute(f"SELECT COLUMN_NAME FROM [{DB}].INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ?", (table,))
    return {r[0].upper() for r in cur.fetchall()}


_TABLES_READY = False


def _ensure_tables(cur, conn):
    """Create the published-file table on first use (once per container)."""
    global _TABLES_READY
    if _TABLES_READY:
        return
    if not _find_table(cur, DB, T_PUBLISHED):
        cur.execute(f"CREATE TABLE [{DB}].dbo.[{T_PUBLISHED}] ({_DDL})")
        conn.commit()
    _TABLES_READY = True


def _team_table(conn, cur, name):
    """One of the team's setup tables as the application database spells it,
    or None. In a test database a missing one is cloned from the definitions
    of record; in production the team's objects are never created here."""
    table = _find_table(cur, DB, name)
    if table or not validation_seed.is_test_target():
        return table
    original = _find_table(cur, SOURCE, name)
    if not original:
        return None
    try:
        seeder = validation_seed.Seeder(conn)
        seeder.ensure(original)
        for failure in seeder.report["failed"]:
            print(f"  WARNING: could not prepare {failure}")
    except Exception as e:  # noqa: BLE001 - the caller answers "not set up"
        conn.rollback()
        print(f"  WARNING: could not prepare {original} in {DB}: {str(e)[:200]}")
    return _find_table(cur, DB, name)


def _rows(cur, table, columns):
    """The table's rows as {key: trimmed text}; a column this cycle's table
    lacks reads as blank."""
    have = _columns(cur, table)
    select = ", ".join(f"[{c}]" if c.upper() in have else f"NULL AS [{c}]" for c in columns.values())
    cur.execute(f"SELECT {select} FROM [{DB}].dbo.[{table}]")
    return [dict(zip(columns, (_s(v) for v in r))) for r in cur.fetchall()]


def _locations(conn, cur, mock):
    table = _team_table(conn, cur, f"{LOCATION_PREFIX}{mock}")
    if not table:
        raise ApiError(f"Files are not set up for {mock} yet: the validation team has not defined "
                       "the cycle's file locations.", 404)
    return [r for r in _rows(cur, table, _LOCATION) if r["source"]]


def _resolver(conn, cur, mock):
    locations = _locations(conn, cur, mock)
    table = _team_table(conn, cur, f"{DISTRIBUTION_PREFIX}{mock}")
    if not table:
        raise ApiError(f"Files cannot be published for {mock} yet: {DISTRIBUTION_PREFIX}{mock} does not exist.", 404)
    return resolver(_rows(cur, table, _DISTRIBUTION), locations)


def _record_key(row):
    return tuple(authz.party_key(row["source"], row["agency"])) + _k(row["module"], row["file_type"], row["entity"])


def _certified(cur, mock):
    """{record key: response code} of the current certifications. The table
    belongs to the certification module; until it exists nothing is certified.
    A row stored before certifications carried a module has none (see
    is_certified)."""
    if not _find_table(cur, DB, T_CERT_FILE):
        return {}
    cols = _columns(cur, T_CERT_FILE)
    module = "[Module]" if "MODULE" in cols else "NULL"
    response = "[Response_Code]" if "RESPONSE_CODE" in cols else "NULL"
    cur.execute(
        f"SELECT [Source], [Agency], {module}, [File_Type], [Entity], {response} FROM [{DB}].dbo.[{T_CERT_FILE}] "
        "WHERE [MOCK] = ? AND [Is_Current] = 1", (mock,))
    return {_record_key({"source": r[0], "agency": r[1], "module": _ANY_MODULE if r[2] is None else r[2],
                         "file_type": r[3], "entity": r[4]}): r[5]
            for r in cur.fetchall()}


def _published(cur, mock, source=None):
    """Current published files of a cycle (optionally one source), by name."""
    where, args = "[MOCK] = ? AND [Deleted] = 0", [mock]
    if source:
        where += " AND UPPER([Source]) = ?"
        args.append(source)
    cur.execute(
        f"SELECT [ID], [Source], [Agency], [Module], [File_Type], [Entity], [File_Name], [Size_Bytes], "
        f"[Published_By], [Published_DTTM] FROM [{DB}].dbo.[{T_PUBLISHED}] WHERE {where} "
        "ORDER BY [File_Name], [ID]", tuple(args))
    return [{"id": r[0], "source": _s(r[1]), "agency": _s(r[2]), "module": _s(r[3]), "file_type": _s(r[4]),
             "entity": _s(r[5]), "name": r[6], "size": r[7], "published_by": r[8], "published_at": r[9]}
            for r in cur.fetchall()]


def _file_row(cur, raw_id):
    try:
        file_id = int(raw_id)
    except (TypeError, ValueError):
        raise ApiError("id must be a number")
    cur.execute(
        f"SELECT [ID], [Source], [Agency], [BU], [File_Name], [S3_Key] FROM [{DB}].dbo.[{T_PUBLISHED}] "
        "WHERE [ID] = ? AND [Deleted] = 0", (file_id,))
    row = cur.fetchone()
    if not row:
        raise ApiError("File not found", 404)
    return row


# ── access ───────────────────────────────────────────────────────────────────

def _reader(values, what="viewing published files"):
    email = _s(values.get("email"))
    authz.require(email, authz.AGENCY_USER, authz.CERT_REVIEWER, what=what)
    return email


def _publisher(data, what="publishing files"):
    actor = _s(data.get("actor"))
    authz.require(actor, what=what)
    return actor


def _may_see(email, source, agency, bu):
    """A source-level party (blank agency) is matched on the party alone: a BU
    on its setup rows must not open the source's files to that agency."""
    return authz.can_act_on_party(email, source, agency, bu if _s(agency) else "")


def _check_party(email, source, agency, bu):
    if not _may_see(email, source, agency, bu):
        raise ApiError(f"{email} is not allowed to see the files of {party_name(source, agency)}", 403)


# ── published files: reads ───────────────────────────────────────────────────

def _parties(conn, cur, p, bucket):
    email = _reader(p)
    mock = api_util.mock(p.get("mock"))
    locations = _locations(conn, cur, mock)
    certified = _certified(cur, mock)
    files = {}
    for f in _published(cur, mock):
        key = tuple(authz.party_key(f["source"], f["agency"]))
        files[key] = files.get(key, 0) + 1
    parties, counted = {}, set()
    for loc in locations:
        key = tuple(authz.party_key(loc["source"], loc["agency"]))
        party = parties.setdefault(key, {
            "source": loc["source"], "agency": loc["agency"], "bu": "",
            "party": party_name(loc["source"], loc["agency"]), "files": files.get(key, 0),
            "required": 0, "certified": 0})
        party["bu"] = party["bu"] or loc["bu"]
        record = _record_key(loc)
        if loc["required"].upper() == "Y" and record not in counted:
            counted.add(record)
            party["required"] += 1
            if is_certified(certified, record):
                party["certified"] += 1
    mine = [row for row in parties.values() if _may_see(email, row["source"], row["agency"], row["bu"])]
    return {"parties": sorted(mine, key=lambda row: _k(row["party"], row["source"]))}


def _tree(conn, cur, p, bucket):
    email = _reader(p)
    mock = api_util.mock(p.get("mock"))
    source, agency = _s(p.get("source")), _s(p.get("agency"))
    if not source:
        raise ApiError("source is required")
    wanted = tuple(authz.party_key(source, agency))
    rows = [r for r in _locations(conn, cur, mock) if tuple(authz.party_key(r["source"], r["agency"])) == wanted]
    if rows:
        # Authorise and answer with the party as the setup table spells it.
        source, agency = rows[0]["source"], rows[0]["agency"]
    _check_party(email, source, agency, next((r["bu"] for r in rows if r["bu"]), ""))
    if not rows:
        raise ApiError(f"No files are set up for {party_name(source, agency)} in {mock}", 404)
    files = [f for f in _published(cur, mock, wanted[0])
             if tuple(authz.party_key(f["source"], f["agency"])) == wanted]
    certified = {key[2:]: v for key, v in _certified(cur, mock).items() if key[:2] == wanted}
    return {"party": party_name(source, agency), "modules": build_tree(rows, files, certified),
            "total_files": len(files)}


def _download_url(conn, cur, p, bucket):
    email = _reader(p, "downloading a published file")
    row = _file_row(cur, p.get("id"))
    _check_party(email, row[1], row[2], row[3])
    return {"url": api_util.presign_get(bucket, row[5], file_segment(row[4])), "file_name": row[4]}


# ── published files: writes (super users) ────────────────────────────────────

def _names(data, limit=None):
    names = data.get("names")
    if not isinstance(names, list) or not names:
        raise ApiError("names must be a list of file names")
    names = list(dict.fromkeys(n if isinstance(n, str) else "" for n in names))
    if limit and len(names) > limit:
        raise ApiError(f"At most {limit} files can be sent in one request")
    return names


def _public(targets):
    return [{f: t[f] for f in _TARGET_FIELDS} for t in targets]


def _preview(conn, cur, data, bucket):
    _publisher(data)
    resolve = _resolver(conn, cur, api_util.mock(data.get("mock")))
    results = []
    for name in _names(data, MAX_PREVIEW):
        targets, reason = resolve(name)
        results.append({"name": name, "matched": bool(targets), "targets": _public(targets), "reason": reason})
    return {"results": results}


def _upload_urls(data, bucket):
    _publisher(data)
    mock = api_util.mock(data.get("mock"))
    batch = _s(data.get("batch"))
    batch = api_util.ident(batch, "batch") if batch else new_batch()
    if len(batch) > MAX_BATCH_LENGTH:
        raise ApiError(f"batch is longer than {MAX_BATCH_LENGTH} characters")
    files = data.get("files")
    if not isinstance(files, list) or not files or not all(isinstance(f, dict) for f in files):
        raise ApiError("files must be a list of {name, size, content_type}")
    if len(files) > MAX_UPLOADS:
        raise ApiError(f"At most {MAX_UPLOADS} files can be sent in one request")
    uploads, seen = [], set()
    for f in files:
        name = _file_name(f.get("name"))
        _size(name, f.get("size"), MAX_FILE_BYTES)
        key = inbox_key(mock, batch, name)
        if key in seen:
            raise ApiError(f"{name} is listed twice")
        seen.add(key)
        content_type = _s(f.get("content_type")) or "application/octet-stream"
        uploads.append({"name": name, "key": key, "content_type": content_type,
                        "url": api_util.presign_put(bucket, key, content_type)})
    return {"batch": batch, "uploads": uploads}


def _publish_object(conn, cur, s3, bucket, mock, from_key, name, size, targets, actor):
    """Copy one object into every target folder and record it. The row of an
    earlier file at the same key is retired, not removed."""
    for t in targets:
        key = published_key(mock, t, name)
        s3.copy_object(Bucket=bucket, Key=key, CopySource={"Bucket": bucket, "Key": from_key})
        cur.execute(
            f"UPDATE [{DB}].dbo.[{T_PUBLISHED}] SET [Deleted] = 1, [Deleted_By] = ?, [Deleted_DTTM] = GETDATE() "
            "WHERE [S3_Key] = ? AND [Deleted] = 0", (actor, key))
        cur.execute(
            f"INSERT INTO [{DB}].dbo.[{T_PUBLISHED}] ([MOCK], [Source], [Agency], [BU], [Module], [File_Type], "
            "[Entity], [File_Name], [S3_Key], [Size_Bytes], [Published_By], [Published_DTTM], [Deleted]) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, GETDATE(), 0)",
            (mock, t["source"], t["agency"], t["bu"], t["module"], t["file_type"], t["entity"], name, key, size,
             actor))
    conn.commit()


def _remove_inbox(s3, bucket, key):
    """The file is published by now, so a failed clean-up is only logged."""
    try:
        s3.delete_object(Bucket=bucket, Key=key)
    except Exception as e:  # noqa: BLE001
        print(f"  WARNING: could not remove {key}: {str(e)[:200]}")


def _publish(conn, cur, data, bucket):
    actor = _publisher(data)
    mock = api_util.mock(data.get("mock"))
    batch = api_util.ident(_s(data.get("batch")), "batch")
    names = _names(data, MAX_PUBLISH)
    resolve = _resolver(conn, cur, mock)
    s3 = boto3.client("s3")
    published, unmatched = [], []
    for name in names:
        targets, reason = resolve(name)
        from_key, size = inbox_key(mock, batch, name), None
        if targets:
            size = api_util.object_size(bucket, from_key)
            if size is None:
                reason = "The file was not uploaded"
            elif size > MAX_FILE_BYTES:
                reason = f"The file is larger than the {MAX_FILE_BYTES // (1024 * 1024)} MB limit"
        if not reason:
            # One file's failure is reported against that file; the ones
            # already published in this request stay published.
            try:
                _publish_object(conn, cur, s3, bucket, mock, from_key, name, size, targets, actor)
            except Exception as e:  # noqa: BLE001
                conn.rollback()
                reason = f"Could not be published: {str(e)[:200]}"
            else:
                _remove_inbox(s3, bucket, from_key)
        if reason:
            unmatched.append({"name": name, "reason": reason})
        else:
            published.append({"name": name, "targets": _public(targets)})
    return {"published": published, "unmatched": unmatched}


def _publish_report(conn, cur, data, bucket):
    """Publish a workbook the application generated; it stays in the reports
    folder as well."""
    actor = _publisher(data, "publishing a report")
    mock = api_util.mock(data.get("mock"))
    key = _s(data.get("key"))
    if not key.startswith(REPORT_PREFIX) or ".." in key or "\\" in key or key.endswith("/"):
        raise ApiError("Not a generated report key")
    size = api_util.object_size(bucket, key)
    if size is None:
        raise ApiError("Report not found", 404)
    if size > MAX_FILE_BYTES:
        raise ApiError(f"The report is larger than the {MAX_FILE_BYTES // (1024 * 1024)} MB limit")
    name = key.rsplit("/", 1)[-1]
    targets, reason = _resolver(conn, cur, mock)(name)
    if not targets:
        return {"published": [], "unmatched": [{"name": name, "reason": reason}]}
    _publish_object(conn, cur, boto3.client("s3"), bucket, mock, key, name, size, targets, actor)
    return {"published": [{"name": name, "targets": _public(targets)}], "unmatched": []}


def _delete(conn, cur, data, bucket):
    actor = _publisher(data, "removing a published file")
    row = _file_row(cur, data.get("id"))
    cur.execute(
        f"UPDATE [{DB}].dbo.[{T_PUBLISHED}] SET [Deleted] = 1, [Deleted_By] = ?, [Deleted_DTTM] = GETDATE() "
        "WHERE [ID] = ?", (actor, row[0]))
    conn.commit()
    return {"id": row[0], "deleted": True}


# ── user guides ──────────────────────────────────────────────────────────────

def _guide_list(p, bucket):
    _reader(p, "viewing the user guides")
    prefix = f"{GUIDE_PREFIX}/{api_util.mock(p.get('mock'))}/"
    guides = []
    pages = boto3.client("s3").get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix, Delimiter="/")
    for page in pages:
        for o in page.get("Contents", []):
            name = o["Key"][len(prefix):]
            if name:
                guides.append({"name": name, "size": o["Size"], "last_modified": o["LastModified"].isoformat()})
    return {"guides": sorted(guides, key=lambda g: g["name"].upper())}


def _existing_guide(values, bucket):
    """(name, key) of a guide exactly as the listing names it: a guide the
    team placed in the folder by hand keeps whatever spelling it has."""
    name = _file_name(values.get("name"))
    key = f"{GUIDE_PREFIX}/{api_util.mock(values.get('mock'))}/{name}"
    if api_util.object_size(bucket, key) is None:
        raise ApiError("User guide not found", 404)
    return name, key


def _guide_url(p, bucket):
    _reader(p, "viewing the user guides")
    name, key = _existing_guide(p, bucket)
    return {"url": api_util.presign_get(bucket, key, file_segment(name))}


def _guide_upload_url(data, bucket):
    _publisher(data, "adding a user guide")
    name = _file_name(data.get("file_name"))
    _size(name, data.get("size"), MAX_GUIDE_BYTES)
    key = guide_key(api_util.mock(data.get("mock")), name)
    content_type = _s(data.get("content_type")) or "application/octet-stream"
    return {"url": api_util.presign_put(bucket, key, content_type), "key": key, "content_type": content_type}


def _guide_delete(data, bucket):
    _publisher(data, "removing a user guide")
    name, key = _existing_guide(data, bucket)
    boto3.client("s3").delete_object(Bucket=bucket, Key=key)
    return {"name": name, "deleted": True}


_S3_ONLY = {"guide_list": _guide_list, "guide_url": _guide_url, "pub_upload_urls": _upload_urls,
            "guide_upload_url": _guide_upload_url, "guide_delete": _guide_delete}
_WITH_DATABASE = {"pub_parties": _parties, "pub_tree": _tree, "pub_download_url": _download_url,
                  "pub_preview": _preview, "pub_publish": _publish, "pub_publish_report": _publish_report,
                  "pub_delete": _delete}


def handle(action, event, bucket, headers, conn_str):
    def run():
        values = api_util.params(event) if action in _READS else api_util.body(event)
        if action in _S3_ONLY:
            return api_util.ok(headers, _S3_ONLY[action](values, bucket))
        with pyodbc.connect(conn_str, autocommit=False) as conn:
            cur = conn.cursor()
            _ensure_tables(cur, conn)
            return api_util.ok(headers, _WITH_DATABASE[action](conn, cur, values, bucket))

    return api_util.guarded(run, headers)
