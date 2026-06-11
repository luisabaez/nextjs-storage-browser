"""
file_config_admin.py
====================
Phase 6.2 — backend for the File Configuration dashboard tab.

Lets users manage file-level metadata directly in SQL Server without
re-uploading a Conversion Plan Excel:

  * List, view, edit each SETUP_CONVERSION_PLAN_{MOCK} row.
  * Set File_Expected, Parent_Entity, Validation_Group_ID per entity.
  * Set Members_Total on the Validation Group so auto-trigger logic can fire.
  * Define column mappings (file header -> table column) in
    FILE_COLUMN_MAPPINGS_{MOCK}.
  * Add a NEW entity row (used when onboarding files outside the Excel spec).
  * Create the target SQL table from a list of {column_name, data_type}.
  * Browse existing SQL tables and their columns for the column mapper.

Every function returns a JSON-ready dict. Never raises.
"""
from datetime import datetime
from typing import Optional

import pyodbc


# ─────────────────────────────────────────────────────────────────────────────
# 1. List + detail
# ─────────────────────────────────────────────────────────────────────────────
def list_file_configs(connection_str: str, mock_number: str,
                      module: Optional[str] = None,
                      search: Optional[str] = None) -> dict:
    """List all entities in SETUP_CONVERSION_PLAN_{MOCK}."""
    table = f"SETUP_CONVERSION_PLAN_{mock_number}"
    try:
        with pyodbc.connect(connection_str) as conn:
            cur = conn.cursor()
            cur.execute("SELECT COUNT(*) FROM sys.tables WHERE name = ?", (table,))
            if cur.fetchone()[0] == 0:
                return {"ok": True, "rows": [], "note": f"{table} does not exist"}

            where = []
            args = []
            if module:
                where.append("Module = ?")
                args.append(module)
            if search:
                where.append("(Entity LIKE ? OR SubEntity LIKE ? OR Table_Name LIKE ? OR FileName LIKE ?)")
                like = f"%{search}%"
                args.extend([like, like, like, like])
            where_clause = ("WHERE " + " AND ".join(where)) if where else ""

            cur.execute(
                f"""
                SELECT
                    Pillar, Module, Entity, SubEntity, [SOURCE], Table_Name,
                    File_Expected, Validation_Group_ID, Parent_Entity,
                    Mock_Number, Current_Process_Stage, Latest_File_ID,
                    Latest_File_Upload_Date, Total_Upload_Attempts,
                    Latest_Validation_Status, Latest_Approval_Status,
                    BU, FileName, [RowCount], LoadedAt, LoadedBy
                FROM [{table}]
                {where_clause}
                ORDER BY Pillar, Module, Entity, [SOURCE]
                """,
                args,
            )
            cols = [c[0] for c in cur.description]
            rows = [dict(zip(cols, r)) for r in cur.fetchall()]
            return {"ok": True, "mock_number": mock_number, "count": len(rows), "rows": rows}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def get_file_config_detail(connection_str: str, mock_number: str,
                            entity: str, source: str) -> dict:
    """Full detail for a single entity+source pair."""
    table = f"SETUP_CONVERSION_PLAN_{mock_number}"
    mapping_table = f"FILE_COLUMN_MAPPINGS_{mock_number}"
    try:
        with pyodbc.connect(connection_str) as conn:
            cur = conn.cursor()

            cur.execute(f"SELECT COUNT(*) FROM sys.tables WHERE name = ?", (table,))
            if cur.fetchone()[0] == 0:
                return {"ok": False, "error": f"{table} does not exist"}

            cur.execute(
                f"""
                SELECT * FROM [{table}]
                WHERE LTRIM(RTRIM(ISNULL([Entity], ''))) = ?
                  AND LTRIM(RTRIM(ISNULL([SOURCE], ''))) = ?
                """,
                (entity, source),
            )
            row = cur.fetchone()
            if not row:
                return {"ok": False, "error": f"No row for entity='{entity}' source='{source}' in {table}"}
            cols = [c[0] for c in cur.description]
            detail = dict(zip(cols, row))

            # Column mappings (may be empty)
            mappings = []
            cur.execute("SELECT COUNT(*) FROM sys.tables WHERE name = ?", (mapping_table,))
            if cur.fetchone()[0] > 0:
                cur.execute(
                    f"""
                    SELECT Mapping_ID, File_Header, Table_Column, Header_Order,
                           Sample_Value, Data_Type, Is_Required, Notes
                    FROM [{mapping_table}]
                    WHERE Entity = ? AND [Source] = ?
                    ORDER BY Header_Order, File_Header
                    """,
                    (entity, source),
                )
                mcols = [c[0] for c in cur.description]
                mappings = [dict(zip(mcols, r)) for r in cur.fetchall()]

            # Files loaded for this entity (from AWS_FILES)
            cur.execute(
                """
                SELECT TOP 20
                    AWS_eTag, Movement_Sequence, File_Name, File_Status,
                    Record_Count, Received_DateTime, Processed_DateTime,
                    Supersedes_eTag, Superseded_By_eTag
                FROM AWS_FILES
                WHERE Mock_Number = ?
                  AND ((Conversion_Plan_Entity = ?) OR (Data_Entity = ?))
                  AND ([Source] = ?)
                ORDER BY Received_DateTime DESC, Movement_Sequence
                """,
                (mock_number, entity, entity, source),
            )
            fcols = [c[0] for c in cur.description]
            files = [dict(zip(fcols, r)) for r in cur.fetchall()]

            # Children (other rows whose Parent_Entity = this entity)
            children = []
            if "Parent_Entity" in cols:
                cur.execute(
                    f"""
                    SELECT Entity, SubEntity, [SOURCE], Table_Name, File_Expected
                    FROM [{table}]
                    WHERE LTRIM(RTRIM(ISNULL([Parent_Entity], ''))) = ?
                    """,
                    (entity,),
                )
                ccols = [c[0] for c in cur.description]
                children = [dict(zip(ccols, r)) for r in cur.fetchall()]

            return {
                "ok": True,
                "detail": detail,
                "column_mappings": mappings,
                "loaded_files": files,
                "children": children,
            }
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"ok": False, "error": str(e)}


