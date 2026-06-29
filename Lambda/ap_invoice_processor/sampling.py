"""
sampling.py - Interim record sampling for the ERP conversion validation effort.

Relationship config is taken directly from "Sampling Tables Relationship.xlsx".
For a chosen target table we select N random records, gather the child records
linked to those records through the business-key field defined in the sheet,
and write the whole sample set to an Excel workbook in the Sampling/ folder of
the data bucket.

Interim limitations (pending methodology confirmation with Ethree / Wanda):
  * Selection is random (ORDER BY NEWID()); runs are NOT reproducible yet.
  * Only DIRECT children of the target are gathered (no multi-level recursion).
  * Sample size is a manual input.
  * Table names are the exact MOCK14 names from the sheet; not yet parameterized
    by mock iteration.
"""

import io
import json
import re
import uuid
from datetime import datetime, date
from decimal import Decimal

import pyodbc
import openpyxl

SAMPLING_FOLDER = "Sampling/"
MANIFEST_FOLDER = "Sampling/_manifests/"
MAX_SAMPLE_SIZE = 5000          # guardrail
IN_CHUNK = 1000                 # values per IN(...) batch (SQL Server 2100 param cap)
URL_TTL_SECONDS = 3600

# ── Config generated from "Sampling Tables Relationship.xlsx" ──────────────────
TARGET_TABLES = [
    'FIN_911_BUDGET_BALANCE_MOCK14_VW_TBL',
    'FIN_AP_INVOICES_MOCK14_VW_TBL',
    'FIN_AP_INVOICES_SIFDE_MOCK14_VW_TBL',
    'FIN_AR_INVOICES_LINES_MOCK14_VW_TBL',
    'FIN_ASSETS_MOCK14_VW_TBL',
    'FIN_AWARDS_MOCK14_VW_TBL',
    'FIN_BUDGET_BALANCE_MOCK14_VW_TBL',
    'FIN_CUSTOMER_MOCK14_VW_TBL',
    'FIN_GL_BALANCE_911_MOCK14_VW_TBL',
    'FIN_GL_BALANCE_OPEN_PERIODS_911_MOCK14_VW_TBL',
    'FIN_GL_BALANCE_OPEN_PERIODS_MOCK14_VW_TBL',
    'FIN_GL_BALANCES_MOCK14_VW_TBL',
    'FIN_REVENUE_BUDGET_MOCK14_VW_TBL',
    'SCM_BPA_MOCK14_VW_TBL',
    'SCM_CONTRACTS_ASG_MOCK14_VW_TBL',
    'SCM_ITEMS_ASG_MOCK14_VW_TBL',
    'SCM_ITEMS_MOCK14_VW_TBL',
    'SCM_PURCHASE_ORDERS_MOCK14_VW_TBL',
    'SCM_PURCHASE_ORDERS_RET911_MOCK14_VW_TBL',
    'SCM_REQ_HDR_MOCK14_VW_TBL',
    'SCM_SUPPLIER_MOCK14_VW_TBL',
    'SCM_SUPPLIER_ASG_MOCK13_VW_TBL',
]

