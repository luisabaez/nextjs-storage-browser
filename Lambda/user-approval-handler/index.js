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
 * Reading everyone's accounts and changing permissions also need the caller's
 * Cognito access token (Authorization: Bearer ...), checked with Cognito:
 * set_permissions, list and list_permissions are for administrators; the
 * portal_* actions let the HCM portal's super users manage the portal's users
 * (agency users and certification reviewers; administrators also super users).
 *
 * Environment Variables:
 * - ADMIN_EMAIL: Email to receive approval requests
 * - APPROVAL_TOKEN: Secret token for approval links
 * - USER_POOL_ID: Cognito User Pool ID
 * - APPROVED_EMAILS: Comma-separated list of approved emails (used for legacy compatibility)
 */

const {
  CognitoIdentityProviderClient, AdminGetUserCommand, AdminUpdateUserAttributesCommand, AdminEnableUserCommand, ListUsersCommand,
  AdminCreateUserCommand, AdminDisableUserCommand, GetUserCommand,
} = require("@aws-sdk/client-cognito-identity-provider");
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
// Built-in administrators (the same list as the application's ADMIN_EMAILS).
const ADMIN_EMAILS = ["mrichcreek@elitebco.com", "lbaez@elitebco.com", "jvelilla@elitebco.com", "flockwood@elitebco.com"];
const PORTAL_ROLES = ["super_user", "agency_user", "certification_reviewer"];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const asArray = (v) => (Array.isArray(v) ? v : []);
const asRole = (v) => (PORTAL_ROLES.includes(v) ? v : "");
// Source / agency assignments as "SOURCE|AGENCY"; the agency is empty for a
// source-level certifier. Anything that is not a clean pair is dropped.
const asParties = (v) => {
  const parties = new Set();
  for (const entry of asArray(v)) {
    if (typeof entry !== "string") continue;
    const parts = entry.toUpperCase().split("|").map((s) => s.trim());
    if (parts.length === 2 && /^[A-Z0-9_]{1,20}$/.test(parts[0]) && /^[A-Z0-9_-]{0,20}$/.test(parts[1])) {
      parties.add(parts.join("|"));
    }
  }
  return [...parties].slice(0, 200);
};

async function getRecord(email) {
  const res = await ddb.send(new GetCommand({ TableName: PERMISSIONS_TABLE, Key: { email: email.toLowerCase() } }));
  return res.Item || null;
}

// Access token -> e-mail, for a few minutes: Cognito answers GetUser only for a
// token it issued and that is still valid.
const sessions = new Map();