# ─────────────────────────────────────────────────────────────────────────────
# 2. Update existing config
# ─────────────────────────────────────────────────────────────────────────────
_EDITABLE_FIELDS = {
    "File_Expected", "Validation_Group_ID", "Parent_Entity",
    "Table_Name", "FileName", "BU", "LOAD_REQUIRED",
    "Module", "Pillar", "Entity", "SubEntity",
    "Notes", "Mock_Number",
}


def update_file_config(connection_str: str, mock_number: str,
                       entity: str, source: str,
                       updates: dict, actor: str = "") -> dict:
    """Update editable fields on a SETUP_CONVERSION_PLAN row."""
    table = f"SETUP_CONVERSION_PLAN_{mock_number}"
    safe_updates = {k: v for k, v in (updates or {}).items() if k in _EDITABLE_FIELDS}
    if not safe_updates:
        return {"ok": False, "error": "No editable fields supplied"}

    try:
        with pyodbc.connect(connection_str) as conn:
            cur = conn.cursor()
            cur.execute("SELECT name FROM sys.columns WHERE object_id = OBJECT_ID(?)", (table,))
            existing = {row[0] for row in cur.fetchall()}
            if not existing:
                return {"ok": False, "error": f"{table} does not exist"}

            set_parts = []
            args = []
            for k, v in safe_updates.items():
                if k not in existing:
                    continue
                set_parts.append(f"[{k}] = ?")
                args.append(v if v != "" else None)
            if not set_parts:
                return {"ok": False, "error": "No valid columns to update"}

            now = datetime.utcnow()
            if "Last_Updated_By" in existing:
                set_parts.append("[Last_Updated_By] = ?")
                args.append(actor or "file_config_admin")
            if "Last_Updated_Date" in existing:
                set_parts.append("[Last_Updated_Date] = ?")
                args.append(now)

            update_sql = (
                f"UPDATE [{table}] SET {', '.join(set_parts)} "
                f"WHERE LTRIM(RTRIM(ISNULL([Entity], ''))) = ? "
                f"AND LTRIM(RTRIM(ISNULL([SOURCE], ''))) = ?"
            )
            cur.execute(update_sql, (*args, entity, source))
            affected = cur.rowcount
            conn.commit()
            return {"ok": True, "rows_updated": affected, "updated_fields": list(safe_updates.keys())}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"ok": False, "error": str(e)}


