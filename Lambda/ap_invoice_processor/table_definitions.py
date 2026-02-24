"""
SQL Server table definitions for AP Invoice staging tables.

Auto-creates tables when they don't exist in the database.
All columns use NVARCHAR(500) since the original Python programs
treat all data as strings.

Table naming:
    - Header:  FIN_AP_INVOICES_{MOCK}_{SOURCE}
    - Lines:   FIN_AP_INVOICE_LINES_{MOCK}_{SOURCE}
    - DTL1:    FIN_AP_INVOICE_LINES_DTL1_{MOCK}_{SOURCE}
"""


def get_create_table_sql(table_name, file_type, source):
    """
    Generate a CREATE TABLE statement for the given table.

    Args:
        table_name: Full table name (e.g., FIN_AP_INVOICES_MOCK10_PRIFAS)
        file_type: 'HDR', 'LINES', or 'LINES_DTL1'
        source: Source agency name (e.g., 'PRIFAS')

    Returns:
        SQL CREATE TABLE string, or None if unsupported
    """
    source = source.upper()

    if file_type == "HDR":
        return _header_create_sql(table_name, source)
    elif file_type == "LINES":
        return _lines_create_sql(table_name, source)
    elif file_type == "LINES_DTL1":
        return _lines_dtl1_create_sql(table_name)
    return None


def _header_create_sql(table_name, source):
    """CREATE TABLE for header (HDR) files."""
    cols = [
        "BUSINESS_UNIT NVARCHAR(500)",
        "INVOICE_NUMBER NVARCHAR(500)",
        "INVOICE_AMOUNT NVARCHAR(500)",
        "INVOICE_DATE NVARCHAR(500)",
        "SUPPLIER_NAME NVARCHAR(500)",
        "SUPPLIER_SITE NVARCHAR(500)",
        "DESCRIPTION NVARCHAR(500)",
        "INVOICE_TYPE NVARCHAR(500)",
        "PAYMENT_TERMS NVARCHAR(500)",
        "PAYMENT_METHOD NVARCHAR(500)",
        "SUPPLIER_NUMBER NVARCHAR(500)",
        "SYSTEM_NAME NVARCHAR(500)",
    ]

    # All sources except PRIFAS have LAST_MODIFIED
    if source != "PRIFAS":
        cols.append("LAST_MODIFIED NVARCHAR(500)")

    col_defs = ",\n    ".join(cols)
    return f"CREATE TABLE {table_name} (\n    {col_defs}\n)"


def _lines_create_sql(table_name, source):
    """CREATE TABLE for lines (LINES) files."""
    cols = [
        "INVOICE_ID NVARCHAR(500)",
        "BUSINESS_UNIT NVARCHAR(500)",
        "SUPPLIER_NAME NVARCHAR(500)",
        "SUPPLIER_SITE NVARCHAR(500)",
        "LINE_NUMBER NVARCHAR(500)",
        "LINE_TYPE NVARCHAR(500)",
        "AMOUNT NVARCHAR(500)",
        "INVOICE_QUANTITY NVARCHAR(500)",
        "UNIT_PRICE NVARCHAR(500)",
        "DESCRIPTION NVARCHAR(500)",
        "PO_NUMBER NVARCHAR(500)",
        "PO_LINE_NUMBER NVARCHAR(500)",
        "PO_SCHED_NUMBER NVARCHAR(500)",
        "PO_DISTRIB NVARCHAR(500)",
        "FUND_CODE NVARCHAR(500)",
        "DEPTID NVARCHAR(500)",
        "BUDGET_PERIOD NVARCHAR(500)",
        "CLASS_FLD NVARCHAR(500)",
        "ACCOUNT NVARCHAR(500)",
        "PROGRAM_CODE NVARCHAR(500)",
        "PROJECT_ID NVARCHAR(500)",
        "VENDOR_ID NVARCHAR(500)",
    ]

    # SIFDE has 3 extra columns
    if source == "SIFDE":
        cols.extend([
            "PO_STATUS NVARCHAR(500)",
            "DISTRIB_LN_STATUS NVARCHAR(500)",
            "VCHR_BLD_STATUS NVARCHAR(500)",
        ])

    col_defs = ",\n    ".join(cols)
    return f"CREATE TABLE {table_name} (\n    {col_defs}\n)"


def _lines_dtl1_create_sql(table_name):
    """CREATE TABLE for lines detail (LINES_DTL1) files."""
    cols = [
        "INVOICE_ID NVARCHAR(500)",
        "INVOICE_DT NVARCHAR(500)",
        "BUSINESS_UNIT NVARCHAR(500)",
        "NAME1 NVARCHAR(500)",
        "DEFAULT_LOC NVARCHAR(500)",
        "VOUCHER_LINE_NUM NVARCHAR(500)",
        "RESOURCE_CATEGORY NVARCHAR(500)",
        "MERCHANDISE_AMT NVARCHAR(500)",
        "QTY_VCHR NVARCHAR(500)",
        "UNIT_PRICE NVARCHAR(500)",
        "DESCR NVARCHAR(500)",
        "PO_ID NVARCHAR(500)",
        "LINE_NBR NVARCHAR(500)",
        "SCHED_NBR NVARCHAR(500)",
        "DISTRIB_LINE_NUM NVARCHAR(500)",
        "FUND_CODE NVARCHAR(500)",
        "DEPTID NVARCHAR(500)",
        "BUDGET_REF NVARCHAR(500)",
        "CLASS_FLD NVARCHAR(500)",
        "ACCOUNT NVARCHAR(500)",
        "PROGRAM_CODE NVARCHAR(500)",
        "PROJECT_ID NVARCHAR(500)",
        "VENDOR_ID NVARCHAR(500)",
        "PO_STATUS NVARCHAR(500)",
        "DISTRIB_LN_STATUS NVARCHAR(500)",
        "VCHR_BLD_STATUS NVARCHAR(500)",
    ]

    col_defs = ",\n    ".join(cols)
    return f"CREATE TABLE {table_name} (\n    {col_defs}\n)"
