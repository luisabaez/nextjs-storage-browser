"""
Multi-sheet workbook intake for the Assets and Inventory files.

These two entities arrive as ONE Excel workbook per agency/office and land in
SEVERAL per-source staging tables — unlike every other entity (one file → one
table). The sheet names, header position (headers sit on the SECOND row of
each sheet), column mappings, key-row filters and zero-padding rules mirror the
standalone loader programs that run on the SQL Server box
(LoadAssets.py / LoadInventory-4EntitiesFromExcel.py), so the staged data
matches what those programs produce for the same workbook.

Deliberate differences from the box loaders (cleanups, not behavior the
conversion depends on):
  - Empty cells are staged as '' consistently (the box Inventory loader wrote
    the literal string 'nan' for blanks, and float-formatted numbers like 5.0).
  - Zero-padding (Fund, ZIP) is applied only to all-digit values, so a blank
    ZIP stays blank instead of becoming '00nan'.
  - Rows that are entirely blank are dropped from every sheet.

This module is pure parsing (no DB access) so it can be exercised locally.
"""

import io

import pandas as pd

# ── Assets workbook ───────────────────────────────────────────────────────────
# (excel_header, sql_column) pairs in the staging table's insert order. Excel
# headers are matched after stripping surrounding whitespace — the templates
# carry trailing spaces on a few (e.g. 'Asset Description ', 'Model ').
# Note the master's legacy-ID header has a space after the slash
# ('Legacy/ Peoplesoft Asset ID') while the distribution sheet's does not.

