export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_ISSUER = "https://auth.openai.com";
export const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

const POLLING_SAFETY_MARGIN_MS = 3000;
const POLLING_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

interface DeviceCodeResponse {
  device_auth_id: string;
  user_code: string;
  interval: string;
}

interface DeviceTokenResponse {
  authorization_code: string;
  code_challenge: string;
  code_verifier: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  id_token: string;
  expires_in?: number;
}

interface IdTokenClaims {
  chatgpt_account_id?: string;
  organizations?: Array<{ id: string }>;
  email?: string;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
  };
}

export async function requestDeviceCode(): Promise<{
  deviceAuthId: string;
  userCode: string;
  interval: number;
}> {
  const response = await fetch(
    `${CODEX_ISSUER}/api/accounts/deviceauth/usercode`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "claude-code-router",
      },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to initiate device authorization: ${response.status}`);
  }

  const data: DeviceCodeResponse = await response.json();
  return {
    deviceAuthId: data.device_auth_id,
    userCode: data.user_code,
    interval: Math.max(parseInt(data.interval) || 5, 1),
  };
}

export async function pollDeviceAuth(
  deviceAuthId: string,
  userCode: string,
  intervalSec: number
): Promise<DeviceTokenResponse> {
  const intervalMs = intervalSec * 1000 + POLLING_SAFETY_MARGIN_MS;
  const deadline = Date.now() + POLLING_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const response = await fetch(
      `${CODEX_ISSUER}/api/accounts/deviceauth/token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "claude-code-router",
        },
        body: JSON.stringify({
          device_auth_id: deviceAuthId,
          user_code: userCode,
        }),
      }
    );

    if (response.ok) {
      return (await response.json()) as DeviceTokenResponse;
    }

    if (response.status !== 403 && response.status !== 404) {
      throw new Error(`Device auth polling failed: ${response.status}`);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error("Device authorization timed out");
}

export async function exchangeCodeForTokens(
  authCode: string,
  codeVerifier: string
): Promise<TokenResponse> {
  const response = await fetch(`${CODEX_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: authCode,
      redirect_uri: `${CODEX_ISSUER}/deviceauth/callback`,
      client_id: CODEX_CLIENT_ID,
      code_verifier: codeVerifier,
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`);
  }

  return response.json();
}

export async function refreshAccessToken(
  refreshToken: string
): Promise<TokenResponse> {
  const response = await fetch(`${CODEX_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID,
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`);
  }

  return response.json();
}

export function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString());
  } catch {
    return undefined;
  }
}

export function extractAccountId(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token);
    if (claims) {
      const id =
        claims.chatgpt_account_id ||
        claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
        claims.organizations?.[0]?.id;
      if (id) return id;
    }
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token);
    if (claims) {
      return (
        claims.chatgpt_account_id ||
        claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
        claims.organizations?.[0]?.id
      );
    }
  }
  return undefined;
}
