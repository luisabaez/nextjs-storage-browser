"""
validation_jobs.py — validation runs that outlast a Lambda call.

A procedure-run program (HCM, PAY, Benefits and the FSCM procedures) can run
far longer than the 15 minutes a Lambda call may last: RHUM's HCM programs
take over an hour. Each such run is a job in VALIDATION_RUN_JOB:

  queued     recorded, waiting for a free slot
  running    its log rows were reset and stamped (validation_runner._new_run)
             and the procedure was handed to the database server through
             Systems Manager: a PowerShell command there connects with the
             application's own login (read from Secrets Manager by the
             server's role) and executes it with no time limit
  finishing  the procedure ended; the counts and the client workbook are
             being written (validation_runner.finish_sp_run / write_report)
  done | failed | cancelled

At most MAX_PARALLEL jobs run at once (VALIDATION_MAX_PARALLEL, default 4),
the rest wait their turn oldest first, so a busy day cannot pile every run
onto the database server. A second job for the same cycle, program and
source while one is queued or running is refused.

Jobs move on without anyone watching: Systems Manager reports the end of each
command to EventBridge, which calls this Lambda (handle_ssm_event). Listing
the jobs makes the same check, in case an event never arrives.
"""
import json
import os
from datetime import datetime

import boto3
import pyodbc

import validation_runner as runner
import validation_seed
from api_util import ApiError

DB = runner.DB
T_JOB = "VALIDATION_RUN_JOB"
MAX_PARALLEL = int(os.environ.get("VALIDATION_MAX_PARALLEL", "4"))
SQL_SERVER_INSTANCE = os.environ.get("SQL_SERVER_INSTANCE_ID", "i-005bc43c1a95338e4")
SECRET_ID = os.environ.get("SQL_SECRET_ID", "Hacienda_ERP_Test_MSSQL_text")
EXECUTION_TIMEOUT = 6 * 3600   # seconds the server may spend on one run
ACTIVE = ("queued", "running", "finishing")
_DONE_MARK = "VALIDATION RUN COMPLETE"

_DDL = (
    "[ID] INT IDENTITY(1,1) PRIMARY KEY, [MOCK] VARCHAR(20) NOT NULL, [Program] VARCHAR(100) NOT NULL, "
    "[Source] VARCHAR(50) NOT NULL, [Status] VARCHAR(20) NOT NULL, [Requested_By] NVARCHAR(200) NULL, "
    "[Requested_DTTM] DATETIME NOT NULL, [Started_DTTM] DATETIME NULL, [Finished_DTTM] DATETIME NULL, "
    "[Command_ID] VARCHAR(64) NULL, [Run_Number] INT NULL, [Run_DTTM] DATETIME NULL, [BU] NVARCHAR(100) NULL, "
    "[Total_Rows] INT NULL, [Report_Key] NVARCHAR(600) NULL, [Message] NVARCHAR(MAX) NULL")
_COLUMNS = ("[ID], [MOCK], [Program], [Source], [Status], [Requested_By], [Requested_DTTM], [Started_DTTM], "
            "[Finished_DTTM], [Command_ID], [Run_Number], [Run_DTTM], [BU], [Total_Rows], [Report_Key], [Message]")
_READY = False


def _ensure_table(cur, conn):
    global _READY
    if _READY:
        return
    cur.execute(f"SELECT COUNT(*) FROM [{DB}].sys.tables WHERE name = ?", (T_JOB,))
    if not cur.fetchone()[0]:
        cur.execute(f"CREATE TABLE [{DB}].dbo.[{T_JOB}] ({_DDL})")
        conn.commit()
    _READY = True


def _job(r):
    return {"id": r[0], "mock": r[1], "program": r[2], "source": r[3], "status": r[4], "requested_by": r[5],
            "requested_at": r[6], "started_at": r[7], "finished_at": r[8], "command_id": r[9], "run_number": r[10],
            "run_dttm": r[11], "bu": r[12], "total_rows": r[13], "report_key": r[14], "message": r[15]}


