/**
 * User Approval Handler Lambda
 *
 * Handles user approval/denial requests and sends notification emails.
 * Accessed via Lambda Function URL.
 *
 * Query Parameters:
 * - action: "approve", "deny", or "list"
 * - email: user email to approve/deny (not needed for list)
 * - token: simple security token
 *
 * Environment Variables:
 * - ADMIN_EMAIL: Email to receive approval requests
 * - APPROVAL_TOKEN: Secret token for approval links
 * - USER_POOL_ID: Cognito User Pool ID
 * - APPROVED_EMAILS: Comma-separated list of approved emails (used for legacy compatibility)
 */

const { CognitoIdentityProviderClient, AdminGetUserCommand, AdminUpdateUserAttributesCommand, AdminEnableUserCommand, ListUsersCommand } = require("@aws-sdk/client-cognito-identity-provider");
const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");
const { LambdaClient, GetFunctionConfigurationCommand, UpdateFunctionConfigurationCommand } = require("@aws-sdk/client-lambda");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");

const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || "us-east-1" });
const sesClient = new SESClient({ region: process.env.AWS_REGION || "us-east-1" });
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION || "us-east-1" });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" }));
const PERMISSIONS_TABLE = process.env.PERMISSIONS_TABLE || "HaciendaUserPermissions";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "mrichcreek@elitebco.com";
const APPROVAL_TOKEN = process.env.APPROVAL_TOKEN || "hacienda-erp-approval-2024";
const USER_POOL_ID = process.env.USER_POOL_ID || "us-east-1_3iz7lup2k";
const PRE_AUTH_FUNCTION = process.env.PRE_AUTH_FUNCTION || "cognito-pre-auth-approval";

exports.handler = async (event) => {
  console.log("User Approval Handler invoked");
  console.log("Event:", JSON.stringify(event, null, 2));

  // Parse query parameters from Lambda Function URL
  const queryParams = event.queryStringParameters || {};
  const { action, email, token } = queryParams;

  // JSON response helper for API calls
  const jsonResponse = (statusCode, data) => ({
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS"
    },
    body: JSON.stringify(data)
  });

  // HTML response helper
  const htmlResponse = (statusCode, title, message, isSuccess = true) => ({
    statusCode,
    headers: { "Content-Type": "text/html" },
    body: `
      <!DOCTYPE html>
      <html>
      <head>
        <title>${title}</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                 display: flex; justify-content: center; align-items: center;
                 min-height: 100vh; margin: 0; background: #f5f5f5; }
          .container { background: white; padding: 40px; border-radius: 12px;
                       box-shadow: 0 4px 20px rgba(0,0,0,0.1); text-align: center; max-width: 500px; }
          h1 { color: ${isSuccess ? '#10b981' : '#ef4444'}; margin-bottom: 16px; }
          p { color: #6b7280; line-height: 1.6; }
          .icon { font-size: 64px; margin-bottom: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="icon">${isSuccess ? '✅' : '❌'}</div>
          <h1>${title}</h1>
          <p>${message}</p>
        </div>
      </body>
      </html>
    `
  });

  // Actions that return JSON (vs the HTML approve/deny pages)
  const JSON_ACTIONS = ["list", "get_permissions", "list_permissions", "set_permissions"];

  // Validate token
  if (token !== APPROVAL_TOKEN) {
    if (JSON_ACTIONS.includes(action)) {
      return jsonResponse(403, { error: "Invalid or missing security token" });
    }
    return htmlResponse(403, "Access Denied", "Invalid or missing security token.", false);
  }

  // Handle list action (returns JSON for admin dashboard)
  if (action === "list") {
    try {
      const data = await getAdminDashboardData();
      return jsonResponse(200, data);
    } catch (error) {
      console.error("Error fetching admin data:", error);
      return jsonResponse(500, { error: error.message });
    }
  }

  // ── User permission store (DynamoDB) ──
  // get_permissions&email=X       -> one user's permissions (client fetches its own on login)
  // list_permissions              -> all users' permissions (admin dashboard)
  // set_permissions&data=<json>   -> upsert; data = {email, permissions, actor} url-encoded
  if (action === "get_permissions") {
    if (!email) return jsonResponse(400, { ok: false, error: "email required" });
    try {
      const res = await ddb.send(new GetCommand({
        TableName: PERMISSIONS_TABLE, Key: { email: email.toLowerCase() },
      }));
      return jsonResponse(200, { ok: true, permissions: res.Item || null });
    } catch (e) {
      console.error("get_permissions error:", e);
      return jsonResponse(500, { ok: false, error: e.message });
    }
  }

  if (action === "list_permissions") {
    try {
      const res = await ddb.send(new ScanCommand({ TableName: PERMISSIONS_TABLE }));
      return jsonResponse(200, { ok: true, permissions: res.Items || [] });
    } catch (e) {
      console.error("list_permissions error:", e);
      return jsonResponse(500, { ok: false, error: e.message });
    }
  }

  if (action === "set_permissions") {
    try {
      const payload = JSON.parse(queryParams.data || "{}");
      const targetEmail = (payload.email || "").toLowerCase();
      if (!targetEmail) return jsonResponse(400, { ok: false, error: "email required" });
      const p = payload.permissions || {};
      const asArray = (v) => (Array.isArray(v) ? v : []);
      const item = {
        email: targetEmail,
        isAdmin: !!p.isAdmin,
        allowedSources: asArray(p.allowedSources),
        allowedEntities: asArray(p.allowedEntities),
        allowedMocks: asArray(p.allowedMocks),
        allowedBusinessUnits: asArray(p.allowedBusinessUnits),
        updatedBy: payload.actor || "",
        updatedAt: new Date().toISOString(),
      };
      await ddb.send(new PutCommand({ TableName: PERMISSIONS_TABLE, Item: item }));
      return jsonResponse(200, { ok: true, permissions: item });
    } catch (e) {
      console.error("set_permissions error:", e);
      return jsonResponse(500, { ok: false, error: e.message });
    }
  }

  // Validate action
  if (!action || !["approve", "deny"].includes(action)) {
    return htmlResponse(400, "Invalid Request", "Action must be 'approve', 'deny', or 'list'.", false);
  }

  // Validate email
  if (!email) {
    return htmlResponse(400, "Invalid Request", "Email parameter is required.", false);
  }

  try {
    if (action === "approve") {
      // Add email to the approved list in pre-auth Lambda
      await addToApprovedList(email);

      // Send approval notification to user
      await sendUserApprovalEmail(email);

      return htmlResponse(200, "User Approved",
        `<strong>${email}</strong> has been approved and notified via email. They can now sign in to Hacienda ERP.`);
    } else {
      // For denial, we just don't add them to the approved list
      // Optionally send denial email
      await sendUserDenialEmail(email);

      return htmlResponse(200, "User Denied",
        `<strong>${email}</strong> has been denied access and notified via email.`);
    }
  } catch (error) {
    console.error("Error processing approval:", error);
    return htmlResponse(500, "Error", `Failed to process request: ${error.message}`, false);
  }
};

