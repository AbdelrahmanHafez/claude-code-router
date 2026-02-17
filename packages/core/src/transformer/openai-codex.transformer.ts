import { Transformer } from "@/types/transformer";
import { LLMProvider, UnifiedChatRequest } from "@/types/llm";
import {
  getAuth,
  setAuth,
  OAuthCredentials,
  refreshAccessToken,
  extractAccountId,
  CODEX_API_ENDPOINT,
} from "@CCR/shared";

const REFRESH_MARGIN_MS = 5 * 60 * 1000; // 5 minutes before expiry

export class OpenAICodexTransformer implements Transformer {
  name = "openai-codex";

  private refreshPromise: Promise<OAuthCredentials> | null = null;

  async transformRequestIn(
    request: UnifiedChatRequest,
    provider: LLMProvider,
    context: any
  ): Promise<Record<string, any>> {
    const auth = (await getAuth("openai-codex")) as OAuthCredentials | undefined;
    if (!auth || auth.type !== "oauth") {
      throw new Error(
        "OpenAI Codex authentication required. Run 'ccr auth login' first."
      );
    }

    let current = auth;

    if (!current.access || current.expires < Date.now() + REFRESH_MARGIN_MS) {
      current = await this.refreshToken(current);
    }

    const headers: Record<string, string | undefined> = {
      Authorization: `Bearer ${current.access}`,
      Accept: "text/event-stream",
      "User-Agent": "codex_cli_rs/0.101.0 (Mac OS 26.0.1; arm64)",
      Originator: "codex_cli_rs",
      Version: "0.101.0",
      "Openai-Beta": "responses=experimental",
      Session_id: crypto.randomUUID(),
    };

    if (current.accountId) {
      headers["ChatGPT-Account-Id"] = current.accountId;
    }

    // Codex API requires instructions, store: false, and stream: true
    if (!(request as any).instructions) {
      (request as any).instructions = "";
    }
    (request as any).store = false;
    (request as any).stream = true;

    return {
      body: request,
      config: {
        url: new URL(CODEX_API_ENDPOINT),
        headers,
      },
    };
  }

  async transformResponseOut(response: Response): Promise<Response> {
    // Codex API always streams SSE but may not set the correct Content-Type.
    // Ensure downstream transformers (openai-responses) handle it as SSE.
    const headers = new Headers(response.headers);
    headers.set("Content-Type", "text/event-stream");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  private async refreshToken(auth: OAuthCredentials): Promise<OAuthCredentials> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      try {
        const tokens = await refreshAccessToken(auth.refresh);
        const accountId = extractAccountId(tokens) || auth.accountId;
        const updated: OAuthCredentials = {
          type: "oauth",
          refresh: tokens.refresh_token,
          access: tokens.access_token,
          expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
          accountId,
        };
        await setAuth("openai-codex", updated);
        return updated;
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }
}
