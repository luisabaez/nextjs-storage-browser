# Project Instructions for Claude

## Branding Policy — STRICT
- NEVER include "Claude", "Anthropic", "Claude Code", or any AI tool branding in:
  - Git commit messages (no "Co-Authored-By: Claude", no "Generated with Claude Code")
  - Source code comments
  - Pull request descriptions
  - README files or documentation
  - AWS resource tags or descriptions
  - GitHub repository descriptions
  - Any user-facing output
- Do NOT add emoji prefixes to commit messages
- Commit messages should read as if written by a human developer
- No AI attribution of any kind in any file or output

## Git Conventions
- Write concise, professional commit messages describing the change
- No co-author lines
- No "Generated with" lines
- No emoji in commit messages

## Project
- Next.js 14 app with AWS Amplify, Cognito, S3, Lambda
- Database: SQL Server (Hacienda_ERP_Test)
- Lambda: Python (AP-Invoice-Processor)
- Push to BOTH remotes: `origin` (luisabaez) and `production` (mrichcreek)
