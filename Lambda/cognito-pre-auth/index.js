/**
 * Cognito Pre Authentication Lambda Trigger
 *
 * This function blocks users who are NOT on the approved list.
 *
 * APPROVAL METHOD: Add approved emails to the APPROVED_EMAILS environment variable
 * as a comma-separated list, e.g.: "user1@example.com,user2@example.com"
 *
 * NO SPECIAL PERMISSIONS REQUIRED - just uses environment variable
 */

exports.handler = async (event) => {
  console.log("========================================");
  console.log("=== PRE AUTHENTICATION CHECK ===");
  console.log("========================================");
  console.log("Full event:", JSON.stringify(event, null, 2));

  const { userName, request, userPoolId, region } = event;
  const userEmail = request.userAttributes?.email || userName;

  console.log(`User attempting login: ${userEmail}`);
  console.log(`Username: ${userName}`);

  // Get approved emails from environment variable
  const approvedEmailsEnv = process.env.APPROVED_EMAILS || "";
  const approvedEmails = approvedEmailsEnv
    .split(",")
    .map(email => email.trim().toLowerCase())
    .filter(email => email.length > 0);

  console.log(`Approved emails count: ${approvedEmails.length}`);

  // Check if user is approved
  const userEmailLower = userEmail.toLowerCase();
  const isApproved = approvedEmails.includes(userEmailLower);

  console.log(`User email: ${userEmailLower}`);
  console.log(`Is approved: ${isApproved}`);

  if (!isApproved) {
    console.log("========================================");
    console.log("ACCESS DENIED - User not in approved list");
    console.log("");
    console.log("TO APPROVE THIS USER:");
    console.log("1. Go to Lambda -> Functions -> cognito-pre-auth-approval");
    console.log("2. Go to Configuration -> Environment variables");
    console.log("3. Add this email to APPROVED_EMAILS (comma-separated)");
    console.log(`4. Add: ${userEmail}`);
    console.log("========================================");

    // Throw an error to block authentication
    throw new Error("Your account is pending approval. Please contact the administrator.");
  }

  console.log("ACCESS GRANTED - User is approved");
  console.log("========================================");

  // Return the event to allow authentication
  return event;
};
