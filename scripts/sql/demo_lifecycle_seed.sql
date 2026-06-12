-- ============================================================================
-- Demo lifecycle seed — replays the spec's APINV-PRIFAS scenario.
-- ----------------------------------------------------------------------------
-- Idempotent. Inserts 15 AWS_FILES rows + 3 VALIDATION_RUNS rows + the
-- VBL_GROUPS_MOCK12.VBL-FIN-AP row state covering:
--    Two failed initial uploads     (Invalid Headers + TSQL Load Error)
--    Two successful re-uploads      → VAL-0001
--    A File Not Expected rejection
--    A source data correction       → VAL-0002 (Approved)
--    Conversion Load + Recon + VBL file generation
--    Sterling transmission
--    A Distribution file (BU split)
--
-- All synthetic rows have Reason_for_Upload = 'DEMO-LIFECYCLE' so you can
-- filter them in the dashboard or delete them with a single statement:
--    DELETE FROM AWS_FILES WHERE Reason_for_Upload = 'DEMO-LIFECYCLE';
--    DELETE FROM VALIDATION_RUNS_MOCK12 WHERE Notes LIKE 'DEMO%';
-- ============================================================================

USE [Hacienda_ERP_Test];
GO
SET NOCOUNT ON;
GO

PRINT 'Cleaning up any prior demo rows…';
DELETE FROM AWS_FILES WHERE Reason_for_Upload = 'DEMO-LIFECYCLE';
DELETE FROM VALIDATION_RUNS_MOCK12 WHERE Notes LIKE 'DEMO%';
GO

DECLARE @bucket NVARCHAR(50) = N'hacienda-erp-dev';
DECLARE @now DATETIME2 = SYSUTCDATETIME();
DECLARE @t0 DATETIME2 = DATEADD(hour, -10, @now);  -- day 1, 10h ago
DECLARE @t1 DATETIME2 = DATEADD(hour, -9, @now);
DECLARE @t2 DATETIME2 = DATEADD(hour, -8, @now);
DECLARE @t3 DATETIME2 = DATEADD(hour, -7, @now);
DECLARE @t4 DATETIME2 = DATEADD(hour, -6, @now);
DECLARE @t5 DATETIME2 = DATEADD(hour, -5, @now);
DECLARE @t6 DATETIME2 = DATEADD(hour, -4, @now);
DECLARE @t7 DATETIME2 = DATEADD(hour, -3, @now);
DECLARE @t8 DATETIME2 = DATEADD(hour, -2, @now);
DECLARE @t9 DATETIME2 = DATEADD(hour, -1, @now);

-- 1. FIRST FAILED HDR UPLOAD — Invalid Headers
INSERT INTO AWS_FILES (
    AWS_eTag, Movement_Sequence, File_Name, File_Category, File_Status,
    File_Size_KB, Record_Count, Attempt_Number,
    Conversion_Plan_Table_Name, Conversion_Plan_Entity,
    Validation_Group_ID, WBS_ID, Pillar, Module, Data_Entity,
    [Source], Mock_Number,
    S3_Bucket, Parent_Folder, Parent_Folder_URL, File_URL, Moved_To_Folder,
    Created_DateTime, Received_DateTime, Processed_DateTime,
    Error_Type, Error_Owner,
    Check_File_Name, Check_File_Expected, Check_Column_Headers,
    Check_TSQL_File_Found, Check_TSQL_Load,
    Reason_for_Upload, Created_By, Last_Updated_By, Last_Updated_DateTime
) VALUES
(N'demo0001invhdr0000000000000000000', 1,
 N'FIN_AP_INVOICE_HDR_MOCK12_PRIFAS_20260101_0900.csv', N'Extract',
 N'Invalid Headers', 142, 0, 1,
 N'FIN_AP_INVOICES_MOCK12_PRIFAS', N'AP Invoice Header', N'APINV-PRIFAS',
 N'1.1.1.1.5.1', N'FIN', N'AP', N'AP Invoice Header', N'PRIFAS', N'MOCK12',
 @bucket, N'InitialUpload/', N's3://hacienda-erp-dev/InitialUpload/',
 N's3://hacienda-erp-dev/InitialUpload/FIN_AP_INVOICE_HDR_MOCK12_PRIFAS_20260101_0900.csv',
 N'FailedInvoices/FIN/MOCK12/PRIFAS/FIN_AP_INVOICE_HDR/',
 @t0, @t0, @t0, N'Invalid Headers', N'Source Team',
 N'Pass', N'Pass', N'Fail', N'Not Run', N'Not Run',
 N'DEMO-LIFECYCLE', N'source-team@demo', N'aws_files_writer', @t0);

