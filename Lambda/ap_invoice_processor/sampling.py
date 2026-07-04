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
import unicodedata
import uuid
from collections import defaultdict
from datetime import datetime, date
from decimal import Decimal

import pyodbc
import openpyxl

SAMPLING_FOLDER = "Sampling/"
MANIFEST_FOLDER = "Sampling/_manifests/"
MAX_SAMPLE_SIZE = 5000          # guardrail
IN_CHUNK = 1000                 # values per IN(...) batch (SQL Server 2100 param cap)
URL_TTL_SECONDS = 3600

# The consolidated MOCK*_VW_TBL tables live in the Hacienda_ERP database, NOT
# the Hacienda_ERP_Test database the Lambda's connection string points at. The
# Lambda's SQL login has read access to it, so we reach the tables with
# database-qualified names ([Hacienda_ERP].[schema].[table]) rather than
# changing the global connection (which other actions need for _Test). A
# request may override this via source_db.
SOURCE_DATABASE = "Hacienda_ERP"

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
    'SCM_PURCHASE_ORDERS_FINAL_MOCK14_VW_TBL',
    'SCM_PURCHASE_ORDERS_FINAL_911_MOCK14_VW_TBL',
    'SCM_PURCHASE_ORDERS_FINAL_RETIRO_MOCK14_VW_TBL',
    'SCM_REQ_HDR_MOCK14_VW_TBL',
    'SCM_SUPPLIER_MOCK14_VW_TBL',
    'SCM_SUPPLIER_ASG_MOCK13_VW_TBL',
    'HCM_PERSON_MOCK14_BU_VW_CONVERTED_TBL',
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
    # Purchase Orders — reconciled to the actual conversion-plan tables: the PO
    # header view is *_FINAL_* and the line/location/distribution views are
    # *_BY_BU_*, each split by source (main/PRIFAS, 911, RETIRO). All children
    # link to their source's header on the Order number.
    ('SCM_PURCHASE_ORDERS_LINES_FINAL_MOCK14_BY_BU_VW', 'SCM_PURCHASE_ORDERS_FINAL_MOCK14_VW_TBL', 'Order'),
    ('SCM_PURCHASE_ORDERS_LINE_LOCATIONS_MOCK14_BY_BU_VW', 'SCM_PURCHASE_ORDERS_FINAL_MOCK14_VW_TBL', 'Order'),
    ('SCM_PURCHASE_ORDERS_LINES_DISTRIBUTION_MOCK14_BY_BU_VW', 'SCM_PURCHASE_ORDERS_FINAL_MOCK14_VW_TBL', 'Order'),
    ('SCM_PURCHASE_ORDERS_LINES_911_MOCK14_BY_BU_VW', 'SCM_PURCHASE_ORDERS_FINAL_911_MOCK14_VW_TBL', 'Order'),
    ('SCM_PURCHASE_ORDERS_LINE_LOCATIONS_911_MOCK14_BY_BU_VW', 'SCM_PURCHASE_ORDERS_FINAL_911_MOCK14_VW_TBL', 'Order'),
    ('SCM_PURCHASE_ORDERS_LINES_DISTRIBUTION_911_MOCK14_BY_BU_VW', 'SCM_PURCHASE_ORDERS_FINAL_911_MOCK14_VW_TBL', 'Order'),
    ('SCM_PURCHASE_ORDERS_LINES_ATTACHMENTS_RET911_MOCK14_VW_TBL', 'SCM_PURCHASE_ORDERS_FINAL_911_MOCK14_VW_TBL', 'Order'),
    ('SCM_PURCHASE_ORDERS_LINES_RETIRO_MOCK14_BY_BU_VW', 'SCM_PURCHASE_ORDERS_FINAL_RETIRO_MOCK14_VW_TBL', 'Order'),
    ('SCM_PURCHASE_ORDERS_LINE_LOCATIONS_RETIRO_MOCK14_BY_BU_VW', 'SCM_PURCHASE_ORDERS_FINAL_RETIRO_MOCK14_VW_TBL', 'Order'),
    ('SCM_PURCHASE_ORDERS_LINES_DISTRIBUTION_RETIRO_MOCK14_BY_BU_VW', 'SCM_PURCHASE_ORDERS_FINAL_RETIRO_MOCK14_VW_TBL', 'Order'),
    ('SCM_REQ_DISTRIBUTION_MOCK14_VW_TBL', 'SCM_REQ_HDR_MOCK14_VW_TBL', 'Order'),
    ('SCM_REQ_LINE_MOCK14_VW_TBL', 'SCM_REQ_HDR_MOCK14_VW_TBL', 'Requisition Number'),
    ('SCM_SUPPLIER_ADDRESSES_ASG_MOCK14_VW_TBL', 'SCM_SUPPLIER_ASG_MOCK13_VW_TBL', 'Supplier Name'),
    ('SCM_SUPPLIER_ADDRESSES_MOCK14_VW_TBL', 'SCM_SUPPLIER_MOCK14_VW_TBL', 'Supplier Name'),
    ('SCM_SUPPLIER_BANK_ACCOUNTS_MOCK14_VW_TBL', 'SCM_SUPPLIER_MOCK14_VW_TBL', 'Supplier Name'),
    ('SCM_SUPPLIER_CLASSIFICATION_MOCK14_VW_TBL', 'SCM_SUPPLIER_MOCK14_VW_TBL', 'Supplier Name'),
    ('SCM_SUPPLIER_CONTACTS_MOCK14_VW_TBL', 'SCM_SUPPLIER_MOCK14_VW_TBL', 'Supplier Name'),
    ('SCM_SUPPLIER_SITE_ASG_MOCK14_VW_TBL', 'SCM_SUPPLIER_ASG_MOCK13_VW_TBL', 'Supplier Name'),
    ('SCM_SUPPLIER_SITE_ASSIG_ASG_MOCK14_VW_TBL', 'SCM_SUPPLIER_ASG_MOCK13_VW_TBL', 'Supplier Name'),
    ('SCM_SUPPLIER_SITE_ASSIG_MOCK14_VW_TBL', 'SCM_SUPPLIER_MOCK14_VW_TBL', 'Supplier Name'),
    ('SCM_SUPPLIER_SITE_MOCK14_VW_TBL', 'SCM_SUPPLIER_MOCK14_VW_TBL', 'Supplier Name'),
    ('SCM_SUPPLIER_CONTACTS_ASG_MOCK13_VW_TBL', 'SCM_SUPPLIER_ASG_MOCK13_VW_TBL', 'Supplier Name'),
    # HCM Person (#9): one entity with 8 sub-entities, each its own conversion
    # table, all linking to the Person on PERSON_NUMBER. (Person External
    # Identifier's HCM_EXTERNAL_IDENTIFIER_MOCK14_ALL is a different table shape
    # and isn't wired yet.)
    ('HCM_PERSON_ADDRESS_MOCK14_BU_VW_CONVERTED_TBL', 'HCM_PERSON_MOCK14_BU_VW_CONVERTED_TBL', 'PERSON_NUMBER'),
    ('HCM_PERSON_EMAIL_MOCK14_BU_VW_CONVERTED_TBL', 'HCM_PERSON_MOCK14_BU_VW_CONVERTED_TBL', 'PERSON_NUMBER'),
    ('HCM_PERSON_NAME_MOCK14_BU_VW_CONVERTED_TBL', 'HCM_PERSON_MOCK14_BU_VW_CONVERTED_TBL', 'PERSON_NUMBER'),
    ('HCM_PERSON_NID_MOCK14_BU_VW_CONVERTED_TBL', 'HCM_PERSON_MOCK14_BU_VW_CONVERTED_TBL', 'PERSON_NUMBER'),
    ('HCM_PERSON_ASSIGNMENT_MOCK14_BU_VW_CONVERTED_TBL', 'HCM_PERSON_MOCK14_BU_VW_CONVERTED_TBL', 'PERSON_NUMBER'),
    ('HCM_PERSON_SUPERVISOR_MOCK14_BU_VW_CONVERTED_TBL', 'HCM_PERSON_MOCK14_BU_VW_CONVERTED_TBL', 'PERSON_NUMBER'),
    ('HCM_EXTERNAL_BANK_ACCOUNT_MOCK14_BU_VW_CONVERTED_TBL', 'HCM_PERSON_MOCK14_BU_VW_CONVERTED_TBL', 'PERSON_NUMBER'),
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