_ASSETS_SHEETS = [
    {
        "sheet": "Input File Format_Assets",
        "table_prefix": "FIN_ASSETS_",
        "usecols": 26,
        "key_columns": ["Tag Number", "Legacy/ Peoplesoft Asset ID"],
        "pad": {"Asset Key Segment1 (Fund)": 3},
        "columns": [
            ("Asset Book (5 digit Agency Code+AM Business Unit)", "ASSET_BOOK"),
            ("Legacy/ Peoplesoft Asset ID", "ASSET_NUMBER"),
            ("Asset Description", "ASSET_DESCRIPTION"),
            ("Tag Number", "TAG_NUMBER"),
            ("Manufacturer", "MANUFACTURER"),
            ("Serial Number", "SERIAL_NUMBER"),
            ("Model", "MODEL"),
            ("Asset Type", "ASSET_TYPE"),
            ("Cost", "COST"),
            ("Date Placed in Service", "DATE_PLACED_IN_SERVICE"),
            ("Prorate Convention", "PRORATE_CONVENTION"),
            ("Asset Units", "ASSET_UNITS"),
            ("Asset Category Segment1 (Major Category)", "ASSET_CATEGORY_SEGMENT1_MAJOR_CATEGORY"),
            ("Asset Category Segment2 (Minor Category)", "ASSET_CATEGORY_SEGMENT2_MINOR_CATEGORY"),
            ("Asset Category Segment3 (Threshold)", "ASSET_CATEGORY_SEGMENT3_THRESHOLD"),
            ("Asset Key Segment1 (Fund)", "ASSET_KEY_SEGMENT1_FUND"),
            ("Asset Key Segment2 (Agency)", "ASSET_KEY_SEGMENT2_AGENCY"),
            ("In physical inventory", "IN_PHYSICAL_INVENTORY"),
            ("In use", "IN_USE"),
            ("Ownership", "OWNERSHIP"),
            ("Bought", "BOUGHT"),
            ("Depreciate", "DEPRECIATE"),
            ("Salvage Value Amount", "SALVAGE_VALUE_AMOUNT"),
            ("Salvage Value Percent", "SALVAGE_VALUE_PERCENT"),
            ("Depreciation Method", "DEPRECIATION_METHOD"),
            ("Life in Months", "LIFE_IN_MONTHS"),
        ],
    },
    {
        "sheet": "Input File Format_Asset Distrib",
        "table_prefix": "FIN_ASSETS_DISTRIBUTION_",
        "usecols": 20,
        "key_columns": ["Tag Number", "Legacy/Peoplesoft Asset ID"],
        "pad": {"Asset Location Segment4 (ZIP CODE)": 5},
        "columns": [
            ("Tag Number", "TAG_NUMBER"),
            ("Legacy/Peoplesoft Asset ID", "ASSET_NUMBER"),
            ("Units Assigned", "UNITS_ASSIGNED"),
            ("Employee Email Address", "EMPLOYEE_EMAIL_ADDRESS"),
            ("Asset Location Segment1 (ADDRESS)", "ASSET_LOCATION_SEGMENT1_ADDRESS"),
            ("Asset Location Segment2 (CITY)", "ASSET_LOCATION_SEGMENT2_CITY"),
            ("Asset Location Segment3 (STATE)", "ASSET_LOCATION_SEGMENT3_STATE"),
            ("Asset Location Segment4 (ZIP CODE)", "ASSET_LOCATION_SEGMENT4_ZIP_CODE"),
            ("Asset Location Segment5 (BUILDING)", "ASSET_LOCATION_SEGMENT5_BUILDING"),
            ("Asset Location Segment6 (FLOOR)", "ASSET_LOCATION_SEGMENT6_FLOOR"),
            ("Asset Location Segment7 (OFFICE)", "ASSET_LOCATION_SEGMENT7_OFFICE"),
            ("Depreciation Expense Account Segment1 (Fund)", "DEPRECIATION_EXPENSE_ACCOUNT_SEGMENT1_FUND"),
            ("Depreciation Expense Account Segment2 (Agency)", "DEPRECIATION_EXPENSE_ACCOUNT_SEGMENT2_AGENCY"),
            ("Depreciation Expense Account Segment3 (Cost Center)", "DEPRECIATION_EXPENSE_ACCOUNT_SEGMENT3_COST_CENTER"),
            ("Depreciation Expense Account Segment4 (Program)", "DEPRECIATION_EXPENSE_ACCOUNT_SEGMENT4_PROGRAM"),
            ("Depreciation Expense Account Segment5 (Budget Year)", "DEPRECIATION_EXPENSE_ACCOUNT_SEGMENT5_BUDGET_YEAR"),
            ("Depreciation Expense Account Segment6 (Appropriation)", "DEPRECIATION_EXPENSE_ACCOUNT_SEGMENT6_APPROPRIATION"),
            ("Depreciation Expense Account Segment7 (Account)", "DEPRECIATION_EXPENSE_ACCOUNT_SEGMENT7_ACCOUNT"),
            ("Depreciation Expense Account Segment8 (Project)", "DEPRECIATION_EXPENSE_ACCOUNT_SEGMENT8_PROJECT"),
            ("Segment9 (Award)", "DEPRECIATION_EXPENSE_ACCOUNT_SEGMENT9_INTERFUND"),
        ],
    },
]

# ── Inventory workbook ────────────────────────────────────────────────────────
# The ITEM/QOH sheets carry SQL-style headers; the CATEGORY sheet carries
# friendly ones. The INV ORG sheet is not loaded (disabled in the box loader).

