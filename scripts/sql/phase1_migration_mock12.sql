-- ============================================================================
-- Phase 1 Migration — ERP Migration Tracking System
-- ----------------------------------------------------------------------------
-- Target database : Hacienda_ERP_Test
-- Target Mock     : MOCK12 (the current Mock with data; confirmed 2026-06-03)
--                   MOCK12 is created empty by the Promote button when ready.
--
-- This script is IDEMPOTENT. Safe to re-run; uses guarded CREATE / ALTER /
-- INSERT statements so existing objects/data are not duplicated.
--
-- Sections (in order):
--   1. SETUP_CONVERSION_PLAN_MOCK12 — add 39 new columns (53 → 92 spec cols)
--   2. AWS_FILES                    — single global event-log table
--   3. VALIDATION_GROUPS_MOCK12     — group state
--   4. VALIDATION_RUNS_MOCK12       — VAL-NNNN run history
--   5. VBL_GROUPS_MOCK12            — VBL-PILLAR-MODULE state
--   6. VBL_GROUP_MEMBERS_MOCK12     — mapping (composite PK)
--   7. VG_DEPENDENCIES_MOCK12       — cross-group prerequisites
--   8. SCHEMA_REFERENCE             — data dictionary (global)
--   9. MOCK_PROMOTIONS              — promote-button audit trail (global)
--
-- All text columns use NVARCHAR(...) to match the existing
-- SETUP_CONVERSION_PLAN style.  No CHECK constraints on enums — the
-- application layer enforces them.  Foreign keys are intentionally
-- omitted because Mock-numbered tables are dropped/recreated per Mock
-- and FKs across Mocks would block the promotion flow.
-- ============================================================================

USE [Hacienda_ERP_Test];
GO

SET NOCOUNT ON;
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO


-- ============================================================================
-- 1. SETUP_CONVERSION_PLAN_MOCK12 — add 39 new columns from spec
-- ============================================================================
-- The table already exists with 53 reference columns + 8 tracking columns.
-- This block adds the 39 columns introduced by Database_Schema_v9.xlsx.
-- Each ALTER TABLE is guarded so re-runs are no-ops.

DECLARE @setup_table NVARCHAR(128) = N'SETUP_CONVERSION_PLAN_MOCK12';

-- Make sure the base table exists. If it doesn't, the Lambda creates it on
-- first file load; here we just bail with a clear message instead of crashing.
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = @setup_table)
BEGIN
    PRINT 'NOTE: ' + @setup_table + ' does not exist yet — Lambda will create it on first load. New columns will be added then via Lambda code (see conversion_plan_tracker.py).';