def list_relationships():
    """Full parent/child edge list + target tables, for client-side multi-level
    traversal (e.g. Awards -> Award Projects bridge -> Project Tasks). Config only,
    no DB/row data."""
    edges = [{"child": c, "parent": p, "link_field": link,
              "child_display": _short_name(c), "parent_display": _short_name(p)}
             for (c, p, link) in RELATIONSHIPS]
    return {"ok": True, "target_tables": list(TARGET_TABLES),
            "count": len(edges), "relationships": edges}


# ── Column resolution ──────────────────────────────────────────────────────────

def _normalize(s):
    return re.sub(r'[^a-z0-9]', '', (s or '').lower())


def _object_meta(cursor, db, table):
    """
    (schema, [columns]) for a table/view in `db`, via that database's
    INFORMATION_SCHEMA. Returns (None, []) when the object is not present.
    """
    cursor.execute(
        f"SELECT TABLE_SCHEMA, COLUMN_NAME FROM [{db}].INFORMATION_SCHEMA.COLUMNS "
        "WHERE TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
        (table,),
    )
    rows = cursor.fetchall()
    if not rows:
        return None, []
    return rows[0][0], [r[1] for r in rows]


def _qualified(db, schema, table):
    return f"[{db}].[{schema}].[{table}]"


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