def _get(cur, job_id):
    cur.execute(f"SELECT {_COLUMNS} FROM [{DB}].dbo.[{T_JOB}] WHERE [ID] = ?", (job_id,))
    r = cur.fetchone()
    return _job(r) if r else None


def _public(job, queue=None):
    out = {k: v for k, v in job.items() if k != "command_id"}
    if queue is not None and job["status"] == "queued":
        out["queue_position"] = queue.index(job["id"]) + 1 if job["id"] in queue else None
    if job.get("report_key"):
        out["report_name"] = job["report_key"].rsplit("/", 1)[-1]
    return out


def _lock(cur, resource):
    """A session lock that serializes the job queue across Lambda calls."""
    cur.execute("DECLARE @r INT; EXEC @r = sp_getapplock @Resource = ?, @LockMode = 'Exclusive', "
                "@LockOwner = 'Session', @LockTimeout = 30000; SELECT @r", (resource,))
    if cur.fetchone()[0] < 0:
        raise ApiError("The validation queue is busy; try again in a moment", 503)


def _unlock(cur, resource):
    try:
        cur.execute("EXEC sp_releaseapplock @Resource = ?, @LockOwner = 'Session'", (resource,))
    except pyodbc.Error:
        pass


# ── the command the database server runs ─────────────────────────────────────

def _q(text):
    """A PowerShell single-quoted string."""
    return "'" + str(text).replace("'", "''") + "'"


def server_script(job_id, sp, label, source, mock):
    """PowerShell that executes the program's procedure on the database server.
    The login comes from Secrets Manager there and never appears in the
    command; the run's values are SQL parameters, not text."""
    sql = f"EXEC [{DB}].dbo.[{sp}] @REFRESH_TABLE = 1, @SOURCE = @source, @Validation_Program = @program, @MOCK = @mock"
    return "\n".join([
        "$ErrorActionPreference = 'Stop'",
        "Import-Module AWSPowerShell",
        f"$raw = (Get-SECSecretValue -SecretId {_q(SECRET_ID)} -Region us-east-1).SecretString",
        "$kv = @{}",
        "foreach ($part in $raw.Split(';')) { $i = $part.IndexOf('='); "
        "if ($i -gt 0) { $kv[$part.Substring(0, $i).Trim().ToUpper()] = $part.Substring($i + 1).Trim().Trim('{', '}') } }",
        "$b = New-Object System.Data.SqlClient.SqlConnectionStringBuilder",
        "$b['Data Source'] = $kv['SERVER']",
        "$b['Initial Catalog'] = $kv['DATABASE']",
        "$b['User ID'] = $kv['UID']",
        "$b['Password'] = $kv['PWD']",
        "$b['Encrypt'] = [bool]($kv['ENCRYPT'] -match '^(yes|true|mandatory)$')",
        "$b['TrustServerCertificate'] = $true",
        f"$b['Application Name'] = {_q(f'Validation run {job_id}')}",
        "$conn = New-Object System.Data.SqlClient.SqlConnection $b.ConnectionString",
        "$conn.add_InfoMessage([System.Data.SqlClient.SqlInfoMessageEventHandler] "
        "{ param($s, $e) [Console]::Out.WriteLine('MSG ' + $e.Message) })",
        "$conn.Open()",
        "try {",
        "  $cmd = $conn.CreateCommand()",
        "  $cmd.CommandTimeout = 0",
        f"  $cmd.CommandText = {_q(sql)}",
        f"  [void]$cmd.Parameters.AddWithValue('@source', {_q(source)})",
        f"  [void]$cmd.Parameters.AddWithValue('@program', {_q(label)})",
        f"  [void]$cmd.Parameters.AddWithValue('@mock', {_q(mock)})",
        "  [void]$cmd.ExecuteNonQuery()",
        f"  [Console]::Out.WriteLine({_q(_DONE_MARK)})",
        "} finally { $conn.Close() }",
    ])