# (child_table, parent_table, link_field) - link_field is the business-key name;
# it is resolved to a real column at run time (see resolve_link_column).
RELATIONSHIPS = [
    ('FIN_AP_INV_LINES_MOCK14_VW_TBL', 'FIN_AP_INVOICES_MOCK14_VW_TBL', 'Invoice Number'),
    ('FIN_AP_INV_LINES_SIFDE_MOCK14_VW_TBL', 'FIN_AP_INVOICES_SIFDE_MOCK14_VW_TBL', 'Invoice Number'),
    ('FIN_AR_INVOICES_DISTRIBUTION_MOCK14_VW_tbl', 'FIN_AR_INVOICES_LINES_MOCK14_VW_TBL', 'Line Transaction Flexfield 1 - Legacy Invoice Number'),
    ('FIN_ASSETS_DISTRIBUTION_MOCK14_VW_TBL', 'FIN_ASSETS_MOCK14_VW_TBL', 'Tag Number'),
    ('FIN_AWARD_BUDGET_MOCK14_VW_TBL', 'FIN_AWARDS_MOCK14_VW_TBL', 'Award Number'),
    ('FIN_AWARD_BUDGET_PERIOD_MOCK14_VW_TBL', 'FIN_AWARDS_MOCK14_VW_TBL', 'Award Number'),
    ('FIN_AWARD_CFDA_MOCK14_VW_TBL', 'FIN_AWARDS_MOCK14_VW_TBL', 'Award Number'),
    ('FIN_AWARD_FUNDING_ALLOCATION_MOCK14_VW_TBL', 'FIN_AWARDS_MOCK14_VW_TBL', 'Award Number'),
    ('FIN_AWARD_FUNDING_MOCK14_VW_TBL', 'FIN_AWARDS_MOCK14_VW_TBL', 'Award Number'),
    ('FIN_AWARD_FUNDING_SOURCE_MOCK14_VW_TBL', 'FIN_AWARDS_MOCK14_VW_TBL', 'Award Number'),
    ('FIN_AWARD_PROJECTS_MOCK14_VW_TBL', 'FIN_AWARDS_MOCK14_VW_TBL', 'Award Number'),
    ('FIN_CUSTOMER_CONTACT_MOCK14_VW_TBL', 'FIN_CUSTOMER_MOCK14_VW_TBL', 'Organization Name'),
    ('FIN_PRIFAS_CUSTOMER_MOCK14_VW_TBL', 'FIN_AWARDS_MOCK14_VW_TBL', 'Primary Sponsor Name'),
    ('FIN_PROJECT_TASKS_MOCK14_VW_TBL', 'FIN_PROJECTS_MOCK14_VW_TBL', 'Project Name'),
    ('FIN_PROJECTS_CLASS_MOCK14_VW_TBL', 'FIN_PROJECTS_MOCK14_VW_TBL', 'Project Name'),
    ('FIN_PROJECTS_MOCK14_VW_TBL', 'FIN_AWARD_PROJECTS_MOCK14_VW_TBL', 'Project Name'),
    ('FIN_PROJECTS_TEAM_MEMBERS_MOCK14_VW_TBL', 'FIN_AWARDS_MOCK14_VW_TBL', 'Project Name'),
    ('SCM_BPA_LINES_ATTACHMENT_MOCK14_VW_TBL', 'SCM_BPA_MOCK14_VW_TBL', 'BPA Number'),
    ('SCM_BPA_LINES_MOCK14_VW_TBL', 'SCM_BPA_MOCK14_VW_TBL', 'BPA Number'),
    ('SCM_CONTRACT_ATTACHMENTS_ASG_MOCK14_VW_TBL', 'SCM_CONTRACTS_ASG_MOCK14_VW_TBL', 'Contract Number'),
    ('SCM_CONTRACT_LINES_ASG_MOCK14_VW_TBL', 'SCM_CONTRACTS_ASG_MOCK14_VW_TBL', 'Contract Number'),
    ('SCM_CONTRACTS_PARTYCONTACTS_ASG_MOCK14_VW_TBL', 'SCM_CONTRACTS_ASG_MOCK14_VW_TBL', 'Contract Number'),
    ('SCM_INV_MANUFACTURER_MOCK14_VW_TBL', 'SCM_ITEMS_MOCK14_VW_TBL', 'Item'),
    ('SCM_ITEM_LOTS_MOCK14_VW_TBL', 'SCM_ITEMS_MOCK14_VW_TBL', 'Item'),
    ('SCM_ITEM_SUBINVENTORY_MOCK14_VW_TBL', 'SCM_ITEMS_MOCK14_VW_TBL', 'Item'),
    ('SCM_ITEMS_CATEGORY_MOCK14_VW_TBL', 'SCM_ITEMS_MOCK14_VW_TBL', 'Item'),
    ('SCM_ITEMS_LOCATOR_MOCK14_VW_TBL', 'SCM_ITEMS_MOCK14_VW_TBL', 'Item'),
    ('SCM_ITEMS_OHQ_MOCK14_VW_TBL', 'SCM_ITEMS_MOCK14_VW_TBL', 'Item'),
    ('SCM_ITEMS_RELATIONSHIPS_MOCK14_VW_TBL', 'SCM_ITEMS_MOCK14_VW_TBL', 'Item'),
    ('SCM_PS_ITEMS_CATEGORY_MOCK14_VW_TBL', 'SCM_PS_ITEMS_MOCK14_VW_TBL', 'Item'),
    ('SCM_PS_ITEMS_MOCK14_VW_TBL', 'SCM_PURCHASE_ORDERS_LINES_MOCK14_VW_TBL', 'Item'),
    ('SCM_PURCHASE_ORDERS_LINE_LOCATIONS_MOCK14_VW_TBL', 'SCM_PURCHASE_ORDERS_MOCK14_VW_TBL', 'Order'),
    ('SCM_PURCHASE_ORDERS_LINE_LOCATIONS_RET911_MOCK14_VW_TBL', 'SCM_PURCHASE_ORDERS_RET911_MOCK14_VW_TBL', 'Order'),
    ('SCM_PURCHASE_ORDERS_LINES_ATTACHMENTS_MOCK14_VW_TBL', 'SCM_PURCHASE_ORDERS_MOCK14_VW_TBL', 'Order'),
    ('SCM_PURCHASE_ORDERS_LINES_DISTRIBUTION_MOCK14_VW_tbl', 'SCM_PURCHASE_ORDERS_MOCK14_VW_TBL', 'Order'),
    ('SCM_PURCHASE_ORDERS_LINES_DISTRIBUTION_RET911_MOCK14_VW_tbl', 'SCM_PURCHASE_ORDERS_RET911_MOCK14_VW_TBL', 'Order'),
    ('SCM_PURCHASE_ORDERS_LINES_MOCK14_VW_TBL', 'SCM_PURCHASE_ORDERS_MOCK14_VW_TBL', 'Order'),
    ('SCM_PURCHASE_ORDERS_LINES_RET911_MOCK14_VW_TBL', 'SCM_PURCHASE_ORDERS_RET911_MOCK14_VW_TBL', 'Order'),
    ('SCM_REQ_DISTRIBUTION_MOCK14_VW_TBL', 'SCM_REQ_HDR_MOCK14_VW_TBL', 'Order'),
    ('SCM_REQ_LINE_MOCK14_VW_TBL', 'SCM_REQ_HDR_MOCK14_VW_TBL', 'Requisition Number'),
    ('SCM_SUPPLIER_ADDRESSES_ASG_MOCK14_VW_TBL', 'SCM_SUPPLIER_ASG_MOCK13_VW_TBL', 'Supplier Name'),
    ('SCM_SUPPLIER_ADDRESSES_MOCK14_VW_TBL', 'SCM_SUPPLIER_MOCK14_VW_TBL', 'Supplier Name'),
    ('SCM_SUPPLIER_BANK_ACCOUNTS_MOCK14_VW_TBL', 'SCM_SUPPLIER_MOCK14_VW_TBL', 'Supplier Name'),
    ('SCM_SUPPLIER_CONTACTS_MOCK14_VW_TBL', 'SCM_SUPPLIER_MOCK14_VW_TBL', 'Supplier Name'),
    ('SCM_SUPPLIER_SITE_ASG_MOCK14_VW_TBL', 'SCM_SUPPLIER_ASG_MOCK13_VW_TBL', 'Supplier Name'),
    ('SCM_SUPPLIER_SITE_ASSIG_ASG_MOCK14_VW_TBL', 'SCM_SUPPLIER_ASG_MOCK13_VW_TBL', 'Supplier Name'),
    ('SCM_SUPPLIER_SITE_ASSIG_MOCK14_VW_TBL', 'SCM_SUPPLIER_MOCK14_VW_TBL', 'Supplier Name'),
    ('SCM_SUPPLIER_SITE_MOCK14_VW_TBL', 'SCM_SUPPLIER_MOCK14_VW_TBL', 'Supplier Name'),
    ('SCM_SUPPLIER_CONTACTS_ASG_MOCK13_VW_TBL', 'SCM_SUPPLIER_ASG_MOCK13_VW_TBL', 'Supplier Name'),
]

