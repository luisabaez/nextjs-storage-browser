"""
Column mappings for AP Invoice file processing.

Each source agency has different CSV column names that map to standardized
SQL Server table columns. This module defines those mappings for:
- Header files (FIN_AP_INVOICE_HDR)
- Lines files (FIN_AP_INVOICE_LINES)
- Lines Detail files (FIN_AP_INVOICE_LINES_DTL1)

Derived from the original Python programs:
- LoadAPInvoices.py (headers)
- LoadAPInvoiceLines.py (lines)
- LoadAPInvoiceLinesDTL1.py (detail lines)
"""

# ─── HEADER MAPPINGS ──────────────────────────────────────────────────────────
# Target table: FIN_AP_INVOICES_{MOCK}_{SOURCE}
# Target columns: BUSINESS_UNIT, INVOICE_NUMBER, INVOICE_AMOUNT, INVOICE_DATE,
#   SUPPLIER_NAME, SUPPLIER_SITE, DESCRIPTION, INVOICE_TYPE, PAYMENT_TERMS,
#   PAYMENT_METHOD, SUPPLIER_NUMBER, SYSTEM_NAME [, LAST_MODIFIED]

# CSV column name -> SQL column name
HEADER_COLUMNS_STANDARD = [
    ("BUSINESS_UNIT_AS_BUSINESS_UNIT", "BUSINESS_UNIT"),
    ("INVOICE_ID_AS_INVOICE_NUMBER", "INVOICE_NUMBER"),
    ("INVOICE_AMOUNT_AS_INVOICE_AMOUNT", "INVOICE_AMOUNT"),
    ("INVOICE_DT_AS_INVOICE_DATE", "INVOICE_DATE"),
    ("NAME1_AS_SUPPLIER_NAME", "SUPPLIER_NAME"),
    ("DEFAULT_LOC_AS_SUPPLIER_SITE", "SUPPLIER_SITE"),
    ("COMMENTS_AS_DESCRIPTION", "DESCRIPTION"),
    ("DESCR_AS_INVOICE_TYPE", "INVOICE_TYPE"),
    ("PYMNT_TERMS_CD_AS_PAYMENT_TERMS", "PAYMENT_TERMS"),
    ("PYMNT_METHOD_AS_PAYMENT_METHOD", "PAYMENT_METHOD"),
    ("VENDOR_ID", "SUPPLIER_NUMBER"),
]