def _send(job, spec):
    label = spec["label"] or job["program"]
    sent = boto3.client("ssm").send_command(
        InstanceIds=[SQL_SERVER_INSTANCE], DocumentName="AWS-RunPowerShellScript",
        Comment=f"Validation run {job['id']}: {job['program']} {job['source']} {job['mock']}"[:100],
        Parameters={"commands": [server_script(job["id"], spec["sp"], label, job["source"], job["mock"])],
                    "executionTimeout": [str(EXECUTION_TIMEOUT)]},
        TimeoutSeconds=600)
    return sent["Command"]["CommandId"]


# ── queue ────────────────────────────────────────────────────────────────────

def _queue(cur):
    cur.execute(f"SELECT [ID] FROM [{DB}].dbo.[{T_JOB}] WHERE [Status] = 'queued' ORDER BY [ID]")
    return [r[0] for r in cur.fetchall()]


def dispatch(cur, conn):
    """Start queued jobs while fewer than MAX_PARALLEL run."""
    _lock(cur, "validation_jobs")
    started = []
    try:
        cur.execute(f"SELECT COUNT(*) FROM [{DB}].dbo.[{T_JOB}] WHERE [Status] IN ('running', 'finishing')")
        free = MAX_PARALLEL - cur.fetchone()[0]
        for job_id in _queue(cur)[:max(free, 0)]:
            job = _get(cur, job_id)
            spec = runner.PROGRAMS[job["program"]]
            try:
                run_number, run_dttm, bu = runner._new_run(cur, conn, job["program"], job["source"], job["mock"],
                                                          job["requested_by"], spec["label"] or job["program"])
                command_id = _send(job, spec)
                cur.execute(f"UPDATE [{DB}].dbo.[{T_JOB}] SET [Status] = 'running', [Started_DTTM] = GETDATE(), "
                            "[Command_ID] = ?, [Run_Number] = ?, [Run_DTTM] = ?, [BU] = ? WHERE [ID] = ?",
                            (command_id, run_number, run_dttm, bu, job_id))
                started.append(job_id)
            except Exception as e:  # noqa: BLE001 - the job fails, the queue goes on
                conn.rollback()
                cur.execute(f"UPDATE [{DB}].dbo.[{T_JOB}] SET [Status] = 'failed', [Finished_DTTM] = GETDATE(), "
                            "[Message] = ? WHERE [ID] = ?", (f"Could not start: {str(e)[:500]}", job_id))
            conn.commit()
    finally:
        _unlock(cur, "validation_jobs")
    return started


def submit(conn_str, program, source, mock, actor):
    """Queue one run (and start it when a slot is free). Returns the job."""
    spec = runner.PROGRAMS.get(program)
    if not spec or spec["mode"] != "sp":
        raise ApiError(f"'{program}' does not run in the background")
    source = runner._check_ident((source or "").strip().upper(), "source")
    mock = runner._check_ident((mock or "").strip().upper(), "mock")
    seeded = None
    if validation_seed.is_test_target():
        seeded = validation_seed.seed_for_run(conn_str, spec, source, mock, program=program)
    with pyodbc.connect(conn_str, autocommit=False) as conn:
        cur = conn.cursor()
        _ensure_table(cur, conn)
        if not runner.sp_views(cur, spec, program, source, mock):
            raise ApiError(f"No {program} validation views found for {source} / {mock}", 404)
        _lock(cur, "validation_jobs")
        try:
            cur.execute(f"SELECT {_COLUMNS} FROM [{DB}].dbo.[{T_JOB}] WHERE [MOCK] = ? AND [Program] = ? "
                        f"AND [Source] = ? AND [Status] IN ('queued', 'running', 'finishing')", (mock, program, source))
            row = cur.fetchone()
            if row:
                job = _job(row)
                raise ApiError(f"{program} for {source} is already {job['status']} "
                               f"(requested by {job['requested_by']})", 409)
            cur.execute(f"INSERT INTO [{DB}].dbo.[{T_JOB}] ([MOCK], [Program], [Source], [Status], [Requested_By], "
                        "[Requested_DTTM]) OUTPUT INSERTED.[ID] VALUES (?, ?, ?, 'queued', ?, GETDATE())",
                        (mock, program, source, (actor or "app")[:200]))
            job_id = cur.fetchone()[0]
            conn.commit()
        finally:
            _unlock(cur, "validation_jobs")
        dispatch(cur, conn)
        job = _get(cur, job_id)
        out = {"ok": True, "background": True, "job": _public(job, _queue(cur))}
        if seeded and seeded.get("failed"):
            out["warnings"] = [f"{len(seeded['failed'])} object(s) could not be created in {DB}"]
        return out


