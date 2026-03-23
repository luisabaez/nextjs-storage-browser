"""
Universal file validation — filename parsing and CSV header validation
for all FIN, SCM, and HCM entity types.
"""

import re
from entity_registry import (
    ENTITY_REGISTRY,
    EXCLUDED_PREFIXES,
    match_entity_prefix,
    is_excluded,
)

KNOWN_SOURCES = {
    "PRIFAS", "HACIENDA", "FIMAS", "ASSMCA", "SIFDE", "SALUD", "RETIRO",
    "RHUM", "KRONOSPOL", "KRONOSPOL_PHASE2", "DOE", "ADPPOLICIA",
    "911", "SURI", "ASG", "034", "015",
}


def parse_filename(filename):
    """
    Parse any FIN/SCM/HCM data filename to extract metadata.

    Expected pattern:
        {ENTITY_PREFIX}_MOCK{N}[PRE]_{SOURCE}_{YYYYMMDD}_{HHMM}.{csv|xlsx}

    Examples:
        FIN_AP_INVOICE_HDR_MOCK10_PRIFAS_20240101_1200.csv
        HCM_PERSON_MOCK11PRE_HACIENDA_20240301_0900.csv
        SCM_SUPPLIER_MOCK10_SALUD_20240201_1430.xlsx

    Returns:
        dict with keys: filename, module, entity_prefix, entity_display,
        mock_number, source, date, time, extension, is_legacy, is_excluded,
        valid, error
    """
    result = {
        "filename": filename,
        "module": None,
        "entity_prefix": None,
        "entity_display": None,
        "mock_number": None,
        "source": None,
        "date": None,
        "time": None,
        "extension": None,
        "is_legacy": False,
        "is_excluded": False,
        "valid": False,
        "error": None,
        # Keep backward-compat keys
        "pillar": None,
        "file_type": None,
    }

    # Strip S3 path prefix
    name = filename.split("/")[-1] if "/" in filename else filename

    # Check extension
    lower_name = name.lower()
    if lower_name.endswith(".csv"):
        result["extension"] = "csv"
    elif lower_name.endswith(".xlsx"):
        result["extension"] = "xlsx"
    else:
        result["error"] = f"Unsupported file type (expected .csv or .xlsx): {name}"
        return result

    # Strip version suffix (e.g. _V2, _v3, _V10) before pattern matching.
    # Submitters append these to indicate corrected re-uploads.
    # We preserve the original filename but parse against the base name.
    ext = ".csv" if result["extension"] == "csv" else ".xlsx"
    base_no_ext = name[: -len(ext)]
    version_suffix = None
    version_match = re.search(r'[_\-][Vv](\d+)$', base_no_ext)
    if version_match:
        version_suffix = version_match.group(0)          # e.g. "_V2"
        result["file_version"] = int(version_match.group(1))
        # Rebuild name without version suffix for pattern matching
        name = base_no_ext[: version_match.start()] + ext
    else:
        result["file_version"] = 1

    # Check for excluded entities first
    if is_excluded(name.upper()):
        result["is_excluded"] = True
        result["error"] = f"File belongs to an excluded entity: {name}"
        return result

    # Match entity prefix using longest-first matching
    entity_prefix = match_entity_prefix(name)
    if not entity_prefix:
        result["error"] = f"Filename does not match any known entity pattern: {name}"
        return result

    entity_info = ENTITY_REGISTRY[entity_prefix]
    result["entity_prefix"] = entity_prefix
    result["module"] = entity_info["module"]
    result["entity_display"] = entity_info["display_name"]
    result["is_legacy"] = entity_info["legacy"]
    # Backward compat
    result["pillar"] = entity_info["module"]

    # Extract the remainder after entity prefix: _MOCK{N}[PRE]_{SOURCE}[_{DATE}[_{TIME}]].ext
    remainder = name[len(entity_prefix):]
    ext = ".csv" if result["extension"] == "csv" else ".xlsx"
    ext_re = re.escape(ext)

    # Pattern 1: Standard format — _MOCK{N}_{SOURCE}_{YYYYMMDD}_{HHMM}.ext
    m = re.match(
        r'^_(MOCK\d+(?:PRE)?)_([A-Z0-9_]+)_(\d{8})_(\d{4})' + ext_re + r'$',
        remainder, re.IGNORECASE,
    )
    if m:
        result["mock_number"] = m.group(1).upper()
        result["source"] = m.group(2).upper()
        result["date"] = m.group(3)
        result["time"] = m.group(4)
        result["valid"] = True
        return _set_legacy_type(result, entity_prefix)

    # Pattern 2: Dashed date — _MOCK{N}_{SOURCE}_{YYYY-MM-DD}.ext
    m = re.match(
        r'^_(MOCK\d+(?:PRE)?)_([A-Z0-9_]+)_(\d{4}-\d{2}-\d{2})' + ext_re + r'$',
        remainder, re.IGNORECASE,
    )
    if m:
        result["mock_number"] = m.group(1).upper()
        result["source"] = m.group(2).upper()
        result["date"] = m.group(3).replace("-", "")
        result["time"] = "0000"
        result["valid"] = True
        return _set_legacy_type(result, entity_prefix)

    # Pattern 3: YYYYMMDD without time — _MOCK{N}_{SOURCE}_{YYYYMMDD}.ext
    m = re.match(
        r'^_(MOCK\d+(?:PRE)?)_([A-Z0-9_]+?)_(\d{8})' + ext_re + r'$',
        remainder, re.IGNORECASE,
    )
    if m:
        result["mock_number"] = m.group(1).upper()
        result["source"] = m.group(2).upper()
        result["date"] = m.group(3)
        result["time"] = "0000"
        result["valid"] = True
        return _set_legacy_type(result, entity_prefix)

    # Pattern 4: Underscored YYYY_MM_DD — _MOCK{N}_{SOURCE}_{YYYY}_{MM}_{DD}.ext
    m = re.match(
        r'^_(MOCK\d+(?:PRE)?)_(.+?)_(\d{4})_(\d{2})_(\d{2})' + ext_re + r'$',
        remainder, re.IGNORECASE,
    )
    if m:
        result["mock_number"] = m.group(1).upper()
        result["source"] = m.group(2).upper()
        result["date"] = m.group(3) + m.group(4) + m.group(5)
        result["time"] = "0000"
        result["valid"] = True
        return _set_legacy_type(result, entity_prefix)

    # Pattern 5: US date MM_DD_YYYY — _MOCK{N}_{SOURCE}_{MM}_{DD}_{YYYY}.ext
    m = re.match(
        r'^_(MOCK\d+(?:PRE)?)_(.+?)_(\d{2})_(\d{2})_(\d{4})' + ext_re + r'$',
        remainder, re.IGNORECASE,
    )
    if m:
        result["mock_number"] = m.group(1).upper()
        result["source"] = m.group(2).upper()
        result["date"] = m.group(5) + m.group(3) + m.group(4)  # → YYYYMMDD
        result["time"] = "0000"
        result["valid"] = True
        return _set_legacy_type(result, entity_prefix)

    # Pattern 6: No date at all — _MOCK{N}_{SOURCE}.ext
    m = re.match(
        r'^_(MOCK\d+(?:PRE)?)_([A-Z0-9_]+)' + ext_re + r'$',
        remainder, re.IGNORECASE,
    )
    if m:
        result["mock_number"] = m.group(1).upper()
        result["source"] = m.group(2).upper()
        result["date"] = "00000000"
        result["time"] = "0000"
        result["valid"] = True
        return _set_legacy_type(result, entity_prefix)

    # No pattern matched
    result["error"] = (
        f"Filename structure invalid after entity prefix '{entity_prefix}': "
        f"got '{remainder}'"
    )
    return result