END
ELSE
BEGIN
    PRINT 'Extending ' + @setup_table + ' with new spec columns…';

    -- Core Identity & WBS (5 new)
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'ID')                               ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [ID]                               NVARCHAR(50)  NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'WBS_level')                        ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [WBS_level]                        INT           NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'Validation_Group_ID')              ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [Validation_Group_ID]              NVARCHAR(100) NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'Predecessor_Validation_Group_ID')  ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [Predecessor_Validation_Group_ID]  NVARCHAR(100) NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'Successors_for_Initial_Validation')ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [Successors_for_Initial_Validation]NVARCHAR(500) NULL;

    -- WBS Breakdown (6 new)
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'WBS_L1_Mock')   ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [WBS_L1_Mock]   NVARCHAR(50) NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'WBS_L2_Pillar') ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [WBS_L2_Pillar] NVARCHAR(50) NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'WBS_L3_Module') ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [WBS_L3_Module] NVARCHAR(50) NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'WBS_L4_Entity') ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [WBS_L4_Entity] NVARCHAR(200) NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'WBS_L5_Source') ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [WBS_L5_Source] NVARCHAR(50) NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'WBS_L6_Table')  ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [WBS_L6_Table]  NVARCHAR(200) NULL;

    -- Mock / Phase (2 new)
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'Mock_Number') ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [Mock_Number] NVARCHAR(20) NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'Phase')       ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [Phase]       NVARCHAR(20) NULL;

    -- Scheduling & Ownership (7 new)
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'Expected_File_Receipt_Date') ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [Expected_File_Receipt_Date] DATETIME2 NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'Actual_File_Receipt_Date')   ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [Actual_File_Receipt_Date]   DATETIME2 NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'Target_Conversion_Complete') ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [Target_Conversion_Complete] DATETIME2 NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'Target_Oracle_Load_Date')    ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [Target_Oracle_Load_Date]    DATETIME2 NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'Responsible_Team')           ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [Responsible_Team]           NVARCHAR(100) NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'Owner_Contact')              ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [Owner_Contact]              NVARCHAR(200) NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'Priority')                   ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [Priority]                   NVARCHAR(20)  NULL;

    -- Current Status (12 new) — Current_Process_Stage drives the Gantt
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'Current_Process_Stage')   ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [Current_Process_Stage]   NVARCHAR(50)  NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'Latest_File_ID')          ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [Latest_File_ID]          NVARCHAR(64)  NULL;  -- eTag pointer to AWS_FILES
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'Latest_File_Upload_Date') ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [Latest_File_Upload_Date] DATETIME2 NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'Total_Upload_Attempts')   ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [Total_Upload_Attempts]   INT       NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'Latest_Validation_Status') ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [Latest_Validation_Status] NVARCHAR(50) NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'Latest_Approval_Status')   ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [Latest_Approval_Status]   NVARCHAR(50) NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'Latest_Approver')          ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [Latest_Approver]          NVARCHAR(200) NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'Latest_Approval_Date')     ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [Latest_Approval_Date]     DATETIME2 NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'Pre_Load_Validation_Status') ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [Pre_Load_Validation_Status] NVARCHAR(50) NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'Pre_Load_Recon_Status')      ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [Pre_Load_Recon_Status]      NVARCHAR(50) NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'Oracle_Load_Status')         ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [Oracle_Load_Status]         NVARCHAR(50) NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'Oracle_Load_Date')           ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [Oracle_Load_Date]           DATETIME2 NULL;

    -- Blockers & Issues (4 new)
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'Blocker_Flag')        ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [Blocker_Flag]        NVARCHAR(5)   NULL;  -- Y / N
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'Blocker_Description') ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [Blocker_Description] NVARCHAR(2000) NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'Issue_Opened_Date')   ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [Issue_Opened_Date]   DATETIME2 NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'Issue_Resolved_Date') ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [Issue_Resolved_Date] DATETIME2 NULL;

    -- Audit (3 new) — spec calls these out separately from our own tracking cols
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'Last_Updated_By')   ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [Last_Updated_By]   NVARCHAR(200) NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'Last_Updated_Date') ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [Last_Updated_Date] DATETIME2 NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(@setup_table) AND name = 'Notes')             ALTER TABLE [SETUP_CONVERSION_PLAN_MOCK12] ADD [Notes]             NVARCHAR(MAX) NULL;

    PRINT '  ✓ SETUP_CONVERSION_PLAN_MOCK12 extended (39 new columns checked / added)';
END
GO