-- 2. FIRST FAILED LINES UPLOAD — TSQL Load Error
INSERT INTO AWS_FILES (
    AWS_eTag, Movement_Sequence, File_Name, File_Category, File_Status,
    File_Size_KB, Record_Count, Attempt_Number,
    Conversion_Plan_Table_Name, Conversion_Plan_Entity,
    Validation_Group_ID, WBS_ID, Pillar, Module, Data_Entity,
    [Source], Mock_Number,
    S3_Bucket, Parent_Folder, Parent_Folder_URL, File_URL, Moved_To_Folder,
    Created_DateTime, Received_DateTime, Processed_DateTime,
    Error_Type, Error_Owner,
    Check_File_Name, Check_File_Expected, Check_Column_Headers,
    Check_TSQL_File_Found, Check_TSQL_Load,
    Reason_for_Upload, Created_By, Last_Updated_By, Last_Updated_DateTime
) VALUES
(N'demo0002tsqlerr00000000000000000', 1,
 N'FIN_AP_INVOICE_LINES_MOCK12_PRIFAS_20260101_0905.csv', N'Extract',
 N'TSQL Load Error', 2480, 0, 1,
 N'FIN_AP_INVOICE_LINES_MOCK12_PRIFAS', N'AP Invoice Lines', N'APINV-PRIFAS',
 N'1.1.1.1.5.2', N'FIN', N'AP', N'AP Invoice Lines', N'PRIFAS', N'MOCK12',
 @bucket, N'InitialUpload/', N's3://hacienda-erp-dev/InitialUpload/',
 N's3://hacienda-erp-dev/InitialUpload/FIN_AP_INVOICE_LINES_MOCK12_PRIFAS_20260101_0905.csv',
 N'FailedInvoices/FIN/MOCK12/PRIFAS/FIN_AP_INVOICE_LINES/',
 @t0, @t0, @t0, N'TSQL Load Error', N'Pipeline Team',
 N'Pass', N'Pass', N'Pass', N'Pass', N'Fail',
 N'DEMO-LIFECYCLE', N'source-team@demo', N'aws_files_writer', @t0);

-- 3 + 4. SUCCESSFUL RE-UPLOADS (seq 1 + seq 2 each) — HDR
INSERT INTO AWS_FILES (
    AWS_eTag, Movement_Sequence, File_Name, File_Category, File_Status,
    File_Size_KB, Record_Count, Attempt_Number,
    Conversion_Plan_Table_Name, Conversion_Plan_Entity,
    Validation_Group_ID, WBS_ID, Pillar, Module, Data_Entity,
    [Source], Mock_Number, Business_Unit,
    S3_Bucket, Parent_Folder, Parent_Folder_URL, File_URL, Moved_To_Folder,
    Created_DateTime, Received_DateTime, Processed_DateTime,
    Supersedes_eTag,
    Check_File_Name, Check_File_Expected, Check_Column_Headers,
    Check_TSQL_File_Found, Check_TSQL_Load,
    Reason_for_Upload, Created_By, Last_Updated_By, Last_Updated_DateTime
) VALUES
(N'demo0003hdrgood00000000000000000', 1,
 N'FIN_AP_INVOICE_HDR_MOCK12_PRIFAS_20260101_1030.csv', N'Extract',
 N'Table Load Success', 145, 1284, 2,
 N'FIN_AP_INVOICES_MOCK12_PRIFAS', N'AP Invoice Header', N'APINV-PRIFAS',
 N'1.1.1.1.5.1', N'FIN', N'AP', N'AP Invoice Header', N'PRIFAS', N'MOCK12', N'14',
 @bucket, N'InitialUpload/', N's3://hacienda-erp-dev/InitialUpload/',
 N's3://hacienda-erp-dev/InitialUpload/FIN_AP_INVOICE_HDR_MOCK12_PRIFAS_20260101_1030.csv',
 N'ProcessedFiles/FIN/MOCK12/PRIFAS/FIN_AP_INVOICE_HDR/',
 N'demo0001invhdr0000000000000000000',
 @t1, @t1, @t1,
 N'Pass', N'Pass', N'Pass', N'Pass', N'Pass',
 N'DEMO-LIFECYCLE', N'source-team@demo', N'aws_files_writer', @t1);