HEADER_MAPPINGS = {
    # PRIFAS: 12 columns, no LAST_MODIFIED, uses DH_SOURCE prefix
    "PRIFAS": {
        "csv_columns": [
            "BUSINESS_UNIT_AS_BUSINESS_UNIT",
            "INVOICE_ID_AS_INVOICE_NUMBER",
            "INVOICE_AMOUNT_AS_INVOICE_AMOUNT",
            "INVOICE_DT_AS_INVOICE_DATE",
            "NAME1_AS_SUPPLIER_NAME",
            "DEFAULT_LOC_AS_SUPPLIER_SITE",
            "COMMENTS_AS_DESCRIPTION",
            "DESCR_AS_INVOICE_TYPE",
            "PYMNT_TERMS_CD_AS_PAYMENT_TERMS",
            "PYMNT_METHOD_AS_PAYMENT_METHOD",
            "VENDOR_ID",
            "DH_SOURCE_AS_SYSTEM_NAME",
        ],
        "sql_columns": [
            "BUSINESS_UNIT", "INVOICE_NUMBER", "INVOICE_AMOUNT", "INVOICE_DATE",
            "SUPPLIER_NAME", "SUPPLIER_SITE", "DESCRIPTION", "INVOICE_TYPE",
            "PAYMENT_TERMS", "PAYMENT_METHOD", "SUPPLIER_NUMBER", "SYSTEM_NAME",
        ],
        "has_last_modified": False,
    },
    # HACIENDA: 13 columns, uses DH_SOURCE prefix + VENDOR_LAST_MODIFIED
    "HACIENDA": {
        "csv_columns": [
            "BUSINESS_UNIT_AS_BUSINESS_UNIT",
            "INVOICE_ID_AS_INVOICE_NUMBER",
            "INVOICE_AMOUNT_AS_INVOICE_AMOUNT",
            "INVOICE_DT_AS_INVOICE_DATE",
            "NAME1_AS_SUPPLIER_NAME",
            "DEFAULT_LOC_AS_SUPPLIER_SITE",
            "COMMENTS_AS_DESCRIPTION",
            "DESCR_AS_INVOICE_TYPE",
            "PYMNT_TERMS_CD_AS_PAYMENT_TERMS",
            "PYMNT_METHOD_AS_PAYMENT_METHOD",
            "VENDOR_ID",
            "DH_SOURCE_AS_SYSTEM_NAME",
            "VENDOR_LAST_MODIFIED",
        ],
        "sql_columns": [
            "BUSINESS_UNIT", "INVOICE_NUMBER", "INVOICE_AMOUNT", "INVOICE_DATE",
            "SUPPLIER_NAME", "SUPPLIER_SITE", "DESCRIPTION", "INVOICE_TYPE",
            "PAYMENT_TERMS", "PAYMENT_METHOD", "SUPPLIER_NUMBER", "SYSTEM_NAME",
            "LAST_MODIFIED",
        ],
        "has_last_modified": True,
    },
    # FIMAS: 13 columns, uses SOURCE prefix (not DH_SOURCE)
    "FIMAS": {
        "csv_columns": [
            "BUSINESS_UNIT_AS_BUSINESS_UNIT",
            "INVOICE_ID_AS_INVOICE_NUMBER",
            "INVOICE_AMOUNT_AS_INVOICE_AMOUNT",
            "INVOICE_DT_AS_INVOICE_DATE",
            "NAME1_AS_SUPPLIER_NAME",
            "DEFAULT_LOC_AS_SUPPLIER_SITE",
            "COMMENTS_AS_DESCRIPTION",
            "DESCR_AS_INVOICE_TYPE",
            "PYMNT_TERMS_CD_AS_PAYMENT_TERMS",
            "PYMNT_METHOD_AS_PAYMENT_METHOD",
            "VENDOR_ID",
            "SOURCE_AS_SYSTEM_NAME",
            "VENDOR_LAST_MODIFIED",
        ],
        "sql_columns": [
            "BUSINESS_UNIT", "INVOICE_NUMBER", "INVOICE_AMOUNT", "INVOICE_DATE",
            "SUPPLIER_NAME", "SUPPLIER_SITE", "DESCRIPTION", "INVOICE_TYPE",
            "PAYMENT_TERMS", "PAYMENT_METHOD", "SUPPLIER_NUMBER", "SYSTEM_NAME",
            "LAST_MODIFIED",
        ],
        "has_last_modified": True,
    },
    # ASSMCA: 13 columns, uses SOURCE prefix
    "ASSMCA": {
        "csv_columns": [
            "BUSINESS_UNIT_AS_BUSINESS_UNIT",
            "INVOICE_ID_AS_INVOICE_NUMBER",
            "INVOICE_AMOUNT_AS_INVOICE_AMOUNT",
            "INVOICE_DT_AS_INVOICE_DATE",
            "NAME1_AS_SUPPLIER_NAME",
            "DEFAULT_LOC_AS_SUPPLIER_SITE",
            "COMMENTS_AS_DESCRIPTION",
            "DESCR_AS_INVOICE_TYPE",
            "PYMNT_TERMS_CD_AS_PAYMENT_TERMS",
            "PYMNT_METHOD_AS_PAYMENT_METHOD",
            "VENDOR_ID",
            "SOURCE_AS_SYSTEM_NAME",
            "VENDOR_LAST_MODIFIED",
        ],
        "sql_columns": [
            "BUSINESS_UNIT", "INVOICE_NUMBER", "INVOICE_AMOUNT", "INVOICE_DATE",
            "SUPPLIER_NAME", "SUPPLIER_SITE", "DESCRIPTION", "INVOICE_TYPE",
            "PAYMENT_TERMS", "PAYMENT_METHOD", "SUPPLIER_NUMBER", "SYSTEM_NAME",
            "LAST_MODIFIED",
        ],
        "has_last_modified": True,
    },
}

