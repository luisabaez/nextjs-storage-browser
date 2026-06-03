-- ============================================================================
-- Phase 1 retarget: drop empty _MOCK13 per-Mock tables created in the first
-- pass, so the live current Mock (MOCK12) becomes the schema baseline. The
-- Promote button will recreate MOCK13 from MOCK12 when admin clicks it.
-- ----------------------------------------------------------------------------
-- Safe to run: only drops tables that have zero rows. AWS_FILES,
-- SCHEMA_REFERENCE, and MOCK_PROMOTIONS are NEVER touched.
-- ============================================================================

USE [Hacienda_ERP_Test];
GO

SET NOCOUNT ON;
GO

DECLARE @rc INT;

-- VALIDATION_GROUPS_MOCK13
IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'VALIDATION_GROUPS_MOCK13')
BEGIN
    SELECT @rc = COUNT(*) FROM [VALIDATION_GROUPS_MOCK13];
    IF @rc = 0 BEGIN DROP TABLE [VALIDATION_GROUPS_MOCK13]; PRINT '  ✓ dropped empty VALIDATION_GROUPS_MOCK13'; END
    ELSE PRINT '  ! VALIDATION_GROUPS_MOCK13 has rows — leaving alone';
END

-- VALIDATION_RUNS_MOCK13
IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'VALIDATION_RUNS_MOCK13')
BEGIN
    SELECT @rc = COUNT(*) FROM [VALIDATION_RUNS_MOCK13];
    IF @rc = 0 BEGIN DROP TABLE [VALIDATION_RUNS_MOCK13]; PRINT '  ✓ dropped empty VALIDATION_RUNS_MOCK13'; END
    ELSE PRINT '  ! VALIDATION_RUNS_MOCK13 has rows — leaving alone';
END

-- VBL_GROUPS_MOCK13
IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'VBL_GROUPS_MOCK13')
BEGIN
    SELECT @rc = COUNT(*) FROM [VBL_GROUPS_MOCK13];
    IF @rc = 0 BEGIN DROP TABLE [VBL_GROUPS_MOCK13]; PRINT '  ✓ dropped empty VBL_GROUPS_MOCK13'; END
    ELSE PRINT '  ! VBL_GROUPS_MOCK13 has rows — leaving alone';
END

-- VBL_GROUP_MEMBERS_MOCK13
IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'VBL_GROUP_MEMBERS_MOCK13')
BEGIN
    SELECT @rc = COUNT(*) FROM [VBL_GROUP_MEMBERS_MOCK13];
    IF @rc = 0 BEGIN DROP TABLE [VBL_GROUP_MEMBERS_MOCK13]; PRINT '  ✓ dropped empty VBL_GROUP_MEMBERS_MOCK13'; END
    ELSE PRINT '  ! VBL_GROUP_MEMBERS_MOCK13 has rows — leaving alone';
END

-- VG_DEPENDENCIES_MOCK13
IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'VG_DEPENDENCIES_MOCK13')
BEGIN
    SELECT @rc = COUNT(*) FROM [VG_DEPENDENCIES_MOCK13];
    IF @rc = 0 BEGIN DROP TABLE [VG_DEPENDENCIES_MOCK13]; PRINT '  ✓ dropped empty VG_DEPENDENCIES_MOCK13'; END
    ELSE PRINT '  ! VG_DEPENDENCIES_MOCK13 has rows — leaving alone';
END
GO

PRINT '=== Retarget complete. Now run phase1_migration_mock12.sql ===';
GO