async function addToApprovedList(email) {
  console.log(`Adding ${email} to approved list`);

  // Get current approved emails from pre-auth Lambda
  const getConfigCommand = new GetFunctionConfigurationCommand({
    FunctionName: PRE_AUTH_FUNCTION
  });

  const config = await lambdaClient.send(getConfigCommand);
  const currentEnvVars = config.Environment?.Variables || {};
  const currentApproved = currentEnvVars.APPROVED_EMAILS || "";

  // Parse and add new email
  const approvedList = currentApproved
    .split(",")
    .map(e => e.trim().toLowerCase())
    .filter(e => e.length > 0);

  const emailLower = email.toLowerCase();
  if (!approvedList.includes(emailLower)) {
    approvedList.push(emailLower);
  }

  // Update the Lambda environment variable
  const updateCommand = new UpdateFunctionConfigurationCommand({
    FunctionName: PRE_AUTH_FUNCTION,
    Environment: {
      Variables: {
        ...currentEnvVars,
        APPROVED_EMAILS: approvedList.join(", ")
      }
    }
  });

  await lambdaClient.send(updateCommand);
  console.log(`Updated APPROVED_EMAILS: ${approvedList.join(", ")}`);
}

async function sendUserApprovalEmail(userEmail) {
  console.log(`Sending approval notification to ${userEmail}`);

  const command = new SendEmailCommand({
    Source: ADMIN_EMAIL,
    Destination: {
      ToAddresses: [userEmail]
    },
    Message: {
      Subject: {
        Data: "Your Hacienda ERP Account Has Been Approved",
        Charset: "UTF-8"
      },
      Body: {
        Html: {
          Data: `
            <!DOCTYPE html>
            <html>
            <head>
              <style>
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                       line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: linear-gradient(135deg, #3b82f6, #2563eb); color: white;
                          padding: 30px; border-radius: 12px 12px 0 0; text-align: center; }
                .content { background: #f9fafb; padding: 30px; border-radius: 0 0 12px 12px; }
                .button { display: inline-block; background: #3b82f6; color: white;
                          padding: 14px 28px; text-decoration: none; border-radius: 8px;
                          font-weight: 600; margin: 20px 0; }
                .footer { text-align: center; margin-top: 20px; color: #6b7280; font-size: 14px; }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="header">
                  <h1 style="margin: 0;">Account Approved!</h1>
                </div>
                <div class="content">
                  <p>Hello,</p>
                  <p>Great news! Your Hacienda ERP account has been approved by an administrator.</p>
                  <p>You can now sign in to the application using your email and password.</p>
                  <p style="text-align: center;">
                    <a href="https://develop.d1weje07uqmri2.amplifyapp.com" class="button">Sign In to Hacienda ERP</a>
                  </p>
                  <p>If you have any questions, please contact your administrator.</p>
                  <p>Best regards,<br>Hacienda ERP Team</p>
                </div>
                <div class="footer">
                  <p>This is an automated message from Hacienda ERP.</p>
                </div>
              </div>
            </body>
            </html>
          `,
          Charset: "UTF-8"
        },
        Text: {
          Data: `Your Hacienda ERP Account Has Been Approved

Hello,

Great news! Your Hacienda ERP account has been approved by an administrator.

You can now sign in to the application using your email and password at:
https://develop.d1weje07uqmri2.amplifyapp.com

If you have any questions, please contact your administrator.

Best regards,
Hacienda ERP Team`,
          Charset: "UTF-8"
        }
      }
    }
  });

  await sesClient.send(command);
  console.log(`Approval email sent to ${userEmail}`);
}

