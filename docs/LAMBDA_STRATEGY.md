# Hacienda ERP - Lambda Function Strategy

**Last Updated:** January 22, 2026
**Document Owner:** Matt Richcreek

---

## Overview

This document outlines the strategy for Lambda functions in the Hacienda ERP application, specifically addressing the decision between using two separate functions or one function with multiple triggers.

---

## Current State

### File Validation Lambda Functions

| Function | Environment | S3 Trigger | Status |
|----------|-------------|------------|--------|
| `TestFunction` | DEV | `hacienda-erp-dev` (ObjectCreated) | Active |
| `Validation_FileHeaders` | PRD | None configured | **Needs trigger** |

### Problem
The current naming is inconsistent, and the production function lacks its S3 trigger.

---

## Strategy Options

### Option A: Two Separate Functions (Recommended)

Deploy separate Lambda functions for each environment:

```
┌─────────────────────────────────┐
│         DEVELOPMENT             │
├─────────────────────────────────┤
│  S3: hacienda-erp-dev           │
│           │                     │
│           ▼                     │
│  Lambda: Validation-FileHeaders-DEV │
└─────────────────────────────────┘

┌─────────────────────────────────┐
│         PRODUCTION              │
├─────────────────────────────────┤
│  S3: hacienda-erp-prd           │
│           │                     │
│           ▼                     │
│  Lambda: Validation-FileHeaders-PRD │
└─────────────────────────────────┘
```

**Pros:**
- Complete isolation between environments
- Can deploy/test DEV without affecting PRD
- Different configurations per environment
- Can use different IAM roles/permissions
- Easier rollback - only affects one environment
- Clearer logging and monitoring
- No risk of accidental cross-environment execution

**Cons:**
- Code duplication (same code in two functions)
- Must deploy to both when making changes
- Two functions to maintain

**Implementation:**
```bash
# Rename TestFunction to proper name
aws lambda update-function-configuration \
  --function-name Validation-FileHeaders-DEV \
  --description "File header validation - Development"

# Create PRD trigger
aws s3api put-bucket-notification-configuration \
  --bucket hacienda-erp-prd \
  --notification-configuration '{
    "LambdaFunctionConfigurations": [{
      "LambdaFunctionArn": "arn:aws:lambda:us-east-1:087243890715:function:Validation_FileHeaders",
      "Events": ["s3:ObjectCreated:*"]
    }]
  }'
```

---

### Option B: One Function with Multiple Triggers

Single Lambda function triggered by both DEV and PRD S3 buckets:

```
┌─────────────────────────────────────────┐
│                                         │
│  S3: hacienda-erp-dev ──┐               │
│                         │               │
│                         ▼               │
│            Lambda: Validation-FileHeaders│
│                         ▲               │
│                         │               │
│  S3: hacienda-erp-prd ──┘               │
│                                         │
└─────────────────────────────────────────┘
```

**Pros:**
- Single codebase to maintain
- Deploy once, applies everywhere
- Less AWS resource sprawl

**Cons:**
- **No environment isolation** - bugs affect both DEV and PRD
- Must handle environment detection in code
- Harder to test DEV changes safely
- Shared configuration/permissions
- **Single point of failure** - if Lambda breaks, both environments break
- More complex logging/debugging
- Risk of accidental production changes

**Implementation (if chosen):**
```javascript
// Lambda would need to detect environment from bucket
exports.handler = async (event) => {
  const bucket = event.Records[0].s3.bucket.name;
  const environment = bucket.includes('-dev') ? 'DEV' : 'PRD';

  // Environment-specific configuration
  const config = getConfigForEnvironment(environment);

  // Process file
  await processFile(event, config);
};
```

---

## Recommendation

### **Use Option A: Two Separate Functions**

**Rationale:**

1. **Safety First**: Production should never be affected by development testing
2. **Industry Best Practice**: Separate deployments per environment is standard
3. **Easier Debugging**: Clear separation of logs and metrics
4. **Flexible Deployment**: Can update DEV without touching PRD
5. **Rollback Simplicity**: Issues only affect one environment

### Deployment Strategy

1. Use **Infrastructure as Code** (CloudFormation/CDK/Terraform) to manage both functions
2. Store code in **GitHub** with CI/CD pipeline
3. Deploy to DEV first, test, then deploy to PRD
4. Use **Lambda Aliases** for blue/green deployments if needed

---

## Implementation Plan

### Step 1: Rename and Configure DEV Function
```bash
# Current: TestFunction
# Target: Validation-FileHeaders-DEV

# Option 1: Create new function with correct name
aws lambda create-function \
  --function-name Validation-FileHeaders-DEV \
  --runtime python3.13 \
  --handler lambda_function.lambda_handler \
  --zip-file fileb://validation.zip \
  --role arn:aws:iam::087243890715:role/validation-lambda-role

# Option 2: Create alias (if keeping TestFunction)
aws lambda create-alias \
  --function-name TestFunction \
  --name DEV \
  --function-version '$LATEST'
```

### Step 2: Configure PRD Function Trigger
```bash
# Add S3 trigger to existing Validation_FileHeaders
aws lambda add-permission \
  --function-name Validation_FileHeaders \
  --statement-id s3-trigger-prd \
  --action lambda:InvokeFunction \
  --principal s3.amazonaws.com \
  --source-arn arn:aws:s3:::hacienda-erp-prd

aws s3api put-bucket-notification-configuration \
  --bucket hacienda-erp-prd \
  --notification-configuration file://prd-notification.json
```

### Step 3: Standardize Naming
| Current Name | New Name | Environment |
|--------------|----------|-------------|
| `TestFunction` | `Validation-FileHeaders-DEV` | DEV |
| `Validation_FileHeaders` | `Validation-FileHeaders-PRD` | PRD |

---

## Environment Variables Strategy

Each function should have environment-specific variables:

### DEV Function
```json
{
  "ENVIRONMENT": "DEV",
  "S3_BUCKET": "hacienda-erp-dev",
  "LOG_LEVEL": "DEBUG",
  "ERROR_NOTIFICATION_EMAIL": "dev-alerts@elitebco.com"
}
```

### PRD Function
```json
{
  "ENVIRONMENT": "PRD",
  "S3_BUCKET": "hacienda-erp-prd",
  "LOG_LEVEL": "INFO",
  "ERROR_NOTIFICATION_EMAIL": "prod-alerts@elitebco.com"
}
```

---

## CI/CD Pipeline Recommendation

```yaml
# GitHub Actions workflow example
name: Deploy Lambda

on:
  push:
    branches: [develop, main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set environment
        run: |
          if [ "${{ github.ref }}" == "refs/heads/main" ]; then
            echo "ENV=PRD" >> $GITHUB_ENV
            echo "FUNCTION_NAME=Validation-FileHeaders-PRD" >> $GITHUB_ENV
          else
            echo "ENV=DEV" >> $GITHUB_ENV
            echo "FUNCTION_NAME=Validation-FileHeaders-DEV" >> $GITHUB_ENV
          fi

      - name: Deploy to Lambda
        run: |
          aws lambda update-function-code \
            --function-name ${{ env.FUNCTION_NAME }} \
            --zip-file fileb://lambda.zip
```

---

## Summary

| Aspect | Two Functions (Recommended) | One Function |
|--------|---------------------------|--------------|
| Isolation | Complete | None |
| Deployment Risk | Low | High |
| Maintenance | Slightly more | Simpler |
| Best Practice | Yes | No |
| Debugging | Easy | Complex |
| Cost | ~Same (pay per invocation) | ~Same |

**Final Recommendation: Use Two Separate Functions** with consistent naming and proper CI/CD pipeline for deployments.