INSERT INTO AWS_FILES (
    AWS_eTag, Movement_Sequence, File_Name, File_Category, File_Status,
    File_Size_KB, Record_Count,
    Conversion_Plan_Table_Name, Conversion_Plan_Entity,
    Validation_Group_ID, Pillar, Module, Data_Entity,
    [Source], Mock_Number, Business_Unit,
    S3_Bucket, Parent_Folder, File_URL,
    Received_DateTime, Processed_DateTime,
    Check_File_Name, Check_File_Expected, Check_Column_Headers,
    Check_TSQL_File_Found, Check_TSQL_Load,
    Reason_for_Upload
) VALUES
(N'demo0003hdrgood00000000000000000', 2,
 N'FIN_AP_INVOICE_HDR_MOCK12_PRIFAS_20260101_1030.csv', N'Extract',
 N'Table Load Success', 145, 1284,
 N'FIN_AP_INVOICES_MOCK12_PRIFAS', N'AP Invoice Header', N'APINV-PRIFAS',
 N'FIN', N'AP', N'AP Invoice Header', N'PRIFAS', N'MOCK12', N'14',
 @bucket, N'ProcessedFiles/FIN/MOCK12/PRIFAS/FIN_AP_INVOICE_HDR/',
 N's3://hacienda-erp-dev/ProcessedFiles/FIN/MOCK12/PRIFAS/FIN_AP_INVOICE_HDR/FIN_AP_INVOICE_HDR_MOCK12_PRIFAS_20260101_1030.csv',
 @t1, @t1,
 N'N/A', N'N/A', N'N/A', N'N/A', N'N/A',
 N'DEMO-LIFECYCLE');

-- 5 + 6. SUCCESSFUL RE-UPLOAD LINES (seq 1 + seq 2)
INSERT INTO AWS_FILES (
    AWS_eTag, Movement_Sequence, File_Name, File_Category, File_Status,
    File_Size_KB, Record_Count, Attempt_Number,
    Conversion_Plan_Table_Name, Conversion_Plan_Entity,
    Validation_Group_ID, Pillar, Module, Data_Entity,
    [Source], Mock_Number, Business_Unit,
    S3_Bucket, Parent_Folder, File_URL, Moved_To_Folder,
    Created_DateTime, Received_DateTime, Processed_DateTime,
    Supersedes_eTag,
    Check_File_Name, Check_File_Expected, Check_Column_Headers,
    Check_TSQL_File_Found, Check_TSQL_Load,
    Reason_for_Upload
) VALUES
(N'demo0004lnsgood00000000000000000', 1,
 N'FIN_AP_INVOICE_LINES_MOCK12_PRIFAS_20260101_1045.csv', N'Extract',
 N'Table Load Success', 2510, 8421, 2,
 N'FIN_AP_INVOICE_LINES_MOCK12_PRIFAS', N'AP Invoice Lines', N'APINV-PRIFAS',
 N'FIN', N'AP', N'AP Invoice Lines', N'PRIFAS', N'MOCK12', N'14',
 @bucket, N'InitialUpload/',
 N's3://hacienda-erp-dev/InitialUpload/FIN_AP_INVOICE_LINES_MOCK12_PRIFAS_20260101_1045.csv',
 N'ProcessedFiles/FIN/MOCK12/PRIFAS/FIN_AP_INVOICE_LINES/',
 @t1, @t2, @t2, N'demo0002tsqlerr00000000000000000',
 N'Pass', N'Pass', N'Pass', N'Pass', N'Pass',
 N'DEMO-LIFECYCLE');