_TARGET_SET = set(TARGET_TABLES)


# ── Config helpers ─────────────────────────────────────────────────────────────

def _short_name(table):
    """Friendly label: strip the _MOCKnn_VW[_TBL] suffix."""
    return re.sub(r'_MOCK\d+_VW(_TBL)?$', '', table, flags=re.IGNORECASE)


def _children_of(target):
    """[(child_table, link_field), ...] for the direct children of a target."""
    return [(c, link) for (c, p, link) in RELATIONSHIPS if p == target]


def list_targets():
    """Target tables + their direct children, for the picker UI."""
    out = []
    for t in TARGET_TABLES:
        children = [{"table": c, "display": _short_name(c), "link_field": link}
                    for (c, link) in _children_of(t)]
        out.append({
            "table": t,
            "display": _short_name(t),
            "child_count": len(children),
            "children": children,
        })
    out.sort(key=lambda r: r["display"])
    return {"ok": True, "count": len(out), "targets": out}


# ── Column resolution ──────────────────────────────────────────────────────────

def _normalize(s):
    return re.sub(r'[^a-z0-9]', '', (s or '').lower())


def _table_columns(cursor, table):
    cursor.execute(
        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ? "
        "ORDER BY ORDINAL_POSITION",
        (table,),
    )
    return [r[0] for r in cursor.fetchall()]