def _combine(parent_cols, parent_rows, p_link, child_cols, child_rows, c_link):
    """
    Flatten a parent/child relationship into one wide table joined on the link
    (unique-identifier) column. Child columns whose name already exists on the
    parent are dropped — repeating data is ignored so the shared key/fields show
    once — and exact-duplicate rows are collapsed. Parent rows with no matching
    child appear once with the child columns blank (left join), so the sampled
    records are never lost.

    Returns (combined_columns, combined_rows).
    """
    def _idx(cols, name):
        nl = name.lower()
        for i, c in enumerate(cols):
            if c.lower() == nl:
                return i
        return None

    p_idx = _idx(parent_cols, p_link)
    c_idx = _idx(child_cols, c_link)
    if p_idx is None or c_idx is None:
        # Links were already resolved; fail safe to parent-only if not found.
        return list(parent_cols), [list(r) for r in parent_rows]

    pset = {c.lower() for c in parent_cols}
    extra = [(i, c) for i, c in enumerate(child_cols) if c.lower() not in pset]
    combined_cols = list(parent_cols) + [c for _, c in extra]

    pmap = defaultdict(list)
    for pr in parent_rows:
        pmap[pr[p_idx]].append(pr)

    rows, matched = [], set()
    for cr in child_rows:
        parents = pmap.get(cr[c_idx])
        if not parents:
            continue
        matched.add(cr[c_idx])
        tail = [cr[i] for i, _ in extra]
        for pr in parents:
            rows.append(list(pr) + tail)

    blanks = [None] * len(extra)
    for pr in parent_rows:
        if pr[p_idx] not in matched:
            rows.append(list(pr) + blanks)

    seen, out = set(), []
    for r in rows:
        k = tuple('' if v is None else str(v) for v in r)
        if k in seen:
            continue
        seen.add(k)
        out.append(r)
    return combined_cols, out