# SIFDE, SALUD, RETIRO all share the same mapping (DH_SOURCE + VENDOR_LAST_MODIFIED)
for _src in ("SIFDE", "SALUD", "RETIRO"):
    HEADER_MAPPINGS[_src] = {
        "csv_columns": [
            "BUSINESS_UNIT_AS_BUSINESS_UNIT",
            "INVOICE_ID_AS_INVOICE_NUMBER",
            "INVOICE_AMOUNT_AS_INVOICE_AMOUNT",
            "INVOICE_DT_AS_INVOICE_DATE",
            "NAME1_AS_SUPPLIER_NAME",
            "DEFAULT_LOC_AS_SUPPLIER_SITE",
            "COMMENTS_AS_DESCRIPTION",
            "DESCR_AS_INVOICE_TYPE",
            "PYMNT_TERMS_CD_AS_PAYMENT_TERMS",
            "PYMNT_METHOD_AS_PAYMENT_METHOD",
            "VENDOR_ID",
            "DH_SOURCE_AS_SYSTEM_NAME",
            "VENDOR_LAST_MODIFIED",
        ],
        "sql_columns": [
            "BUSINESS_UNIT", "INVOICE_NUMBER", "INVOICE_AMOUNT", "INVOICE_DATE",
            "SUPPLIER_NAME", "SUPPLIER_SITE", "DESCRIPTION", "INVOICE_TYPE",
            "PAYMENT_TERMS", "PAYMENT_METHOD", "SUPPLIER_NUMBER", "SYSTEM_NAME",
            "LAST_MODIFIED",
        ],
        "has_last_modified": True,
    }


# ─── LINES MAPPINGS ──────────────────────────────────────────────────────────
# Target table: FIN_AP_INVOICE_LINES_{MOCK}_{SOURCE}

LINES_STANDARD_SQL = [
    "INVOICE_ID", "BUSINESS_UNIT", "SUPPLIER_NAME", "SUPPLIER_SITE",
    "LINE_NUMBER", "LINE_TYPE", "AMOUNT", "INVOICE_QUANTITY", "UNIT_PRICE",
    "DESCRIPTION", "PO_NUMBER", "PO_LINE_NUMBER", "PO_SCHED_NUMBER",
    "PO_DISTRIB", "FUND_CODE", "DEPTID", "BUDGET_PERIOD", "CLASS_FLD",
    "ACCOUNT", "PROGRAM_CODE", "PROJECT_ID", "VENDOR_ID",
]

