import { defineBackend } from "@aws-amplify/backend";
import { auth } from "./auth/resource";
import { storage } from "./storage/resource";
import { preSignUp } from "./auth/pre-sign-up/resource";
import { PolicyStatement, Effect } from "aws-cdk-lib/aws-iam";

/**
 * @see https://docs.amplify.aws/react/build-a-backend/ to add storage, functions, and more
 */
const backend = defineBackend({
  auth,
  storage,
  preSignUp,
});

// Grant SES permissions to the pre-sign-up Lambda function
const preSignUpLambda = backend.preSignUp.resources.lambda;
preSignUpLambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["ses:SendEmail", "ses:SendRawEmail"],
    resources: ["*"],
  })
);