def update_validation_group(connection_str: str, mock_number: str,
                            vg_id: str, members_total: Optional[int] = None,
                            error_threshold: Optional[int] = None,
                            actor: str = "") -> dict:
    """Edit Members_Total / Error_Threshold on a Validation Group."""
    vg_table = f"VALIDATION_GROUPS_{mock_number}"
    try:
        with pyodbc.connect(connection_str) as conn:
            cur = conn.cursor()
            cur.execute("SELECT COUNT(*) FROM sys.tables WHERE name = ?", (vg_table,))
            if cur.fetchone()[0] == 0:
                return {"ok": False, "error": f"{vg_table} does not exist"}

            sets = []
            args = []
            if members_total is not None:
                sets.append("Members_Total = ?")
                args.append(int(members_total))
            if error_threshold is not None:
                sets.append("Error_Threshold = ?")
                args.append(int(error_threshold))
            if not sets:
                return {"ok": False, "error": "Nothing to update"}

            now = datetime.utcnow()
            sets += ["Last_Updated_By = ?", "Last_Updated_DateTime = ?"]
            args += [actor or "file_config_admin", now]

            cur.execute(
                f"UPDATE {vg_table} SET {', '.join(sets)} WHERE Validation_Group_ID = ?",
                (*args, vg_id),
            )
            affected = cur.rowcount
            conn.commit()
            return {"ok": True, "rows_updated": affected}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ─────────────────────────────────────────────────────────────────────────────
# 3. Add new entity (without uploading a file first)
# ─────────────────────────────────────────────────────────────────────────────
def add_file_entity(connection_str: str, mock_number: str,
                    payload: dict, actor: str = "") -> dict:
    """
    INSERTs a row into SETUP_CONVERSION_PLAN_{MOCK} for a new entity.

    Required keys in payload:
        Entity, Source, Table_Name
    Optional keys:
        Pillar, Module, SubEntity, FileName, Parent_Entity, Validation_Group_ID,
        File_Expected (defaults 'Y'), BU
    """
    table = f"SETUP_CONVERSION_PLAN_{mock_number}"

    required = ("Entity", "Source", "Table_Name")
    missing = [r for r in required if not payload.get(r)]
    if missing:
        return {"ok": False, "error": f"Missing required fields: {', '.join(missing)}"}

    try:
        with pyodbc.connect(connection_str) as conn:
            cur = conn.cursor()
            cur.execute("SELECT COUNT(*) FROM sys.tables WHERE name = ?", (table,))
            if cur.fetchone()[0] == 0:
                return {"ok": False, "error": f"{table} does not exist — run Phase 1 migration first"}

            cur.execute(
                f"""
                SELECT COUNT(*) FROM [{table}]
                WHERE LTRIM(RTRIM(ISNULL([Entity], ''))) = ?
                  AND LTRIM(RTRIM(ISNULL([SOURCE], ''))) = ?
                """,
                (payload["Entity"], payload["Source"]),
            )
            if cur.fetchone()[0] > 0:
                return {"ok": False, "error":
                        f"Entity '{payload['Entity']}' / Source '{payload['Source']}' "
                        f"already exists in {table}"}

            cur.execute("SELECT name FROM sys.columns WHERE object_id = OBJECT_ID(?)", (table,))
            existing_cols = {row[0] for row in cur.fetchall()}

            values = {
                "Pillar": payload.get("Pillar"),
                "Module": payload.get("Module"),
                "Entity": payload["Entity"],
                "SubEntity": payload.get("SubEntity") or payload["Entity"],
                "Data_Sources": payload.get("Source"),
                "SOURCE": payload["Source"],
                "Table_Name": payload["Table_Name"],
                "FileName": payload.get("FileName"),
                "Parent_Entity": payload.get("Parent_Entity"),
                "Validation_Group_ID": payload.get("Validation_Group_ID"),
                "File_Expected": payload.get("File_Expected", "Y"),
                "Mock_Number": mock_number,
                "BU": payload.get("BU"),
                "LOAD_REQUIRED": payload.get("LOAD_REQUIRED", "YES"),
                "Last_Updated_By": actor or "file_config_admin",
                "Last_Updated_Date": datetime.utcnow(),
            }
            values = {k: v for k, v in values.items()
                      if k in existing_cols and v is not None}

            if not values:
                return {"ok": False, "error": "No matching columns found on table"}

            col_list = ", ".join(f"[{c}]" for c in values.keys())
            placeholders = ", ".join(["?"] * len(values))
            cur.execute(
                f"INSERT INTO [{table}] ({col_list}) VALUES ({placeholders})",
                tuple(values.values()),
            )
            conn.commit()
            return {"ok": True, "inserted_into": table, "entity": payload["Entity"],
                    "source": payload["Source"], "fields_set": list(values.keys())}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"ok": False, "error": str(e)}