LINES_MAPPINGS = {
    # Standard (HACIENDA, ASSMCA, SALUD, RETIRO): 22 columns
    "STANDARD": {
        "csv_columns": [
            "INVOICE_ID_AS_INVOICE_NUMBER",
            "BUSINESS_UNIT_AS_BUSINESS_UNIT",
            "NAME1_AS_SUPPLIER_NAME",
            "DEFAULT_LOC_AS_SUPPLIER_SITE",
            "LINE_NBR_AS_LINE_NBR",
            "BLANK_AS_LINE_TYPE",
            "MONETARY_AMOUNT_AS_AMOUNT",
            "QUANTITY_AS_INVOICE_QUANTITY",
            "PRICE_PO_AS_UNIT_PRICE",
            "DESCR254_MIXED_AS_DESCRIPTION",
            "PO_ID_AS_PO_NUMBER",
            "LINE_NBR_AS_PO_LINE_NBR",
            "SCHED_NBR_AS_PO_SCHEDULE_NUMB",
            "DISTRIB_LINE_NUM_AS_PO_DISTRIBUTION_NUMBER",
            "FUND_CODE",
            "DEPTID",
            "BUDGET_REF",
            "CLASS_FLD",
            "ACCOUNT",
            "PROGRAM_CODE",
            "PROJECT_ID",
            "VENDOR_ID",
        ],
        "sql_columns": LINES_STANDARD_SQL,
    },
    # PRIFAS: 22 columns with different names for AMOUNT, BUDGET, DESCRIPTION
    "PRIFAS": {
        "csv_columns": [
            "INVOICE_ID_AS_INVOICE_NUMBER",
            "BUSINESS_UNIT_AS_BUSINESS_UNIT",
            "NAME1_AS_SUPPLIER_NAME",
            "DEFAULT_LOC_AS_SUPPLIER_SITE",
            "LINE_NBR_AS_LINE_NBR",
            "BLANK_AS_LINE_TYPE",
            "AMOUNT_AS_AMOUNT",
            "QUANTITY_AS_INVOICE_QUANTITY",
            "PRICE_PO_AS_UNIT_PRICE",
            "DESCR_AS_DESCRIPTION",
            "PO_ID_AS_PO_NUMBER",
            "LINE_NBR_AS_PO_LINE_NBR",
            "SCHED_NBR_AS_PO_Schedule_Numb",
            "DISTRIB_LINE_NUM_AS_PO_DISTRIBUTION_NUMBER",
            "FUND_CODE",
            "DEPTID",
            "BUDGET_PERIOD",
            "CLASS_FLD",
            "ACCOUNT",
            "PROGRAM_CODE",
            "PROJECT_ID",
            "VENDOR_ID",
        ],
        "sql_columns": LINES_STANDARD_SQL,
    },
    # FIMAS: 22 columns, uses RDEFAULT_LOC (extra R prefix)
    "FIMAS": {
        "csv_columns": [
            "INVOICE_ID_AS_INVOICE_NUMBER",
            "BUSINESS_UNIT_AS_BUSINESS_UNIT",
            "NAME1_AS_SUPPLIER_NAME",
            "RDEFAULT_LOC_AS_SUPPLIER_SITE",
            "LINE_NBR_AS_LINE_NBR",
            "BLANK_AS_LINE_TYPE",
            "MONETARY_AMOUNT_AS_AMOUNT",
            "QUANTITY_AS_INVOICE_QUANTITY",
            "PRICE_PO_AS_UNIT_PRICE",
            "DESCR254_MIXED_AS_DESCRIPTION",
            "PO_ID_AS_PO_NUMBER",
            "LINE_NBR_AS_PO_LINE_NBR",
            "SCHED_NBR_AS_PO_SCHEDULE_NUMB",
            "DISTRIB_LINE_NUM_AS_PO_DISTRIBUTION_NUMBER",
            "FUND_CODE",
            "DEPTID",
            "BUDGET_REF",
            "CLASS_FLD",
            "ACCOUNT",
            "PROGRAM_CODE",
            "PROJECT_ID",
            "VENDOR_ID",
        ],
        "sql_columns": LINES_STANDARD_SQL,
    },
    # SIFDE: 25 columns (standard 22 + 3 extra)
    "SIFDE": {
        "csv_columns": [
            "INVOICE_ID_AS_INVOICE_NUMBER",
            "BUSINESS_UNIT_AS_BUSINESS_UNIT",
            "NAME1_AS_SUPPLIER_NAME",
            "DEFAULT_LOC_AS_SUPPLIER_SITE",
            "LINE_NBR_AS_LINE_NBR",
            "BLANK_AS_LINE_TYPE",
            "MONETARY_AMOUNT_AS_AMOUNT",
            "QUANTITY_AS_INVOICE_QUANTITY",
            "PRICE_PO_AS_UNIT_PRICE",
            "DESCR254_MIXED_AS_DESCRIPTION",
            "PO_ID_AS_PO_NUMBER",
            "LINE_NBR_AS_PO_LINE_NBR",
            "SCHED_NBR_AS_PO_SCHEDULE_NUMB",
            "DISTRIB_LINE_NUM_AS_PO_DISTRIBUTION_NUMBER",
            "FUND_CODE",
            "DEPTID",
            "BUDGET_REF",
            "CLASS_FLD",
            "ACCOUNT",
            "PROGRAM_CODE",
            "PROJECT_ID",
            "VENDOR_ID",
            "PO_STATUS",
            "DISTRIB_LN_STATUS",
            "VCHR_BLD_STATUS",
        ],
        "sql_columns": LINES_STANDARD_SQL + [
            "PO_STATUS", "DISTRIB_LN_STATUS", "VCHR_BLD_STATUS",
        ],
    },
}

