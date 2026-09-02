"""
Entity registry for all FIN, SCM, and HCM data file types.

Maps entity prefixes (extracted from filenames) to module info,
table naming, and processing metadata.
"""

import re

# Prefixes to exclude from processing (Assets and Inventory workbooks are now
# handled by the workbook intake — see workbook_loaders.py)
EXCLUDED_PREFIXES = []

# Master entity registry
# Keys are entity prefixes as they appear in filenames (before MOCK)
# "legacy" flag means the entity uses the old column_mappings.py / table_definitions.py path
ENTITY_REGISTRY = {
    # ── FIN (19 entities) ──
    "FIN_AP_INVOICE_HDR": {
        "module": "FIN",
        "display_name": "AP Invoice Header",
        "legacy": True,
    },
    "FIN_AP_INVOICE_LINES_DTL1": {
        "module": "FIN",
        "display_name": "AP Invoice Lines Detail",
        "legacy": True,
    },
    "FIN_AP_INVOICE_LINES": {
        "module": "FIN",
        "display_name": "AP Invoice Lines",
        "legacy": True,
    },
    "FIN_AR_INVOICE_DISTRIBUTION": {
        "module": "FIN",
        "display_name": "AR Invoice Distribution",
        "legacy": False,
    },
    # Multi-sheet workbook (Assets + Asset Distribution) — see workbook_loaders.py
    "FIN_ASSETS": {
        "module": "FIN",
        "display_name": "Assets",
        "legacy": False,
    },
    "FIN_AR_INVOICE_LINES": {
        "module": "FIN",
        "display_name": "AR Invoice Lines",
        "legacy": False,
    },
    "FIN_AR_INVOICE": {
        "module": "FIN",
        "display_name": "AR Invoice",
        "legacy": False,
    },
    "FIN_AWARDS_CFDACMIA": {
        "module": "FIN",
        "display_name": "Awards CFDA/CMIA",
        "legacy": False,
    },
    "FIN_BUDGETARY_BALANCES": {
        "module": "FIN",
        "display_name": "Budgetary Balances",
        "legacy": False,
    },
    "FIN_CUSTOMER_CONTACT": {
        "module": "FIN",
        "display_name": "Customer Contact",
        "legacy": False,
    },
    "FIN_CUSTOMER": {
        "module": "FIN",
        "display_name": "Customer",
        "legacy": False,
    },
    "FIN_GL_BALANCES": {
        "module": "FIN",
        "display_name": "GL Balances",
        "legacy": False,
    },
    "FIN_PROJECT_CLASS": {
        "module": "FIN",
        "display_name": "Project Class",
        "legacy": False,
    },
    "FIN_PROJECTS_CROSS_REFERENCES": {
        "module": "FIN",
        "display_name": "Projects Cross References",
        "legacy": False,
    },
    "FIN_PROJECTS_TASK_ACTIVITY": {
        "module": "FIN",
        "display_name": "Projects Task Activity",
        "legacy": False,
    },
    "FIN_PROJECTS_TEAM_MEMBERS": {
        "module": "FIN",
        "display_name": "Projects Team Members",
        "legacy": False,
    },
    "FIN_PROJECTS": {
        "module": "FIN",
        "display_name": "Projects",
        "legacy": False,
    },
    "FIN_REQ_DISTRIBUTION": {
        "module": "FIN",
        "display_name": "Requisition Distribution",
        "legacy": False,
    },
    "FIN_REQ_HDR": {
        "module": "FIN",
        "display_name": "Requisition Header",
        "legacy": False,
    },
    "FIN_REQ_LINE": {
        "module": "FIN",
        "display_name": "Requisition Line",
        "legacy": False,
    },

    # ── HCM (35 entities) ──
    "HCM_ACCRUAL_DETAIL": {
        "module": "HCM",
        "display_name": "Accrual Detail",
        "legacy": False,
    },
    "HCM_ASSIGNMENT_EIT_KRONOS": {
        "module": "HCM",
        "display_name": "Assignment EIT Kronos",
        "legacy": False,
    },
    "HCM_CONTRACT_SUPERVISOR": {
        "module": "HCM",
        "display_name": "Contract Supervisor",
        "legacy": False,
    },
    "HCM_COST_ALLOCATION": {
        "module": "HCM",
        "display_name": "Cost Allocation",
        "legacy": False,
    },
    "HCM_COURSES": {
        "module": "HCM",
        "display_name": "Courses",
        "legacy": False,
    },
    "HCM_DEPARTMENT": {
        "module": "HCM",
        "display_name": "Department",
        "legacy": False,
    },
    "HCM_ELEMENT_ENTRY_COSTING": {
        "module": "HCM",
        "display_name": "Element Entry Costing",
        "legacy": False,
    },
    "HCM_ELEMENT_ENTRY": {
        "module": "HCM",
        "display_name": "Element Entry",
        "legacy": False,
    },
    "HCM_EXTERNAL_BANK_ACCOUNT": {
        "module": "HCM",
        "display_name": "External Bank Account",
        "legacy": False,
    },
    "HCM_FEDERAL_TAX": {
        "module": "HCM",
        "display_name": "Federal Tax",
        "legacy": False,
    },
    "HCM_GRADE_RATE_VALUE": {
        "module": "HCM",
        "display_name": "Grade Rate Value",
        "legacy": False,
    },
    "HCM_GRADE": {
        "module": "HCM",
        "display_name": "Grade",
        "legacy": False,
    },
    "HCM_INVOLUNTARY_DEDUCTIONS": {
        "module": "HCM",
        "display_name": "Involuntary Deductions",
        "legacy": False,
    },
    "HCM_JOB_GRADE": {
        "module": "HCM",
        "display_name": "Job Grade",
        "legacy": False,
    },
    "HCM_JOBS": {
        "module": "HCM",
        "display_name": "Jobs",
        "legacy": False,
    },
    "HCM_LEARNING_RECORD": {
        "module": "HCM",
        "display_name": "Learning Record",
        "legacy": False,
    },
    "HCM_LOCATION": {
        "module": "HCM",
        "display_name": "Location",
        "legacy": False,
    },
    "HCM_PAYROLL_RELATIONSHIP": {
        "module": "HCM",
        "display_name": "Payroll Relationship",
        "legacy": False,
    },
    "HCM_PERSONAL_PAYMENT_METHOD": {
        "module": "HCM",
        "display_name": "Personal Payment Method",
        "legacy": False,
    },
    "HCM_PERSON_ADDRESS": {
        "module": "HCM",
        "display_name": "Person Address",
        "legacy": False,
    },
    "HCM_PERSON_ASSIGNMENT": {
        "module": "HCM",
        "display_name": "Person Assignment",
        "legacy": False,
    },
    "HCM_PERSON_EMAIL": {
        "module": "HCM",
        "display_name": "Person Email",
        "legacy": False,
    },
    "HCM_PERSON_LEGISLATIVE": {
        "module": "HCM",
        "display_name": "Person Legislative",
        "legacy": False,
    },
    "HCM_PERSON_NAME": {
        "module": "HCM",
        "display_name": "Person Name",
        "legacy": False,
    },
    "HCM_PERSON_NID": {
        "module": "HCM",
        "display_name": "Person NID",
        "legacy": False,
    },
    "HCM_PERSON_PHONE": {
        "module": "HCM",
        "display_name": "Person Phone",
        "legacy": False,
    },
    "HCM_PERSON_SUPERVISOR": {
        "module": "HCM",
        "display_name": "Person Supervisor",
        "legacy": False,
    },
    "HCM_PERSON": {
        "module": "HCM",
        "display_name": "Person",
        "legacy": False,
    },
    "HCM_POSITION_GRADE": {
        "module": "HCM",
        "display_name": "Position Grade",
        "legacy": False,
    },
    "HCM_POSITION_HIERARCHY": {
        "module": "HCM",
        "display_name": "Position Hierarchy",
        "legacy": False,
    },
    "HCM_POSITION": {
        "module": "HCM",
        "display_name": "Position",
        "legacy": False,
    },
    "HCM_SALARY": {
        "module": "HCM",
        "display_name": "Salary",
        "legacy": False,
    },
    "HCM_SENIORITY": {
        "module": "HCM",
        "display_name": "Seniority",
        "legacy": False,
    },
    "HCM_STATE_TAX": {
        "module": "HCM",
        "display_name": "State Tax",
        "legacy": False,
    },
    "HCM_WORK_SCHEDULE": {
        "module": "HCM",
        "display_name": "Work Schedule",
        "legacy": False,
    },

    # ── SCM (19 entities, excluding INV/Inventory) ──
    "SCM_BU_RECENT_BILLTO_SHIPTO_LOCATION": {
        "module": "SCM",
        "display_name": "BU Recent BillTo/ShipTo Location",
        "legacy": False,
    },
    "SCM_CATALOG": {
        "module": "SCM",
        "display_name": "Catalog",
        "legacy": False,
    },
    "SCM_CATEGORY": {
        "module": "SCM",
        "display_name": "Category",
        "legacy": False,
    },
    "SCM_CONTRACTS_LINES": {
        "module": "SCM",
        "display_name": "Contracts Lines",
        "legacy": False,
    },
    "SCM_CONTRACTS": {
        "module": "SCM",
        "display_name": "Contracts",
        "legacy": False,
    },
    "SCM_CONTRACT_LINES": {
        "module": "SCM",
        "display_name": "Contract Lines",
        "legacy": False,
    },
    # Multi-sheet workbook (Items + Item OHQ + Item Category) — see workbook_loaders.py
    "SCM_INV": {
        "module": "SCM",
        "display_name": "Inventory",
        "legacy": False,
    },
    "SCM_ITEMS": {
        "module": "SCM",
        "display_name": "Items",
        "legacy": False,
    },
    "SCM_LOCATIONS": {
        "module": "SCM",
        "display_name": "Locations",
        "legacy": False,
    },
    "SCM_PURCHASE_ORDER_COMMENTS": {
        "module": "SCM",
        "display_name": "Purchase Order Comments",
        "legacy": False,
    },
    "SCM_PURCHASE_ORDER_LINE_DISTRIBUTION": {
        "module": "SCM",
        "display_name": "PO Line Distribution",
        "legacy": False,
    },
    "SCM_PURCHASE_ORDER_LINE_LOCATIONS": {
        "module": "SCM",
        "display_name": "PO Line Locations",
        "legacy": False,
    },
    "SCM_PURCHASE_ORDER_LINES": {
        "module": "SCM",
        "display_name": "Purchase Order Lines",
        "legacy": False,
    },
    "SCM_PURCHASE_ORDER": {
        "module": "SCM",
        "display_name": "Purchase Order",
        "legacy": False,
    },
    "SCM_SUPPLIER_ADDRESS": {
        "module": "SCM",
        "display_name": "Supplier Address",
        "legacy": False,
    },
    "SCM_SUPPLIER_BANK_ACCOUNTS": {
        "module": "SCM",
        "display_name": "Supplier Bank Accounts",
        "legacy": False,
    },
    "SCM_SUPPLIER_CONTACT": {
        "module": "SCM",
        "display_name": "Supplier Contact",
        "legacy": False,
    },
    "SCM_SUPPLIER_SITE_ASSIG": {
        "module": "SCM",
        "display_name": "Supplier Site Assignment",
        "legacy": False,
    },
    "SCM_SUPPLIER_SITE": {
        "module": "SCM",
        "display_name": "Supplier Site",
        "legacy": False,
    },
    "SCM_SUPPLIER": {
        "module": "SCM",
        "display_name": "Supplier",
        "legacy": False,
    },
}

