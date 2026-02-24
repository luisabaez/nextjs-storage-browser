"""
AP Invoice file validation — filename parsing and CSV header validation.
"""

import re

KNOWN_SOURCES = {"PRIFAS", "HACIENDA", "FIMAS", "ASSMCA", "SIFDE", "SALUD", "RETIRO"}


def parse_filename(filename):
    """
    Parse an AP Invoice filename to extract metadata.

    Expected patterns:
        FIN_AP_INVOICE_HDR_MOCK{N}_{SOURCE}_{YYYYMMDD}_{HHMM}.csv
        FIN_AP_INVOICE_LINES_MOCK{N}_{SOURCE}_{YYYYMMDD}_{HHMM}.csv
        FIN_AP_INVOICE_LINES_DTL1_MOCK{N}_{SOURCE}_{YYYYMMDD}_{HHMM}.csv

    Returns:
        dict with keys: pillar, file_type, mock_number, source, date, time, valid, error
    """
    result = {
        "filename": filename,
        "pillar": None,
        "file_type": None,
        "mock_number": None,
        "source": None,
        "date": None,
        "time": None,
        "valid": False,
        "error": None,
    }

    # Strip path prefix
    name = filename.split("/")[-1] if "/" in filename else filename

    if not name.lower().endswith(".csv"):
        result["error"] = f"Not a CSV file: {name}"
        return result

    # Try LINES_DTL1 first (most specific)
    m = re.match(
        r"^(FIN)_AP_INVOICE_LINES_DTL1_MOCK(\d+)_([A-Z0-9]+)_(\d{8})_(\d{4})\.csv$",
        name, re.IGNORECASE
    )
    if m:
        result["pillar"] = m.group(1).upper()
        result["file_type"] = "LINES_DTL1"
        result["mock_number"] = f"MOCK{m.group(2)}"
        result["source"] = m.group(3).upper()
        result["date"] = m.group(4)
        result["time"] = m.group(5)
        result["valid"] = True
        return result

    # Try LINES
    m = re.match(
        r"^(FIN)_AP_INVOICE_LINES_MOCK(\d+)_([A-Z0-9]+)_(\d{8})_(\d{4})\.csv$",
        name, re.IGNORECASE
    )
    if m:
        result["pillar"] = m.group(1).upper()
        result["file_type"] = "LINES"
        result["mock_number"] = f"MOCK{m.group(2)}"
        result["source"] = m.group(3).upper()
        result["date"] = m.group(4)
        result["time"] = m.group(5)
        result["valid"] = True
        return result

    # Try HDR
    m = re.match(
        r"^(FIN)_AP_INVOICE_HDR_MOCK(\d+)_([A-Z0-9]+)_(\d{8})_(\d{4})\.csv$",
        name, re.IGNORECASE
    )
    if m:
        result["pillar"] = m.group(1).upper()
        result["file_type"] = "HDR"
        result["mock_number"] = f"MOCK{m.group(2)}"
        result["source"] = m.group(3).upper()
        result["date"] = m.group(4)
        result["time"] = m.group(5)
        result["valid"] = True
        return result

    result["error"] = f"Filename does not match expected AP Invoice pattern: {name}"
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
    # Normalize: strip whitespace, uppercase
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