-- ============================================================================
-- 2. AWS_FILES — single global event-log table
-- ============================================================================
-- Composite PK: AWS_eTag + Movement_Sequence
--   • seq 1 = file landed (InitialUpload)
--   • seq 2 = file moved to destination (ConversionFiles, Errors, etc.)
-- Lifetime: a single eTag survives moves; new uploads get a new eTag.
-- Version chain: Supersedes_eTag / Superseded_By_eTag form the chain;
-- Split_From_eTag links BU-split distribution files to their parent.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'AWS_FILES')
BEGIN
    PRINT 'Creating AWS_FILES…';
    CREATE TABLE [AWS_FILES] (
        -- File Identity (cols 1-7)
        [AWS_eTag]                       NVARCHAR(64)  NOT NULL,
        [Movement_Sequence]              INT           NOT NULL,
        [File_Name]                      NVARCHAR(500) NOT NULL,
        [File_Category]                  NVARCHAR(100) NOT NULL,
        [File_Size_KB]                   BIGINT        NULL,
        [Record_Count]                   BIGINT        NULL,
        [Attempt_Number]                 INT           NULL,

        -- Conversion Plan Link (cols 8-18)
        [Conversion_Plan_Table_Name]     NVARCHAR(200) NULL,
        [Conversion_Plan_Entity]         NVARCHAR(200) NULL,
        [Validation_Group_ID]            NVARCHAR(100) NULL,
        [VBL_Group_ID]                   NVARCHAR(100) NULL,
        [WBS_ID]                         NVARCHAR(50)  NULL,
        [Pillar]                         NVARCHAR(50)  NULL,
        [Module]                         NVARCHAR(50)  NULL,
        [Data_Entity]                    NVARCHAR(200) NULL,
        [Source]                         NVARCHAR(50)  NULL,
        [Business_Unit]                  NVARCHAR(50)  NULL,
        [Mock_Number]                    NVARCHAR(20)  NULL,

        -- S3 / AWS Location (cols 19-23)
        [S3_Bucket]                      NVARCHAR(200) NULL,
        [Parent_Folder]                  NVARCHAR(500) NULL,
        [Parent_Folder_URL]              NVARCHAR(1000) NULL,
        [File_URL]                       NVARCHAR(1000) NULL,
        [Moved_To_Folder]                NVARCHAR(500) NULL,

        -- File Lifecycle (cols 24-33)
        [Created_DateTime]               DATETIME2 NULL,
        [Received_DateTime]              DATETIME2 NULL,
        [Processed_DateTime]             DATETIME2 NULL,
        [File_Status]                    NVARCHAR(50)  NOT NULL,
        [Error_Type]                     NVARCHAR(50)  NULL,
        [Error_Owner]                    NVARCHAR(50)  NULL,
        [Supersedes_eTag]                NVARCHAR(64)  NULL,
        [Superseded_By_eTag]             NVARCHAR(64)  NULL,
        [Split_From_eTag]                NVARCHAR(64)  NULL,
        [Reason_for_Upload]              NVARCHAR(500) NULL,

        -- Gate Check Results (cols 34-38) — Pass / Fail / Not Run / N/A
        [Check_File_Name]                NVARCHAR(10)  NULL,
        [Check_File_Expected]            NVARCHAR(10)  NULL,
        [Check_Column_Headers]           NVARCHAR(10)  NULL,
        [Check_TSQL_File_Found]          NVARCHAR(10)  NULL,
        [Check_TSQL_Load]                NVARCHAR(10)  NULL,

        -- Sterling Transmission (cols 39-41)
        [Sterling_Transmission_Status]   NVARCHAR(50)  NULL,
        [Sterling_Transmission_DateTime] DATETIME2 NULL,
        [Sterling_Error_Notes]           NVARCHAR(MAX) NULL,

        -- Audit (cols 42-45)
        [Created_By]                     NVARCHAR(200) NULL,
        [Last_Updated_By]                NVARCHAR(200) NULL,
        [Last_Updated_DateTime]          DATETIME2 NULL,
        [Notes]                          NVARCHAR(MAX) NULL,

        CONSTRAINT [PK_AWS_FILES] PRIMARY KEY CLUSTERED ([AWS_eTag] ASC, [Movement_Sequence] ASC)
    );

    -- Hot indexes for the dashboard's most common filters
    CREATE INDEX [IX_AWS_FILES_Mock]        ON [AWS_FILES] ([Mock_Number]);
    CREATE INDEX [IX_AWS_FILES_VGroup]      ON [AWS_FILES] ([Validation_Group_ID]);
    CREATE INDEX [IX_AWS_FILES_VBLGroup]    ON [AWS_FILES] ([VBL_Group_ID]);
    CREATE INDEX [IX_AWS_FILES_Status]      ON [AWS_FILES] ([File_Status]);
    CREATE INDEX [IX_AWS_FILES_Supersedes]  ON [AWS_FILES] ([Supersedes_eTag]);
    CREATE INDEX [IX_AWS_FILES_SplitFrom]   ON [AWS_FILES] ([Split_From_eTag]);
    CREATE INDEX [IX_AWS_FILES_Entity_Src]  ON [AWS_FILES] ([Conversion_Plan_Entity], [Source], [Mock_Number]);

    PRINT '  ✓ AWS_FILES created with 7 supporting indexes';