def _combine_all(parent_cols, parent_rows, children_data):
    """
    Merge the parent and ALL its children into a single flattened sheet so the
    client can sort/filter every related record in one place. Each child record
    becomes one row carrying its parent's columns alongside; a leading "Source"
    column names the originating child table. Columns shared with the parent (and
    each child's link column) appear once — duplicated data is ignored — and
    child columns are unioned by name. Parents with no children at all are kept
    as a "(parent only)" row, and exact-duplicate rows are collapsed.

    children_data: list of (display, p_link, child_cols, child_rows, c_link).
    Returns (master_columns, master_rows).
    """
    def _idx(cols, name):
        nl = (name or "").lower()
        for i, c in enumerate(cols):
            if c.lower() == nl:
                return i
        return None

    pset = {c.lower() for c in parent_cols}
    master_cols = ["Source"] + list(parent_cols)
    seen_cols = {c.lower() for c in master_cols}
    for disp, p_link, ch_cols, ch_rows, c_link in children_data:
        cl_link = (c_link or "").lower()
        for c in ch_cols:
            cl = c.lower()
            if cl in pset or cl == cl_link or cl in seen_cols:
                continue
            master_cols.append(c)
            seen_cols.add(cl)

    pos = {c.lower(): i for i, c in enumerate(master_cols)}
    width = len(master_cols)
    n_parent = len(parent_cols)

    pmaps = {}
    def _pmap(p_idx):
        if p_idx not in pmaps:
            m = defaultdict(list)
            for ri, pr in enumerate(parent_rows):
                m[pr[p_idx]].append(ri)
            pmaps[p_idx] = m
        return pmaps[p_idx]

    rows, matched = [], set()
    for disp, p_link, ch_cols, ch_rows, c_link in children_data:
        p_idx = _idx(parent_cols, p_link)
        c_idx = _idx(ch_cols, c_link)
        if p_idx is None or c_idx is None:
            continue
        m = _pmap(p_idx)
        for cr in ch_rows:
            pris = m.get(cr[c_idx])
            if not pris:
                continue
            for ri in pris:
                matched.add(ri)
                pr = parent_rows[ri]
                row = [None] * width
                row[0] = disp
                for j in range(n_parent):
                    row[1 + j] = pr[j]
                for k, c in enumerate(ch_cols):
                    p = pos.get(c.lower())
                    if p is not None and p > n_parent:  # child-union cols only
                        row[p] = cr[k]
                rows.append(row)

    for ri, pr in enumerate(parent_rows):
        if ri not in matched:
            row = [None] * width
            row[0] = "(parent only)"
            for j in range(n_parent):
                row[1 + j] = pr[j]
            rows.append(row)

    seen_rows, out = set(), []
    for r in rows:
        k = tuple('' if v is None else str(v) for v in r)
        if k in seen_rows:
            continue
        seen_rows.add(k)
        out.append(r)
    return master_cols, out


# ── Main entry point ───────────────────────────────────────────────────────────