async function verifyCaller(event) {
  const headers = event.headers || {};
  const token = (headers.authorization || headers.Authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new HttpError(401, "Sign in again: the request did not carry your session.");
  let known = sessions.get(token);
  if (!known || known.until < Date.now()) {
    let user;
    try {
      user = await cognitoClient.send(new GetUserCommand({ AccessToken: token }));
    } catch (e) {
      throw new HttpError(401, "Your session has expired. Sign in again.");
    }
    const email = ((user.UserAttributes || []).find((a) => a.Name === "email")?.Value || user.Username || "").toLowerCase();
    known = { email, until: Date.now() + 5 * 60 * 1000 };
    if (sessions.size > 500) sessions.clear();
    sessions.set(token, known);
  }
  const record = await getRecord(known.email);
  const isAdmin = ADMIN_EMAILS.includes(known.email) || !!record?.isAdmin;
  if (record?.disabled && !isAdmin) throw new HttpError(403, "This account has been removed.");
  return { email: known.email, isAdmin, role: isAdmin ? "super_user" : asRole(record?.role) };
}

async function requireAdmin(event) {
  const caller = await verifyCaller(event);
  if (!caller.isAdmin) throw new HttpError(403, "Only an administrator can do this.");
  return caller;
}

exports.handler = async (event) => {
  console.log("User Approval Handler invoked");
  console.log("Event:", JSON.stringify(event, null, 2));

  // Parse query parameters from Lambda Function URL
  const queryParams = event.queryStringParameters || {};
  const { action, email, token } = queryParams;

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  };
  // JSON response helper for API calls
  const jsonResponse = (statusCode, data) => ({
    statusCode,
    headers: { "Content-Type": "application/json", ...cors },
    body: JSON.stringify(data)
  });

  // The browser asks before sending the Authorization header.
  if ((event.requestContext?.http?.method || "").toUpperCase() === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }

  // The HCM portal's user management: the caller is who their Cognito token says.
  if (PORTAL_ACTIONS[action]) {
    try {
      let body = {};
      if (event.body) {
        body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf-8") : event.body);
      }
      const caller = await verifyCaller(event);
      if (!caller.isAdmin && caller.role !== "super_user") throw new HttpError(403, "Only a super user can manage users.");
      return jsonResponse(200, { ok: true, ...(await PORTAL_ACTIONS[action](caller, body || {})) });
    } catch (e) {
      console.error(`${action} error:`, e);
      return jsonResponse(e.status || 500, { ok: false, error: e.message });
    }
  }

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

  // Everyone's accounts and permissions: administrators only, checked on their token.
  if (["list", "list_permissions", "set_permissions"].includes(action)) {
    try {
      await requireAdmin(event);
    } catch (e) {
      return jsonResponse(e.status || 500, { ok: false, error: e.message });
    }
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
      const item = {
        ...((await getRecord(targetEmail)) || {}),
        email: targetEmail,
        isAdmin: !!p.isAdmin,
        role: asRole(p.role),
        allowedSources: asArray(p.allowedSources),
        allowedEntities: asArray(p.allowedEntities),
        allowedMocks: asArray(p.allowedMocks),
        allowedBusinessUnits: asArray(p.allowedBusinessUnits),
        parties: asParties(p.parties),
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

// ── HCM portal user management ───────────────────────────────────────────────

async function allRecords() {
  const items = [];
  let start;
  do {
    const res = await ddb.send(new ScanCommand({ TableName: PERMISSIONS_TABLE, ExclusiveStartKey: start }));
    items.push(...(res.Items || []));
    start = res.LastEvaluatedKey;
  } while (start);
  return items;
}

async function allAccounts() {
  const users = [];
  let next;
  do {
    const res = await cognitoClient.send(new ListUsersCommand({ UserPoolId: USER_POOL_ID, Limit: 60, PaginationToken: next }));
    users.push(...(res.Users || []));
    next = res.PaginationToken;
  } while (next);
  return users;
}

async function account(email) {
  try {
    return await cognitoClient.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: email }));
  } catch (e) {
    if (e.name === "UserNotFoundException") return null;
    throw e;
  }
}

const attribute = (attrs, name) => (attrs || []).find((a) => a.Name === name)?.Value || "";

function statusOf(record, cognito) {
  if (!cognito) return "no_account";
  if (!cognito.enabled || record?.disabled) return "removed";
  if (cognito.status === "FORCE_CHANGE_PASSWORD") return "invited";
  return asRole(record?.role) ? "active" : "no_access";
}

// A super user manages agency users and certification reviewers; an
// administrator also manages super users. Administrators are managed only on
// the Admin page.
function manageable(caller, record, email) {
  if (ADMIN_EMAILS.includes(email) || record?.isAdmin || email === caller.email) return false;
  return caller.isAdmin || asRole(record?.role) !== "super_user";
}

function rolesFor(caller) {
  return caller.isAdmin ? PORTAL_ROLES : ["agency_user", "certification_reviewer"];
}

function publicUser(caller, email, record, cognito) {
  return {
    email,
    name: record?.name || cognito?.name || "",
    role: asRole(record?.role),
    parties: asArray(record?.parties),
    status: statusOf(record, cognito),
    created: cognito?.created || null,
    updatedBy: record?.updatedBy || "",
    updatedAt: record?.updatedAt || "",
    invitedBy: record?.invitedBy || "",
    invitedAt: record?.invitedAt || "",
    manageable: manageable(caller, record, email),
  };
}