# Map sources to their lines mapping key
LINES_SOURCE_MAP = {
    "PRIFAS": "PRIFAS",
    "FIMAS": "FIMAS",
    "SIFDE": "SIFDE",
    "HACIENDA": "STANDARD",
    "ASSMCA": "STANDARD",
    "SALUD": "STANDARD",
    "RETIRO": "STANDARD",
}


# ─── LINES DTL1 MAPPINGS ─────────────────────────────────────────────────────
# Target table: FIN_AP_INVOICE_LINES_DTL1_{MOCK}_{SOURCE}

LINES_DTL1_SQL = [
    "INVOICE_ID", "INVOICE_DT", "BUSINESS_UNIT", "NAME1", "DEFAULT_LOC",
    "VOUCHER_LINE_NUM", "RESOURCE_CATEGORY", "MERCHANDISE_AMT", "QTY_VCHR",
    "UNIT_PRICE", "DESCR", "PO_ID", "LINE_NBR", "SCHED_NBR",
    "DISTRIB_LINE_NUM", "FUND_CODE", "DEPTID", "BUDGET_REF", "CLASS_FLD",
    "ACCOUNT", "PROGRAM_CODE", "PROJECT_ID", "VENDOR_ID",
    "PO_STATUS", "DISTRIB_LN_STATUS", "VCHR_BLD_STATUS",
]

LINES_DTL1_CSV = [
    "INVOICE_ID", "INVOICE_DT", "BUSINESS_UNIT", "NAME1", "DEFAULT_LOC",
    "VOUCHER_LINE_NUM", "RESOURCE_CATEGORY", "MERCHANDISE_AMT", "QTY_VCHR",
    "UNIT_PRICE", "DESCR", "PO_ID", "LINE_NBR", "SCHED_NBR",
    "DISTRIB_LINE_NUM", "FUND_CODE", "DEPTID", "BUDGET_REF", "CLASS_FLD",
    "ACCOUNT", "PROGRAM_CODE", "PROJECT_ID", "VENDOR_ID",
    "PO_STATUS", "DISTRIB_LN_STATUS", "VCHR_BLD_STATUS",
]

LINES_DTL1_MAPPINGS = {
    # All sources (PRIFAS, HACIENDA, ASSMCA, SIFDE) use raw column names
    "DEFAULT": {
        "csv_columns": LINES_DTL1_CSV,
        "sql_columns": LINES_DTL1_SQL,
    }
}

# Sources that support DTL1 loading
LINES_DTL1_SOURCES = {"PRIFAS", "HACIENDA", "ASSMCA", "SIFDE"}


def get_mapping(file_type, source):
    """
    Get the column mapping for a given file type and source.

    Args:
        file_type: 'HDR', 'LINES', or 'LINES_DTL1'
        source: Source agency name (e.g., 'PRIFAS', 'HACIENDA')

    Returns:
        dict with 'csv_columns' and 'sql_columns' lists, or None if unsupported
    """
    source = source.upper()

    if file_type == "HDR":
        return HEADER_MAPPINGS.get(source)

    elif file_type == "LINES":
        mapping_key = LINES_SOURCE_MAP.get(source)
        if mapping_key:
            return LINES_MAPPINGS.get(mapping_key)
        return None

    elif file_type == "LINES_DTL1":
        if source in LINES_DTL1_SOURCES:
            return LINES_DTL1_MAPPINGS["DEFAULT"]
        return None

    return None


def get_table_name(file_type, mock_number, source):
    """
    Build the target SQL table name.

    Args:
        file_type: 'HDR', 'LINES', or 'LINES_DTL1'
        mock_number: e.g., 'MOCK10'
        source: e.g., 'PRIFAS'

    Returns:
        Table name string, e.g., 'FIN_AP_INVOICES_MOCK10_PRIFAS'
    """
    source = source.upper()
    mock = mock_number.upper()

    if file_type == "HDR":
        return f"FIN_AP_INVOICES_{mock}_{source}"
    elif file_type == "LINES":
        return f"FIN_AP_INVOICE_LINES_{mock}_{source}"
    elif file_type == "LINES_DTL1":
        return f"FIN_AP_INVOICE_LINES_DTL1_{mock}_{source}"
    else:
        raise ValueError(f"Unknown file type: {file_type}")