# Pre-sorted entity prefixes longest-first for unambiguous matching
SORTED_PREFIXES = sorted(ENTITY_REGISTRY.keys(), key=len, reverse=True)


def is_excluded(filename_upper):
    """Check if a filename belongs to an excluded entity."""
    for prefix in EXCLUDED_PREFIXES:
        if prefix in filename_upper:
            return True
    return False


def get_entity_info(entity_prefix):
    """Look up entity info by prefix. Returns dict or None."""
    return ENTITY_REGISTRY.get(entity_prefix)


def match_entity_prefix(body):
    """
    Given the body portion of a filename (everything between module prefix
    and MOCK), find the matching entity prefix.

    Uses longest-prefix-first matching to disambiguate
    (e.g., FIN_AP_INVOICE_LINES_DTL1 before FIN_AP_INVOICE_LINES).

    Args:
        body: the full filename without path, e.g.
              "FIN_AP_INVOICE_LINES_DTL1_MOCK10_PRIFAS_20240101_1200.csv"

    Returns:
        entity_prefix string or None
    """
    body_upper = body.upper()
    for prefix in SORTED_PREFIXES:
        if body_upper.startswith(prefix + "_MOCK") or body_upper.startswith(prefix + "_mock"):
            return prefix
    return None


def get_table_name(entity_prefix, mock, source):
    """
    Build SQL table name: {ENTITY_PREFIX}_{MOCK}_{SOURCE}
    e.g. FIN_CUSTOMER_MOCK11_PRIFAS
    """
    return f"{entity_prefix}_{mock}_{source}".upper()


def get_all_entities_for_module(module):
    """Return list of (prefix, info) for a given module (FIN/SCM/HCM)."""
    return [
        (prefix, info)
        for prefix, info in ENTITY_REGISTRY.items()
        if info["module"] == module.upper()
    ]


def get_all_modules():
    """Return sorted list of unique modules."""
    return sorted(set(info["module"] for info in ENTITY_REGISTRY.values()))


def sanitize_column_name(header):
    """
    Convert a CSV header string to a valid SQL column name.
    - Replace spaces and special chars with underscores
    - Strip leading/trailing underscores
    - Collapse multiple underscores
    """
    name = re.sub(r'[^A-Za-z0-9_]', '_', header.strip())
    name = re.sub(r'_+', '_', name)
    name = name.strip('_')
    return name if name else "COLUMN"
