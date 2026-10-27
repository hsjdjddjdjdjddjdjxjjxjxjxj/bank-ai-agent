/**
 * 模型接入 adapter：OpenAI 兼容 baseUrl（本地 vLLM / Qwen / 云端 OpenAI 协议均可）。
 *
 * - 只读环境变量，密钥不进代码、不进仓库。
 * - 没配 PI_API_KEY 时返回 offline transport，整条链路走规则模式，不需要网络。
 * - 只有副1 会用到模型兜底；副2 从不引入本文件。
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
}

export interface ToolDecl {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelReply {
  content: string;
  toolCalls: Array<{ name: string; arguments: string }>;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

export interface Transport {
  readonly model: string;
  readonly available: boolean;
  readonly mode: "offline" | "online";
  readonly baseUrl: string;
  complete(messages: ChatMessage[], tools: ToolDecl[]): Promise<ModelReply>;
}

export interface TransportSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  mode: "offline" | "online";
}

/** 读环境变量。变量名与 README / 交付文档保持一致：PI_BASE_URL / PI_API_KEY / PI_MODEL。 */
export function readTransportSettings(env: Record<string, string | undefined> = process.env): TransportSettings {
  const apiKey = env.PI_API_KEY ?? "";
  const baseUrl = env.PI_BASE_URL ?? "http://127.0.0.1:8000/v1";
  const model = env.PI_MODEL ?? "qwen2.5-7b-instruct";
  const timeoutMs = Number(env.PI_TIMEOUT_MS ?? "20000");
  const forcedOffline = env.PI_OFFLINE === "1" || env.PI_OFFLINE === "true";
  const mode: "offline" | "online" = !forcedOffline && apiKey.trim() !== "" ? "online" : "offline";
  return {
    baseUrl,
    apiKey,
    model: mode === "online" ? model : "offline-rules",
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20000,
    mode
  };
}

/** 离线规则模式：永远返回空工具调用，副1 自动退回纯规则解析。 */
export function createOfflineTransport(): Transport {
  return {
    model: "offline-rules",
    available: false,
    mode: "offline",
    baseUrl: "",
    async complete(): Promise<ModelReply> {
      return { content: "", toolCalls: [], promptTokens: 0, completionTokens: 0, latencyMs: 0 };
    }
  };
}

/** HTTP transport：只用 fetch，不引 SDK，方便接行内 vLLM。 */
export function createHttpTransport(settings: TransportSettings): Transport {
  return {
    model: settings.model,
    available: settings.mode === "online",
    mode: settings.mode,
    baseUrl: settings.baseUrl,
    async complete(messages: ChatMessage[], tools: ToolDecl[]): Promise<ModelReply> {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
      try {
        const body: Record<string, unknown> = {
          model: settings.model,
          messages,
          temperature: 0,
          stream: false
        };
        if (tools.length > 0) {
          body.tools = tools.map((tool) => ({
            type: "function",
            function: { name: tool.name, description: tool.description, parameters: tool.parameters }
          }));
          body.tool_choice = "auto";
        }
        const response = await fetch(settings.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + settings.apiKey },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        if (!response.ok) throw new Error("模型返回 HTTP " + String(response.status));
        const payload = (await response.json()) as {
          choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const message = payload.choices?.[0]?.message ?? {};
        const rawCalls: unknown[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        const toolCalls = rawCalls.map((raw) => {
          const item = raw as { function?: { name?: unknown; arguments?: unknown } };
          return {
            name: typeof item.function?.name === "string" ? item.function.name : "",
            arguments: typeof item.function?.arguments === "string" ? item.function.arguments : "{}"
          };
        }).filter((call) => call.name !== "");
        return {
          content: typeof message.content === "string" ? message.content : "",
          toolCalls,
          promptTokens: payload.usage?.prompt_tokens ?? 0,
          completionTokens: payload.usage?.completion_tokens ?? 0,
          latencyMs: Date.now() - started
        };
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

/** 工厂：没密钥就是离线规则模式，不报错、不阻塞 demo。 */
export function createTransport(settings: TransportSettings): Transport {
  return settings.mode === "online" ? createHttpTransport(settings) : createOfflineTransport();
}
