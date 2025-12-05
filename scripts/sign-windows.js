/**
 * Windows EV code signing script for electron-builder
 * Uses jsign with GCP Cloud KMS for EV certificate signing
 *
 * Required environment variables:
 *   JSIGN_PATH          - Path to jsign JAR file
 *   EV_KEYSTORE         - GCP Cloud KMS keystore URL
 *   EV_KEY              - Key alias in the keystore
 *   EV_CERTIFICATE_PATH - Path to the EV certificate PEM file
 *   EV_TSA_URL          - Timestamp server URL
 *   GCLOUD_ACCESS_TOKEN - GCP access token for authentication
 */

const { execSync } = require("child_process");
const path = require("path");

/**
 * @param {import("electron-builder").CustomWindowsSignTaskConfiguration} configuration
 * @returns {Promise<void>}
 */
exports.default = async function sign(configuration) {
  const filePath = configuration.path;

  // Check if signing is configured
  if (!process.env.JSIGN_PATH || !process.env.EV_KEYSTORE) {
    console.log(
      `⚠️ Windows code signing not configured - skipping signing for ${filePath}`
    );
    return;
  }

  // Validate required environment variables
  const requiredVars = [
    "JSIGN_PATH",
    "EV_KEYSTORE",
    "EV_KEY",
    "EV_CERTIFICATE_PATH",
    "EV_TSA_URL",
    "GCLOUD_ACCESS_TOKEN",
  ];

  for (const varName of requiredVars) {
    if (!process.env[varName]) {
      throw new Error(`Missing required environment variable: ${varName}`);
    }
  }

  console.log(`Signing ${filePath} with EV certificate...`);

  const jsignArgs = [
    "-jar",
    process.env.JSIGN_PATH,
    "--storetype",
    "GOOGLECLOUD",
    "--storepass",
    process.env.GCLOUD_ACCESS_TOKEN,
    "--keystore",
    process.env.EV_KEYSTORE,
    "--alias",
    process.env.EV_KEY,
    "--certfile",
    process.env.EV_CERTIFICATE_PATH,
    "--tsmode",
    "RFC3161",
    "--tsaurl",
    process.env.EV_TSA_URL,
    filePath,
  ];

  try {
    execSync(`java ${jsignArgs.map((a) => `"${a}"`).join(" ")}`, {
      stdio: "inherit",
    });
    console.log(`✅ Successfully signed ${filePath}`);
  } catch (error) {
    throw new Error(`Failed to sign ${filePath}: ${error.message}`);
  }
};