_INVENTORY_SHEETS = [
    {
        "sheet": "ITEM TEMPLATE",
        "table_prefix": "SCM_ITEMS_",
        "usecols": None,
        "key_columns": None,
        "pad": {},
        "columns": [
            ("ITEM_NUMBER", "ITEM_NUMBER"),
            ("ORGANIZATION_CODE", "ORGANIZATION_CODE"),
            ("DESCRIPTION", "DESCRIPTION"),
            ("PRIMARY_UOM_NAME", "PRIMARY_UOM_NAME"),
            ("NEW_ITEM_CLASS_NAME", "NEW_ITEM_CLASS_NAME"),
            ("FIXED_LOT_MULTIPLIER", "FIXED_LOT_MULTIPLIER"),
            ("FIXED_ORDER_QUANTITY", "FIXED_ORDER_QUANTITY"),
            ("INVENTORY_PLANNING_CODE", "INVENTORY_PLANNING_CODE"),
            ("MIN_MINMAX_QUANTITY", "MIN_MINMAX_QUANTITY"),
            ("MAX_MINMAX_QUANTITY", "MAX_MINMAX_QUANTITY"),
            ("MINIMUM_ORDER_QUANTITY", "MINIMUM_ORDER_QUANTITY"),
            ("MAXIMUM_ORDER_QUANTITY", "MAXIMUM_ORDER_QUANTITY"),
            ("PLANNER_CODE", "PLANNER_CODE"),
            ("PLANNING_MAKE_BUY_CODE", "PLANNING_MAKE_BUY_CODE"),
            ("SOURCE_SUBINVENTORY", "SOURCE_SUBINVENTORY"),
            ("SOURCE_TYPE", "SOURCE_TYPE"),
            ("SOURCE_ORGANIZATION_CODE", "SOURCE_ORGANIZATION_CODE"),
            ("EXPIRATION_ACTION_CODE", "EXPIRATION_ACTION_CODE"),
            ("STOCK_ENABLED_FLAG", "STOCK_ENABLED_FLAG"),
            ("CYCLE_COUNT_ENABLED_FLAG", "CYCLE_COUNT_ENABLED_FLAG"),
            ("INVENTORY_ITEM_FLAG", "INVENTORY_ITEM_FLAG"),
            ("LOT_CONTROL_CODE", "LOT_CONTROL_CODE"),
            ("LOT_STATUS_ENABLED", "LOT_STATUS_ENABLED"),
            ("LOT_SUBSTITUTION_ENABLED", "LOT_SUBSTITUTION_ENABLED"),
            ("PREPROCESSING_LEAD_TIME", "PREPROCESSING_LEAD_TIME"),
            ("FULL_LEAD_TIME", "FULL_LEAD_TIME"),
            ("POSTPROCESSING_LEAD_TIME", "POSTPROCESSING_LEAD_TIME"),
            ("ITEM_TYPE", "ITEM_TYPE"),
            ("LONG_DESCRIPTION", "LONG_DESCRIPTION"),
            # The box loader maps the sheet's TRANSFER_ORDER_ENABLED column
            # into INTERNAL_ORDER_ENABLED_FLAG (kept as-is).
            ("TRANSFER_ORDER_ENABLED", "INTERNAL_ORDER_ENABLED_FLAG"),
            ("INTERNAL_ORDER_FLAG", "INTERNAL_ORDER_FLAG"),
            ("UNIT_WEIGHT", "UNIT_WEIGHT"),
            ("WEIGHT_UOM_NAME", "WEIGHT_UOM_NAME"),
            ("UNIT_VOLUME", "UNIT_VOLUME"),
            ("VOLUME_UOM_NAME", "VOLUME_UOM_NAME"),
            ("DIMENSION_UOM_NAME", "DIMENSION_UOM_NAME"),
            ("UNIT_LENGTH", "UNIT_LENGTH"),
            ("UNIT_WIDTH", "UNIT_WIDTH"),
            ("UNIT_HEIGHT", "UNIT_HEIGHT"),
            ("HAZARDOUS_MATERIAL_FLAG", "HAZARDOUS_MATERIAL_FLAG"),
            ("UNIT_OF_ISSUE", "UNIT_OF_ISSUE"),
            ("PURCHASING_ITEM_FLAG", "PURCHASING_ITEM_FLAG"),
            ("BUYER_NAME", "BUYER_NAME"),
            ("ALLOW_ITEM_DESC_UPDATE_FLAG", "ALLOW_ITEM_DESC_UPDATE_FLAG"),
            ("RECEIVING_ROUTING_ID", "RECEIVING_ROUTING_ID"),
            ("ATTRIBUTE1", "ATTRIBUTE1"),
        ],
    },
    {
        "sheet": "ITEM QOH TEMPLATE",
        "table_prefix": "SCM_ITEM_OHQ_",
        "usecols": None,
        "key_columns": None,
        "pad": {},
        "columns": [
            ("ORGANIZATION_NAME", "ORGANIZATION_NAME"),
            ("ITEM_NUMBER", "ITEM_NUMBER"),
            ("SUBINVENTORY_CODE", "SUBINVENTORY_CODE"),
            ("LOCATOR_NAME", "LOCATOR_NAME"),
            ("TRANSACTION_UNIT_OF_MEASURE", "TRANSACTION_UNIT_OF_MEASURE"),
            ("TRANSACTION_QUANTITY", "TRANSACTION_QUANTITY"),
            ("ACCOUNT", "DST_SEGMENT7_ACCOUNT"),
            ("REPRESENTATIVE_LOT_NUMBER", "REPRESENTATIVE_LOT_NUMBER"),
        ],
    },
    {
        "sheet": "ITEM CATEGORY TEMPLATE",
        "table_prefix": "SCM_ITEMS_CATEGORY_",
        "usecols": None,
        "key_columns": None,
        "pad": {},
        "columns": [
            ("Item", "ITEM_NUMBER"),
            ("Inventory Organization", "ORGANIZATION_CODE"),
            ("Category Set", "CATEGORY_SET_NAME"),
            ("Category Name", "CATEGORY_NAME"),
            ("Category Code", "CATEGORY_CODE"),
        ],
    },
]