INSERT INTO AWS_FILES (
    AWS_eTag, Movement_Sequence, File_Name, File_Category, File_Status,
    File_Size_KB, Record_Count,
    Conversion_Plan_Table_Name, Conversion_Plan_Entity,
    Validation_Group_ID, Pillar, Module, Data_Entity,
    [Source], Mock_Number, Business_Unit,
    S3_Bucket, Parent_Folder, File_URL,
    Received_DateTime, Processed_DateTime,
    Check_File_Name, Check_File_Expected, Check_Column_Headers,
    Check_TSQL_File_Found, Check_TSQL_Load,
    Reason_for_Upload
) VALUES
(N'demo0004lnsgood00000000000000000', 2,
 N'FIN_AP_INVOICE_LINES_MOCK12_PRIFAS_20260101_1045.csv', N'Extract',
 N'Table Load Success', 2510, 8421,
 N'FIN_AP_INVOICE_LINES_MOCK12_PRIFAS', N'AP Invoice Lines', N'APINV-PRIFAS',
 N'FIN', N'AP', N'AP Invoice Lines', N'PRIFAS', N'MOCK12', N'14',
 @bucket, N'ProcessedFiles/FIN/MOCK12/PRIFAS/FIN_AP_INVOICE_LINES/',
 N's3://hacienda-erp-dev/ProcessedFiles/FIN/MOCK12/PRIFAS/FIN_AP_INVOICE_LINES/FIN_AP_INVOICE_LINES_MOCK12_PRIFAS_20260101_1045.csv',
 @t2, @t2,
 N'N/A', N'N/A', N'N/A', N'N/A', N'N/A',
 N'DEMO-LIFECYCLE');

-- 7. VAL-DEMO-0001 — first validation run (errors over threshold initially)
INSERT INTO VALIDATION_RUNS_MOCK12 (
    Validation_Run_ID, Validation_Group_ID, Mock_Number, Run_Number,
    Trigger_Reason, Triggered_By_eTag, Run_Status,
    Error_Count, Warning_Count, Informative_Record_Count,
    Threshold_Exceeded, Reextract_Required, Affected_Members,
    Run_Start_DateTime, Run_End_DateTime, Approval_Status,
    Approver_Email, Approval_DateTime, Approval_Comments,
    Last_Updated_By, Last_Updated_DateTime, Notes
) VALUES
(N'VAL-DEMO-0001', N'APINV-PRIFAS', N'MOCK12', 1,
 N'Initial Load', N'demo0004lnsgood00000000000000000', N'Rejected',
 12, 47, 1503, N'Y', N'Y', N'FIN_AP_INVOICES_MOCK12_PRIFAS',
 @t3, @t3, N'Rejected',
 N'approver@demo', @t4, N'Demo: errors exceed threshold; source team to re-extract HDR',
 N'demo-runner', @t4, N'DEMO-LIFECYCLE first validation run');

-- 8. FILE NOT EXPECTED REJECTION — someone tries to re-upload while
--    File_Expected is still N from the original load (before re-extract reset)
INSERT INTO AWS_FILES (
    AWS_eTag, Movement_Sequence, File_Name, File_Category, File_Status,
    File_Size_KB, Attempt_Number,
    Conversion_Plan_Table_Name, Conversion_Plan_Entity,
    Validation_Group_ID, Pillar, Module, Data_Entity,
    [Source], Mock_Number,
    S3_Bucket, Parent_Folder, File_URL, Moved_To_Folder,
    Created_DateTime, Received_DateTime, Processed_DateTime,
    Error_Type, Error_Owner,
    Check_File_Name, Check_File_Expected, Check_Column_Headers,
    Check_TSQL_File_Found, Check_TSQL_Load,
    Reason_for_Upload
) VALUES
(N'demo0005notexpected000000000000', 1,
 N'FIN_AP_INVOICE_HDR_MOCK12_PRIFAS_20260102_0930.csv', N'Extract',
 N'File Not Expected', 145, 3,
 N'FIN_AP_INVOICES_MOCK12_PRIFAS', N'AP Invoice Header', N'APINV-PRIFAS',
 N'FIN', N'AP', N'AP Invoice Header', N'PRIFAS', N'MOCK12',
 @bucket, N'InitialUpload/',
 N's3://hacienda-erp-dev/InitialUpload/FIN_AP_INVOICE_HDR_MOCK12_PRIFAS_20260102_0930.csv',
 N'FailedInvoices/FIN/MOCK12/PRIFAS/FIN_AP_INVOICE_HDR/',
 @t5, @t5, @t5, N'File Not Expected', N'Source Team',
 N'Pass', N'Fail', N'Not Run', N'Not Run', N'Not Run',
 N'DEMO-LIFECYCLE');