def resolve_link_column(columns, link_field):
    """
    Map a business-key name (e.g. "Invoice Number") to a real column name.

    Exact normalized match wins; otherwise the best substring match. Returns
    None when nothing matches confidently so the caller can flag it instead of
    guessing wrong.
    """
    norm_link = _normalize(link_field)
    if not norm_link:
        return None
    norm_cols = [(c, _normalize(c)) for c in columns]
    for c, nc in norm_cols:
        if nc == norm_link:
            return c
    # substring either direction, prefer the shortest column name (most specific)
    candidates = [c for c, nc in norm_cols if nc and (norm_link in nc or nc in norm_link)]
    if candidates:
        return min(candidates, key=len)
    return None


# ── Row / Excel helpers ────────────────────────────────────────────────────────

def _coerce(v):
    """Make a DB value safe for openpyxl cells."""
    if v is None or isinstance(v, (str, int, float, bool, datetime, date)):
        return v
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, (bytes, bytearray)):
        return v.hex()
    return str(v)


def _fetch(cursor, sql, params=None):
    cursor.execute(sql, params or [])
    cols = [d[0] for d in cursor.description]
    rows = [list(r) for r in cursor.fetchall()]
    return cols, rows


_SHEET_BAD = re.compile(r'[\\/?*\[\]:]')


def _sheet_name(base, used):
    name = _SHEET_BAD.sub('_', base)[:31] or "Sheet"
    candidate, i = name, 1
    while candidate.lower() in used:
        suffix = f"_{i}"
        candidate = name[:31 - len(suffix)] + suffix
        i += 1
    used.add(candidate.lower())
    return candidate


def _add_sheet(wb, title, cols, rows):
    ws = wb.create_sheet(title=title)
    ws.append([str(c) for c in cols])
    for r in rows:
        ws.append([_coerce(v) for v in r])
    return ws


# ── Main entry point ───────────────────────────────────────────────────────────