END
ELSE
    PRINT '  • AWS_FILES already exists — skipping create';
GO


-- ============================================================================
-- 3. VALIDATION_GROUPS_MOCK12
-- ============================================================================
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'VALIDATION_GROUPS_MOCK12')
BEGIN
    PRINT 'Creating VALIDATION_GROUPS_MOCK12…';
    CREATE TABLE [VALIDATION_GROUPS_MOCK12] (
        -- Identity
        [Validation_Group_ID]           NVARCHAR(100) NOT NULL,
        [Validation_Group_Name]         NVARCHAR(200) NULL,
        [Mock_Number]                   NVARCHAR(20)  NULL,
        [Pillar]                        NVARCHAR(50)  NULL,
        [Module]                        NVARCHAR(50)  NULL,
        [Data_Entity]                   NVARCHAR(200) NULL,

        -- Group Composition
        [Members_Total]                 INT NOT NULL DEFAULT 0,
        [Members_Currently_Loaded]      INT NOT NULL DEFAULT 0,
        [All_Members_Loaded]            NVARCHAR(5)  NOT NULL DEFAULT 'N',  -- Y / N

        -- Validation Run State
        [Current_Validation_Run_ID]     NVARCHAR(20)  NULL,  -- VAL-NNNN
        [Validation_Run_Count]          INT NOT NULL DEFAULT 0,
        [Latest_Validation_Status]      NVARCHAR(50)  NULL,
        [Latest_Validation_DateTime]    DATETIME2 NULL,
        [Error_Threshold]               INT NULL,
        [Threshold_Exceeded]            NVARCHAR(5)  NULL,
        [Reextract_Required]            NVARCHAR(5)  NULL,
        [Revalidation_Triggered_By_eTag] NVARCHAR(64) NULL,

        -- Approval
        [Latest_Approval_Status]        NVARCHAR(50)  NULL,
        [Latest_Approver]               NVARCHAR(200) NULL,
        [Latest_Approval_DateTime]      DATETIME2 NULL,
        [Latest_Approval_Comments]      NVARCHAR(MAX) NULL,

        -- Audit
        [Last_Updated_By]               NVARCHAR(200) NULL,
        [Last_Updated_DateTime]         DATETIME2 NULL,
        [Notes]                         NVARCHAR(MAX) NULL,

        CONSTRAINT [PK_VG_MOCK12] PRIMARY KEY CLUSTERED ([Validation_Group_ID])
    );
    PRINT '  ✓ VALIDATION_GROUPS_MOCK12 created';
END
ELSE
    PRINT '  • VALIDATION_GROUPS_MOCK12 already exists — skipping create';
GO


