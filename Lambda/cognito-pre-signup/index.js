/**
 * Cognito Pre Sign-Up Lambda Trigger
 *
 * This function intercepts new user registrations and:
 * 1. Sends an email to the admin with Approve/Deny links
 * 2. Logs the registration to CloudWatch
 *
 * Environment Variables:
 * - ADMIN_EMAIL: Email to receive approval requests (must be verified in SES)
 * - APPROVAL_URL: Base URL for the approval Lambda function
 * - APPROVAL_TOKEN: Secret token for approval links
 */

const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");

const sesClient = new SESClient({ region: process.env.AWS_REGION || "us-east-1" });

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "mrichcreek@elitebco.com";
const APPROVAL_URL = process.env.APPROVAL_URL || "https://w47wliqar3ka27qsezzckqpoza0kkmbt.lambda-url.us-east-1.on.aws/";
const APPROVAL_TOKEN = process.env.APPROVAL_TOKEN || "hacienda-erp-approval-2024";

exports.handler = async (event) => {
  console.log("========================================");
  console.log("=== NEW USER REGISTRATION REQUEST ===");
  console.log("========================================");
  console.log("Full event:", JSON.stringify(event, null, 2));

  const { userName, request, userPoolId, region } = event;
  const userEmail = request.userAttributes.email || userName;
  const timestamp = new Date().toISOString();

  console.log(`Email: ${userEmail}`);
  console.log(`Username: ${userName}`);
  console.log(`Time: ${timestamp}`);
  console.log(`User Pool: ${userPoolId}`);
  console.log(`Region: ${region}`);

  // Build approval/denial URLs
  const approveUrl = `${APPROVAL_URL}?action=approve&email=${encodeURIComponent(userEmail)}&token=${encodeURIComponent(APPROVAL_TOKEN)}`;
  const denyUrl = `${APPROVAL_URL}?action=deny&email=${encodeURIComponent(userEmail)}&token=${encodeURIComponent(APPROVAL_TOKEN)}`;

  console.log(`Approve URL: ${approveUrl}`);
  console.log(`Deny URL: ${denyUrl}`);

  // Send approval request email to admin
  try {
    await sendApprovalRequestEmail(userEmail, timestamp, approveUrl, denyUrl);
    console.log("Approval request email sent successfully");
  } catch (error) {
    console.error("Failed to send approval request email:", error);
    // Don't fail the signup if email fails - user can still be approved manually
  }

  // These settings allow email verification to proceed
  // The user will be blocked at login until approved
  event.response.autoConfirmUser = false;
  event.response.autoVerifyEmail = false;
  event.response.autoVerifyPhone = false;

  console.log("Pre Sign-Up trigger completed.");
  console.log("User will verify email, but login blocked until approved.");
  console.log("========================================");

  return event;
};

async function sendApprovalRequestEmail(userEmail, timestamp, approveUrl, denyUrl) {
  const command = new SendEmailCommand({
    Source: ADMIN_EMAIL,
    Destination: {
      ToAddresses: [ADMIN_EMAIL]
    },
    Message: {
      Subject: {
        Data: `[Hacienda ERP] New User Approval Request: ${userEmail}`,
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
                       line-height: 1.6; color: #333; margin: 0; padding: 0; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: linear-gradient(135deg, #f59e0b, #d97706); color: white;
                          padding: 30px; border-radius: 12px 12px 0 0; text-align: center; }
                .content { background: #f9fafb; padding: 30px; }
                .user-info { background: white; padding: 20px; border-radius: 8px;
                             border: 1px solid #e5e7eb; margin: 20px 0; }
                .user-info h3 { margin: 0 0 10px 0; color: #1f2937; }
                .user-info p { margin: 5px 0; color: #6b7280; }
                .buttons { display: flex; gap: 16px; justify-content: center; margin: 30px 0; }
                .button { display: inline-block; padding: 14px 32px; text-decoration: none;
                          border-radius: 8px; font-weight: 600; font-size: 16px; }
                .approve { background: #10b981; color: white; }
                .deny { background: #ef4444; color: white; }
                .footer { text-align: center; padding: 20px; color: #6b7280;
                          font-size: 14px; border-radius: 0 0 12px 12px; background: #f3f4f6; }
                .warning { background: #fef3c7; border: 1px solid #fcd34d; padding: 15px;
                           border-radius: 8px; margin-top: 20px; }
                .warning p { margin: 0; color: #92400e; font-size: 14px; }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="header">
                  <h1 style="margin: 0;">New User Approval Request</h1>
                </div>
                <div class="content">
                  <p>A new user has requested access to Hacienda ERP and requires your approval.</p>

                  <div class="user-info">
                    <h3>User Details</h3>
                    <p><strong>Email:</strong> ${userEmail}</p>
                    <p><strong>Requested:</strong> ${new Date(timestamp).toLocaleString('en-US', {
                      dateStyle: 'full',
                      timeStyle: 'short'
                    })}</p>
                  </div>

                  <div class="buttons">
                    <a href="${approveUrl}" class="button approve">&#10003; Approve User</a>
                    <a href="${denyUrl}" class="button deny">&#10007; Deny User</a>
                  </div>

                  <div class="warning">
                    <p><strong>Note:</strong> Clicking Approve will immediately grant the user access to Hacienda ERP and send them a notification email.</p>
                  </div>
                </div>
                <div class="footer">
                  <p>This is an automated message from Hacienda ERP User Management.</p>
                  <p>Do not reply to this email.</p>
                </div>
              </div>
            </body>
            </html>
          `,
          Charset: "UTF-8"
        },
        Text: {
          Data: `New User Approval Request for Hacienda ERP

A new user has requested access and requires your approval.

User Details:
- Email: ${userEmail}
- Requested: ${timestamp}

To APPROVE this user, click:
${approveUrl}

To DENY this user, click:
${denyUrl}

Note: Clicking Approve will immediately grant access and notify the user.

---
Hacienda ERP User Management`,
          Charset: "UTF-8"
        }
      }
    }
  });

  await sesClient.send(command);
}