-- 9. CORRECTION UPLOAD HDR (after admin reset File_Expected to Y)
INSERT INTO AWS_FILES (
    AWS_eTag, Movement_Sequence, File_Name, File_Category, File_Status,
    File_Size_KB, Record_Count, Attempt_Number,
    Conversion_Plan_Table_Name, Conversion_Plan_Entity,
    Validation_Group_ID, Pillar, Module, Data_Entity,
    [Source], Mock_Number, Business_Unit,
    S3_Bucket, Parent_Folder, File_URL,
    Created_DateTime, Received_DateTime, Processed_DateTime,
    Supersedes_eTag,
    Check_File_Name, Check_File_Expected, Check_Column_Headers,
    Check_TSQL_File_Found, Check_TSQL_Load,
    Reason_for_Upload
) VALUES
(N'demo0006hdrfix000000000000000000', 1,
 N'FIN_AP_INVOICE_HDR_MOCK12_PRIFAS_20260102_1400.csv', N'Extract',
 N'Table Load Success', 148, 1284, 4,
 N'FIN_AP_INVOICES_MOCK12_PRIFAS', N'AP Invoice Header', N'APINV-PRIFAS',
 N'FIN', N'AP', N'AP Invoice Header', N'PRIFAS', N'MOCK12', N'14',
 @bucket, N'ProcessedFiles/FIN/MOCK12/PRIFAS/FIN_AP_INVOICE_HDR/',
 N's3://hacienda-erp-dev/ProcessedFiles/FIN/MOCK12/PRIFAS/FIN_AP_INVOICE_HDR/FIN_AP_INVOICE_HDR_MOCK12_PRIFAS_20260102_1400.csv',
 @t6, @t6, @t6, N'demo0003hdrgood00000000000000000',
 N'Pass', N'Pass', N'Pass', N'Pass', N'Pass',
 N'DEMO-LIFECYCLE');

-- Mark the old HDR superseded
UPDATE AWS_FILES SET Superseded_By_eTag = N'demo0006hdrfix000000000000000000',
                      File_Status = N'Superseded'
WHERE AWS_eTag = N'demo0003hdrgood00000000000000000';

-- 10. VAL-DEMO-0002 — second run, approved
INSERT INTO VALIDATION_RUNS_MOCK12 (
    Validation_Run_ID, Validation_Group_ID, Mock_Number, Run_Number,
    Trigger_Reason, Triggered_By_eTag, Run_Status,
    Error_Count, Warning_Count, Informative_Record_Count,
    Threshold_Exceeded, Reextract_Required,
    Run_Start_DateTime, Run_End_DateTime, Approval_Status,
    Approver_Email, Approval_DateTime, Approval_Comments, Validation_File_eTag,
    Last_Updated_By, Last_Updated_DateTime, Notes
) VALUES
(N'VAL-DEMO-0002', N'APINV-PRIFAS', N'MOCK12', 2,
 N'Re-upload', N'demo0006hdrfix000000000000000000', N'Approved',
 0, 31, 1284, N'N', N'N',
 @t6, @t6, N'Approved',
 N'approver@demo', @t7, N'Demo: after source correction, clean run',
 N'demo0007valxlsx00000000000000000',
 N'demo-runner', @t7, N'DEMO-LIFECYCLE re-validation success');

-- 11. VALIDATION-TO-SOURCE EXCEL output file
INSERT INTO AWS_FILES (
    AWS_eTag, Movement_Sequence, File_Name, File_Category, File_Status,
    File_Size_KB,
    Conversion_Plan_Entity, Validation_Group_ID,
    Pillar, Module, Data_Entity, [Source], Mock_Number,
    S3_Bucket, Parent_Folder, File_URL,
    Created_DateTime, Received_DateTime,
    Check_File_Name, Check_File_Expected, Check_Column_Headers,
    Check_TSQL_File_Found, Check_TSQL_Load,
    Reason_for_Upload
) VALUES
(N'demo0007valxlsx00000000000000000', 1,
 N'APINV-PRIFAS_VAL-DEMO-0002_validation.xlsx', N'Validation to Source',
 N'Table Load Success', 96,
 N'AP Invoice Header', N'APINV-PRIFAS',
 N'FIN', N'AP', N'AP Invoice Header', N'PRIFAS', N'MOCK12',
 @bucket, N'ValidationToSource/MOCK12/FIN/AP AP Invoice Header/PRIFAS/',
 N's3://hacienda-erp-dev/ValidationToSource/MOCK12/FIN/AP AP Invoice Header/PRIFAS/APINV-PRIFAS_VAL-DEMO-0002_validation.xlsx',
 @t7, @t7,
 N'N/A', N'N/A', N'N/A', N'N/A', N'N/A',
 N'DEMO-LIFECYCLE');