-- ============================================================================
-- 4. VALIDATION_RUNS_MOCK12
-- ============================================================================
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'VALIDATION_RUNS_MOCK12')
BEGIN
    PRINT 'Creating VALIDATION_RUNS_MOCK12…';
    CREATE TABLE [VALIDATION_RUNS_MOCK12] (
        -- Identity
        [Validation_Run_ID]             NVARCHAR(20)  NOT NULL,  -- VAL-NNNN
        [Validation_Group_ID]           NVARCHAR(100) NOT NULL,
        [Mock_Number]                   NVARCHAR(20)  NULL,
        [Run_Number]                    INT NOT NULL,
        [Trigger_Reason]                NVARCHAR(50)  NULL,  -- Initial Load | Re-upload | Manual
        [Triggered_By_eTag]             NVARCHAR(64)  NULL,

        -- Run Results
        [Run_Status]                    NVARCHAR(50)  NULL,
        [Error_Count]                   INT NULL,
        [Warning_Count]                 INT NULL,
        [Informative_Record_Count]      BIGINT NULL,
        [Threshold_Exceeded]            NVARCHAR(5)  NULL,
        [Reextract_Required]            NVARCHAR(5)  NULL,
        [Affected_Members]              NVARCHAR(MAX) NULL,  -- semicolon-separated Table_Names
        [Run_Start_DateTime]            DATETIME2 NULL,
        [Run_End_DateTime]              DATETIME2 NULL,
        [Validation_File_eTag]          NVARCHAR(64)  NULL,  -- FK to AWS_FILES

        -- Approval
        [Approval_Status]               NVARCHAR(50)  NULL,
        [Approver_Name]                 NVARCHAR(200) NULL,
        [Approver_Email]                NVARCHAR(200) NULL,
        [Approval_DateTime]             DATETIME2 NULL,
        [Approval_Comments]             NVARCHAR(MAX) NULL,

        -- Audit
        [Last_Updated_By]               NVARCHAR(200) NULL,
        [Last_Updated_DateTime]         DATETIME2 NULL,
        [Notes]                         NVARCHAR(MAX) NULL,

        CONSTRAINT [PK_VR_MOCK12] PRIMARY KEY CLUSTERED ([Validation_Run_ID])
    );
    CREATE INDEX [IX_VR_MOCK12_Group]    ON [VALIDATION_RUNS_MOCK12] ([Validation_Group_ID]);
    CREATE INDEX [IX_VR_MOCK12_Status]   ON [VALIDATION_RUNS_MOCK12] ([Run_Status]);
    CREATE INDEX [IX_VR_MOCK12_Approval] ON [VALIDATION_RUNS_MOCK12] ([Approval_Status]);
    PRINT '  ✓ VALIDATION_RUNS_MOCK12 created with 3 indexes';
END
ELSE
    PRINT '  • VALIDATION_RUNS_MOCK12 already exists — skipping create';
GO


-- ============================================================================
-- 5. VBL_GROUPS_MOCK12
-- ============================================================================
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'VBL_GROUPS_MOCK12')
BEGIN
    PRINT 'Creating VBL_GROUPS_MOCK12…';
    CREATE TABLE [VBL_GROUPS_MOCK12] (
        -- Identity
        [VBL_Group_ID]                  NVARCHAR(100) NOT NULL,
        [VBL_Group_Name]                NVARCHAR(200) NULL,
        [Mock_Number]                   NVARCHAR(20)  NULL,
        [Pillar]                        NVARCHAR(50)  NULL,
        [Module]                        NVARCHAR(50)  NULL,

        -- Readiness
        [Val_To_Source_Members_Total]   INT NOT NULL DEFAULT 0,
        [Val_To_Source_Members_Approved] INT NOT NULL DEFAULT 0,
        [All_Val_To_Source_Approved]    NVARCHAR(5) NOT NULL DEFAULT 'N',

        -- VBL Run State
        [Current_VBL_Run_ID]            NVARCHAR(20)  NULL,
        [VBL_Run_Count]                 INT NOT NULL DEFAULT 0,
        [Latest_VBL_Status]             NVARCHAR(50)  NULL,
        [Latest_VBL_DateTime]           DATETIME2 NULL,
        [VBL_File_eTag]                 NVARCHAR(64)  NULL,

        -- Recon & Conversion
        [Recon_File_eTag]               NVARCHAR(64)  NULL,
        [Conversion_Load_File_eTag]     NVARCHAR(64)  NULL,
        [Sterling_Transmission_Status]  NVARCHAR(50)  NULL,
        [Sterling_Transmission_DateTime] DATETIME2 NULL,

        -- Approval
        [Latest_Approval_Status]        NVARCHAR(50)  NULL,
        [Latest_Approver]               NVARCHAR(200) NULL,
        [Latest_Approval_DateTime]      DATETIME2 NULL,
        [Latest_Approval_Comments]      NVARCHAR(MAX) NULL,

        -- Audit
        [Last_Updated_By]               NVARCHAR(200) NULL,
        [Last_Updated_DateTime]         DATETIME2 NULL,
        [Notes]                         NVARCHAR(MAX) NULL,

        CONSTRAINT [PK_VBL_MOCK12] PRIMARY KEY CLUSTERED ([VBL_Group_ID])
    );
    PRINT '  ✓ VBL_GROUPS_MOCK12 created';
