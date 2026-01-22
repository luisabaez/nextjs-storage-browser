# Hard-Coded S3 Bucket Issue

**Last Updated:** January 22, 2026
**Status:** Investigation Complete

---

## Summary

Investigation into hard-coded S3 bucket references in the codebase.

---

## Findings

### Application Code (Good)

The main application **does NOT have hard-coded S3 bucket names**. It correctly reads from the configuration file:

**app/page.tsx:31**
```typescript
const bucketName = config.storage?.bucket_name || '';
```

The bucket name is read from `amplify_outputs.json` at runtime, which is the correct approach.

---

### Configuration Files

| File | Bucket Name | Purpose |
|------|-------------|---------|
| `amplify_outputs.json` | `hacienda-erp` | Current active config (PRD) |
| `amplify_outputs.dev.json` | `hacienda-erp-dev` | DEV template |
| `amplify_outputs.prd.json` | `hacienda-erp-prd` | PRD template |

**Note:** There appears to be a discrepancy:
- `amplify_outputs.json` uses `hacienda-erp` (old bucket)
- `amplify_outputs.prd.json` uses `hacienda-erp-prd` (new bucket)

---

## Potential Issue: Which Bucket is Production?

### S3 Buckets
```
hacienda-erp         # Created 2023-03-10 (original)
hacienda-erp-dev     # Created 2026-01-15 (new dev)
hacienda-erp-prd     # Created 2026-01-15 (new prd)
```

### Current Configuration
- **Production app** is using `hacienda-erp` (the original bucket)
- **New `hacienda-erp-prd`** bucket exists but may not be in use

---

## Recommended Actions

### 1. Verify Production Bucket
```bash
# Check which bucket production is actually using
aws s3 ls s3://hacienda-erp/ --recursive | head -20
aws s3 ls s3://hacienda-erp-prd/ --recursive | head -20
```

### 2. If Migrating to New Bucket

**Step A: Update amplify_outputs.json**
```json
{
  "storage": {
    "bucket_name": "hacienda-erp-prd",
    "buckets": [
      {
        "name": "hacienda-erp-production",
        "bucket_name": "hacienda-erp-prd"
      }
    ]
  }
}
```

**Step B: Copy existing files (if needed)**
```bash
aws s3 sync s3://hacienda-erp/ s3://hacienda-erp-prd/
```

**Step C: Update Lambda triggers**
Ensure S3 event triggers point to the correct bucket.

### 3. Standardize Configuration

Option A: Keep `hacienda-erp` as production
- Update `amplify_outputs.prd.json` to use `hacienda-erp`
- Consider renaming to `hacienda-erp-prd` for consistency

Option B: Migrate to `hacienda-erp-prd`
- Update `amplify_outputs.json` to use `hacienda-erp-prd`
- Sync files between buckets
- Update all Lambda triggers

---

## No Hard-Coding in Lambda Code

The Lambda functions also appear to use environment variables or event data for bucket names, not hard-coded values:

**user-approval-handler** - No S3 bucket references (uses Cognito/SES)
**cognito-pre-signup-approval** - No S3 bucket references (uses SES)
**cognito-pre-auth-approval** - No S3 bucket references (uses Lambda config)

---

## Verification Commands

```bash
# Search for hard-coded bucket references
grep -r "hacienda-erp-dev\|hacienda-erp-prd\|hacienda-erp" --include="*.ts" --include="*.tsx" --include="*.js"

# Check what bucket the app is configured to use
cat amplify_outputs.json | grep bucket_name

# List files in each bucket
aws s3 ls s3://hacienda-erp/ --summarize
aws s3 ls s3://hacienda-erp-prd/ --summarize
```

---

## Conclusion

The codebase is **correctly configured** to read the S3 bucket name from configuration rather than hard-coding it. The configuration file determines which bucket is used, which can be changed without code modifications.

**Action needed:** Verify and standardize which bucket should be used for production (either `hacienda-erp` or `hacienda-erp-prd`).
