"""
recon_reports.py — pre-load reconciliation reports for the sources.

For every HCM cycle the conversion team's database keeps three views per
entity and source it reconciles:

  HCM_<ENTITY>_<MOCK>_<SOURCE>_RECON_SUMMARY_VW   one row: source, converted
                                                  and excluded counts
  HCM_<ENTITY>_<MOCK>_<SOURCE>_RECON_VW           the records not converted, and why
  HCM_<ENTITY>_<MOCK>_<SOURCE>_RECON2_VW          counts by BU and reason

Views whose source part starts with one of the cycle's agency numbers
(010, 031_ASG) are the agency-level reconciliations; only the sources' are
reported here (911 is a source).

A report is one workbook per entity and source (Summary, Detail, By BU), named
like the team's files: PR_<ENTITY>_<SOURCE>_ReconReport_<MOCK>_<stamp>.xlsx.
It is published through the team's distribution list (portal_files), so it
lands in the source's Pre-Load Recon Reports folder, where it replaces the
earlier report of the same entity and source. A name the list does not know
is reported back instead of published.

The views live in the conversion database (validation_seed.SOURCE_DB) and are
only read.
"""
import os
import re
import tempfile
from datetime import datetime
from decimal import Decimal

import boto3
import openpyxl
import pyodbc
from openpyxl.cell import WriteOnlyCell
from openpyxl.styles import Font

import api_util
import authz
import portal_files
import validation_report
import validation_seed
from api_util import ApiError

ACTIONS = {"recon_list", "recon_generate"}

DB = validation_seed.TARGET_DB
SOURCE = validation_seed.SOURCE_DB
REPORT_PREFIX = f"{api_util.PRIVATE_ROOT}/Reports"
MAX_DETAIL_ROWS = 1_048_000     # what one Excel sheet holds, less the header
_FETCH = 5000
_SUMMARY, _DETAIL, _BY_BU = "_RECON_SUMMARY_VW", "_RECON_VW", "_RECON2_VW"


def _s(value):
    return str(value if value is not None else "").strip()


def entity_label(entity):
    """HCM_PERSON_NATIONAL_IDENTIFIER -> Person National Identifier; a name the
    team wrote in mixed case (HCM_AsgEITDestaque) keeps its spelling."""
    body = entity[4:] if entity.upper().startswith("HCM_") else entity
    return body.replace("_", " ").title() if body.upper() == body else body.replace("_", " ")


def report_prefix(entity, token):
    return f"PR_{entity.upper()}_{token.upper()}_ReconReport_"


def report_name(entity, token, mock, when=None):
    when = when or datetime.now()
    return f"{report_prefix(entity, token)}{mock}_{when.strftime('%Y.%m.%d-%H.%M.%S')}.xlsx"


def source_reports(view_names, mock, agency_numbers):
    """[{entity, token, summary, detail, by_bu}] from the cycle's recon view
    names: one per entity and source (agency-level views left out)."""
    names = {n.upper(): n for n in view_names}
    marker = f"_{mock.upper()}_"
    out = []
    for upper, name in sorted(names.items()):
        if not upper.endswith(_SUMMARY) or marker not in upper:
            continue
        at = upper.index(marker)
        entity, token = name[:at], name[at + len(marker):-len(_SUMMARY)]
        number = re.match(r"^(\d{3})", token)
        if not entity.upper().startswith("HCM_") or not token or (number and number.group(1) in agency_numbers):
            continue
        base = f"{entity}_{mock}_{token}".upper()
        out.append({"entity": entity, "token": token, "summary": name,
                    "detail": names.get(base + _DETAIL), "by_bu": names.get(base + _BY_BU)})
    return out


def _cell(value):
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    return value


# ── database ─────────────────────────────────────────────────────────────────

def _agency_numbers(conn, cur, mock):
    return {authz.agency_code(r["agency"]) for r in portal_files._locations(conn, cur, mock) if r["agency"]}


def _views(cur, mock):
    cur.execute(f"SELECT name FROM [{SOURCE}].sys.views WHERE name LIKE ?", (f"HCM[_]%[_]{mock}[_]%[_]RECON%",))
    return [r[0] for r in cur.fetchall()]


def _latest_published(cur, mock):
    """{report prefix: its newest published file} of the cycle."""
    cur.execute(
        f"SELECT [File_Name], [Published_DTTM], [Published_By] FROM [{DB}].dbo.[{portal_files.T_PUBLISHED}] "
        "WHERE [MOCK] = ? AND [Deleted] = 0 AND [File_Name] LIKE 'PR[_]%' ORDER BY [Published_DTTM]", (mock,))
    latest = {}
    for name, at, by in cur.fetchall():
        m = re.match(r"^(PR_.+?_ReconReport_)", name, re.I)
        if m:
            latest[m.group(1).upper()] = {"name": name, "published_at": at, "published_by": by}
    return latest


def _retire_earlier(cur, mock, prefix, keep, actor):
    """The earlier reports of the same entity and source leave the folders."""
    cur.execute(
        f"UPDATE [{DB}].dbo.[{portal_files.T_PUBLISHED}] SET [Deleted] = 1, [Deleted_By] = ?, "
        "[Deleted_DTTM] = GETDATE() WHERE [MOCK] = ? AND [Deleted] = 0 AND UPPER(LEFT([File_Name], ?)) = ? "
        "AND [File_Name] <> ?", (actor, mock, len(prefix), prefix.upper(), keep))


# ── actions ──────────────────────────────────────────────────────────────────

