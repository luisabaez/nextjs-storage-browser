# S3 File Tagging for Security

**Last Updated:** January 22, 2026
**Document Owner:** Matt Richcreek

---

## Overview

S3 object tagging provides a way to categorize files and implement attribute-based access control (ABAC). This document explores how file tagging can enhance security in the Hacienda ERP application.

---

## What is S3 Object Tagging?

S3 object tags are key-value pairs associated with files:
- Up to 10 tags per object
- Keys: up to 128 characters
- Values: up to 256 characters
- Tags can be used in IAM policies and S3 lifecycle rules

---

## Security Use Cases

### 1. Access Control by Department/Team

Tag files with department ownership:
```
Department: Finance
Department: Operations
Department: HR
```

**IAM Policy Example:**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::hacienda-erp-prd/*",
      "Condition": {
        "StringEquals": {
          "s3:ExistingObjectTag/Department": "${aws:PrincipalTag/Department}"
        }
      }
    }
  ]
}
```

**Result:** Users can only access files tagged with their department.

---

### 2. Classification Levels

Tag files with sensitivity levels:
```
Classification: Public
Classification: Internal
Classification: Confidential
Classification: Restricted
```

**IAM Policy Example:**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Deny",
      "Action": ["s3:GetObject"],
      "Resource": "arn:aws:s3:::hacienda-erp-prd/*",
      "Condition": {
        "StringEquals": {
          "s3:ExistingObjectTag/Classification": "Restricted"
        },
        "StringNotEquals": {
          "aws:PrincipalTag/ClearanceLevel": "Restricted"
        }
      }
    }
  ]
}
```

**Result:** Only users with "Restricted" clearance can access restricted files.

---

### 3. Project/Client Isolation

Tag files by project or client:
```
Project: Mock8
Client: AcmeCorp
ClientID: 12345
```

**Use Case:** Users can only see files for their assigned projects.

---

### 4. Audit and Compliance

Tag files with audit metadata:
```
UploadedBy: user@example.com
UploadDate: 2026-01-22
ApprovedBy: admin@example.com
RetentionPolicy: 7-years
Compliance: SOX
```

---

## Implementation Options

### Option A: Tag on Upload (Recommended)

Add tags when files are uploaded via the application:

```typescript
// In the upload handler
import { uploadData } from 'aws-amplify/storage';

const handleUpload = async (file: File) => {
  const result = await uploadData({
    path: `InitialUpload/${file.name}`,
    data: file,
    options: {
      metadata: {
        // S3 metadata (x-amz-meta-*)
        uploadedBy: userEmail,
        uploadDate: new Date().toISOString(),
      },
      // Note: Amplify SDK may not support tags directly
      // May need to use AWS SDK or Lambda post-upload
    }
  });
};
```

**Lambda Post-Upload Tagging:**
```javascript
const { S3Client, PutObjectTaggingCommand } = require('@aws-sdk/client-s3');

exports.handler = async (event) => {
  const s3 = new S3Client({ region: 'us-east-1' });

  const bucket = event.Records[0].s3.bucket.name;
  const key = event.Records[0].s3.object.key;

  // Determine tags based on file path
  const department = getDepartmentFromPath(key);
  const classification = 'Internal'; // Default

  await s3.send(new PutObjectTaggingCommand({
    Bucket: bucket,
    Key: key,
    Tagging: {
      TagSet: [
        { Key: 'Department', Value: department },
        { Key: 'Classification', Value: classification },
        { Key: 'UploadDate', Value: new Date().toISOString() },
      ]
    }
  }));
};
```

---

### Option B: Inherit Tags from Folder Structure

Map folder paths to tags:
```
ConversionFiles/ → Classification: Internal, Type: Conversion
InitialUpload/ → Classification: Internal, Type: Upload
TSQLFiles/ → Classification: Confidential, Type: SQL
```

---

### Option C: User-Selected Tags

Allow users to select tags during upload:

```typescript
interface UploadOptions {
  department: 'Finance' | 'Operations' | 'IT';
  classification: 'Public' | 'Internal' | 'Confidential';
  project?: string;
}

// UI presents dropdown/checkboxes for tagging
const TagSelector = ({ onSelect }: Props) => (
  <div>
    <select name="department">
      <option>Finance</option>
      <option>Operations</option>
    </select>
    <select name="classification">
      <option>Internal</option>
      <option>Confidential</option>
    </select>
  </div>
);
```

---

## Recommended Tag Schema

### Core Tags (Always Applied)

| Tag Key | Description | Example Values |
|---------|-------------|----------------|
| `Environment` | DEV/PRD | `DEV`, `PRD` |
| `UploadedBy` | User email | `user@elitebco.com` |
| `UploadDate` | ISO timestamp | `2026-01-22T14:30:00Z` |
| `FileType` | File category | `Conversion`, `SQL`, `Validation` |

### Security Tags (When Needed)

| Tag Key | Description | Example Values |
|---------|-------------|----------------|
| `Classification` | Sensitivity level | `Public`, `Internal`, `Confidential` |
| `Department` | Owning department | `Finance`, `Operations`, `IT` |
| `Project` | Project identifier | `Mock8`, `Conversion2026` |
| `RetentionDays` | How long to keep | `30`, `90`, `365`, `2555` |

---

## Security Policy Examples

### Restrict File Download by Classification

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyConfidentialDownload",
      "Effect": "Deny",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::hacienda-erp-prd/*",
      "Condition": {
        "StringEquals": {
          "s3:ExistingObjectTag/Classification": "Confidential"
        },
        "StringNotLike": {
          "aws:PrincipalArn": [
            "arn:aws:iam::*:role/admin-*",
            "arn:aws:iam::*:user/approved-*"
          ]
        }
      }
    }
  ]
}
```

### Lifecycle Rules Based on Tags

Delete files tagged for short retention:
```json
{
  "Rules": [
    {
      "ID": "DeleteTempFiles",
      "Filter": {
        "Tag": {
          "Key": "RetentionDays",
          "Value": "30"
        }
      },
      "Status": "Enabled",
      "Expiration": {
        "Days": 30
      }
    }
  ]
}
```

---

## Implementation Roadmap

### Phase 1: Basic Tagging (2 weeks)
1. Add Lambda to auto-tag files on upload
2. Implement core tags: Environment, UploadedBy, UploadDate, FileType
3. Test with DEV bucket

### Phase 2: Classification Tags (2 weeks)
1. Define classification levels
2. Implement folder-based classification
3. Add Classification tag to Lambda

### Phase 3: Access Control (4 weeks)
1. Design IAM policies using tags
2. Implement Cognito user groups
3. Map groups to tag-based permissions
4. Test with subset of users

### Phase 4: UI Integration (2 weeks)
1. Display file tags in UI
2. Optional: Tag filter/search
3. Optional: Manual tagging UI

---

## Considerations

### Pros of Tag-Based Security
- Fine-grained access control
- Flexible, attribute-based
- Works with existing S3 infrastructure
- Audit-friendly

### Cons / Limitations
- Tags must be applied consistently
- Cannot change existing file tags without write permission
- Max 10 tags per object
- Requires IAM policy changes
- Amplify SDK has limited tag support

### Alternative: Folder-Based Security
Instead of tags, use folder structure for access control:
```
s3://bucket/department/finance/files/
s3://bucket/department/operations/files/
```

IAM policies can then use path prefixes:
```json
{
  "Resource": "arn:aws:s3:::bucket/department/${aws:PrincipalTag/Department}/*"
}
```

---

## Next Steps

1. **Decide on tagging strategy** (Option A, B, or C)
2. **Define tag schema** for the organization
3. **Update Lambda** to apply tags on upload
4. **Create IAM policies** using tags
5. **Test thoroughly** in DEV before PRD

---

## References

- [S3 Object Tagging](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-tagging.html)
- [S3 ABAC Example](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_examples_s3_tag-based.html)
- [S3 Lifecycle Rules with Tags](https://docs.aws.amazon.com/AmazonS3/latest/userguide/intro-lifecycle-rules.html)