# ─────────────────────────────────────────────────────────────────────────────
# 4. SQL table discovery + column mapping
# ─────────────────────────────────────────────────────────────────────────────
def list_sql_tables(connection_str: str, prefix: Optional[str] = None) -> dict:
    """List user-defined tables for the table picker."""
    try:
        with pyodbc.connect(connection_str) as conn:
            cur = conn.cursor()
            if prefix:
                cur.execute(
                    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES "
                    "WHERE TABLE_TYPE='BASE TABLE' AND TABLE_NAME LIKE ? "
                    "ORDER BY TABLE_NAME",
                    (f"{prefix}%",),
                )
            else:
                cur.execute(
                    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES "
                    "WHERE TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME"
                )
            tables = [row[0] for row in cur.fetchall()]
            return {"ok": True, "count": len(tables), "tables": tables}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def get_sql_table_columns(connection_str: str, table: str) -> dict:
    """Column metadata for the column mapping UI."""
    try:
        with pyodbc.connect(connection_str) as conn:
            cur = conn.cursor()
            cur.execute(
                """
                SELECT COLUMN_NAME, DATA_TYPE,
                       CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE,
                       IS_NULLABLE, ORDINAL_POSITION
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_NAME = ?
                ORDER BY ORDINAL_POSITION
                """,
                (table,),
            )
            cols = []
            for r in cur.fetchall():
                cols.append({
                    "name": r[0],
                    "data_type": r[1],
                    "char_length": r[2],
                    "numeric_precision": r[3],
                    "numeric_scale": r[4],
                    "is_nullable": r[5],
                    "ordinal_position": r[6],
                })
            if not cols:
                return {"ok": False, "error": f"Table {table} not found or has no columns"}
            return {"ok": True, "table": table, "columns": cols}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def save_column_mapping(connection_str: str, mock_number: str,
                        entity: str, source: str, table_name: str,
                        mappings: list[dict], actor: str = "") -> dict:
    """
    Replace the column mapping rows for a given (entity, source, mock).

    Each mapping dict: {file_header, table_column, header_order,
                        sample_value, data_type, is_required, notes}
    """
    mapping_table = f"FILE_COLUMN_MAPPINGS_{mock_number}"
    try:
        with pyodbc.connect(connection_str) as conn:
            cur = conn.cursor()
            cur.execute("SELECT COUNT(*) FROM sys.tables WHERE name = ?", (mapping_table,))
            if cur.fetchone()[0] == 0:
                return {"ok": False, "error": f"{mapping_table} does not exist"}

            cur.execute(
                f"DELETE FROM [{mapping_table}] WHERE Entity = ? AND [Source] = ?",
                (entity, source),
            )
            deleted = cur.rowcount

            now = datetime.utcnow()
            inserted = 0
            for m in mappings or []:
                fh = (m.get("file_header") or "").strip()
                if not fh:
                    continue
                cur.execute(
                    f"""
                    INSERT INTO [{mapping_table}]
                    (Mock_Number, Entity, [Source], Table_Name,
                     File_Header, Table_Column, Header_Order,
                     Sample_Value, Data_Type, Is_Required, Notes,
                     Created_By, Last_Updated_By, Last_Updated_DateTime)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (mock_number, entity, source, table_name or None,
                     fh, m.get("table_column") or None,
                     int(m.get("header_order") or 0),
                     m.get("sample_value") or None,
                     m.get("data_type") or None,
                     "Y" if m.get("is_required") else "N",
                     m.get("notes") or None,
                     actor or "file_config_admin",
                     actor or "file_config_admin",
                     now),
                )
                inserted += 1
            conn.commit()
            return {"ok": True, "deleted": deleted, "inserted": inserted}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"ok": False, "error": str(e)}


# ─────────────────────────────────────────────────────────────────────────────
# 5. Create SQL table for a new entity
# ─────────────────────────────────────────────────────────────────────────────
def create_sql_table(connection_str: str, table_name: str,
                      columns: list[dict], actor: str = "") -> dict:
    """
    DDL helper — CREATE TABLE [name] (col1 TYPE NULL, col2 TYPE NULL, ...).
    Each column dict: {name, data_type, length?, nullable?}

    Safety:
      - Refuses if the table already exists.
      - Refuses any column with invalid identifier characters.
      - Defaults all columns to NVARCHAR(500) NULL if data_type not given.
    """
    import re as _re
    ident_ok = _re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
    if not ident_ok.match(table_name or ""):
        return {"ok": False, "error": "table_name must be a valid identifier"}

    parts = []
    for c in columns or []:
        name = (c.get("name") or "").strip()
        if not ident_ok.match(name):
            return {"ok": False, "error": f"Invalid column name: {name}"}
        dtype = (c.get("data_type") or "NVARCHAR").upper()
        length = c.get("length")
        nullable = c.get("nullable", True)
        if dtype in ("NVARCHAR", "VARCHAR", "CHAR", "NCHAR"):
            length_clause = f"({length})" if (length and str(length).upper() != "MAX") else (
                "(MAX)" if length and str(length).upper() == "MAX" else "(500)"
            )
            parts.append(f"[{name}] {dtype}{length_clause} {'NULL' if nullable else 'NOT NULL'}")
        elif dtype in ("DECIMAL", "NUMERIC"):
            prec = c.get("precision") or 18
            scale = c.get("scale") or 2
            parts.append(f"[{name}] {dtype}({prec},{scale}) {'NULL' if nullable else 'NOT NULL'}")
        else:
            parts.append(f"[{name}] {dtype} {'NULL' if nullable else 'NOT NULL'}")
    if not parts:
        return {"ok": False, "error": "No columns supplied"}

    try:
        with pyodbc.connect(connection_str) as conn:
            cur = conn.cursor()
            cur.execute("SELECT COUNT(*) FROM sys.tables WHERE name = ?", (table_name,))
            if cur.fetchone()[0] > 0:
                return {"ok": False, "error": f"Table {table_name} already exists"}
            ddl = f"CREATE TABLE [{table_name}] (\n    " + ",\n    ".join(parts) + "\n)"
            cur.execute(ddl)
            conn.commit()
            return {"ok": True, "table_name": table_name,
                    "column_count": len(parts), "ddl": ddl}
    except Exception as e:
        return {"ok": False, "error": str(e)}
