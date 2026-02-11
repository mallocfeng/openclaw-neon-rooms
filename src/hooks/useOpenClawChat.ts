import { useCallback, useEffect, useRef, useState } from "react";
import {
  type GatewayEventFrame,
  type HelloOkPayload,
  OpenClawGatewayClient,
} from "../lib/openclawGateway";

type ConnectionState = "idle" | "connecting" | "connected" | "error";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
  streaming?: boolean;
  images?: ChatImageItem[];
};

export type ChatImageItem = {
  id: string;
  dataUrl: string;
  mimeType: string;
  fileName?: string;
};

export type AgentItem = {
  id: string;
  name: string;
  isDefault?: boolean;
};

export type OutboundAttachment = {
  fileName: string;
  mimeType: string;
  size: number;
  absolutePath: string;
  relativePath: string;
  imageDataUrl?: string;
};

type ChatEventPayload = {
  runId: string;
  sessionKey: string;
  state: "queued" | "running" | "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
};

type ChatHistoryResult = {
  messages?: unknown[];
};

type AgentsListResult = {
  defaultId?: string;
  agents?: unknown[];
};

type SessionsListResult = {
  sessions?: unknown[];
};

type SessionsResolveResult = {
  key?: string;
};

type ChatSendResult = {
  runId?: string;
  status?: string;
};

type AssistantReplyPreview = {
  text: string;
  createdAt: string;
  isError?: boolean;
  rawError?: string;
};

const DEFAULT_SCREEN_MESSAGE = "";
const IMAGE_SEND_MAX_DIMENSION_PX = 1600;
const IMAGE_SEND_TARGET_MAX_BYTES = 420 * 1024;
const IMAGE_SEND_HARD_MAX_BYTES = 640 * 1024;
const IMAGE_SEND_TOTAL_MAX_BYTES = 820 * 1024;
const INVALID_IMAGE_DATA_RE = /image data .* valid image/i;
const USE_IMAGE_BINARY_ATTACHMENTS = false;
const REQUEST_TIMEOUT_MS = 8000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseMaybeTimestamp(input: unknown): string | null {
  if (typeof input === "number" && Number.isFinite(input) && input > 0) {
    const millis = input < 1e12 ? input * 1000 : input;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof input === "string") {
    const text = input.trim();
    if (!text) {
      return null;
    }
    const asNumber = Number(text);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      const millis = asNumber < 1e12 ? asNumber * 1000 : asNumber;
      const date = new Date(millis);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function pickMessageCreatedAt(item: Record<string, unknown>): string {
  const candidates = [item.createdAt, item.created_at, item.timestamp, item.time, item.ts];
  for (const candidate of candidates) {
    const parsed = parseMaybeTimestamp(candidate);
    if (parsed) {
      return parsed;
    }
  }
  return nowIso();
}

function trimScreenText(input: string): string {
  const text = input.trim();
  if (!text) {
    return DEFAULT_SCREEN_MESSAGE;
  }
  if (text.length > 1200) {
    return `${text.slice(0, 1197)}...`;
  }
  return text;
}

function parseDataUrlToBase64(dataUrl: string): { mimeType: string; content: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl.trim());
  if (!match) {
    return null;
  }
  return {
    mimeType: match[1].trim().toLowerCase(),
    content: match[2].trim(),
  };
}

function toImageDataUrl(mimeType: string, content: string): string {
  return `data:${mimeType};base64,${content}`;
}

function toFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
}

function estimateBase64ByteLength(base64: string): number {
  const cleaned = base64.trim();
  if (!cleaned) {
    return 0;
  }
  let padding = 0;
  if (cleaned.endsWith("==")) {
    padding = 2;
  } else if (cleaned.endsWith("=")) {
    padding = 1;
  }
  return Math.max(0, Math.floor((cleaned.length * 3) / 4) - padding);
}

function estimateDataUrlByteLength(dataUrl: string): number {
  const parsed = parseDataUrlToBase64(dataUrl);
  if (!parsed) {
    return Number.POSITIVE_INFINITY;
  }
  return estimateBase64ByteLength(parsed.content);
}