-- 12. CONVERSION LOAD file
INSERT INTO AWS_FILES (
    AWS_eTag, Movement_Sequence, File_Name, File_Category, File_Status,
    File_Size_KB,
    Conversion_Plan_Entity, VBL_Group_ID,
    Pillar, Module, Data_Entity, [Source], Mock_Number,
    S3_Bucket, Parent_Folder, File_URL,
    Created_DateTime, Received_DateTime,
    Sterling_Transmission_Status,
    Check_File_Name, Check_File_Expected, Check_Column_Headers,
    Check_TSQL_File_Found, Check_TSQL_Load,
    Reason_for_Upload
) VALUES
(N'demo0008convload0000000000000000', 1,
 N'VBL-FIN-AP_ConversionLoad_MOCK12.csv', N'Conversion Load',
 N'Sent to Oracle', 4280,
 N'AP Invoice Header', N'VBL-FIN-AP',
 N'FIN', N'AP', N'AP Invoice Header', N'PRIFAS', N'MOCK12',
 @bucket, N'ConversionLoad/MOCK12/FIN/AP AP Invoice Header/',
 N's3://hacienda-erp-dev/ConversionLoad/MOCK12/FIN/AP AP Invoice Header/VBL-FIN-AP_ConversionLoad_MOCK12.csv',
 @t8, @t8, N'Submitted',
 N'N/A', N'N/A', N'N/A', N'N/A', N'N/A',
 N'DEMO-LIFECYCLE');

-- 13. RECON REPORT
INSERT INTO AWS_FILES (
    AWS_eTag, Movement_Sequence, File_Name, File_Category, File_Status,
    File_Size_KB, VBL_Group_ID,
    Pillar, Module, Mock_Number,
    S3_Bucket, Parent_Folder, File_URL,
    Created_DateTime, Received_DateTime,
    Check_File_Name, Check_File_Expected, Check_Column_Headers,
    Check_TSQL_File_Found, Check_TSQL_Load,
    Reason_for_Upload
) VALUES
(N'demo0009recon000000000000000000', 1,
 N'VBL-FIN-AP_Recon_MOCK12.xlsx', N'Recon Report',
 N'Approved', 184, N'VBL-FIN-AP',
 N'FIN', N'AP', N'MOCK12',
 @bucket, N'ReconReports/MOCK12/FIN/AP/',
 N's3://hacienda-erp-dev/ReconReports/MOCK12/FIN/AP/VBL-FIN-AP_Recon_MOCK12.xlsx',
 @t8, @t8,
 N'N/A', N'N/A', N'N/A', N'N/A', N'N/A',
 N'DEMO-LIFECYCLE');

-- 14. VBL REPORT
INSERT INTO AWS_FILES (
    AWS_eTag, Movement_Sequence, File_Name, File_Category, File_Status,
    File_Size_KB, VBL_Group_ID,
    Pillar, Module, Mock_Number,
    S3_Bucket, Parent_Folder, File_URL,
    Created_DateTime, Received_DateTime,
    Check_File_Name, Check_File_Expected, Check_Column_Headers,
    Check_TSQL_File_Found, Check_TSQL_Load,
    Reason_for_Upload
) VALUES
(N'demo0010vblreport0000000000000', 1,
 N'VBL-FIN-AP_VBLReport_MOCK12.xlsx', N'Validation Before Load',
 N'Approved', 142, N'VBL-FIN-AP',
 N'FIN', N'AP', N'MOCK12',
 @bucket, N'ValidationBeforeLoad/MOCK12/FIN/AP/',
 N's3://hacienda-erp-dev/ValidationBeforeLoad/MOCK12/FIN/AP/VBL-FIN-AP_VBLReport_MOCK12.xlsx',
 @t8, @t8,
 N'N/A', N'N/A', N'N/A', N'N/A', N'N/A',
 N'DEMO-LIFECYCLE');

