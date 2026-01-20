import type { PreSignUpTriggerHandler } from "aws-lambda";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const sesClient = new SESClient({});

// Admin email for approval notifications
const ADMIN_EMAIL = "mrichcreek@elitebco.com";

export const handler: PreSignUpTriggerHandler = async (event) => {
  console.log("Pre Sign Up trigger invoked:", JSON.stringify(event, null, 2));

  const { userName, request } = event;
  const userEmail = request.userAttributes.email || userName;
  const userPoolId = event.userPoolId;

  // Send notification email to admin
  try {
    const approveUrl = `https://console.aws.amazon.com/cognito/v2/idp/user-pools/${userPoolId}/users?region=${process.env.AWS_REGION}`;

    const emailParams = {
      Source: ADMIN_EMAIL, // Note: This email must be verified in SES
      Destination: {
        ToAddresses: [ADMIN_EMAIL],
      },
      Message: {
        Subject: {
          Data: `[Action Required] New User Registration: ${userEmail}`,
          Charset: "UTF-8",
        },
        Body: {
          Html: {
            Data: `
              <html>
                <body style="font-family: Arial, sans-serif; padding: 20px; background-color: #f5f5f5;">
                  <div style="max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
                    <h2 style="color: #333; margin-bottom: 20px;">New User Registration Request</h2>

                    <p style="color: #666; font-size: 16px;">A new user has requested access to the Hacienda ERP File Browser:</p>

                    <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
                      <p style="margin: 0 0 10px 0;"><strong>Email:</strong> ${userEmail}</p>
                      <p style="margin: 0 0 10px 0;"><strong>Username:</strong> ${userName}</p>
                      <p style="margin: 0;"><strong>Time:</strong> ${new Date().toLocaleString()}</p>
                    </div>

                    <p style="color: #666; font-size: 16px;">The user is currently in <strong>UNCONFIRMED</strong> status and cannot log in until approved.</p>

                    <h3 style="color: #333; margin-top: 30px;">To approve this user:</h3>
                    <ol style="color: #666; font-size: 14px;">
                      <li>Go to the <a href="${approveUrl}" style="color: #0066cc;">AWS Cognito Console</a></li>
                      <li>Find the user "${userEmail}"</li>
                      <li>Click on the user and select "Confirm user" from the Actions menu</li>
                    </ol>

                    <p style="color: #666; font-size: 14px; margin-top: 20px;">
                      Or use AWS CLI:<br>
                      <code style="background: #eee; padding: 8px 12px; display: block; margin-top: 10px; border-radius: 4px; font-size: 12px;">
                        aws cognito-idp admin-confirm-sign-up --user-pool-id ${userPoolId} --username ${userEmail}
                      </code>
                    </p>

                    <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
                    <p style="color: #999; font-size: 12px;">This is an automated message from Hacienda ERP File Browser.</p>
                  </div>
                </body>
              </html>
            `,
            Charset: "UTF-8",
          },
          Text: {
            Data: `
New User Registration Request

A new user has requested access to the Hacienda ERP File Browser:

Email: ${userEmail}
Username: ${userName}
Time: ${new Date().toLocaleString()}

The user is currently in UNCONFIRMED status and cannot log in until approved.

To approve this user:
1. Go to AWS Cognito Console: ${approveUrl}
2. Find the user "${userEmail}"
3. Click on the user and select "Confirm user" from the Actions menu

Or use AWS CLI:
aws cognito-idp admin-confirm-sign-up --user-pool-id ${userPoolId} --username ${userEmail}

---
This is an automated message from Hacienda ERP File Browser.
            `,
            Charset: "UTF-8",
          },
        },
      },
    };

    await sesClient.send(new SendEmailCommand(emailParams));
    console.log("Admin notification email sent successfully to:", ADMIN_EMAIL);
  } catch (error) {
    // Log error but don't fail the sign-up process
    console.error("Error sending admin notification email:", error);
    // Continue with sign-up even if email fails
  }

  // IMPORTANT: Do NOT auto-confirm or auto-verify the user
  // This keeps them in UNCONFIRMED status until admin approves
  event.response.autoConfirmUser = false;
  event.response.autoVerifyEmail = false;
  event.response.autoVerifyPhone = false;

  return event;
};