function extractImageItems(content: unknown): ChatImageItem[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const items: ChatImageItem[] = [];
  const seen = new Set<string>();
  for (const entry of content) {
    if (!isRecord(entry)) {
      continue;
    }

    const type = typeof entry.type === "string" ? entry.type : "";
    let dataUrl: string | null = null;
    let mimeType = typeof entry.mimeType === "string" && entry.mimeType.trim() ? entry.mimeType.trim().toLowerCase() : "";
    const fileName = typeof entry.fileName === "string" && entry.fileName.trim() ? entry.fileName.trim() : undefined;

    if (type === "image") {
      if (typeof entry.data === "string" && entry.data.trim()) {
        dataUrl = toImageDataUrl(mimeType || "image/png", entry.data.trim());
      } else if (typeof entry.url === "string" && entry.url.trim()) {
        dataUrl = entry.url.trim();
      }
    } else if (type === "input_image") {
      if (isRecord(entry.source)) {
        const sourceType = typeof entry.source.type === "string" ? entry.source.type : "";
        if (sourceType === "base64" && typeof entry.source.data === "string" && entry.source.data.trim()) {
          const sourceMimeType =
            typeof entry.source.media_type === "string" && entry.source.media_type.trim()
              ? entry.source.media_type.trim().toLowerCase()
              : mimeType;
          dataUrl = toImageDataUrl(sourceMimeType || "image/png", entry.source.data.trim());
          mimeType = sourceMimeType || mimeType;
        } else if (sourceType === "url" && typeof entry.source.url === "string" && entry.source.url.trim()) {
          dataUrl = entry.source.url.trim();
          if (typeof entry.source.media_type === "string" && entry.source.media_type.trim()) {
            mimeType = entry.source.media_type.trim().toLowerCase();
          }
        }
      }
    }

    if (!dataUrl) {
      continue;
    }

    if (!mimeType && dataUrl.startsWith("data:")) {
      const parsed = parseDataUrlToBase64(dataUrl);
      if (parsed?.mimeType) {
        mimeType = parsed.mimeType;
      }
    }
    const normalizedMimeType = mimeType || "image/png";

    const uniqueKey = `${normalizedMimeType}:${dataUrl}`;
    if (seen.has(uniqueKey)) {
      continue;
    }
    seen.add(uniqueKey);
    items.push({
      id: createId(),
      dataUrl,
      mimeType: normalizedMimeType,
      fileName,
    });
  }

  return items;
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片解码失败"));
    image.src = dataUrl;
  });
}

async function normalizeImageDataUrlForGateway(dataUrl: string): Promise<string> {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return dataUrl;
  }

  const originalSize = estimateDataUrlByteLength(dataUrl);
  if (Number.isFinite(originalSize) && originalSize <= IMAGE_SEND_TARGET_MAX_BYTES) {
    return dataUrl;
  }

  const source = await loadImage(dataUrl);
  const sourceWidth = source.naturalWidth || source.width || 1;
  const sourceHeight = source.naturalHeight || source.height || 1;
  const maxDimension = Math.max(sourceWidth, sourceHeight) || 1;
  const dimensionCandidates = [1, 0.86, 0.74, 0.62, 0.5];
  const qualityCandidates = [0.86, 0.78, 0.7, 0.62, 0.54, 0.46];

  let bestDataUrl = dataUrl;
  let bestSize = originalSize;

  for (const dimensionScale of dimensionCandidates) {
    const limit = IMAGE_SEND_MAX_DIMENSION_PX * dimensionScale;
    const scale = maxDimension > limit ? limit / maxDimension : 1;
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      continue;
    }

    // Flatten alpha to white for JPEG output.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(source, 0, 0, width, height);

    for (const quality of qualityCandidates) {
      const candidate = canvas.toDataURL("image/jpeg", quality);
      const size = estimateDataUrlByteLength(candidate);
      if (size < bestSize) {
        bestSize = size;
        bestDataUrl = candidate;
      }
      if (size <= IMAGE_SEND_TARGET_MAX_BYTES) {
        return candidate;
      }
    }
  }

  if (bestSize <= IMAGE_SEND_HARD_MAX_BYTES) {
    return bestDataUrl;
  }

  return bestDataUrl;
}

function extractText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => extractText(entry)).filter(Boolean).join("\n");
  }
  if (isRecord(value)) {
    if (typeof value.text === "string") {
      return value.text;
    }
    if (typeof value.message === "string") {
      return value.message;
    }
    if (typeof value.content === "string") {
      return value.content;
    }
    if (Array.isArray(value.content)) {
      return extractText(value.content);
    }
    if (Array.isArray(value.parts)) {
      return extractText(value.parts);
    }
    if (Array.isArray(value.blocks)) {
      return extractText(value.blocks);
    }
  }
  return "";
}

function parseChatEvent(payload: unknown): ChatEventPayload | null {
  if (!isRecord(payload)) {
    return null;
  }

  const runId = payload.runId;
  const sessionKey = payload.sessionKey;
  const state = payload.state;
  if (
    typeof runId !== "string" ||
    typeof sessionKey !== "string" ||
    (state !== "queued" &&
      state !== "running" &&
      state !== "delta" &&
      state !== "final" &&
      state !== "aborted" &&
      state !== "error")
  ) {
    return null;
  }

  return {
    runId,
    sessionKey,
    state,
    message: payload.message,
    errorMessage: typeof payload.errorMessage === "string" ? payload.errorMessage : undefined,
  };
}

function normalizeGatewayErrorMessage(message: string): string {
  const normalized = message.trim();
  if (!normalized) {
    return "模型返回错误，请稍后重试。";
  }
  if (INVALID_IMAGE_DATA_RE.test(normalized)) {
    return "图片内容解析失败，请重试：优先使用截图/PNG/JPEG，或换一张图后再发。";
  }
  return normalized;
}