END
ELSE
    PRINT '  • VBL_GROUPS_MOCK12 already exists — skipping create';
GO


-- ============================================================================
-- 6. VBL_GROUP_MEMBERS_MOCK12
-- ============================================================================
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'VBL_GROUP_MEMBERS_MOCK12')
BEGIN
    PRINT 'Creating VBL_GROUP_MEMBERS_MOCK12…';
    CREATE TABLE [VBL_GROUP_MEMBERS_MOCK12] (
        [VBL_Group_ID]                   NVARCHAR(100) NOT NULL,
        [Validation_Group_ID]            NVARCHAR(100) NOT NULL,
        [Required]                       NVARCHAR(5)   NOT NULL DEFAULT 'Y',
        [Val_To_Source_Latest_Status]    NVARCHAR(50)  NULL,
        [Val_To_Source_Approval_Status]  NVARCHAR(50)  NULL,
        [Val_To_Source_Approval_DateTime] DATETIME2 NULL,
        [Blocks_VBL_Trigger]             NVARCHAR(5)   NULL,  -- computed in app layer
        [Last_Updated_By]                NVARCHAR(200) NULL,
        [Last_Updated_DateTime]          DATETIME2 NULL,
        [Notes]                          NVARCHAR(MAX) NULL,

        CONSTRAINT [PK_VBLM_MOCK12] PRIMARY KEY CLUSTERED ([VBL_Group_ID], [Validation_Group_ID])
    );
    PRINT '  ✓ VBL_GROUP_MEMBERS_MOCK12 created';
END
ELSE
    PRINT '  • VBL_GROUP_MEMBERS_MOCK12 already exists — skipping create';
GO


-- ============================================================================
-- 7. VG_DEPENDENCIES_MOCK12 — cross-group prerequisites (SUP-* tables before AP/PO/etc)
-- ============================================================================
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'VG_DEPENDENCIES_MOCK12')
BEGIN
    PRINT 'Creating VG_DEPENDENCIES_MOCK12…';
    CREATE TABLE [VG_DEPENDENCIES_MOCK12] (
        [Dependency_ID]                  NVARCHAR(20)  NOT NULL,  -- DEP-NNNN
        [Validation_Group_ID]            NVARCHAR(100) NOT NULL,
        [Validation_Group_Name]          NVARCHAR(200) NULL,
        [Mock_Number]                    NVARCHAR(20)  NULL,
        [Pillar]                         NVARCHAR(50)  NULL,
        [Module]                         NVARCHAR(50)  NULL,
        [Depends_On_Table_Name]          NVARCHAR(200) NOT NULL,
        [Depends_On_Validation_Group_ID] NVARCHAR(100) NULL,
        [Dependency_Reason]              NVARCHAR(500) NULL,
        [Dependency_Status]              NVARCHAR(20)  NOT NULL DEFAULT 'Not Loaded',  -- Loaded / Not Loaded
        [Table_Load_DateTime]            DATETIME2 NULL,
        [Blocks_Validation_Trigger]      NVARCHAR(5)   NOT NULL DEFAULT 'Y',  -- recomputed when status flips
        [Last_Updated_By]                NVARCHAR(200) NULL,
        [Last_Updated_DateTime]          DATETIME2 NULL,
        [Notes]                          NVARCHAR(MAX) NULL,

        CONSTRAINT [PK_VGDEP_MOCK12] PRIMARY KEY CLUSTERED ([Dependency_ID])
    );
    CREATE INDEX [IX_VGDEP_MOCK12_Group]  ON [VG_DEPENDENCIES_MOCK12] ([Validation_Group_ID]);
    CREATE INDEX [IX_VGDEP_MOCK12_Table]  ON [VG_DEPENDENCIES_MOCK12] ([Depends_On_Table_Name]);
    PRINT '  ✓ VG_DEPENDENCIES_MOCK12 created with 2 indexes';
