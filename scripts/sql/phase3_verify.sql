-- ============================================================================
-- Phase 3 verification queries
-- ----------------------------------------------------------------------------
-- Run these after uploading + processing a real file (and ideally a second
-- re-upload of the same logical file) to prove the gate-check + version
-- chain end-to-end pipeline works.
--
-- Safe to run repeatedly. Read-only.
-- ============================================================================

USE [Hacienda_ERP_Test];
GO

PRINT '========================================';
PRINT '1. Most recent AWS_FILES events (top 10)';
PRINT '========================================';
SELECT TOP 10
    LEFT(AWS_eTag, 12) + N'…' AS eTag,
    Movement_Sequence AS Seq,
    File_Name,
    File_Status,
    Check_File_Name AS Chk_Name,
    Check_File_Expected AS Chk_Exp,
    Check_Column_Headers AS Chk_Hdr,
    Check_TSQL_File_Found AS Chk_Found,
    Check_TSQL_Load AS Chk_Load,
    Error_Type,
    Error_Owner,
    Record_Count,
    Received_DateTime
FROM AWS_FILES
ORDER BY Received_DateTime DESC, Movement_Sequence;
GO

PRINT '';
PRINT '========================================';
PRINT '2. Version chain — files that supersede or were superseded';
PRINT '========================================';
SELECT
    LEFT(AWS_eTag, 12) + N'…' AS eTag,
    File_Name,
    File_Status,
    LEFT(Supersedes_eTag, 12) + N'…' AS Supersedes,
    LEFT(Superseded_By_eTag, 12) + N'…' AS Superseded_By,
    Conversion_Plan_Entity,
    [Source],
    Mock_Number,
    Received_DateTime
FROM AWS_FILES
WHERE Movement_Sequence = 1
  AND (Supersedes_eTag IS NOT NULL OR Superseded_By_eTag IS NOT NULL)
ORDER BY Conversion_Plan_Entity, [Source], Received_DateTime;
GO

PRINT '';
PRINT '========================================';
PRINT '3. Gate-check failures — files rejected before load';
PRINT '========================================';
SELECT
    LEFT(AWS_eTag, 12) + N'…' AS eTag,
    File_Name,
    File_Status,
    Error_Type,
    Error_Owner,
    Moved_To_Folder,
    Notes
FROM AWS_FILES
WHERE Movement_Sequence = 1
  AND (Check_File_Name = 'Fail'
    OR Check_File_Expected = 'Fail'
    OR Check_Column_Headers = 'Fail'
    OR Check_TSQL_File_Found = 'Fail'
    OR Check_TSQL_Load = 'Fail')
ORDER BY Received_DateTime DESC;
GO

PRINT '';
PRINT '========================================';
PRINT '4. File_Expected flip — verify Phase 3 auto-flip is working';
PRINT '========================================';
-- After a successful load, the entity+source row should have File_Expected=N
SELECT
    a.File_Name,
    a.Conversion_Plan_Entity AS AWS_Entity,
    a.[Source] AS AWS_Source,
    a.File_Status,
    a.Processed_DateTime,
    p.Entity AS Plan_Entity,
    p.SubEntity AS Plan_SubEntity,
    p.[SOURCE] AS Plan_Source,
    p.File_Expected AS Plan_File_Expected,
    p.Current_Process_Stage,
    LEFT(p.Latest_File_ID, 12) + N'…' AS Latest_File_ID
FROM AWS_FILES a
LEFT JOIN SETUP_CONVERSION_PLAN_MOCK12 p
    ON (LTRIM(RTRIM(ISNULL(p.Entity, ''))) = LTRIM(RTRIM(ISNULL(a.Conversion_Plan_Entity, '')))
        OR LTRIM(RTRIM(ISNULL(p.SubEntity, ''))) = LTRIM(RTRIM(ISNULL(a.Conversion_Plan_Entity, ''))))
   AND LTRIM(RTRIM(ISNULL(p.[SOURCE], ''))) = LTRIM(RTRIM(ISNULL(a.[Source], '')))
WHERE a.Movement_Sequence = 1
  AND a.File_Status = 'Table Load Success'
ORDER BY a.Processed_DateTime DESC;
-- Expect: Plan_File_Expected = 'N' on rows where File_Status = 'Table Load Success'
GO

PRINT '';
PRINT '========================================';
PRINT '5. Pipeline health — counts by status (last 24h)';
PRINT '========================================';
SELECT
    File_Status,
    COUNT(*) AS row_count,
    MIN(Received_DateTime) AS earliest,
    MAX(Received_DateTime) AS latest
FROM AWS_FILES
WHERE Received_DateTime >= DATEADD(hour, -24, SYSUTCDATETIME())
GROUP BY File_Status
ORDER BY row_count DESC;
GO

PRINT '';
PRINT '========================================';
PRINT '6. Lineage — seq 1 + seq 2 paired (file location chain)';
PRINT '========================================';
SELECT
    LEFT(s1.AWS_eTag, 12) + N'…' AS eTag,
    s1.File_Name,
    s1.Parent_Folder AS Landed_In,
    s1.Moved_To_Folder AS Moved_To,
    s2.Parent_Folder AS Now_At,
    s1.File_Status AS Seq1_Status,
    s2.File_Status AS Seq2_Status
FROM AWS_FILES s1
LEFT JOIN AWS_FILES s2
    ON s2.AWS_eTag = s1.AWS_eTag AND s2.Movement_Sequence = 2
WHERE s1.Movement_Sequence = 1
ORDER BY s1.Received_DateTime DESC
OFFSET 0 ROWS FETCH NEXT 20 ROWS ONLY;
GO

PRINT 'Phase 3 verification queries complete.';
GO