function extractAssistantMessageSummary(item: Record<string, unknown>): AssistantReplyPreview | null {
  const text = extractText(item.content ?? item.message).trim();
  const createdAt = pickMessageCreatedAt(item);
  if (text) {
    return {
      text,
      createdAt,
    };
  }

  const stopReason = typeof item.stopReason === "string" ? item.stopReason.trim().toLowerCase() : "";
  const rawError = typeof item.errorMessage === "string" ? item.errorMessage : "";
  if (rawError.trim() || stopReason === "error") {
    const normalizedError = normalizeGatewayErrorMessage(rawError || "模型返回错误，请稍后重试。");
    return {
      text: `错误: ${normalizedError}`,
      createdAt,
      isError: true,
      rawError: rawError || normalizedError,
    };
  }

  return null;
}

function pickSessionKey(hello: HelloOkPayload): string {
  const defaults = hello.snapshot?.sessionDefaults;
  if (!defaults) {
    return "main";
  }
  if (typeof defaults.mainSessionKey === "string" && defaults.mainSessionKey.trim()) {
    return defaults.mainSessionKey.trim();
  }
  if (typeof defaults.mainKey === "string" && defaults.mainKey.trim()) {
    return defaults.mainKey.trim();
  }
  return "main";
}

function extractAssistantFromHistory(messages: unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (!isRecord(candidate)) {
      continue;
    }
    const role = typeof candidate.role === "string" ? candidate.role : "";
    if (role !== "assistant") {
      continue;
    }
    const summary = extractAssistantMessageSummary(candidate);
    if (summary?.text.trim()) {
      return summary.text.trim();
    }
  }
  return null;
}

function extractLatestAssistantReply(messages: unknown[]): AssistantReplyPreview | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (!isRecord(candidate)) {
      continue;
    }
    const role = typeof candidate.role === "string" ? candidate.role : "";
    if (role !== "assistant") {
      continue;
    }
    const summary = extractAssistantMessageSummary(candidate);
    if (summary) {
      return summary;
    }
  }
  return null;
}

function pickLatestAssistantText(messages: ChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") {
      continue;
    }
    const text = message.text.trim();
    if (!text || text === "正在思考...") {
      continue;
    }
    return text;
  }
  return null;
}

function parseSessionAgentId(sessionKey: string): string | null {
  const match = /^agent:([^:]+):/.exec(sessionKey.trim());
  return match?.[1] ?? null;
}

async function requestWithTimeout<T>(
  client: OpenClawGatewayClient,
  method: string,
  params?: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`${method} 请求超时`));
    }, timeoutMs);

    client
      .request<T>(method, params)
      .then((result) => {
        window.clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        window.clearTimeout(timer);
        reject(error);
      });
  });
}

function extractAgentItems(result: AgentsListResult): AgentItem[] {
  const rawAgents = Array.isArray(result.agents) ? result.agents : [];
  const defaultId = typeof result.defaultId === "string" ? result.defaultId : null;
  const list: AgentItem[] = [];

  for (const candidate of rawAgents) {
    if (!isRecord(candidate)) {
      continue;
    }
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    if (!id) {
      continue;
    }

    let name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    if (!name && isRecord(candidate.identity) && typeof candidate.identity.name === "string") {
      name = candidate.identity.name.trim();
    }
    if (!name) {
      name = id;
    }

    list.push({
      id,
      name,
      isDefault: defaultId === id,
    });
  }

  return list;
}

function mapHistoryToChatMessages(messages: unknown[]): ChatMessage[] {
  const mapped: ChatMessage[] = [];
  for (const item of messages) {
    if (!isRecord(item)) {
      continue;
    }
    const role = typeof item.role === "string" ? item.role : "";
    const assistantSummary = role === "assistant" ? extractAssistantMessageSummary(item) : null;
    const text = assistantSummary?.text ?? extractText(item.content ?? item.message).trim();
    const images = extractImageItems(item.content ?? item.message);
    const normalizedText = text || (images.length > 0 ? "[图片消息]" : "");
    if (!normalizedText && images.length === 0) {
      continue;
    }
    if (role === "user" || role === "assistant") {
      mapped.push({
        id: createId(),
        role,
        text: normalizedText,
        createdAt: pickMessageCreatedAt(item),
        images: role === "user" ? images : [],
      });
    }
  }
  return mapped;
}

function extractAgentModelMap(result: SessionsListResult, defaultAgentId: string | null): Record<string, string> {
  const map: Record<string, string> = {};
  const sessions = Array.isArray(result.sessions) ? result.sessions : [];

  for (const session of sessions) {
    if (!isRecord(session)) {
      continue;
    }
    const key = typeof session.key === "string" ? session.key.trim() : "";
    const model = typeof session.model === "string" ? session.model.trim() : "";
    if (!model) {
      continue;
    }
    const provider = typeof session.modelProvider === "string" ? session.modelProvider.trim() : "";
    const modelLabel = provider ? `${provider}/${model}` : model;

    let agentId = parseSessionAgentId(key);
    if (!agentId && defaultAgentId && key === "main") {
      agentId = defaultAgentId;
    }
    if (!agentId) {
      continue;
    }

    if (!map[agentId]) {
      map[agentId] = modelLabel;
    }
  }

  return map;
}