def _set_legacy_type(result, entity_prefix):
    """Set backward-compat file_type for legacy AP Invoice entities."""
    if entity_prefix == "FIN_AP_INVOICE_HDR":
        result["file_type"] = "HDR"
    elif entity_prefix == "FIN_AP_INVOICE_LINES_DTL1":
        result["file_type"] = "LINES_DTL1"
    elif entity_prefix == "FIN_AP_INVOICE_LINES":
        result["file_type"] = "LINES"
    return result


def validate_source(source):
    """Check if the source agency is known."""
    return source.upper() in KNOWN_SOURCES


def validate_csv_headers(actual_headers, expected_csv_columns):
    """
    Validate that CSV headers match expected columns.

    Args:
        actual_headers: list of header strings from the CSV file
        expected_csv_columns: list of expected column names from the mapping

    Returns:
        (is_valid, error_message)
    """
    # Normalize: strip whitespace
    actual = [h.strip() for h in actual_headers]
    expected = [c.strip() for c in expected_csv_columns]

    if len(actual) < len(expected):
        return False, (
            f"CSV has {len(actual)} columns but expected {len(expected)}. "
            f"Missing columns: {', '.join(expected[len(actual):])}"
        )

    # Check each expected column exists in the correct position
    mismatches = []
    for i, (act, exp) in enumerate(zip(actual, expected)):
        if act.upper() != exp.upper():
            mismatches.append(f"Column {i+1}: got '{act}', expected '{exp}'")

    if mismatches:
        return False, f"Header mismatch: {'; '.join(mismatches[:5])}"

    return True, None