def run_sample(conn_str, s3, bucket, target_table, sample_size, actor="",
               source_db=None, combine_all=False):
    """
    Select `sample_size` random records from `target_table`, gather direct child
    records linked via each relationship's business key, write an Excel workbook
    to Sampling/ and return a summary + presigned download URL.

    Tables are read from `source_db` (default SOURCE_DATABASE) using
    database-qualified names, so the Lambda's _Test connection can reach the
    consolidated tables that live in Hacienda_ERP.
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
    db = source_db or SOURCE_DATABASE

    with pyodbc.connect(conn_str) as conn:
        cur = conn.cursor()

        t_schema, target_cols = _object_meta(cur, db, target_table)
        if not target_cols:
            return {"ok": False, "error": f"Target table {target_table} not found in database {db}."}
        target_fq = _qualified(db, t_schema, target_table)

        # Total population (for context in the summary)
        cur.execute(f"SELECT COUNT(*) FROM {target_fq}")
        population = cur.fetchone()[0]

        # Random N rows
        p_cols, p_rows = _fetch(
            cur, f"SELECT TOP ({sample_size}) * FROM {target_fq} ORDER BY NEWID()"
        )
        col_idx = {c: i for i, c in enumerate(p_cols)}

        wb = openpyxl.Workbook()
        wb.remove(wb.active)  # drop default sheet
        used_sheets = set()

        child_summaries = []
        unresolved = []
        children = _children_of(target_table)

        if not children:
            # Standalone target (no children) — just its own records, like the
            # example workbook's "Budget Balance MC2" sheet.
            _add_sheet(wb, _sheet_name(_short_name(target_table), used_sheets), p_cols, p_rows)
        else:
            # Resolve + fetch every child once, then render either one combined
            # sheet per child, or (combine_all) a single merged master sheet.
            resolved = []
            for child, link_field in children:
                c_schema, child_cols = _object_meta(cur, db, child)
                if not child_cols:
                    unresolved.append({"child": child, "link_field": link_field,
                                       "reason": f"child table not found in {db}"})
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

                child_fq = _qualified(db, c_schema, child)
                child_rows, ch_cols = [], child_cols
                for i in range(0, len(key_values), IN_CHUNK):
                    batch = key_values[i:i + IN_CHUNK]
                    placeholders = ",".join("?" * len(batch))
                    ch_cols, rows = _fetch(
                        cur,
                        f"SELECT * FROM {child_fq} WHERE [{c_link}] IN ({placeholders})",
                        batch,
                    )
                    child_rows.extend(rows)

                resolved.append({
                    "child": child, "display": _short_name(child),
                    "link_field": link_field, "p_link": p_link, "c_link": c_link,
                    "ch_cols": ch_cols, "child_rows": child_rows,
                })
                child_summaries.append({
                    "child": child, "display": _short_name(child),
                    "link_field": link_field, "parent_column": p_link,
                    "child_column": c_link, "row_count": len(child_rows),
                })

            if combine_all and resolved:
                # One master sheet: parent + all children unioned on the link
                # field, so the client can sort/filter all data in one place.
                children_data = [(r["display"], r["p_link"], r["ch_cols"],
                                  r["child_rows"], r["c_link"]) for r in resolved]
                m_cols, m_rows = _combine_all(p_cols, p_rows, children_data)
                _add_sheet(wb, _sheet_name(_short_name(target_table), used_sheets), m_cols, m_rows)
            else:
                # One combined, flattened sheet per child.
                for r in resolved:
                    comb_cols, comb_rows = _combine(
                        p_cols, p_rows, r["p_link"], r["ch_cols"], r["child_rows"], r["c_link"]
                    )
                    _add_sheet(wb, _sheet_name(r["display"], used_sheets), comb_cols, comb_rows)

            # If every child was unresolved, still write the parent sample so the
            # workbook isn't empty and the selection isn't lost.
            if not wb.sheetnames:
                _add_sheet(wb, _sheet_name(_short_name(target_table), used_sheets), p_cols, p_rows)

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
        "source_db": db,
        "combine_all": bool(combine_all),
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


# ── Entity-file readiness (from SETUP_CONVERSION_PLAN_{mock}) ──────────────────
# The conversion plan defines, per entity/source/BU, the conversion table the
# generation scripts export to a CV_ file. This powers the Entity Files tab:
# what's expected, whether the table is populated, and (client-side) whether the
# file has been uploaded.
ENTITY_PLAN_COLUMNS = [
    'Pillar', 'Module', 'Entity', 'SubEntity', 'SOURCE', 'BU',
    'CONVERSION_TABLE_BU', 'CONVERSION_TABLE_SourceField', 'CONVERSION_TABLE_BU_Field',
    'Conversion_Table_Sourcefield_ForSampling', 'FileImportStatus', 'SourceFileName',
]


def list_entity_plan(conn_str, mock='MOCK14', source_db=None, with_counts=False):
    db = source_db or SOURCE_DATABASE
    plan_table = f"SETUP_CONVERSION_PLAN_{mock}"
    with pyodbc.connect(conn_str) as conn:
        cur = conn.cursor()
        cur.execute(
            f"SELECT COUNT(*) FROM [{db}].INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = ?",
            (plan_table,),
        )
        if cur.fetchone()[0] == 0:
            return {"ok": False, "error": f"{plan_table} not found in {db}"}

        # Which of the requested columns actually exist (schema varies by mock).
        cur.execute(
            f"SELECT COLUMN_NAME FROM [{db}].INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ?",
            (plan_table,),
        )
        have = {r[0].lower() for r in cur.fetchall()}
        cols = [c for c in ENTITY_PLAN_COLUMNS if c.lower() in have]
        sel = ", ".join(f"[{c}]" for c in cols)
        enrich = "AND ISNULL([ENRICHMENT_SYSTEM],'') <> 'Y'" if 'enrichment_system' in have else ""
        cur.execute(
            f"SELECT {sel} FROM [{db}].[dbo].[{plan_table}] "
            f"WHERE ISNULL([CONVERSION_TABLE_BU],'') <> '' {enrich} "
            f"ORDER BY [Pillar],[Module],[Entity],[SubEntity]"
        )
        rows = cur.fetchall()
        out = []
        for r in rows:
            out.append({cols[i]: (str(r[i]).strip() if r[i] is not None else '') for i in range(len(cols))})

        counts = {}
        if with_counts:
            tables = sorted({rec.get('CONVERSION_TABLE_BU', '') for rec in out if rec.get('CONVERSION_TABLE_BU')})
            for t in tables:
                cur.execute(
                    f"SELECT COUNT(*) FROM [{db}].INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ?",
                    (t,),
                )
                if cur.fetchone()[0] == 0:
                    counts[t] = None  # object missing
                    continue
                try:
                    cur.execute(f"SELECT COUNT(*) FROM [{db}].[dbo].[{t}]")
                    counts[t] = cur.fetchone()[0]
                except Exception:
                    counts[t] = None
            for rec in out:
                rec['tableRows'] = counts.get(rec.get('CONVERSION_TABLE_BU', ''))

    return {"ok": True, "mock": mock, "count": len(out), "rows": out}


# ── Entity-file generation (server-side equivalent of the ConvertedFilesBySource
# scripts) ────────────────────────────────────────────────────────────────────
# For one entity, read its conversion tables from SETUP_CONVERSION_PLAN_{mock},
# split each by its source field (and BU field) and write one CV_ file per
# source[/BU] into Sampling/Generated/{mock}/{entity}/ — the raw parent+child
# set that feeds the merge + sampling. dry_run previews (counts, no writes).
GENERATED_FOLDER = "Sampling/Generated/"
GENERATED_MANIFEST_FOLDER = GENERATED_FOLDER + "_manifests/"
XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
GEN_MAX_FILES = 400  # safety cap per run


def _safe_name(s):
    return re.sub(r'[^A-Za-z0-9]+', '_', str(s or '')).strip('_') or 'NA'


def _table_prefix(t):
    for s in ['_VW_CONVERTED_TBL', 'CONVERTED_VW', 'VW_CONVERTED', 'VW_TBL', 'VW_tbl', 'VW', 'TBL']:
        t = t.replace(s, '')
    return t.strip('_').rstrip('_')


def _clean_name(s):
    # Mirror the conversion scripts' CLEAN_STRING_V4 on plan field names: strip
    # accents, collapse internal whitespace, lower-case. So a plan field with
    # padding/accents still resolves to its column and its table is not skipped.
    s = unicodedata.normalize('NFKD', str(s or '')).encode('ascii', 'ignore').decode('ascii')
    return re.sub(r'\s+', ' ', s).strip().lower()


def _resolve_col(cols, name):
    nl = _clean_name(name)
    if not nl:
        return None
    for c in cols:
        if _clean_name(c) == nl:
            return c
    # last resort: alphanumeric-only match (punctuation differences)
    an = re.sub(r'[^a-z0-9]', '', nl)
    if an:
        for c in cols:
            if re.sub(r'[^a-z0-9]', '', _clean_name(c)) == an:
                return c
    return None


def _rows_to_xlsx_bytes(headers, rows):
    wb = openpyxl.Workbook(write_only=True)
    ws = wb.create_sheet()
    ws.append([str(h) for h in headers])
    for r in rows:
        ws.append([_coerce(v) for v in r])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _write_gen_manifest(s3, bucket, mock, entity, subentity, db, actor,
                        out_prefix, generated, missing, capped=None, bu_filter=None,
                        empties=None):
    """Audit trail for one generation run: which CV_ files were written, from
    which conversion table / source / BU, their row counts, and who ran it and
    when. Lets a suspect generated file be traced back to its source later.
    Written alongside the files under Sampling/Generated/_manifests/."""
    stamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    key = f"{GENERATED_MANIFEST_FOLDER}{mock}/{_safe_name(entity)}/{stamp}_{uuid.uuid4().hex[:6]}.json"
    manifest = {
        "mock": mock,
        "entity": entity,
        "subentity": subentity or "",
        "source_db": db,
        "actor": actor or "",
        "created_at": datetime.utcnow().isoformat() + "Z",
        "folder": out_prefix,
        "file_count": len(generated),
        "total_rows": sum(g.get("rows", 0) for g in generated),
        "generated": generated,
        "missing": missing,
        "empties": empties or [],
    }
    if bu_filter:
        manifest["bu_filter"] = bu_filter
    if capped:
        manifest["capped"] = capped
    try:
        s3.put_object(Bucket=bucket, Key=key,
                      Body=json.dumps(manifest, default=str),
                      ContentType="application/json")
    except Exception:
        return None
    return key


def _empty_entry(table, prefix, bu_filter, reason):
    """One record for an expected conversion table that produced no file this run,
    so the UI can distinguish empty / not-built from never-generated (both would
    otherwise just look 'missing'). reason ∈ not_built | no_source_field |
    empty_table | no_rows_for_bu."""
    return {"table": table, "prefix": prefix, "source": "",
            "bu": bu_filter or "", "rows": 0, "reason": reason}


def generate_entity_files(conn_str, s3, bucket, mock, entity, subentity=None,
                          dry_run=False, source_db=None, actor="", bu_filter=None):
    # bu_filter: when set, only source[/BU] splits whose source OR BU value equals
    # it are generated — so one agency's files can be produced in a small, fast
    # call (no 400-file cap / Lambda timeout) instead of the whole entity at once.
    bu_filter = (str(bu_filter).strip() if bu_filter not in (None, "") else None)
    db = source_db or SOURCE_DATABASE
    plan_table = f"SETUP_CONVERSION_PLAN_{mock}"
    out_prefix = f"{GENERATED_FOLDER}{mock}/{_safe_name(entity)}/"
    planned, generated, missing, empties = [], [], [], []

    with pyodbc.connect(conn_str) as conn:
        cur = conn.cursor()
        cur.execute(f"SELECT COUNT(*) FROM [{db}].INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = ?", (plan_table,))
        if cur.fetchone()[0] == 0:
            return {"ok": False, "error": f"{plan_table} not found in {db}"}

        where = ("ISNULL([CONVERSION_TABLE_BU],'') <> '' AND ISNULL([ENRICHMENT_SYSTEM],'') <> 'Y' "
                 "AND ISNULL([CONVERSION_TABLE_SourceField],'') <> '' AND [Entity] = ?")
        params = [entity]
        if subentity:
            where += " AND [SubEntity] = ?"
            params.append(subentity)
        cur.execute(
            f"SELECT DISTINCT [CONVERSION_TABLE_BU],[CONVERSION_TABLE_SourceField],[CONVERSION_TABLE_BU_Field] "
            f"FROM [{db}].[dbo].[{plan_table}] WHERE {where} ORDER BY 1", params)
        plans = cur.fetchall()

        for (table, src_field, bu_field) in plans:
            table = (table or '').strip()
            src_field = (src_field or '').strip()
            bu_field = (bu_field or '').strip()
            if not table or not src_field:
                continue
            prefix = _table_prefix(table)
            _, cols = _object_meta(cur, db, table)
            if not cols:
                missing.append(table)
                empties.append(_empty_entry(table, prefix, bu_filter, "not_built"))
                continue
            src_col = _resolve_col(cols, src_field)
            if not src_col:
                missing.append(f"{table} (no source field '{src_field}')")
                empties.append(_empty_entry(table, prefix, bu_filter, "no_source_field"))
                continue
            bu_col = _resolve_col(cols, bu_field) if bu_field else None
            fq = f"[{db}].[dbo].[{table}]"

            # Distinct source[/BU] combinations (excluding the header-as-value quirk).
            if bu_col and bu_col.lower() != src_col.lower():
                cur.execute(f"SELECT DISTINCT [{src_col}],[{bu_col}] FROM {fq} WHERE [{src_col}] <> ?", (src_field,))
            else:
                bu_col = None
                cur.execute(f"SELECT DISTINCT [{src_col}] FROM {fq} WHERE [{src_col}] <> ?", (src_field,))
            combos = cur.fetchall()

            used_names = set()
            produced = 0  # files this table yields for the current run / BU filter
            for combo in combos:
                raw_source = combo[0]
                if raw_source is None:
                    continue  # NULL source: excluded by the enumeration and by the scripts
                source = str(raw_source).strip()
                has_bu = bool(bu_col) and len(combo) > 1 and combo[1] is not None
                raw_bu = combo[1] if has_bu else None
                bu = str(raw_bu).strip() if has_bu else ''
                if bu_filter and bu_filter not in (source, bu):
                    continue  # per-BU generation: skip splits for other agencies
                produced += 1
                # Match on the EXACT stored value (like the scripts) so blank or
                # padded source / BU values are captured, not skipped or mismatched.
                # A value that is blank after trimming is named "NA" in the file.
                if has_bu:
                    fname = f"CV_{prefix}__{_safe_name(source)}_{_safe_name(bu)}.xlsx"
                    cond = f"WHERE [{src_col}] = ? AND [{bu_col}] = ?"
                    args = (raw_source, raw_bu)
                else:
                    fname = f"CV_{prefix}__{_safe_name(source)}.xlsx"
                    cond = f"WHERE [{src_col}] = ?"
                    args = (raw_source,)
                base = fname[:-5]
                k = 2
                while fname in used_names:
                    fname = f"{base}_{k}.xlsx"
                    k += 1
                used_names.add(fname)

                if dry_run:
                    cur.execute(f"SELECT COUNT(*) FROM {fq} {cond}", args)
                    planned.append({"file": fname, "table": table, "source": source, "bu": bu,
                                    "rows": cur.fetchone()[0]})
                    continue

                if len(generated) >= GEN_MAX_FILES:
                    cap = f"stopped at {GEN_MAX_FILES} files"
                    mkey = _write_gen_manifest(s3, bucket, mock, entity, subentity, db,
                                               actor, out_prefix, generated, missing, capped=cap,
                                               bu_filter=bu_filter, empties=empties)
                    return {"ok": True, "entity": entity, "mock": mock, "folder": out_prefix,
                            "generated": generated, "missing": missing, "empties": empties,
                            "capped": cap, "manifest_key": mkey}

                cur.execute(f"SELECT * FROM {fq} {cond}", args)
                headers = [d[0] for d in cur.description]
                rows = cur.fetchall()
                s3.put_object(Bucket=bucket, Key=out_prefix + fname,
                              Body=_rows_to_xlsx_bytes(headers, rows), ContentType=XLSX_CONTENT_TYPE)
                generated.append({"file": fname, "key": out_prefix + fname, "table": table,
                                  "source": source, "bu": bu, "rows": len(rows)})

            if produced == 0:  # table exists but yielded no file for this run/BU
                empties.append(_empty_entry(
                    table, prefix, bu_filter,
                    "no_rows_for_bu" if bu_filter else "empty_table"))

    if dry_run:
        return {"ok": True, "entity": entity, "mock": mock, "dry_run": True,
                "folder": out_prefix, "planned": planned, "missing": missing,
                "empties": empties, "plan_count": len(plans)}
    mkey = _write_gen_manifest(s3, bucket, mock, entity, subentity, db, actor,
                               out_prefix, generated, missing, bu_filter=bu_filter,
                               empties=empties)
    return {"ok": True, "entity": entity, "mock": mock, "folder": out_prefix,
            "generated": generated, "missing": missing, "empties": empties,
            "manifest_key": mkey}