def run_sample(conn_str, s3, bucket, target_table, sample_size, actor=""):
    """
    Select `sample_size` random records from `target_table`, gather direct child
    records linked via each relationship's business key, write an Excel workbook
    to Sampling/ and return a summary + presigned download URL.
    """
    if target_table not in _TARGET_SET:
        return {"ok": False, "error": f"'{target_table}' is not a configured sampling target table."}
    try:
        sample_size = int(sample_size)
    except (TypeError, ValueError):
        return {"ok": False, "error": "sample_size must be a number."}
    if sample_size < 1:
        return {"ok": False, "error": "sample_size must be at least 1."}
    sample_size = min(sample_size, MAX_SAMPLE_SIZE)

    with pyodbc.connect(conn_str) as conn:
        cur = conn.cursor()

        target_cols = _table_columns(cur, target_table)
        if not target_cols:
            return {"ok": False, "error": f"Target table {target_table} not found in the database."}

        # Total population (for context in the summary)
        cur.execute(f"SELECT COUNT(*) FROM [{target_table}]")
        population = cur.fetchone()[0]

        # Random N rows
        p_cols, p_rows = _fetch(
            cur, f"SELECT TOP ({sample_size}) * FROM [{target_table}] ORDER BY NEWID()"
        )
        col_idx = {c: i for i, c in enumerate(p_cols)}

        wb = openpyxl.Workbook()
        wb.remove(wb.active)  # drop default sheet
        used_sheets = set()
        _add_sheet(wb, _sheet_name(_short_name(target_table), used_sheets), p_cols, p_rows)

        child_summaries = []
        unresolved = []
        for child, link_field in _children_of(target_table):
            child_cols = _table_columns(cur, child)
            if not child_cols:
                unresolved.append({"child": child, "link_field": link_field,
                                   "reason": "child table not found"})
                continue
            p_link = resolve_link_column(p_cols, link_field)
            c_link = resolve_link_column(child_cols, link_field)
            if not p_link or not c_link:
                unresolved.append({
                    "child": child, "link_field": link_field,
                    "reason": "could not resolve link column on "
                              + ("parent" if not p_link else "child"),
                })
                continue

            key_values = sorted({
                row[col_idx[p_link]] for row in p_rows
                if row[col_idx[p_link]] is not None
            }, key=lambda x: str(x))

            child_rows, ch_cols = [], child_cols
            for i in range(0, len(key_values), IN_CHUNK):
                batch = key_values[i:i + IN_CHUNK]
                placeholders = ",".join("?" * len(batch))
                ch_cols, rows = _fetch(
                    cur,
                    f"SELECT * FROM [{child}] WHERE [{c_link}] IN ({placeholders})",
                    batch,
                )
                child_rows.extend(rows)

            _add_sheet(wb, _sheet_name(_short_name(child), used_sheets), ch_cols, child_rows)
            child_summaries.append({
                "child": child, "display": _short_name(child),
                "link_field": link_field, "parent_column": p_link,
                "child_column": c_link, "row_count": len(child_rows),
            })

    # ── Write workbook + manifest to S3 ──
    stamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    stem = f"{_short_name(target_table)}_{stamp}_{uuid.uuid4().hex[:6]}"
    xlsx_key = f"{SAMPLING_FOLDER}{stem}.xlsx"
    filename = f"{stem}.xlsx"

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    s3.put_object(
        Bucket=bucket, Key=xlsx_key, Body=buf.getvalue(),
        ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )

    manifest = {
        "target_table": target_table,
        "target_display": _short_name(target_table),
        "requested_sample_size": sample_size,
        "selected_count": len(p_rows),
        "population": population,
        "children": child_summaries,
        "unresolved_links": unresolved,
        "child_total_rows": sum(c["row_count"] for c in child_summaries),
        "actor": actor or "",
        "created_at": datetime.utcnow().isoformat() + "Z",
        "xlsx_key": xlsx_key,
        "filename": filename,
        "method": "random (ORDER BY NEWID)",
    }
    s3.put_object(
        Bucket=bucket, Key=f"{MANIFEST_FOLDER}{stem}.json",
        Body=json.dumps(manifest, default=str), ContentType="application/json",
    )

    download_url = s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket, "Key": xlsx_key,
                "ResponseContentDisposition": f'attachment; filename="{filename}"'},
        ExpiresIn=URL_TTL_SECONDS,
    )

    return {"ok": True, "download_url": download_url, **manifest}


def list_runs(s3, bucket, limit=50):
    """Recent sampling runs, newest first, from the manifest folder."""
    runs = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=MANIFEST_FOLDER):
        for obj in page.get("Contents", []):
            if not obj["Key"].endswith(".json"):
                continue
            try:
                body = s3.get_object(Bucket=bucket, Key=obj["Key"])["Body"].read()
                m = json.loads(body)
                m["_modified"] = obj["LastModified"].isoformat()
                runs.append(m)
            except Exception:
                continue
    runs.sort(key=lambda r: r.get("created_at", ""), reverse=True)
    return {"ok": True, "count": len(runs), "runs": runs[:limit]}
