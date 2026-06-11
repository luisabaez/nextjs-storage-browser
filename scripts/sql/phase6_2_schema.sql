-- ============================================================================
-- Phase 6.2 schema additions
-- ----------------------------------------------------------------------------
-- Adds:
--   1. Parent_Entity column on SETUP_CONVERSION_PLAN_MOCK{N} for parent/child
--      relationships (e.g. Person → Person Address, Person Name).
--   2. FILE_COLUMN_MAPPINGS_MOCK{N} per-Mock table storing the mapping
--      from a file's column header to the target SQL table column.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

USE [Hacienda_ERP_Test];
GO

SET NOCOUNT ON;
GO

-- ─── 1. Add Parent_Entity to per-Mock conversion plan tables ───────────────
DECLARE @mocks TABLE (mock_table NVARCHAR(128));
INSERT INTO @mocks VALUES
    ('SETUP_CONVERSION_PLAN_MOCK12'),
    ('SETUP_CONVERSION_PLAN_MOCK13');

DECLARE @tbl NVARCHAR(128);
DECLARE @sql NVARCHAR(MAX);

DECLARE cur CURSOR LOCAL FOR SELECT mock_table FROM @mocks;
OPEN cur;
FETCH NEXT FROM cur INTO @tbl;
WHILE @@FETCH_STATUS = 0
BEGIN
    IF EXISTS (SELECT 1 FROM sys.tables WHERE name = @tbl)
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM sys.columns
            WHERE object_id = OBJECT_ID(@tbl) AND name = 'Parent_Entity'
        )
        BEGIN
            SET @sql = N'ALTER TABLE [' + @tbl + N'] ADD [Parent_Entity] NVARCHAR(200) NULL';
            EXEC sp_executesql @sql;
            PRINT '  + Parent_Entity added to ' + @tbl;
        END
        ELSE
        BEGIN
            PRINT '  - Parent_Entity already exists on ' + @tbl;
        END
    END
    ELSE
    BEGIN
        PRINT '  ! ' + @tbl + ' does not exist — skipped';
    END
    FETCH NEXT FROM cur INTO @tbl;
END
CLOSE cur;
DEALLOCATE cur;
GO


-- ─── 2. FILE_COLUMN_MAPPINGS_MOCK12 ──────────────────────────────────────
-- One row per (entity, source, file_header). table_column is the target
-- SQL column. Header_Order preserves the file's column ordering for
-- regeneration of CSV→SQL inserts.
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'FILE_COLUMN_MAPPINGS_MOCK12')
BEGIN
    PRINT 'Creating FILE_COLUMN_MAPPINGS_MOCK12...';
    CREATE TABLE [FILE_COLUMN_MAPPINGS_MOCK12] (
        [Mapping_ID]            INT IDENTITY(1,1) NOT NULL,
        [Mock_Number]           NVARCHAR(20)  NOT NULL DEFAULT 'MOCK12',
        [Entity]                NVARCHAR(200) NOT NULL,
        [Source]                NVARCHAR(50)  NOT NULL,
        [Table_Name]            NVARCHAR(200) NULL,
        [File_Header]           NVARCHAR(500) NOT NULL,
        [Table_Column]          NVARCHAR(500) NULL,
        [Header_Order]          INT NULL,
        [Sample_Value]          NVARCHAR(500) NULL,
        [Data_Type]             NVARCHAR(100) NULL,
        [Is_Required]           NVARCHAR(5)   NOT NULL DEFAULT 'N',
        [Notes]                 NVARCHAR(MAX) NULL,
        [Created_By]            NVARCHAR(200) NULL,
        [Created_DateTime]      DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        [Last_Updated_By]       NVARCHAR(200) NULL,
        [Last_Updated_DateTime] DATETIME2 NULL,

        CONSTRAINT [PK_FCM_MOCK12] PRIMARY KEY CLUSTERED ([Mapping_ID])
    );
    CREATE INDEX [IX_FCM_MOCK12_Entity_Source] ON [FILE_COLUMN_MAPPINGS_MOCK12] ([Entity], [Source]);
    CREATE INDEX [IX_FCM_MOCK12_Table]         ON [FILE_COLUMN_MAPPINGS_MOCK12] ([Table_Name]);
    PRINT '  + FILE_COLUMN_MAPPINGS_MOCK12 created with 2 indexes';
END
ELSE
BEGIN
    PRINT '  - FILE_COLUMN_MAPPINGS_MOCK12 already exists';
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'FILE_COLUMN_MAPPINGS_MOCK13')
BEGIN
    PRINT 'Creating FILE_COLUMN_MAPPINGS_MOCK13...';
    CREATE TABLE [FILE_COLUMN_MAPPINGS_MOCK13] (
        [Mapping_ID]            INT IDENTITY(1,1) NOT NULL,
        [Mock_Number]           NVARCHAR(20)  NOT NULL DEFAULT 'MOCK13',
        [Entity]                NVARCHAR(200) NOT NULL,
        [Source]                NVARCHAR(50)  NOT NULL,
        [Table_Name]            NVARCHAR(200) NULL,
        [File_Header]           NVARCHAR(500) NOT NULL,
        [Table_Column]          NVARCHAR(500) NULL,
        [Header_Order]          INT NULL,
        [Sample_Value]          NVARCHAR(500) NULL,
        [Data_Type]             NVARCHAR(100) NULL,
        [Is_Required]           NVARCHAR(5)   NOT NULL DEFAULT 'N',
        [Notes]                 NVARCHAR(MAX) NULL,
        [Created_By]            NVARCHAR(200) NULL,
        [Created_DateTime]      DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        [Last_Updated_By]       NVARCHAR(200) NULL,
        [Last_Updated_DateTime] DATETIME2 NULL,
        CONSTRAINT [PK_FCM_MOCK13] PRIMARY KEY CLUSTERED ([Mapping_ID])
    );
    CREATE INDEX [IX_FCM_MOCK13_Entity_Source] ON [FILE_COLUMN_MAPPINGS_MOCK13] ([Entity], [Source]);
    CREATE INDEX [IX_FCM_MOCK13_Table]         ON [FILE_COLUMN_MAPPINGS_MOCK13] ([Table_Name]);
    PRINT '  + FILE_COLUMN_MAPPINGS_MOCK13 created with 2 indexes';
END
ELSE
BEGIN
    PRINT '  - FILE_COLUMN_MAPPINGS_MOCK13 already exists';
END
GO

PRINT '';
PRINT '======================================================================';
PRINT 'Phase 6.2 schema additions complete.';
PRINT '======================================================================';
GO
