import { useCallback, useRef, useState } from "react";
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
  state: "delta" | "final" | "aborted" | "error";
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

const DEFAULT_SCREEN_MESSAGE = "";
const IMAGE_SEND_MAX_DIMENSION_PX = 2048;
const INVALID_IMAGE_DATA_RE = /image data .* valid image/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

  const source = await loadImage(dataUrl);
  const sourceWidth = source.naturalWidth || source.width || 1;
  const sourceHeight = source.naturalHeight || source.height || 1;
  const maxDimension = Math.max(sourceWidth, sourceHeight);
  const scale = maxDimension > IMAGE_SEND_MAX_DIMENSION_PX ? IMAGE_SEND_MAX_DIMENSION_PX / maxDimension : 1;
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return dataUrl;
  }
  ctx.drawImage(source, 0, 0, width, height);
  return canvas.toDataURL("image/png");
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
    (state !== "delta" && state !== "final" && state !== "aborted" && state !== "error")
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
    const text = extractText(candidate.content ?? candidate.message);
    if (text.trim()) {
      return text.trim();
    }
  }
  return null;
}

function parseSessionAgentId(sessionKey: string): string | null {
  const match = /^agent:([^:]+):/.exec(sessionKey.trim());
  return match?.[1] ?? null;
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
    const text = extractText(item.content ?? item.message).trim();
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
    },
  ]);

  const clientRef = useRef<OpenClawGatewayClient | null>(null);
  const unsubscribeEventsRef = useRef<(() => void) | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const activeAssistantMessageIdRef = useRef<string | null>(null);
  const sessionKeyRef = useRef("main");
  const streamingTextRef = useRef("");

  const tearDownClient = useCallback(() => {
    if (unsubscribeEventsRef.current) {
      unsubscribeEventsRef.current();
      unsubscribeEventsRef.current = null;
    }
    if (clientRef.current) {
      clientRef.current.stop();
      clientRef.current = null;
    }
  }, []);

  const disconnect = useCallback(() => {
    activeRunIdRef.current = null;
    activeAssistantMessageIdRef.current = null;
    streamingTextRef.current = "";
    setIsStreaming(false);
    setActiveAgentId(null);
    tearDownClient();
    setStatus("idle");
  }, [tearDownClient]);

  const loadConversationForSession = useCallback(async (client: OpenClawGatewayClient, key: string) => {
    try {
      const history = await client.request<ChatHistoryResult>("chat.history", {
        sessionKey: key,
        limit: 20,
      });
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
        },
      ]);
    }
  }, []);

  const refreshAgentList = useCallback(
    async (client: OpenClawGatewayClient, currentSessionKey: string) => {
      setAgentsLoading(true);
      try {
        const result = await client.request<AgentsListResult>("agents.list", {});
        const list = extractAgentItems(result);
        setAgents(list);
        const defaultAgentId = typeof result.defaultId === "string" ? result.defaultId : null;

        try {
          const sessionsResult = await client.request<SessionsListResult>("sessions.list", {
            includeGlobal: false,
            includeUnknown: false,
            limit: 500,
          });
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
      if (payload.sessionKey !== sessionKeyRef.current) {
        return;
      }

      const activeRunId = activeRunIdRef.current;
      if (activeRunId && payload.runId !== activeRunId) {
        return;
      }

      if (payload.state === "delta") {
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

      if (payload.state === "final") {
        const finalText = extractText(payload.message) || streamingTextRef.current;
        activeRunIdRef.current = null;
        streamingTextRef.current = "";
        setIsStreaming(false);
        const assistantId = activeAssistantMessageIdRef.current;
        activeAssistantMessageIdRef.current = null;
        if (finalText.trim()) {
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
          void loadConversationForSession(nextClient, sessionKeyRef.current);
        }
        return;
      }

      if (payload.state === "aborted") {
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

      activeRunIdRef.current = null;
      const assistantId = activeAssistantMessageIdRef.current;
      activeAssistantMessageIdRef.current = null;
      streamingTextRef.current = "";
      setIsStreaming(false);
      const rawErrorMessage = payload.errorMessage ?? "chat error";
      const normalizedErrorMessage = INVALID_IMAGE_DATA_RE.test(rawErrorMessage)
        ? "图片内容解析失败，请重试：优先使用截图/PNG/JPEG，或换一张图后再发。"
        : rawErrorMessage;
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
    });

    clientRef.current = nextClient;
    nextClient.start();
  }, [gatewayUrl, loadConversationForSession, refreshAgentList, tearDownClient, token]);

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
        imageAttachments.push({
          attachment,
          payload: {
            type: "image",
            mimeType,
            // Use full data URL for broader gateway/provider compatibility.
            content: normalizedDataUrl,
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
      const fileNotes = safeAttachments
        .map(
          (attachment) =>
            `- ${imagePathSet.has(attachment.relativePath) ? "[图片]" : "[文件]"} ${attachment.fileName} (${attachment.mimeType || "application/octet-stream"}) -> ${attachment.relativePath}`,
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

      const runId = createId();
      const assistantMessageId = createId();
      activeRunIdRef.current = runId;
      activeAssistantMessageIdRef.current = assistantMessageId;
      streamingTextRef.current = "";
      setIsStreaming(true);
      setLastError(null);
      setLastPrompt(finalMessage);
      setScreenText("");
      const attachmentPreview =
        safeAttachments.length > 0
          ? `\n\n附件:\n${safeAttachments
              .map((item) => `${imagePathSet.has(item.relativePath) ? "[图片]" : "[文件]"} ${item.fileName}`)
              .join("\n")}`
          : "";
      const userDisplayText = `${message || (imageAttachments.length > 0 ? "[图片]" : "[仅附件]")}${attachmentPreview}`.trim();
      setChatMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "user",
          text: userDisplayText,
          images: imageAttachments.map((item) => item.image),
        },
        { id: assistantMessageId, role: "assistant", text: "正在思考...", streaming: true },
      ]);

      try {
        await client.request("chat.send", {
          sessionKey: sessionKeyRef.current,
          message: finalMessage,
          attachments: imageAttachments.length > 0 ? imageAttachments.map((item) => item.payload) : undefined,
          deliver: false,
          idempotencyKey: runId,
        });
        return true;
      } catch (error) {
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
    [status],
  );

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
        setLastError("当前有进行中的回复，请稍后切换 Agent。");
        return false;
      }
      if (nextAgentId === activeAgentId) {
        return true;
      }

      setAgentSwitching(true);
      setLastError(null);
      try {
        // Use explicit agent-scoped key so room -> agent routing is deterministic.
        // Some gateway builds ignore `agentId` when resolving "main".
        const requestedSessionKey = `agent:${nextAgentId}:main`;
        let nextSessionKey = requestedSessionKey;

        try {
          const resolved = await client.request<SessionsResolveResult>("sessions.resolve", {
            key: requestedSessionKey,
            includeGlobal: true,
          });
          if (typeof resolved.key === "string" && resolved.key.trim()) {
            nextSessionKey = resolved.key.trim();
          }
        } catch {
          nextSessionKey = requestedSessionKey;
        }

        setActiveAgentId(nextAgentId);
        setSessionKey(nextSessionKey);
        sessionKeyRef.current = nextSessionKey;
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
    [activeAgentId, loadConversationForSession, status],
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
    sendPrompt,
    switchAgent,
  };
}