# ── finishing ────────────────────────────────────────────────────────────────

_SSM_FINAL = {"Success": "done", "Failed": "failed", "Cancelled": "cancelled", "TimedOut": "failed",
              "DeliveryTimedOut": "failed", "ExecutionTimedOut": "failed", "Undeliverable": "failed",
              "Terminated": "failed", "InvalidPlatform": "failed", "AccessDenied": "failed"}


def _claim(cur, conn, job_id):
    """Take a running job for finishing; False when another call already did."""
    cur.execute(f"UPDATE [{DB}].dbo.[{T_JOB}] SET [Status] = 'finishing' WHERE [ID] = ? AND [Status] = 'running'",
                (job_id,))
    conn.commit()
    return cur.rowcount == 1


def finish(conn_str, bucket, job_id, invocation=None):
    """Record the end of a job whose command finished: counts and workbook on
    success, the server's error otherwise. Then start whatever is queued."""
    with pyodbc.connect(conn_str, autocommit=False) as conn:
        cur = conn.cursor()
        _ensure_table(cur, conn)
        job = _get(cur, job_id)
        if not job or job["status"] != "finishing":
            return job
        inv = invocation or boto3.client("ssm").get_command_invocation(
            CommandId=job["command_id"], InstanceId=SQL_SERVER_INSTANCE)
        status = _SSM_FINAL.get(inv.get("Status") or inv.get("StatusDetails"), "failed")
        stdout = inv.get("StandardOutputContent") or ""
        # Success means the script ended cleanly: any SQL error stops it with a
        # failure. (The output is cut at 24,000 characters, so the closing
        # mark may be missing after many procedure messages.)
        if status == "done":
            spec = runner.PROGRAMS[job["program"]]
            result = {"warnings": [], "codes": {}, "ok": True}
            # One message event can carry several PRINTs; every output line is one.
            printed = [line[4:] if line.startswith("MSG ") else line for line in stdout.splitlines()
                       if line.strip() and line.strip() != _DONE_MARK]
            runner.finish_sp_run(cur, conn, spec, job["program"], job["source"], job["mock"], job["run_number"],
                                 job["run_dttm"], job["bu"], printed, result)
            if bucket:
                runner.write_report(cur, spec, job["program"], job["source"], job["mock"], bucket, result)
            cur.execute(f"UPDATE [{DB}].dbo.[{T_JOB}] SET [Status] = 'done', [Finished_DTTM] = GETDATE(), "
                        "[Total_Rows] = ?, [Report_Key] = ?, [Message] = ? WHERE [ID] = ?",
                        (result.get("total_rows"), result.get("report_key"),
                         "\n".join(result["warnings"])[:4000] or None, job_id))
        else:
            detail = (inv.get("StandardErrorContent") or "").strip() or stdout.strip()
            final = "cancelled" if status == "cancelled" else "failed"
            cur.execute(f"UPDATE [{DB}].dbo.[{T_JOB}] SET [Status] = ?, [Finished_DTTM] = GETDATE(), [Message] = ? "
                        "WHERE [ID] = ?", (final, f"{inv.get('Status')}: {detail[-1500:]}"[:4000], job_id))
        conn.commit()
        dispatch(cur, conn)
        return _get(cur, job_id)


def _finish_later(job_id, function_name):
    """Finish in a separate invocation: a large workbook can take minutes."""
    boto3.client("lambda").invoke(FunctionName=function_name, InvocationType="Event",
                                  Payload=json.dumps({"validation_job_finish": job_id}).encode("utf-8"))


