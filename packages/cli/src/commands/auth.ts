import {
  getAuth,
  setAuth,
  removeAuth,
  getAllAuth,
  OAuthCredentials,
  requestDeviceCode,
  pollDeviceAuth,
  exchangeCodeForTokens,
  refreshAccessToken,
  extractAccountId,
  HOME_DIR,
} from "@CCR/shared";
import path from "node:path";
import os from "node:os";

export async function handleAuthCommand(subcommand: string): Promise<void> {
  switch (subcommand) {
    case "login":
      await loginCommand();
      break;
    case "logout":
      await logoutCommand();
      break;
    case "status":
      await statusCommand();
      break;
    case "list":
    case "ls":
      await listCommand();
      break;
    default:
      printHelp();
  }
}

function printHelp() {
  console.log(`
Usage: ccr auth [command]

Commands:
  login        Log in to a provider (OpenAI Codex)
  logout       Remove stored credentials
  status       Check authentication status
  list, ls     List stored credentials

Examples:
  ccr auth login
  ccr auth status
  ccr auth logout
`);
}

async function loginCommand() {
  const { select } = await import("@inquirer/prompts");

  const provider = await select({
    message: "Select provider",
    choices: [
      { name: "OpenAI Codex (ChatGPT Plus/Pro)", value: "openai-codex" },
    ],
  });

  if (provider === "openai-codex") {
    console.log("\nInitiating OpenAI device authorization...\n");

    const { deviceAuthId, userCode, interval } = await requestDeviceCode();

    console.log(`  Visit:  https://auth.openai.com/codex/device`);
    console.log(`  Code:   ${userCode}\n`);
    console.log("Waiting for authorization...");

    const deviceToken = await pollDeviceAuth(deviceAuthId, userCode, interval);

    console.log("Exchanging authorization code for tokens...");
    const tokens = await exchangeCodeForTokens(
      deviceToken.authorization_code,
      deviceToken.code_verifier
    );

    const accountId = extractAccountId(tokens);

    await setAuth("openai-codex", {
      type: "oauth",
      refresh: tokens.refresh_token,
      access: tokens.access_token,
      expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      accountId,
    });

    console.log("\nLogin successful!");
    if (accountId) {
      console.log(`Account ID: ${accountId}`);
    }
  }
}

async function logoutCommand() {
  const credentials = await getAllAuth();
  const entries = Object.entries(credentials);

  if (entries.length === 0) {
    console.log("No stored credentials.");
    return;
  }

  const { select } = await import("@inquirer/prompts");

  const providerID = await select({
    message: "Select credential to remove",
    choices: entries.map(([id, info]) => ({
      name: `${id} (${info.type})`,
      value: id,
    })),
  });

  await removeAuth(providerID);
  console.log(`Removed credentials for ${providerID}.`);
}

async function statusCommand() {
  const credentials = await getAllAuth();
  const entries = Object.entries(credentials);

  if (entries.length === 0) {
    console.log("No stored credentials.");
    return;
  }

  const authPath = path.join(HOME_DIR, "auth.json");
  const displayPath = authPath.replace(os.homedir(), "~");
  console.log(`\nCredentials: ${displayPath}\n`);

  for (const [id, info] of entries) {
    if (info.type === "oauth") {
      const oauth = info as OAuthCredentials;
      const now = Date.now();
      const expired = oauth.expires < now;
      const expiresIn = expired
        ? "EXPIRED"
        : `expires in ${Math.round((oauth.expires - now) / 60000)} min`;
      const accountStr = oauth.accountId ? ` (account: ${oauth.accountId})` : "";
      console.log(`  ${id}  oauth  ${expiresIn}${accountStr}`);
    } else {
      console.log(`  ${id}  api-key`);
    }
  }
  console.log();
}

async function listCommand() {
  const credentials = await getAllAuth();
  const entries = Object.entries(credentials);

  if (entries.length === 0) {
    console.log("No stored credentials.");
    return;
  }

  for (const [id, info] of entries) {
    console.log(`  ${id}  ${info.type}`);
  }
}
