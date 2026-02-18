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

    const req = request as any;
    const body = this.buildCodexBody(req);

    return {
      body,
      config: {
        url: new URL(CODEX_API_ENDPOINT),
        headers,
      },
    };
  }

  private buildCodexBody(req: any): Record<string, any> {
    const body: Record<string, any> = {
      model: req.model,
      instructions: req.instructions || "",
      input: req.input || [],
      stream: true,
      store: false,
      parallel_tool_calls: req.parallel_tool_calls ?? true,
      include: ["reasoning.encrypted_content"],
    };

    if (req.tools?.length) {
      body.tools = req.tools;
    }
    if (req.tool_choice != null) {
      body.tool_choice = req.tool_choice;
    }
    if (req.reasoning) {
      body.reasoning = {
        effort: req.reasoning.effort || "medium",
        summary: req.reasoning.summary || "auto",
      };
    }
    if (req.text) {
      body.text = req.text;
    }

    return body;
  }

  async transformResponseOut(response: Response): Promise<Response> {
    const headers = new Headers(response.headers);
    headers.set("Content-Type", "text/event-stream");
    headers.set("X-CCR-Response-Converted", "chat-completions");

    if (!response.body) {
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    const stream = this.convertCodexToChat(response.body);

    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  private convertCodexToChat(source: ReadableStream): ReadableStream {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    let responseId = "chatcmpl-" + Date.now();
    let model = "codex";
    let buffer = "";
    let isStreamEnded = false;
    let toolCallIndex = -1;
    const itemIdToToolIndex = new Map<string, number>();

    const makeChunk = (
      delta: Record<string, any>,
      finishReason: string | null = null,
      usage?: Record<string, any>
    ): string => {
      const chunk: Record<string, any> = {
        id: responseId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      };
      if (usage) {
        chunk.usage = usage;
      }
      return `data: ${JSON.stringify(chunk)}\n\n`;
    };

    return new ReadableStream({
      async start(controller) {
        const reader = source.getReader();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              const dataStr = line.slice(5).trim();
              if (!dataStr || dataStr === "[DONE]") {
                if (dataStr === "[DONE]" && !isStreamEnded) {
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                  isStreamEnded = true;
                }
                continue;
              }

              let event: any;
              try {
                event = JSON.parse(dataStr);
              } catch {
                continue;
              }

              const type = event.type;

              if (type === "response.created") {
                responseId = event.response?.id || responseId;
                model = event.response?.model || model;
              } else if (type === "response.reasoning_summary_text.delta") {
                controller.enqueue(
                  encoder.encode(
                    makeChunk({ thinking: { content: event.delta || "" } })
                  )
                );
              } else if (type === "response.reasoning_summary_part.done") {
                const signature =
                  event.part?.signature || event.item_id || "";
                controller.enqueue(
                  encoder.encode(makeChunk({ thinking: { signature } }))
                );
              } else if (type === "response.output_text.delta") {
                controller.enqueue(
                  encoder.encode(makeChunk({ content: event.delta || "" }))
                );
              } else if (
                type === "response.output_item.added" &&
                event.item?.type === "function_call"
              ) {
                toolCallIndex++;
                const callId = event.item.call_id || event.item.id || "";
                const name = event.item.name || "";
                if (event.item.id) {
                  itemIdToToolIndex.set(event.item.id, toolCallIndex);
                }
                controller.enqueue(
                  encoder.encode(
                    makeChunk({
                      role: "assistant",
                      tool_calls: [
                        {
                          index: toolCallIndex,
                          id: callId,
                          function: { name, arguments: "" },
                          type: "function",
                        },
                      ],
                    })
                  )
                );
              } else if (
                type === "response.function_call_arguments.delta"
              ) {
                const idx =
                  itemIdToToolIndex.get(event.item_id) ?? toolCallIndex;
                controller.enqueue(
                  encoder.encode(
                    makeChunk({
                      tool_calls: [
                        {
                          index: idx,
                          function: { arguments: event.delta || "" },
                        },
                      ],
                    })
                  )
                );
              } else if (type === "response.completed") {
                const resp = event.response || {};
                const output = resp.output || [];
                const hasFunctionCall = output.some(
                  (o: any) => o.type === "function_call"
                );
                const incomplete = resp.incomplete_details?.reason;

                let finishReason = "stop";
                if (hasFunctionCall) finishReason = "tool_calls";
                else if (incomplete === "max_output_tokens")
                  finishReason = "length";

                const usage = resp.usage || {};
                const inputTokens = usage.input_tokens || 0;
                const outputTokens = usage.output_tokens || 0;
                const cachedTokens =
                  usage.input_tokens_details?.cached_tokens || 0;

                controller.enqueue(
                  encoder.encode(
                    makeChunk({}, finishReason, {
                      prompt_tokens: Math.max(inputTokens - cachedTokens, 0),
                      completion_tokens: outputTokens,
                      prompt_tokens_details: { cached_tokens: cachedTokens },
                    })
                  )
                );
                controller.enqueue(
                  encoder.encode("data: [DONE]\n\n")
                );
                isStreamEnded = true;
              } else if (type === "error") {
                const errMsg =
                  event.error?.message || event.message || "Unknown error";
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ error: { message: errMsg } })}\n\n`
                  )
                );
              }
            }
          }

          if (!isStreamEnded) {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          }
        } catch (error) {
          controller.error(error);
          return;
        } finally {
          try {
            reader.releaseLock();
          } catch {}
        }
        controller.close();
      },
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