async function sendUserDenialEmail(userEmail) {
  console.log(`Sending denial notification to ${userEmail}`);

  const command = new SendEmailCommand({
    Source: ADMIN_EMAIL,
    Destination: {
      ToAddresses: [userEmail]
    },
    Message: {
      Subject: {
        Data: "Hacienda ERP Account Request Update",
        Charset: "UTF-8"
      },
      Body: {
        Html: {
          Data: `
            <!DOCTYPE html>
            <html>
            <head>
              <style>
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                       line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: #6b7280; color: white;
                          padding: 30px; border-radius: 12px 12px 0 0; text-align: center; }
                .content { background: #f9fafb; padding: 30px; border-radius: 0 0 12px 12px; }
                .footer { text-align: center; margin-top: 20px; color: #6b7280; font-size: 14px; }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="header">
                  <h1 style="margin: 0;">Account Request Update</h1>
                </div>
                <div class="content">
                  <p>Hello,</p>
                  <p>Thank you for your interest in Hacienda ERP.</p>
                  <p>After review, your account request has not been approved at this time. If you believe this was in error or have questions, please contact your administrator.</p>
                  <p>Best regards,<br>Hacienda ERP Team</p>
                </div>
                <div class="footer">
                  <p>This is an automated message from Hacienda ERP.</p>
                </div>
              </div>
            </body>
            </html>
          `,
          Charset: "UTF-8"
        },
        Text: {
          Data: `Hacienda ERP Account Request Update

Hello,

Thank you for your interest in Hacienda ERP.

After review, your account request has not been approved at this time. If you believe this was in error or have questions, please contact your administrator.

Best regards,
Hacienda ERP Team`,
          Charset: "UTF-8"
        }
      }
    }
  });

  await sesClient.send(command);
  console.log(`Denial email sent to ${userEmail}`);
}

async function getAdminDashboardData() {
  console.log("Fetching admin dashboard data");

  // Get all users from Cognito
  const listUsersCommand = new ListUsersCommand({
    UserPoolId: USER_POOL_ID,
    Limit: 60
  });

  const usersResponse = await cognitoClient.send(listUsersCommand);

  // Get approved emails from pre-auth Lambda
  const getConfigCommand = new GetFunctionConfigurationCommand({
    FunctionName: PRE_AUTH_FUNCTION
  });

  const config = await lambdaClient.send(getConfigCommand);
  const currentEnvVars = config.Environment?.Variables || {};
  const approvedEmailsStr = currentEnvVars.APPROVED_EMAILS || "";

  const approvedEmails = approvedEmailsStr
    .split(",")
    .map(e => e.trim().toLowerCase())
    .filter(e => e.length > 0);

  // Transform users to a simpler format
  const users = usersResponse.Users.map(user => {
    const emailAttr = user.Attributes?.find(attr => attr.Name === "email");
    const emailVerifiedAttr = user.Attributes?.find(attr => attr.Name === "email_verified");

    return {
      username: user.Username,
      email: emailAttr?.Value || user.Username,
      status: user.UserStatus,
      enabled: user.Enabled,
      created: user.UserCreateDate?.toISOString(),
      lastModified: user.UserLastModifiedDate?.toISOString(),
      emailVerified: emailVerifiedAttr?.Value === "true"
    };
  });

  // Calculate stats
  const confirmedUsers = users.filter(u => u.status === "CONFIRMED");
  const approvedUsers = confirmedUsers.filter(u =>
    approvedEmails.includes(u.email.toLowerCase())
  );
  const pendingUsers = confirmedUsers.filter(u =>
    !approvedEmails.includes(u.email.toLowerCase())
  );

  return {
    users,
    approvedEmails,
    stats: {
      totalUsers: users.length,
      confirmedUsers: confirmedUsers.length,
      approvedUsers: approvedUsers.length,
      pendingUsers: pendingUsers.length
    }
  };
}