END
ELSE
    PRINT '  • VG_DEPENDENCIES_MOCK12 already exists — skipping create';
GO


-- ============================================================================
-- 8. SCHEMA_REFERENCE — global data dictionary (single table, not per-Mock)
-- ============================================================================
-- Seeded once from Database_Schema_v9.xlsx Schema Reference sheet by the
-- companion Python script: scripts/sql/seed_schema_reference.py
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'SCHEMA_REFERENCE')
BEGIN
    PRINT 'Creating SCHEMA_REFERENCE…';
    CREATE TABLE [SCHEMA_REFERENCE] (
        [Reference_ID]      INT IDENTITY(1,1) NOT NULL,
        [Sheet]             NVARCHAR(100) NOT NULL,
        [Column_Field]      NVARCHAR(200) NOT NULL,
        [Data_Type]         NVARCHAR(100) NULL,
        [Allowed_Values]    NVARCHAR(MAX) NULL,
        [Description]       NVARCHAR(MAX) NULL,
        [Required]          NVARCHAR(50)  NULL,  -- spec uses "Y for Extract seq 1" etc., not just Y/N
        [Spec_Version]      NVARCHAR(20)  NOT NULL DEFAULT 'v9',
        [Loaded_At]         DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),

        CONSTRAINT [PK_SCHEMA_REFERENCE] PRIMARY KEY CLUSTERED ([Reference_ID])
    );
    CREATE INDEX [IX_SCHEMA_REF_Sheet_Col] ON [SCHEMA_REFERENCE] ([Sheet], [Column_Field]);
    PRINT '  ✓ SCHEMA_REFERENCE created (run seed_schema_reference.py to populate)';
END
ELSE
    PRINT '  • SCHEMA_REFERENCE already exists — skipping create';
GO


-- ============================================================================
-- 9. MOCK_PROMOTIONS — audit trail for the "Promote to Mock N+1" admin button
-- ============================================================================
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'MOCK_PROMOTIONS')
BEGIN
    PRINT 'Creating MOCK_PROMOTIONS…';
    CREATE TABLE [MOCK_PROMOTIONS] (
        [Promotion_ID]      INT IDENTITY(1,1) NOT NULL,
        [Source_Mock]       NVARCHAR(20) NOT NULL,   -- e.g. MOCK12
        [Target_Mock]       NVARCHAR(20) NOT NULL,   -- e.g. MOCK14
        [Performed_By]      NVARCHAR(200) NOT NULL,  -- Cognito email
        [Performed_At]      DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        [Row_Counts_JSON]   NVARCHAR(MAX) NULL,      -- {"setup_plan": 2211, "vg": 25, ...}
        [Status]            NVARCHAR(20) NOT NULL,   -- Started / Completed / Failed
        [Error_Message]     NVARCHAR(MAX) NULL,
        [Duration_Seconds]  INT NULL,

        CONSTRAINT [PK_MOCK_PROMOTIONS] PRIMARY KEY CLUSTERED ([Promotion_ID])
    );
    CREATE INDEX [IX_MOCK_PROMO_Target] ON [MOCK_PROMOTIONS] ([Target_Mock]);
    PRINT '  ✓ MOCK_PROMOTIONS created';
END
ELSE
    PRINT '  • MOCK_PROMOTIONS already exists — skipping create';
GO


-- ============================================================================
-- Summary
-- ============================================================================
PRINT '';
PRINT '============================================================';
PRINT 'Phase 1 migration complete.';
PRINT '';
PRINT 'Next steps:';
PRINT '  1. Run python scripts/sql/seed_schema_reference.py to populate SCHEMA_REFERENCE.';
PRINT '  2. Update Lambda conversion_plan_tracker.py SETUP_COLUMNS list (done in this commit).';
PRINT '  3. Build /admin/promote-mock UI (Phase 1 deliverable).';
PRINT '============================================================';
GO