-- 15. BU DISTRIBUTION — BU 14 split of the Conversion Load
INSERT INTO AWS_FILES (
    AWS_eTag, Movement_Sequence, File_Name, File_Category, File_Status,
    File_Size_KB, Business_Unit, Split_From_eTag,
    VBL_Group_ID, Conversion_Plan_Entity,
    Pillar, Module, Mock_Number, [Source],
    S3_Bucket, Parent_Folder, File_URL,
    Created_DateTime, Received_DateTime,
    Check_File_Name, Check_File_Expected, Check_Column_Headers,
    Check_TSQL_File_Found, Check_TSQL_Load,
    Reason_for_Upload
) VALUES
(N'demo0011distrib00000000000000000', 1,
 N'VBL-FIN-AP_ConversionLoad_MOCK12_BU14.csv', N'Distribution - Conversion Load',
 N'Distributed', 1410, N'14', N'demo0008convload0000000000000000',
 N'VBL-FIN-AP', N'AP Invoice Header',
 N'FIN', N'AP', N'MOCK12', N'PRIFAS',
 @bucket, N'Distribution/MOCK12/FIN/AP AP Invoice Header/14/',
 N's3://hacienda-erp-dev/Distribution/MOCK12/FIN/AP AP Invoice Header/14/VBL-FIN-AP_ConversionLoad_MOCK12_BU14.csv',
 @t9, @t9,
 N'N/A', N'N/A', N'N/A', N'N/A', N'N/A',
 N'DEMO-LIFECYCLE');

-- ─── VBL group state to match the lifecycle ────────────────────────────
UPDATE VBL_GROUPS_MOCK12 SET
    VBL_File_eTag = N'demo0010vblreport0000000000000',
    Recon_File_eTag = N'demo0009recon000000000000000000',
    Conversion_Load_File_eTag = N'demo0008convload0000000000000000',
    VBL_Run_Count = 1,
    Latest_VBL_Status = N'Sent to Oracle',
    Latest_VBL_DateTime = @t8,
    Latest_Approval_Status = N'Approved',
    Latest_Approver = N'approver@demo',
    Latest_Approval_DateTime = @t8,
    Latest_Approval_Comments = N'Demo: VBL approved after both VGs cleared',
    Sterling_Transmission_Status = N'Submitted',
    Sterling_Transmission_DateTime = @t8,
    Val_To_Source_Members_Approved = 2,
    All_Val_To_Source_Approved = N'Y',
    Last_Updated_By = N'demo-seed',
    Last_Updated_DateTime = @now
WHERE VBL_Group_ID = N'VBL-FIN-AP';

-- Mark APINV-PRIFAS + SUP-PRIFAS approved in the member matrix
UPDATE VBL_GROUP_MEMBERS_MOCK12 SET
    Val_To_Source_Latest_Status = N'Approved',
    Val_To_Source_Approval_Status = N'Approved',
    Val_To_Source_Approval_DateTime = @t7,
    Blocks_VBL_Trigger = N'N',
    Last_Updated_By = N'demo-seed',
    Last_Updated_DateTime = @now
WHERE VBL_Group_ID = N'VBL-FIN-AP'
  AND Validation_Group_ID IN (N'APINV-PRIFAS', N'SUP-PRIFAS');

-- Validation Group rollup
UPDATE VALIDATION_GROUPS_MOCK12 SET
    Members_Currently_Loaded = 2,
    All_Members_Loaded = N'Y',
    Current_Validation_Run_ID = N'VAL-DEMO-0002',
    Validation_Run_Count = 2,
    Latest_Validation_Status = N'Pending Approval',
    Latest_Validation_DateTime = @t7,
    Latest_Approval_Status = N'Approved',
    Latest_Approver = N'approver@demo',
    Latest_Approval_DateTime = @t7,
    Latest_Approval_Comments = N'Demo: re-extract corrected',
    Last_Updated_By = N'demo-seed',
    Last_Updated_DateTime = @now
WHERE Validation_Group_ID = N'APINV-PRIFAS';
GO

PRINT '';
PRINT '======================================================================';
PRINT 'Demo lifecycle seed complete.';
PRINT '======================================================================';
PRINT 'Filter the dashboard by Reason_for_Upload = ''DEMO-LIFECYCLE'' to see';
PRINT 'the 11 AWS_FILES rows. Open Validation Runs tab to see VAL-DEMO-0001';
PRINT '(rejected) and VAL-DEMO-0002 (approved). Open the VBL-FIN-AP card to';
PRINT 'see Sterling = Submitted + 1 Distribution child.';
PRINT '';
PRINT 'To remove demo rows:';
PRINT '  DELETE FROM AWS_FILES WHERE Reason_for_Upload = ''DEMO-LIFECYCLE'';';
PRINT '  DELETE FROM VALIDATION_RUNS_MOCK12 WHERE Notes LIKE ''DEMO%'';';
PRINT '======================================================================';
GO