function targetEmail(body) {
  const email = String(body.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new HttpError(400, "Enter a valid e-mail address.");
  return email;
}

async function checkTarget(caller, email) {
  const record = await getRecord(email);
  if (!manageable(caller, record, email)) {
    throw new HttpError(403, email === caller.email ? "You cannot change your own access here."
      : "This account is managed by an administrator.");
  }
  return record;
}

const PORTAL_ACTIONS = {
  // Everyone who can use the portal, or could be given access to it.
  async portal_users(caller) {
    const records = new Map((await allRecords()).map((r) => [String(r.email || "").toLowerCase(), r]));
    const accounts = new Map((await allAccounts()).map((u) => [
      (attribute(u.Attributes, "email") || u.Username || "").toLowerCase(),
      { status: u.UserStatus, enabled: u.Enabled, name: attribute(u.Attributes, "name"),
        created: u.UserCreateDate ? u.UserCreateDate.toISOString() : null },
    ]));
    const users = [];
    for (const email of new Set([...records.keys(), ...accounts.keys()])) {
      const record = records.get(email);
      if (!email || ADMIN_EMAILS.includes(email) || record?.isAdmin) continue;
      if (!accounts.has(email) && !asRole(record?.role)) continue;
      users.push(publicUser(caller, email, record, accounts.get(email)));
    }
    users.sort((a, b) => a.email.localeCompare(b.email));
    return { users, roles: rolesFor(caller), you: caller.email, isAdmin: caller.isAdmin };
  },

  // Add a user (an invitation e-mail with a temporary password when they have
  // no account yet) or change their role and source / agency assignments.
  async portal_user_save(caller, body) {
    const email = targetEmail(body);
    const record = await checkTarget(caller, email);
    const role = String(body.role || "");
    if (!rolesFor(caller).includes(role)) throw new HttpError(400, "Choose a role.");
    const parties = role === "agency_user" ? asParties(body.parties) : [];
    if (role === "agency_user" && parties.length === 0) {
      throw new HttpError(400, "An agency user needs at least one source / agency assignment.");
    }
    const name = String(body.name || "").trim().slice(0, 200);
    let cognito = await account(email);
    let invited = false;
    if (!cognito) {
      if (!body.invite) throw new HttpError(404, "This person has no account yet. Send an invitation instead.");
      const attributes = [{ Name: "email", Value: email }, { Name: "email_verified", Value: "true" }];
      if (name) attributes.push({ Name: "name", Value: name });
      await cognitoClient.send(new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID, Username: email, UserAttributes: attributes, DesiredDeliveryMediums: ["EMAIL"],
      }));
      invited = true;
    } else if (!cognito.Enabled) {
      await cognitoClient.send(new AdminEnableUserCommand({ UserPoolId: USER_POOL_ID, Username: email }));
    }
    const now = new Date().toISOString();
    const item = {
      allowedSources: [], allowedEntities: [], allowedMocks: [], allowedBusinessUnits: [],
      ...(record || {}),
      email, name: name || record?.name || "", isAdmin: false, role, parties,
      approved: true, disabled: false, updatedBy: caller.email, updatedAt: now,
      ...(invited ? { invitedBy: caller.email, invitedAt: now } : {}),
    };
    delete item.removedBy;
    delete item.removedAt;
    await ddb.send(new PutCommand({ TableName: PERMISSIONS_TABLE, Item: item }));
    cognito = await account(email);
    return {
      invited,
      user: publicUser(caller, email, item, cognito && { status: cognito.UserStatus, enabled: cognito.Enabled,
        created: cognito.UserCreateDate ? cognito.UserCreateDate.toISOString() : null }),
    };
  },

  // Take the portal away: the account can no longer sign in and loses its
  // role and assignments. Kept, so it can be given access again later.
  async portal_user_remove(caller, body) {
    const email = targetEmail(body);
    const record = await checkTarget(caller, email);
    if (await account(email)) {
      await cognitoClient.send(new AdminDisableUserCommand({ UserPoolId: USER_POOL_ID, Username: email }));
    }
    const item = {
      ...(record || { email, allowedSources: [], allowedEntities: [], allowedMocks: [], allowedBusinessUnits: [] }),
      email, isAdmin: false, role: "", parties: [], approved: false, disabled: true,
      removedBy: caller.email, removedAt: new Date().toISOString(),
      updatedBy: caller.email, updatedAt: new Date().toISOString(),
    };
    await ddb.send(new PutCommand({ TableName: PERMISSIONS_TABLE, Item: item }));
    return { email, removed: true };
  },

  // A new invitation e-mail for someone who has not signed in yet.
  async portal_user_resend(caller, body) {
    const email = targetEmail(body);
    await checkTarget(caller, email);
    const cognito = await account(email);
    if (!cognito || cognito.UserStatus !== "FORCE_CHANGE_PASSWORD") {
      throw new HttpError(400, "This person has already signed in; there is no invitation to send again.");
    }
    await cognitoClient.send(new AdminCreateUserCommand({
      UserPoolId: USER_POOL_ID, Username: email, MessageAction: "RESEND", DesiredDeliveryMediums: ["EMAIL"],
    }));
    return { email, resent: true };
  },
};
