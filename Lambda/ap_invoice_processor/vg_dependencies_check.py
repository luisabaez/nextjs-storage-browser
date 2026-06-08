"""
vg_dependencies_check.py
========================
Evaluates VG_DEPENDENCIES_MOCK{N} rows: for each row, marks
Dependency_Status as 'Loaded' if the depended-on table currently has at
least one Movement_Sequence=1 row in AWS_FILES with
File_Status='Table Load Success' (and not Superseded).

The Validation Group can only trigger when every VG_DEPENDENCIES row for it
has Blocks_Validation_Trigger='N' (which we derive from Dependency_Status).

Called by validation_group_tracker.on_table_load_success after each
successful load, AND when checking whether a run can fire.
"""
import pyodbc


def evaluate_dependencies(connection_str: str, mock_number: str,
                          validation_group_id: str = None) -> dict:
    """
    Re-evaluate every VG_DEPENDENCIES_{MOCK} row's Dependency_Status by
    checking whether Depends_On_Table_Name has an active Table Load Success
    row in AWS_FILES.

    If validation_group_id is given, only that group's rows are evaluated;
    otherwise all rows in the table are refreshed.

    Returns:
        {
            'evaluated': N,
            'satisfied': M,
            'blocking': K,
            'by_group': {'APINV-PRIFAS': [{...dep row}, ...]}
        }
    """
    table = f"VG_DEPENDENCIES_{mock_number}"
    result = {'evaluated': 0, 'satisfied': 0, 'blocking': 0, 'by_group': {}}

    with pyodbc.connect(connection_str) as conn:
        cur = conn.cursor()

        # Bail cleanly if the table doesn't exist (Phase 1 not run for this Mock)
        cur.execute("SELECT COUNT(*) FROM sys.tables WHERE name = ?", (table,))
        if cur.fetchone()[0] == 0:
            return result

        # Fetch dep rows
        params = []
        sql = f"""
            SELECT Dependency_ID, Validation_Group_ID, Depends_On_Table_Name
            FROM {table}
        """
        if validation_group_id:
            sql += " WHERE Validation_Group_ID = ?"
            params.append(validation_group_id)
        cur.execute(sql, params)
        deps = cur.fetchall()

        for dep_id, vg_id, table_name in deps:
            result['evaluated'] += 1
            # Does this table currently have an active Table Load Success?
            cur.execute(
                """
                SELECT TOP 1 AWS_eTag, Processed_DateTime
                FROM AWS_FILES
                WHERE Conversion_Plan_Table_Name = ?
                  AND Movement_Sequence = 1
                  AND File_Status = 'Table Load Success'
                  AND Superseded_By_eTag IS NULL
                ORDER BY Processed_DateTime DESC
                """,
                (table_name,),
            )
            row = cur.fetchone()
            loaded = row is not None
            load_dt = row[1] if row else None

            status = 'Loaded' if loaded else 'Not Loaded'
            blocks = 'N' if loaded else 'Y'

            cur.execute(
                f"""
                UPDATE {table} SET
                    Dependency_Status = ?,
                    Table_Load_DateTime = ?,
                    Blocks_Validation_Trigger = ?,
                    Last_Updated_By = 'validation_group_tracker',
                    Last_Updated_DateTime = SYSUTCDATETIME()
                WHERE Dependency_ID = ?
                """,
                (status, load_dt, blocks, dep_id),
            )
            if loaded:
                result['satisfied'] += 1
            else:
                result['blocking'] += 1

            result['by_group'].setdefault(vg_id, []).append({
                'dep_id': dep_id,
                'table': table_name,
                'status': status,
                'blocks': blocks,
            })

        conn.commit()
    return result


def all_dependencies_satisfied(connection_str: str, mock_number: str,
                               validation_group_id: str) -> bool:
    """
    Quick check: does this VG have zero blocking dependency rows?
    Always re-evaluates first so the result reflects current AWS_FILES state.
    """
    summary = evaluate_dependencies(connection_str, mock_number, validation_group_id)
    blocking_for_vg = sum(
        1 for r in summary['by_group'].get(validation_group_id, [])
        if r['blocks'] == 'Y'
    )
    return blocking_for_vg == 0