WORKBOOK_ENTITIES = {
    "FIN_ASSETS": {"sheets": _ASSETS_SHEETS},
    "SCM_INV": {"sheets": _INVENTORY_SHEETS},
}


# Workbook staging tables (FIN_ASSETS_MOCK14_<office>, SCM_ITEMS_MOCK14_<bu>, ...)
# live in the conversion database — the one the box loaders fill and the
# FILEVAL validation views read — not the Lambda connection's default
# database. Every workbook-path table reference is qualified with this name.
STAGING_DATABASE = "Hacienda_ERP"


def is_workbook_entity(entity_prefix):
    """Whether this entity prefix is a multi-sheet workbook intake."""
    return entity_prefix in WORKBOOK_ENTITIES


def _pad_digits(series, width):
    """Zero-pad only all-digit values (mirrors the box loader's fund padding).
    Blank and mixed values pass through unchanged."""
    s = series.astype(str)
    return s.where(~s.str.fullmatch(r"\d+"), s.str.zfill(width))


def parse_workbook_sheets(content, entity_prefix, mock_number, source):
    """
    Read every sheet of a workbook entity into staged inserts.

    Returns a list (in master-first order) of dicts:
        sheet, table, sql_columns, rows (tuples of str, '' for blank),
        row_count, df (the parsed sheet, for BU extraction on the master).

    Raises ValueError with a sheet-specific message when a sheet or an
    expected column is missing, so failures read like the header gate.
    """
    loads = []
    for sheet_spec in WORKBOOK_ENTITIES[entity_prefix]["sheets"]:
        sheet = sheet_spec["sheet"]
        usecols = range(sheet_spec["usecols"]) if sheet_spec["usecols"] else None
        try:
            df = pd.read_excel(
                io.BytesIO(content), sheet_name=sheet, skiprows=1,
                dtype=str, usecols=usecols, engine="openpyxl",
            )
        except ValueError as e:
            raise ValueError(f"sheet '{sheet}' could not be read: {e}")

        df.columns = [str(c).strip() for c in df.columns]
        expected = [h for h, _ in sheet_spec["columns"]]
        missing_cols = [h for h in expected if h not in df.columns]
        if missing_cols:
            raise ValueError(
                f"sheet '{sheet}' is missing expected columns: "
                f"{', '.join(missing_cols[:5])}"
            )

        df = df.fillna("")
        # Drop rows that are entirely blank across the mapped columns.
        df = df[df[expected].apply(lambda r: any(str(v).strip() for v in r), axis=1)]

        for col, width in sheet_spec["pad"].items():
            df[col] = _pad_digits(df[col], width)

        # Assets sheets: keep only rows carrying a key (Tag Number or legacy
        # asset ID) — trailing notes under the table are dropped, like the box.
        keys = sheet_spec["key_columns"]
        if keys:
            df = df[df[keys].apply(lambda r: any(str(v).strip() for v in r), axis=1)]

        rows = [tuple(str(row[h]) for h in expected) for _, row in df.iterrows()]
        loads.append({
            "sheet": sheet,
            "table": f"{sheet_spec['table_prefix']}{mock_number}_{source}".upper(),
            "sql_columns": [c for _, c in sheet_spec["columns"]],
            "rows": rows,
            "row_count": len(rows),
            "df": df,
        })
    return loads
