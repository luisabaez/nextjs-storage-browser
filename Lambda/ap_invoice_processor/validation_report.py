"""
validation_report.py — the Excel workbook a validation run hands back to the
client, in the layout the validation team's programs produce:

  Data    one row per failing record — Error Message, Entity, File, Source,
          Last Load Dttm, Validation Type, Column 1 .. Column 21
  Pivot   count of rows per Error Message, split by File, with totals
          (a computed summary; not a live Excel PivotTable)

Files are written to S3 under REPORT_PREFIX/<mock>/<program>/<source>/ with
the team's file naming, e.g. 122651_HUM_ASSETS_MOCK14_FileValidation_2026.09.19-14.05.31.xlsx
"""
import io
import re
from collections import Counter, OrderedDict
from datetime import datetime

import boto3
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

# Under DataValidation/ — a folder the app's storage access already covers,
# so the page can hand out download links and the file browser can show it.
REPORT_PREFIX = "DataValidation/Reports"
N_EXTRA = 21
HEADER = (["Error Message", "Entity", "File", "Source", "Last Load Dttm", "Validation Type"]
          + [f"Column {i}" for i in range(1, N_EXTRA + 1)])

# The team's programs name the workbook by entity, not by catalog program.
_LABEL = {"Asset": "ASSETS", "Inventory": "ITEM"}

_HEAD_FILL = PatternFill("solid", fgColor="1F4E79")
_HEAD_FONT = Font(bold=True, color="FFFFFF")


def _fixed(cols, row, name_variants):
    """Value of the first column whose (normalised) name is in name_variants."""
    for i, c in enumerate(cols):
        if c.upper().replace(" ", "_") in name_variants:
            return row[i]
    return ""


def records_from_view_rows(cols, rows):
    """Map one view's rows onto the team's 27-column layout: the six named
    columns by name, every other column in view order into Column 1..21."""
    fixed_idx = set()
    order = [("ERROR_MSG",), ("ENTITY",), ("FILE",), ("SOURCE",),
             ("PROCESSED_DTTM", "LAST_LOAD_DTTM", "FILE_PROCESSED_DTTM", "LAST_LOAD_DTTM"),
             ("VALIDATION_TYPE",)]
    picks = []
    for variants in order:
        idx = next((i for i, c in enumerate(cols) if c.upper().replace(" ", "_") in variants), None)
        picks.append(idx)
        if idx is not None:
            fixed_idx.add(idx)
    extra_idx = [i for i in range(len(cols)) if i not in fixed_idx][:N_EXTRA]
    out = []
    for r in rows:
        rec = [(r[i] if i is not None else "") for i in picks]
        rec += [r[i] for i in extra_idx]
        rec += [""] * (N_EXTRA - len(extra_idx))
        out.append(rec)
    return out


def records_from_detail_rows(rows):
    """LOG_DATA_CLEANSE_DETAIL rows (ERROR_MSG, Entity, File, File_PROCESSED_DTTM,
    Source, VALIDATION_TYPE, Col1..Col30) onto the same layout."""
    out = []
    for r in rows:
        rec = [r[0], r[1], r[2], r[4], r[3], r[5]]
        extras = [c for c in r[6:6 + 30] if c not in (None, "")][:N_EXTRA]
        rec += extras + [""] * (N_EXTRA - len(extras))
        out.append(rec)
    return out


def build_workbook(records):
    """Workbook bytes: Data sheet + Pivot sheet."""
    wb = Workbook()
    ws = wb.active
    ws.title = "Data"
    ws.append(HEADER)
    for c in range(1, len(HEADER) + 1):
        cell = ws.cell(row=1, column=c)
        cell.fill = _HEAD_FILL
        cell.font = _HEAD_FONT
    for rec in records:
        ws.append([_cell(v) for v in rec])
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(HEADER))}{max(2, len(records) + 1)}"
    widths = [60, 18, 40, 14, 20, 14] + [22] * N_EXTRA
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w

    # Pivot: rows = Error Message, columns = File, values = count
    files = sorted({str(rec[2] or "") for rec in records})
    counts = OrderedDict()
    for rec in records:
        msg = str(rec[0] or "")
        counts.setdefault(msg, Counter())[str(rec[2] or "")] += 1
    pv = wb.create_sheet("Pivot")
    pv.append(["Count of Error Message", "File"] + [""] * max(0, len(files) - 1))
    pv.append(["Error Message"] + files + ["Grand Total"])
    for c in range(1, len(files) + 3):
        cell = pv.cell(row=2, column=c)
        cell.fill = _HEAD_FILL
        cell.font = _HEAD_FONT
    col_totals = Counter()
    for msg in sorted(counts):
        row_counts = [counts[msg].get(f, 0) for f in files]
        pv.append([msg] + row_counts + [sum(row_counts)])
        for f, n in zip(files, row_counts):
            col_totals[f] += n
    pv.append(["Grand Total"] + [col_totals[f] for f in files] + [sum(col_totals.values())])
    last = pv.max_row
    for c in range(1, len(files) + 3):
        pv.cell(row=last, column=c).font = Font(bold=True)
    pv.column_dimensions["A"].width = 70
    for i in range(2, len(files) + 3):
        pv.column_dimensions[get_column_letter(i)].width = 22
    pv.freeze_panes = "B3"
    pv.cell(row=1, column=1).alignment = Alignment(horizontal="left")

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _cell(v):
    if v is None:
        return ""
    if isinstance(v, datetime):
        return v.strftime("%Y-%m-%d %H:%M:%S")
    return v


def report_key(mock, program, source, when=None):
    when = when or datetime.now()
    label = _LABEL.get(program, re.sub(r"[^A-Za-z0-9]+", "_", program).strip("_").upper())
    name = f"{source}_{label}_{mock}_FileValidation_{when.strftime('%Y.%m.%d-%H.%M.%S')}.xlsx"
    prog_dir = re.sub(r"[^A-Za-z0-9_-]+", "_", program)
    return f"{REPORT_PREFIX}/{mock}/{prog_dir}/{source}/{name}"


def write_report(bucket, key, content):
    boto3.client("s3").put_object(
        Bucket=bucket, Key=key, Body=content,
        ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    return key


def list_reports(bucket, mock, program=None, source=None):
    """Reports in S3 for a mock (optionally one program / source), newest first."""
    prefix = f"{REPORT_PREFIX}/{mock}/"
    if program:
        prefix += re.sub(r"[^A-Za-z0-9_-]+", "_", program) + "/"
        if source:
            prefix += f"{source}/"
    s3 = boto3.client("s3")
    out = []
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
        for o in page.get("Contents", []):
            if not o["Key"].lower().endswith(".xlsx"):
                continue
            parts = o["Key"].split("/")
            out.append({"key": o["Key"], "name": parts[-1], "program": parts[3] if len(parts) > 4 else "",
                        "source": parts[4] if len(parts) > 5 else "", "size": o["Size"],
                        "last_modified": o["LastModified"].isoformat()})
    out.sort(key=lambda r: r["last_modified"], reverse=True)
    return out