export function useOpenClawChat(defaultUrl: string, defaultToken: string) {
  const [gatewayUrl, setGatewayUrl] = useState(defaultUrl);
  const [token, setToken] = useState(defaultToken);
  const [status, setStatus] = useState<ConnectionState>("idle");
  const [lastError, setLastError] = useState<string | null>(null);
  const [screenText, setScreenText] = useState(DEFAULT_SCREEN_MESSAGE);
  const [sessionKey, setSessionKey] = useState("main");
  const [lastPrompt, setLastPrompt] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [agentModels, setAgentModels] = useState<Record<string, string>>({});
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentSwitching, setAgentSwitching] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "system",
      text: "连接 Gateway 后开始问答。",
      createdAt: nowIso(),
    },
  ]);

  const clientRef = useRef<OpenClawGatewayClient | null>(null);
  const unsubscribeEventsRef = useRef<(() => void) | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const activeAssistantMessageIdRef = useRef<string | null>(null);
  const activeAgentIdRef = useRef<string | null>(null);
  const sessionKeyRef = useRef("main");
  const mainSessionKeyRef = useRef("main");
  const streamingTextRef = useRef("");
  const imageErrorRecoveredSessionRef = useRef<string | null>(null);
  const historyFallbackTimerRef = useRef<number | null>(null);
  const historyFallbackTokenRef = useRef(0);
  const chatMessagesRef = useRef<ChatMessage[]>(chatMessages);

  useEffect(() => {
    chatMessagesRef.current = chatMessages;
  }, [chatMessages]);

  useEffect(() => {
    activeAgentIdRef.current = activeAgentId;
  }, [activeAgentId]);

  const stopHistoryFallback = useCallback(() => {
    if (historyFallbackTimerRef.current !== null) {
      window.clearTimeout(historyFallbackTimerRef.current);
      historyFallbackTimerRef.current = null;
    }
    historyFallbackTokenRef.current += 1;
  }, []);

  const tearDownClient = useCallback(() => {
    stopHistoryFallback();
    if (unsubscribeEventsRef.current) {
      unsubscribeEventsRef.current();
      unsubscribeEventsRef.current = null;
    }
    if (clientRef.current) {
      clientRef.current.stop();
      clientRef.current = null;
    }
  }, [stopHistoryFallback]);

  const disconnect = useCallback(() => {
    activeRunIdRef.current = null;
    activeAssistantMessageIdRef.current = null;
    streamingTextRef.current = "";
    setIsStreaming(false);
    setActiveAgentId(null);
    tearDownClient();
    setStatus("idle");
    setSessionKey(mainSessionKeyRef.current);
    sessionKeyRef.current = mainSessionKeyRef.current;
  }, [tearDownClient]);

  const loadConversationForSession = useCallback(async (client: OpenClawGatewayClient, key: string) => {
    try {
      const history = await requestWithTimeout<ChatHistoryResult>(client, "chat.history", {
        sessionKey: key,
        limit: 20,
      }, 6000);
      const messages = Array.isArray(history.messages) ? history.messages : [];
      const mapped = mapHistoryToChatMessages(messages);
      setChatMessages(
        mapped.length > 0
          ? mapped
          : [
              {
                id: createId(),
                role: "system",
                text: "当前会话暂无消息，发送第一条指令开始。",
                createdAt: nowIso(),
              },
            ],
      );
      const latest = extractAssistantFromHistory(messages);
      if (latest) {
        setScreenText(trimScreenText(latest));
      } else {
        setScreenText("");
      }
    } catch {
      setChatMessages([
        {
          id: createId(),
          role: "system",
          text: "读取会话历史失败，请直接发送指令。",
          createdAt: nowIso(),
        },
      ]);
    }
  }, []);

  const refreshAgentList = useCallback(
    async (client: OpenClawGatewayClient, currentSessionKey: string) => {
      setAgentsLoading(true);
      try {
        const result = await requestWithTimeout<AgentsListResult>(client, "agents.list", {}, 6000);
        const list = extractAgentItems(result);
        setAgents(list);
        const defaultAgentId = typeof result.defaultId === "string" ? result.defaultId : null;

        try {
          const sessionsResult = await requestWithTimeout<SessionsListResult>(client, "sessions.list", {
            includeGlobal: false,
            includeUnknown: false,
            limit: 500,
          }, 6000);
          setAgentModels(extractAgentModelMap(sessionsResult, defaultAgentId));
        } catch {
          setAgentModels({});
        }

        const fromSession = parseSessionAgentId(currentSessionKey);
        if (fromSession) {
          setActiveAgentId(fromSession);
          return;
        }
        const defaultAgent = list.find((item) => item.isDefault) ?? list[0];
        setActiveAgentId(defaultAgent?.id ?? null);
      } catch {
        setAgents([]);
        setAgentModels({});
        setActiveAgentId(null);
      } finally {
        setAgentsLoading(false);
      }
    },
    [],
  );

  const recoverSessionFromImageError = useCallback(
    async (client: OpenClawGatewayClient) => {
      void client;
      const currentSessionKey = sessionKeyRef.current;
      if (imageErrorRecoveredSessionRef.current === currentSessionKey) {
        return;
      }
      imageErrorRecoveredSessionRef.current = currentSessionKey;
      const agentId = parseSessionAgentId(currentSessionKey) ?? activeAgentId ?? "main";
      const nextSessionKey = `agent:${agentId}:main:webui-${Date.now()}`;
      if (agentId === "main") {
        mainSessionKeyRef.current = nextSessionKey;
      }
      setSessionKey(nextSessionKey);
      sessionKeyRef.current = nextSessionKey;
      activeRunIdRef.current = null;
      activeAssistantMessageIdRef.current = null;
      streamingTextRef.current = "";
      setIsStreaming(false);
      setScreenText("");
      setChatMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "system",
          text: "检测到图片上下文异常，已自动切换到新会话。请重新发送图片。",
          createdAt: nowIso(),
        },
      ]);
    },
    [activeAgentId],
  );

  const connect = useCallback(async () => {
    tearDownClient();
    setStatus("connecting");
    setLastError(null);
    setIsStreaming(false);
    activeRunIdRef.current = null;
    streamingTextRef.current = "";

    const nextClient = new OpenClawGatewayClient({
      url: gatewayUrl.trim() || "ws://127.0.0.1:18789",
      token: token.trim() || undefined,
      onHello: (hello) => {
        if (clientRef.current !== nextClient) {
          return;
        }
        const nextSessionKey = pickSessionKey(hello);
        mainSessionKeyRef.current = nextSessionKey;
        setSessionKey(nextSessionKey);
        sessionKeyRef.current = nextSessionKey;
        setStatus("connected");
        void Promise.all([
          loadConversationForSession(nextClient, nextSessionKey),
          refreshAgentList(nextClient, nextSessionKey),
        ]);
      },
      onClose: (code, reason) => {
        if (clientRef.current !== nextClient) {
          return;
        }
        activeRunIdRef.current = null;
        activeAssistantMessageIdRef.current = null;
        streamingTextRef.current = "";
        setIsStreaming(false);
        if (code === 1000) {
          setStatus("idle");
          return;
        }
        setStatus("error");
        setLastError(`连接关闭 (${code}): ${reason || "no reason"}`);
      },
      onError: (error) => {
        if (clientRef.current !== nextClient) {
          return;
        }
        setStatus("error");
        setLastError(error.message);
      },
    });

    unsubscribeEventsRef.current = nextClient.onEvent((event: GatewayEventFrame) => {
      if (event.event !== "chat") {
        return;
      }
      const payload = parseChatEvent(event.payload);
      if (!payload) {
        return;
      }

      const activeRunId = activeRunIdRef.current;
      if (activeRunId) {
        // One in-flight request at a time: accept first chat event as authoritative,
        // even when gateway canonicalizes sessionKey or rewrites runId.
        if (payload.runId !== activeRunId) {
          activeRunIdRef.current = payload.runId;
        }
        if (payload.sessionKey !== sessionKeyRef.current) {
          setSessionKey(payload.sessionKey);
          sessionKeyRef.current = payload.sessionKey;
        }
      } else if (payload.sessionKey !== sessionKeyRef.current) {
        return;
      }

      if (payload.state === "delta") {
        stopHistoryFallback();
        const next = extractText(payload.message);
        if (!next) {
          return;
        }
        if (next.length >= streamingTextRef.current.length) {
          streamingTextRef.current = next;
          setScreenText(trimScreenText(next));
          setIsStreaming(true);
          const assistantId = activeAssistantMessageIdRef.current;
          if (!assistantId) {
            return;
          }
          setChatMessages((current) =>
            current.map((message) =>
              message.id === assistantId
                ? {
                    ...message,
                    text: next,
                    streaming: true,
                  }
                : message,
            ),
          );
        }
        return;
      }

      if (payload.state === "queued" || payload.state === "running") {
        setIsStreaming(true);
        return;
      }

      if (payload.state === "final") {
        const finalText = extractText(payload.message) || streamingTextRef.current;
        activeRunIdRef.current = null;
        streamingTextRef.current = "";
        const assistantId = activeAssistantMessageIdRef.current;
        if (finalText.trim()) {
          stopHistoryFallback();
          setIsStreaming(false);
          activeAssistantMessageIdRef.current = null;
          setLastError(null);
          setScreenText(trimScreenText(finalText));
          if (assistantId) {
            setChatMessages((current) =>
              current.map((message) =>
                message.id === assistantId
                  ? {
                      ...message,
                      text: finalText,
                      streaming: false,
                    }
                  : message,
              ),
            );
          }
        } else {
          // Keep waiting: some gateways emit `final` before history is materialized.
          // The existing history fallback poll started in sendPrompt will continue.
          if (!assistantId) {
            setIsStreaming(false);
            void loadConversationForSession(nextClient, sessionKeyRef.current);
          }
        }
        return;
      }

      if (payload.state === "aborted") {
        stopHistoryFallback();
        activeRunIdRef.current = null;
        const assistantId = activeAssistantMessageIdRef.current;
        activeAssistantMessageIdRef.current = null;
        streamingTextRef.current = "";
        setIsStreaming(false);
        setScreenText("本次运行已终止。");
        if (assistantId) {
          setChatMessages((current) =>
            current.map((message) =>
              message.id === assistantId
                ? {
                    ...message,
                    text: "本次运行已终止。",
                    streaming: false,
                  }
                : message,
            ),
          );
        }
        return;
      }

      stopHistoryFallback();
      activeRunIdRef.current = null;
      const assistantId = activeAssistantMessageIdRef.current;
      activeAssistantMessageIdRef.current = null;
      streamingTextRef.current = "";
      setIsStreaming(false);
      const rawErrorMessage = payload.errorMessage ?? "chat error";
      const normalizedErrorMessage = normalizeGatewayErrorMessage(rawErrorMessage);
      setLastError(normalizedErrorMessage);
      const errorText = `错误: ${normalizedErrorMessage}`;
      setScreenText(trimScreenText(errorText));
      if (assistantId) {
        setChatMessages((current) =>
          current.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  text: errorText,
                  streaming: false,
                }
              : message,
          ),
        );
      }
      if (INVALID_IMAGE_DATA_RE.test(rawErrorMessage)) {
        void recoverSessionFromImageError(nextClient);
      }
    });

    clientRef.current = nextClient;
    nextClient.start();
  }, [gatewayUrl, loadConversationForSession, recoverSessionFromImageError, refreshAgentList, stopHistoryFallback, tearDownClient, token]);

  const sendPrompt = useCallback(
    async (prompt: string, attachments?: OutboundAttachment[]): Promise<boolean> => {
      const client = clientRef.current;
      const message = prompt.trim();
      const safeAttachments = Array.isArray(attachments) ? attachments : [];
      const imageAttachments: Array<{
        attachment: OutboundAttachment;
        payload: { type: "image"; mimeType: string; content: string; fileName: string };
        image: ChatImageItem;
      }> = [];
      let imageBytesTotal = 0;
      let droppedImageCount = 0;
      for (const attachment of safeAttachments) {
        if (!attachment.imageDataUrl) {
          continue;
        }
        let dataUrl = attachment.imageDataUrl;
        try {
          dataUrl = await normalizeImageDataUrlForGateway(dataUrl);
        } catch {
          dataUrl = attachment.imageDataUrl;
        }
        const parsed = parseDataUrlToBase64(dataUrl);
        if (!parsed) {
          continue;
        }
        const mimeType = parsed.mimeType || attachment.mimeType || "image/png";
        const normalizedDataUrl = toImageDataUrl(mimeType, parsed.content);
        const imageBytes = estimateBase64ByteLength(parsed.content);
        if (
          imageBytesTotal + imageBytes > IMAGE_SEND_TOTAL_MAX_BYTES &&
          imageAttachments.length > 0
        ) {
          droppedImageCount += 1;
          continue;
        }
        imageBytesTotal += imageBytes;
        imageAttachments.push({
          attachment,
          payload: {
            type: "image",
            mimeType,
            content: parsed.content,
            fileName: attachment.fileName,
          },
          image: {
            id: createId(),
            dataUrl: normalizedDataUrl,
            mimeType,
            fileName: attachment.fileName,
          },
        });
      }

      const imagePathSet = new Set(imageAttachments.map((item) => item.attachment.relativePath));
      const formatAttachmentLocation = (attachment: OutboundAttachment) => {
        const absolutePath = (attachment.absolutePath || "").trim();
        if (absolutePath) {
          return `${absolutePath} (${toFileUrl(absolutePath)})`;
        }
        return attachment.relativePath;
      };
      const fileNotes = safeAttachments
        .map(
          (attachment) =>
            `- ${imagePathSet.has(attachment.relativePath) ? "[图片]" : "[文件]"} ${attachment.fileName} (${attachment.mimeType || "application/octet-stream"}) -> ${formatAttachmentLocation(attachment)}`,
        )
        .join("\n");
      const messageWithAttachmentNotes = fileNotes
        ? `${message}\n\n附件（已保存到项目目录）:\n${fileNotes}`.trim()
        : message;
      const finalMessage = messageWithAttachmentNotes || (imageAttachments.length > 0 ? "请结合我上传的图片回答。" : "");
      if (!finalMessage) {
        return false;
      }
      if (!client || status !== "connected") {
        setLastError("Gateway 未连接，请先建立连接。");
        return false;
      }
      if (activeRunIdRef.current) {
        setLastError("已有进行中的请求，请等待当前回复完成。");
        return false;
      }
      const currentSessionKey = sessionKeyRef.current;
      const preferredSessionKey = currentSessionKey;
      const historySessionKeys = Array.from(
        new Set(
          activeAgentId === "main"
            ? [currentSessionKey, mainSessionKeyRef.current, "main", "agent:main:main"]
            : [currentSessionKey, mainSessionKeyRef.current],
        ),
      );

      const idempotencyKey = createId();
      const assistantMessageId = createId();
      const createdAt = nowIso();
      const sendStartedAtMs = Date.parse(createdAt);
      const baselineAssistantText = pickLatestAssistantText(chatMessagesRef.current);
      // Temporary in-flight marker before gateway returns actual runId.
      activeRunIdRef.current = idempotencyKey;
      activeAssistantMessageIdRef.current = assistantMessageId;
      streamingTextRef.current = "";
      setIsStreaming(true);
      setLastError(droppedImageCount > 0 ? `已自动跳过 ${droppedImageCount} 张超大图片。` : null);
      setLastPrompt(finalMessage);
      setScreenText("");
      const userDisplayText = message;
      setChatMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "user",
          text: userDisplayText,
          createdAt,
          images: imageAttachments.map((item) => item.image),
        },
        { id: assistantMessageId, role: "assistant", text: "正在思考...", createdAt, streaming: true },
      ]);

      try {
        if (preferredSessionKey !== currentSessionKey) {
          setSessionKey(preferredSessionKey);
          sessionKeyRef.current = preferredSessionKey;
        }
        const sendResult = await requestWithTimeout<ChatSendResult>(client, "chat.send", {
          sessionKey: preferredSessionKey,
          message: finalMessage,
          attachments:
            USE_IMAGE_BINARY_ATTACHMENTS && imageAttachments.length > 0
              ? imageAttachments.map((item) => item.payload)
              : undefined,
          deliver: true,
          idempotencyKey,
        });
        if (isRecord(sendResult) && typeof sendResult.runId === "string" && sendResult.runId.trim()) {
          activeRunIdRef.current = sendResult.runId.trim();
        }
        stopHistoryFallback();
        const fallbackToken = historyFallbackTokenRef.current + 1;
        historyFallbackTokenRef.current = fallbackToken;
        const pollHistory = async (attempt: number) => {
          if (historyFallbackTokenRef.current !== fallbackToken) {
            return;
          }
          if (!clientRef.current || status !== "connected") {
            return;
          }
          const activeAssistantId = activeAssistantMessageIdRef.current;
          if (activeAssistantId !== assistantMessageId) {
            return;
          }
          for (const historySessionKey of historySessionKeys) {
            try {
              const history = await requestWithTimeout<ChatHistoryResult>(client, "chat.history", {
                sessionKey: historySessionKey,
                limit: 20,
              }, 5000);
              const messages = Array.isArray(history.messages) ? history.messages : [];
              const latestAssistant = extractLatestAssistantReply(messages);
              if (!latestAssistant) {
                continue;
              }
              const latestMs = Date.parse(latestAssistant.createdAt);
              const isLikelyNewByTime =
                Number.isFinite(latestMs) &&
                Number.isFinite(sendStartedAtMs) &&
                latestMs >= sendStartedAtMs - 1500;
              const isLikelyNewByText =
                baselineAssistantText === null || latestAssistant.text.trim() !== baselineAssistantText.trim();
              if (!(isLikelyNewByTime || isLikelyNewByText)) {
                continue;
              }
              stopHistoryFallback();
              activeRunIdRef.current = null;
              activeAssistantMessageIdRef.current = null;
              streamingTextRef.current = "";
              setIsStreaming(false);
              setScreenText(trimScreenText(latestAssistant.text));
              if (latestAssistant.isError) {
                setLastError(latestAssistant.text.replace(/^错误:\s*/, ""));
              } else {
                setLastError(null);
              }
              if (historySessionKey !== sessionKeyRef.current) {
                setSessionKey(historySessionKey);
                sessionKeyRef.current = historySessionKey;
              }
              setChatMessages((current) =>
                current.map((item) =>
                  item.id === assistantMessageId
                    ? {
                        ...item,
                        text: latestAssistant.text,
                        createdAt: latestAssistant.createdAt,
                        streaming: false,
                      }
                    : item,
                ),
              );
              if (latestAssistant.rawError && INVALID_IMAGE_DATA_RE.test(latestAssistant.rawError)) {
                void recoverSessionFromImageError(client);
              }
              return;
            } catch {
              // Ignore transient history fetch failures; next round may recover.
            }
          }

          if (attempt >= 20) {
            stopHistoryFallback();
            activeRunIdRef.current = null;
            activeAssistantMessageIdRef.current = null;
            streamingTextRef.current = "";
            setIsStreaming(false);
            const timeoutText =
              activeAgentId === "main"
                ? "请求超时：main 房间未收到回复（已尝试主会话和 agent:main:main）。请重连后再试。"
                : "请求超时：未收到回复，请重连后再试。";
            setLastError(timeoutText);
            setScreenText(trimScreenText(timeoutText));
            setChatMessages((current) =>
              current.map((item) =>
                item.id === assistantMessageId
                  ? {
                      ...item,
                      text: timeoutText,
                      streaming: false,
                    }
                  : item,
              ),
            );
            return;
          }
          historyFallbackTimerRef.current = window.setTimeout(() => {
            void pollHistory(attempt + 1);
          }, 1200);
        };
        historyFallbackTimerRef.current = window.setTimeout(() => {
          void pollHistory(1);
        }, 1600);
        return true;
      } catch (error) {
        stopHistoryFallback();
        activeRunIdRef.current = null;
        activeAssistantMessageIdRef.current = null;
        streamingTextRef.current = "";
        setIsStreaming(false);
        const messageText = error instanceof Error ? error.message : String(error);
        setLastError(messageText);
        setScreenText(trimScreenText(`请求失败: ${messageText}`));
        setChatMessages((current) =>
          current.map((item) =>
            item.id === assistantMessageId
              ? {
                  ...item,
                  text: `请求失败: ${messageText}`,
                  streaming: false,
                }
              : item,
          ),
        );
        return false;
      }
    },
    [activeAgentId, recoverSessionFromImageError, status, stopHistoryFallback],
  );

  const cancelPending = useCallback((reason?: string) => {
    const finalReason = (reason ?? "已手动停止等待。").trim() || "已手动停止等待。";
    stopHistoryFallback();
    activeRunIdRef.current = null;
    const assistantId = activeAssistantMessageIdRef.current;
    activeAssistantMessageIdRef.current = null;
    streamingTextRef.current = "";
    setIsStreaming(false);
    setLastError(finalReason);
    setScreenText(trimScreenText(finalReason));
    if (assistantId) {
      setChatMessages((current) =>
        current.map((item) =>
          item.id === assistantId
            ? {
                ...item,
                text: finalReason,
                streaming: false,
              }
            : item,
        ),
      );
    }
  }, [stopHistoryFallback]);

  const switchAgent = useCallback(
    async (agentId: string): Promise<boolean> => {
      const client = clientRef.current;
      const nextAgentId = agentId.trim();
      if (!client || !nextAgentId) {
        return false;
      }
      if (status !== "connected") {
        setLastError("Gateway 未连接，请先连接后再切换 Agent。");
        return false;
      }
      if (activeRunIdRef.current) {
        stopHistoryFallback();
        activeRunIdRef.current = null;
        const assistantId = activeAssistantMessageIdRef.current;
        activeAssistantMessageIdRef.current = null;
        streamingTextRef.current = "";
        setIsStreaming(false);
        if (assistantId) {
          setChatMessages((current) =>
            current.map((message) =>
              message.id === assistantId
                ? {
                    ...message,
                    text: "已停止当前回复，正在切换房间...",
                    streaming: false,
                  }
                : message,
            ),
          );
        }
      }
      const currentActiveAgentId = activeAgentIdRef.current;
      const currentSessionAgentId = parseSessionAgentId(sessionKeyRef.current);
      const isMainLikeCurrentSession =
        sessionKeyRef.current === mainSessionKeyRef.current ||
        sessionKeyRef.current === "main" ||
        currentSessionAgentId === "main";
      const alreadyInTargetSession =
        currentSessionAgentId === nextAgentId ||
        (nextAgentId === "main" && isMainLikeCurrentSession);
      if (nextAgentId === currentActiveAgentId && alreadyInTargetSession) {
        return true;
      }

      setAgentSwitching(true);
      setLastError(null);
      try {
        let nextSessionKey = "";
        if (nextAgentId === "main") {
          const mainCandidates = Array.from(new Set([mainSessionKeyRef.current, "main", "agent:main:main"])).filter((value) =>
            Boolean(value && value.trim()),
          );
          for (const candidate of mainCandidates) {
            try {
              const resolved = await requestWithTimeout<SessionsResolveResult>(client, "sessions.resolve", {
                key: candidate,
                includeGlobal: true,
              });
              if (typeof resolved.key === "string" && resolved.key.trim()) {
                nextSessionKey = resolved.key.trim();
                break;
              }
            } catch {
              // Try next candidate.
            }
          }
          if (!nextSessionKey) {
            nextSessionKey = mainCandidates[0] ?? "main";
          }
        } else {
          const requestedSessionKey = `agent:${nextAgentId}:main`;
          nextSessionKey = requestedSessionKey;
          try {
            const resolved = await requestWithTimeout<SessionsResolveResult>(client, "sessions.resolve", {
              key: requestedSessionKey,
              includeGlobal: true,
            });
            if (typeof resolved.key === "string" && resolved.key.trim()) {
              nextSessionKey = resolved.key.trim();
            }
          } catch {
            nextSessionKey = requestedSessionKey;
          }
        }
        setActiveAgentId(nextAgentId);
        setSessionKey(nextSessionKey);
        sessionKeyRef.current = nextSessionKey;
        imageErrorRecoveredSessionRef.current = null;
        activeRunIdRef.current = null;
        activeAssistantMessageIdRef.current = null;
        streamingTextRef.current = "";
        setIsStreaming(false);
        setLastPrompt("");
        setScreenText("");
        setChatMessages([
          {
            id: createId(),
            role: "system",
            text: `已切换到 Agent: ${nextAgentId}`,
            createdAt: nowIso(),
          },
        ]);
        await loadConversationForSession(client, nextSessionKey);
        return true;
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        setLastError(`切换 Agent 失败: ${messageText}`);
        return false;
      } finally {
        setAgentSwitching(false);
      }
    },
    [loadConversationForSession, status, stopHistoryFallback],
  );

  return {
    gatewayUrl,
    setGatewayUrl,
    token,
    setToken,
    status,
    lastError,
    screenText,
    sessionKey,
    lastPrompt,
    isStreaming,
    agents,
    agentModels,
    activeAgentId,
    agentsLoading,
    agentSwitching,
    chatMessages,
    connect,
    disconnect,
    cancelPending,
    sendPrompt,
    switchAgent,
  };
}