def _list(conn, cur, p, bucket):
    authz.require(_s(p.get("email")), authz.CERT_REVIEWER, what="viewing the recon reports")
    mock = api_util.mock(p.get("mock"))
    resolve = portal_files._resolver(conn, cur, mock)
    latest = _latest_published(cur, mock)
    reports = []
    for r in source_reports(_views(cur, mock), mock, _agency_numbers(conn, cur, mock)):
        targets, reason = resolve(f"{report_prefix(r['entity'], r['token'])}{mock}.xlsx")
        reports.append({"entity": r["entity"], "token": r["token"], "label": entity_label(r["entity"]),
                        "has_detail": bool(r["detail"]), "has_by_bu": bool(r["by_bu"]),
                        "targets": portal_files._public(targets), "reason": reason,
                        "published": latest.get(report_prefix(r["entity"], r["token"]).upper())})
    return {"mock": mock, "reports": reports, "sources": sorted({r["token"] for r in reports})}


def _sheet(wb, cur, title, view, limit=None):
    """Copy one view into a sheet; the number of rows written, and whether the
    view had more than the sheet holds."""
    ws = wb.create_sheet(title)
    top = f"TOP ({int(limit) + 1}) " if limit is not None else ""
    cur.execute(f"SELECT {top}* FROM [{SOURCE}].dbo.[{api_util.ident(view, 'view')}]")
    bold = Font(bold=True)
    header = []
    for d in cur.description:
        c = WriteOnlyCell(ws, value=d[0])
        c.font = bold
        header.append(c)
    ws.append(header)
    written = 0
    while True:
        batch = cur.fetchmany(_FETCH)
        if not batch:
            return written, False
        for row in batch:
            if limit is not None and written >= limit:
                return written, True
            ws.append([api_util.xlsx_value(ws, _cell(v)) for v in row])
            written += 1


def build_report(cur, report, mock, path, when):
    """Write the report workbook to `path`: (rows per sheet, summary row, truncated)."""
    wb = openpyxl.Workbook(write_only=True)
    ws = wb.create_sheet("Summary")
    title = WriteOnlyCell(ws, value="Pre-Load Reconciliation Report")
    title.font = Font(bold=True, size=14)
    ws.append([title])
    for label, value in (("Entity", entity_label(report["entity"])), ("Source", report["token"]),
                         ("Mock cycle", mock), ("Generated", when.strftime("%Y-%m-%d %H:%M"))):
        ws.append([label, value])
    ws.append([])
    cur.execute(f"SELECT * FROM [{SOURCE}].dbo.[{api_util.ident(report['summary'], 'view')}]")
    columns = [d[0] for d in cur.description]
    summary_rows = [[_cell(v) for v in row] for row in cur.fetchall()]
    bold = Font(bold=True)
    head = []
    for name in columns:
        c = WriteOnlyCell(ws, value=name)
        c.font = bold
        head.append(c)
    ws.append(head)
    for row in summary_rows:
        ws.append([api_util.xlsx_value(ws, v) for v in row])
    counts, truncated = {"summary": len(summary_rows), "detail": 0, "by_bu": 0}, False
    if report["detail"]:
        counts["detail"], truncated = _sheet(wb, cur, "Detail", report["detail"], MAX_DETAIL_ROWS)
    if report["by_bu"]:
        counts["by_bu"], _ = _sheet(wb, cur, "By BU", report["by_bu"])
    wb.save(path)
    summary = dict(zip(columns, summary_rows[0])) if summary_rows else {}
    return counts, summary, truncated


def _generate(conn, cur, data, bucket):
    actor = _s(data.get("actor"))
    authz.require(actor, what="generating recon reports")
    mock = api_util.mock(data.get("mock"))
    entity, token = _s(data.get("entity")).upper(), _s(data.get("token")).upper()
    report = next((r for r in source_reports(_views(cur, mock), mock, _agency_numbers(conn, cur, mock))
                   if r["entity"].upper() == entity and r["token"].upper() == token), None)
    if not report:
        raise ApiError(f"There is no recon report for {entity} / {token} in {mock}", 404)
    when = datetime.now()
    name = report_name(report["entity"], report["token"], mock, when)
    handle, path = tempfile.mkstemp(suffix=".xlsx")
    os.close(handle)
    try:
        counts, summary, truncated = build_report(cur, report, mock, path, when)
        with open(path, "rb") as f:
            content = f.read()
    finally:
        os.remove(path)
    key = f"{REPORT_PREFIX}/{mock}/Recon/{api_util.safe_segment(report['token'])}/{name}"
    validation_report.write_report(bucket, key, content)
    targets, reason = portal_files._resolver(conn, cur, mock)(name)
    if targets:
        portal_files._publish_object(conn, cur, boto3.client("s3"), bucket, mock, key, name, len(content),
                                     targets, actor)
        _retire_earlier(cur, mock, report_prefix(report["entity"], report["token"]), name, actor)
        conn.commit()
    return {"name": name, "rows": counts, "truncated": truncated,
            "summary": {k: v for k, v in summary.items()},
            "targets": portal_files._public(targets), "reason": reason,
            "url": api_util.presign_get(bucket, key, name)}


_ACTIONS = {"recon_list": _list, "recon_generate": _generate}


def handle(action, event, bucket, headers, conn_str):
    def run():
        values = api_util.params(event) if action == "recon_list" else api_util.body(event)
        with pyodbc.connect(conn_str, autocommit=False) as conn:
            cur = conn.cursor()
            portal_files._ensure_tables(cur, conn)
            return api_util.ok(headers, _ACTIONS[action](conn, cur, values, bucket))

    return api_util.guarded(run, headers)
