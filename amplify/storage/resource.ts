import { defineStorage } from "@aws-amplify/backend";

// ─────────────────────────────────────────────────────────────────────────────
// Every top-level folder the file browser works with is listed here so that
// authenticated users get read/write/delete access to it. This is the single
// source of truth for storage access.
//
// ADDING A NEW FOLDER: add its name to FOLDERS below AND mirror a matching
// `"<name>/*"` entry into the `paths` of amplify_outputs.dev.json /
// amplify_outputs.prd.json (and amplify_outputs.json for local dev) — the app
// reads its access config from those generated files at runtime. Keeping both
// in sync prevents "folder not accessible / not listed" problems.
// ─────────────────────────────────────────────────────────────────────────────
const FOLDERS = [
  "ConversionFiles",
  "ConversionFileErrors",
  "ConversionFileErrors/Mock8",
  "InitialUpload",
  "InitialUploadErrors",
  "TSQLFiles",
  "DataValidation",
  "Dalving Input",
  "InputFilesForProcessing",
  "ProcessedFiles",
  "FailedInvoices",
  "FailedUnmatchedFilenames",
  "APInvoiceInput",
  "UploadedAPInvoices",
  "FailedAPInvoices",
  "Sampling",
  "Sampling/Generated",
  "Sampling/Reports",
];

export const storage = defineStorage({
  name: "storage-browser-test",
  access: (allow) =>
    Object.fromEntries(
      FOLDERS.map((folder) => [
        `${folder}/*`,
        [
          allow.authenticated.to(["read", "write", "delete"]),
          allow.entity("identity").to(["read", "write", "delete"]),
        ],
      ])
    ),
});
