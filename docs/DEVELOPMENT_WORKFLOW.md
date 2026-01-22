# Hacienda ERP - Development Workflow

**Last Updated:** January 22, 2026
**Document Owner:** Matt Richcreek

---

## Branch Strategy

### Overview

This project uses a **two-branch deployment model** with AWS Amplify:

| Branch | Environment | URL | Purpose |
|--------|-------------|-----|---------|
| `develop` | Development | https://develop.d1weje07uqmri2.amplifyapp.com | Testing, QA, feature development |
| `main` | Production | https://main.d1weje07uqmri2.amplifyapp.com | Live production environment |

---

## Develop Branch

### What It Is

The `develop` branch is the **development and testing environment** for the Hacienda ERP File Browser application. It serves as:

1. **Staging Environment** - Test changes before they go to production
2. **QA Environment** - Quality assurance testing
3. **Feature Integration** - Merge and test new features together
4. **Bug Verification** - Verify bug fixes before production deployment

### What It Does

When code is pushed to the `develop` branch:

1. **AWS Amplify automatically builds** the Next.js application
2. **Deploys to the develop URL** (https://develop.d1weje07uqmri2.amplifyapp.com)
3. **Uses DEV configuration** - `amplify_outputs.json` with DEV settings
4. **Connects to DEV resources**:
   - S3 Bucket: `hacienda-erp-dev`
   - Cognito User Pool: `Hacienda-ERP-DEV-Users`
   - Lambda Triggers: `TestFunction`

### Configuration

The develop branch uses the following configuration:

```json
{
  "auth": {
    "user_pool_id": "us-east-1_3iz7lup2k",  // DEV User Pool
    "identity_pool_id": "..."
  },
  "storage": {
    "bucket_name": "hacienda-erp-dev"  // DEV S3 Bucket
  }
}
```

---

## Development Workflow

### Standard Development Process

```
1. Create feature branch from develop
   git checkout develop
   git pull origin develop
   git checkout -b feature/my-new-feature

2. Make changes and commit
   git add .
   git commit -m "Add new feature"

3. Push to feature branch
   git push origin feature/my-new-feature

4. Create Pull Request to develop
   - Review code
   - Test in feature branch if needed

5. Merge to develop
   - Amplify automatically deploys
   - Test at https://develop.d1weje07uqmri2.amplifyapp.com

6. When ready for production, merge develop to main
   git checkout main
   git merge develop
   git push origin main
```

### Setting Up Local Environment

1. **Clone the repository:**
   ```bash
   git clone https://github.com/mrichcreek/production-nextjs-storage-browser.git
   cd production-nextjs-storage-browser
   ```

2. **Switch to develop branch:**
   ```bash
   git checkout develop
   git pull origin develop
   ```

3. **Install dependencies:**
   ```bash
   npm install
   ```

4. **Configure Amplify for DEV environment:**
   ```bash
   # Copy DEV configuration
   cp amplify_outputs.dev.json amplify_outputs.json
   ```

5. **Run locally:**
   ```bash
   npm run dev
   ```
   Access at: http://localhost:3000

### Keeping Local Environment Up to Date

```bash
# Switch to develop branch
git checkout develop

# Pull latest changes
git pull origin develop

# Install any new dependencies
npm install

# Run the app
npm run dev
```

---

## Configuration Files

### Environment-Specific Configuration

| File | Purpose |
|------|---------|
| `amplify_outputs.json` | **Active configuration** - Used by the app at runtime |
| `amplify_outputs.dev.json` | DEV environment template |
| `amplify_outputs.prd.json` | PRD environment template |

### Switching Environments Locally

**For DEV:**
```bash
cp amplify_outputs.dev.json amplify_outputs.json
```

**For PRD (testing production config locally):**
```bash
cp amplify_outputs.prd.json amplify_outputs.json
```

**Note:** The `amplify_outputs.json` file in the repository is configured for production. Amplify handles environment-specific configuration during deployment.

---

## Admin Users

The following users have admin access to the Admin Dashboard:

| Email | Role |
|-------|------|
| `mrichcreek@elitebco.com` | Administrator |
| `lbaez@elitebco.com` | Administrator |

Admin dashboard is accessible at `/admin` when logged in with an admin account.

---

## Lambda Functions in Development

### User Approval Workflow

| Function | Purpose | Trigger |
|----------|---------|---------|
| `cognito-pre-signup-approval` | Sends approval request email | Cognito Pre Sign-Up |
| `cognito-pre-auth-approval` | Validates user approval status | Cognito Pre Auth |
| `user-approval-handler` | Processes approve/deny actions | Lambda Function URL |

### File Processing (DEV)

| Function | Purpose | Trigger |
|----------|---------|---------|
| `TestFunction` | File validation on upload | S3 ObjectCreated on `hacienda-erp-dev` |

---

## Deployment Checklist

### Before Merging to Develop

- [ ] Code compiles without errors (`npm run build`)
- [ ] No TypeScript errors
- [ ] Tested locally
- [ ] No sensitive data committed (API keys, tokens, etc.)
- [ ] Configuration files correct

### Before Merging to Main (Production)

- [ ] All changes tested on develop environment
- [ ] QA sign-off received
- [ ] No breaking changes
- [ ] Database migrations (if any) planned
- [ ] Rollback plan documented
- [ ] Stakeholders notified

---

## Troubleshooting

### Build Fails on Amplify

1. Check Amplify console for build logs
2. Verify `package.json` dependencies are correct
3. Ensure `amplify_outputs.json` is valid JSON
4. Check for TypeScript compilation errors

### Cannot Login in DEV Environment

1. Verify you're using the correct Cognito User Pool
2. Check if your email is in the approved list
3. Verify the pre-auth Lambda is configured correctly

### File Uploads Not Working

1. Check S3 bucket permissions
2. Verify Cognito Identity Pool is configured
3. Check browser console for CORS errors

---

## Useful Commands

```bash
# Check current branch
git branch

# See all branches
git branch -a

# Check Amplify build status
aws amplify list-jobs --app-id d1weje07uqmri2 --branch-name develop

# View recent commits
git log --oneline -10

# Check S3 bucket contents
aws s3 ls s3://hacienda-erp-dev/ --recursive | head -20
```

---

## Contact

For questions or issues:
- **Matt Richcreek** - mrichcreek@elitebco.com
- **Luis Baez** - lbaez@elitebco.com