def check_running(conn_str, function_name):
    """Ask Systems Manager about the running jobs; hand finished ones to a
    separate invocation. The safety net for a missed EventBridge event."""
    ssm = boto3.client("ssm")
    with pyodbc.connect(conn_str, autocommit=False) as conn:
        cur = conn.cursor()
        _ensure_table(cur, conn)
        cur.execute(f"SELECT [ID], [Command_ID] FROM [{DB}].dbo.[{T_JOB}] WHERE [Status] = 'running'")
        for job_id, command_id in cur.fetchall():
            try:
                inv = ssm.get_command_invocation(CommandId=command_id, InstanceId=SQL_SERVER_INSTANCE)
            except ssm.exceptions.InvocationDoesNotExist:
                continue
            if inv.get("Status") in _SSM_FINAL and _claim(cur, conn, job_id):
                _finish_later(job_id, function_name)
        dispatch(cur, conn)


def handle_ssm_event(conn_str, bucket, event):
    """EventBridge: a Systems Manager command on the database server ended.
    Commands that are not validation jobs are ignored."""
    detail = event.get("detail") or {}
    command_id = detail.get("command-id")
    if not command_id or (detail.get("status") not in _SSM_FINAL):
        return None
    with pyodbc.connect(conn_str, autocommit=False) as conn:
        cur = conn.cursor()
        _ensure_table(cur, conn)
        cur.execute(f"SELECT [ID] FROM [{DB}].dbo.[{T_JOB}] WHERE [Command_ID] = ? AND [Status] = 'running'",
                    (command_id,))
        row = cur.fetchone()
        if not row or not _claim(cur, conn, row[0]):
            return None
    return finish(conn_str, bucket, row[0])


# ── reading and cancelling ───────────────────────────────────────────────────

def list_jobs(conn_str, mock=None, limit=50, function_name=None):
    """Recent jobs, newest first, with each queued job's place in line."""
    if function_name:
        check_running(conn_str, function_name)
    with pyodbc.connect(conn_str) as conn:
        cur = conn.cursor()
        _ensure_table(cur, conn)
        where, params = ("WHERE [MOCK] = ?", (mock,)) if mock else ("", ())
        cur.execute(f"SELECT TOP {int(limit)} {_COLUMNS} FROM [{DB}].dbo.[{T_JOB}] {where} ORDER BY [ID] DESC", params)
        jobs = [_job(r) for r in cur.fetchall()]
        queue = _queue(cur)
        cur.execute(f"SELECT COUNT(*) FROM [{DB}].dbo.[{T_JOB}] WHERE [Status] IN ('running', 'finishing')")
        running = cur.fetchone()[0]
    return {"ok": True, "jobs": [_public(j, queue) for j in jobs], "running": running, "queued": len(queue),
            "max_parallel": MAX_PARALLEL, "now": datetime.now()}


def cancel(conn_str, job_id, actor):
    """Stop a queued or running job."""
    with pyodbc.connect(conn_str, autocommit=False) as conn:
        cur = conn.cursor()
        _ensure_table(cur, conn)
        job = _get(cur, int(job_id))
        if not job:
            raise ApiError("Run not found", 404)
        if job["status"] == "queued":
            cur.execute(f"UPDATE [{DB}].dbo.[{T_JOB}] SET [Status] = 'cancelled', [Finished_DTTM] = GETDATE(), "
                        "[Message] = ? WHERE [ID] = ? AND [Status] = 'queued'", (f"Cancelled by {actor}", job["id"]))
            conn.commit()
        elif job["status"] == "running":
            boto3.client("ssm").cancel_command(CommandId=job["command_id"], InstanceIds=[SQL_SERVER_INSTANCE])
            cur.execute(f"UPDATE [{DB}].dbo.[{T_JOB}] SET [Message] = ? WHERE [ID] = ?",
                        (f"Cancel requested by {actor}", job["id"]))
            conn.commit()
        else:
            raise ApiError(f"This run is already {job['status']}", 409)
        return _public(_get(cur, job["id"]), _queue(cur))
