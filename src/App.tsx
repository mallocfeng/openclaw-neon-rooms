import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FutureScene } from "./components/FutureScene";
import { type OutboundAttachment, useOpenClawChat } from "./hooks/useOpenClawChat";
import "./App.css";

const STATUS_TEXT: Record<"idle" | "connecting" | "connected" | "error", string> = {
  idle: "未连接",
  connecting: "连接中",
  connected: "已连接",
  error: "连接异常",
};

type RoomConfig = {
  id: string;
  name: string;
  agentId: string;
};

type PreviewImageState = {
  src: string;
  title: string;
};

const ROOMS_STORAGE_KEY = "openclaw.rooms.v1";
const MAIN_ROOM_ID = "main-room";
const MAIN_ROOM: RoomConfig = {
  id: MAIN_ROOM_ID,
  name: "main",
  agentId: "main",
};

function createRoomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `room-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type UploadApiFile = {
  fileName: string;
  mimeType: string;
  size: number;
  relativePath: string;
  absolutePath: string;
};

function looksLikeImageFileName(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|avif)$/i.test(name);
}

function joinBasePath(baseUrl: string, subPath: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const normalizedSub = subPath.startsWith("/") ? subPath.slice(1) : subPath;
  return `${normalizedBase}${normalizedSub}`;
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("读取图片失败"));
    };
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function ensureMainRoom(rooms: RoomConfig[]): RoomConfig[] {
  const cleaned = rooms
    .filter((room) => room && typeof room.id === "string" && room.id.trim())
    .map((room) => ({
      id: room.id.trim(),
      name: room.name.trim() || room.id.trim(),
      agentId: room.agentId.trim() || "main",
    }));

  const hasMain = cleaned.some((room) => room.id === MAIN_ROOM_ID);
  if (!hasMain) {
    return [MAIN_ROOM, ...cleaned];
  }

  return cleaned.map((room) =>
    room.id === MAIN_ROOM_ID
      ? {
          ...room,
          name: room.name || "main",
          agentId: room.agentId || "main",
        }
      : room,
  );
}

function loadRoomsFromStorage(): RoomConfig[] {
  try {
    const raw = localStorage.getItem(ROOMS_STORAGE_KEY);
    if (!raw) {
      return [MAIN_ROOM];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [MAIN_ROOM];
    }

    const rooms: RoomConfig[] = [];
    for (const item of parsed) {
      if (!isRecord(item)) {
        continue;
      }
      const id = typeof item.id === "string" ? item.id : "";
      const name = typeof item.name === "string" ? item.name : "";
      const agentId = typeof item.agentId === "string" ? item.agentId : "main";
      if (!id.trim()) {
        continue;
      }
      rooms.push({ id, name, agentId });
    }

    return ensureMainRoom(rooms);
  } catch {
    return [MAIN_ROOM];
  }
}

function App() {
  const [command, setCommand] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<OutboundAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<PreviewImageState | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [rooms, setRooms] = useState<RoomConfig[]>(() => loadRoomsFromStorage());
  const [activeRoomId, setActiveRoomId] = useState(MAIN_ROOM_ID);

  const defaultUrl = useMemo(() => import.meta.env.VITE_OPENCLAW_WS_URL ?? "ws://127.0.0.1:18789", []);
  const defaultToken = useMemo(() => import.meta.env.VITE_OPENCLAW_TOKEN ?? "", []);
  const uploadApiCandidates = useMemo(() => {
    const fromBase = joinBasePath(import.meta.env.BASE_URL ?? "/", "api/uploads");
    const candidates = [fromBase, "/api/uploads"];
    return Array.from(new Set(candidates));
  }, []);

  const {
    gatewayUrl,
    setGatewayUrl,
    token,
    setToken,
    status,
    lastError,
    sessionKey,
    isStreaming,
    agents,
    agentModels,
    agentsLoading,
    agentSwitching,
    chatMessages,
    connect,
    disconnect,
    sendPrompt,
    switchAgent,
  } = useOpenClawChat(defaultUrl, defaultToken);

  const connected = status === "connected";
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);

  const roomList = useMemo(() => ensureMainRoom(rooms), [rooms]);
  const activeRoom = useMemo(
    () => roomList.find((room) => room.id === activeRoomId) ?? roomList.find((room) => room.id === MAIN_ROOM_ID),
    [roomList, activeRoomId],
  );
  const effectiveActiveRoomId = activeRoom?.id ?? MAIN_ROOM_ID;
  const defaultAgentId = useMemo(
    () => agents.find((agent) => agent.isDefault)?.id ?? agents[0]?.id ?? "main",
    [agents],
  );
  const resolveRoomAgentId = useCallback(
    (room: RoomConfig) => {
      const targetAgentId = room.agentId.trim() || "main";
      if (agents.length === 0) {
        return targetAgentId;
      }
      if (targetAgentId === "main") {
        return agents.some((agent) => agent.id === "main") ? "main" : defaultAgentId;
      }
      return agents.some((agent) => agent.id === targetAgentId) ? targetAgentId : defaultAgentId;
    },
    [agents, defaultAgentId],
  );
  const activeTargetAgentId = useMemo(() => {
    if (!activeRoom) {
      return defaultAgentId;
    }
    return resolveRoomAgentId(activeRoom);
  }, [activeRoom, defaultAgentId, resolveRoomAgentId]);

  const agentOptions = useMemo(() => {
    const map = new Map<string, string>();
    map.set("main", "main");
    for (const agent of agents) {
      map.set(agent.id, agent.name);
    }
    for (const room of roomList) {
      if (!map.has(room.agentId)) {
        map.set(room.agentId, room.agentId);
      }
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [agents, roomList]);

  const imageAttachments = useMemo(
    () => pendingAttachments.filter((attachment) => typeof attachment.imageDataUrl === "string" && attachment.imageDataUrl.length > 0),
    [pendingAttachments],
  );

  useEffect(() => {
    const node = chatScrollRef.current;
    if (!node) {
      return;
    }
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [chatMessages, isStreaming]);

  useEffect(() => {
    localStorage.setItem(ROOMS_STORAGE_KEY, JSON.stringify(roomList));
  }, [roomList]);

  useEffect(() => {
    if (!connected) {
      return;
    }
    void switchAgent(activeTargetAgentId);
  }, [connected, activeTargetAgentId, switchAgent]);

  useEffect(() => {
    if (!previewImage) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPreviewImage(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [previewImage]);

  const uploadSingleFile = useCallback(async (file: File): Promise<OutboundAttachment> => {
    let imageDataUrl = file.type.startsWith("image/") ? await fileToDataUrl(file) : undefined;
    const formData = new FormData();
    const safeName = file.name?.trim() || `clipboard-${Date.now()}.png`;
    formData.append("files", file, safeName);

    let lastError: Error | null = null;
    for (const endpoint of uploadApiCandidates) {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          body: formData,
        });
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }

      const raw = await response.text();
      let payload: unknown = {};
      if (raw.trim()) {
        try {
          payload = JSON.parse(raw) as unknown;
        } catch {
          lastError = new Error(`上传服务响应不是合法 JSON（HTTP ${response.status}）`);
          continue;
        }
      }

      if (response.status === 404) {
        lastError = new Error(`上传失败（HTTP 404）`);
        continue;
      }

      if (!response.ok || !isRecord(payload) || !Array.isArray(payload.files) || payload.files.length === 0) {
        const message =
          isRecord(payload) && typeof payload.error === "string"
            ? payload.error
            : `上传失败（HTTP ${response.status}）`;
        throw new Error(message);
      }

      const first = payload.files[0];
      if (!isRecord(first)) {
        throw new Error("上传返回格式错误");
      }

      const saved: UploadApiFile = {
        fileName: typeof first.fileName === "string" ? first.fileName : file.name,
        mimeType: typeof first.mimeType === "string" ? first.mimeType : file.type || "application/octet-stream",
        size: typeof first.size === "number" ? first.size : file.size,
        relativePath: typeof first.relativePath === "string" ? first.relativePath : "",
        absolutePath: typeof first.absolutePath === "string" ? first.absolutePath : "",
      };
      const shouldTreatAsImage = saved.mimeType.startsWith("image/") || looksLikeImageFileName(saved.fileName);
      if (shouldTreatAsImage && !imageDataUrl) {
        try {
          imageDataUrl = await fileToDataUrl(file);
        } catch {
          imageDataUrl = undefined;
        }
      }

      return {
        fileName: saved.fileName,
        mimeType: saved.mimeType || "application/octet-stream",
        size: saved.size,
        relativePath: saved.relativePath,
        absolutePath: saved.absolutePath,
        imageDataUrl,
      };
    }

    throw new Error(
      lastError?.message ??
        `上传服务不可用。请确认当前服务支持 ${uploadApiCandidates.join(" / ")}（建议使用 npm run dev 或 npm run preview 启动）。`,
    );
  }, [uploadApiCandidates]);

  const uploadFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) {
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const uploaded: OutboundAttachment[] = [];
      for (const file of files) {
        // Keep uploads deterministic so UI order matches selected order.
        uploaded.push(await uploadSingleFile(file));
      }
      setPendingAttachments((current) => [...current, ...uploaded]);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }, [uploadSingleFile]);

  const onPickAttachments = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    await uploadFiles(files);
  }, [uploadFiles]);

  const onInputPaste = useCallback((event: React.ClipboardEvent<HTMLInputElement>) => {
    const items = Array.from(event.clipboardData?.items ?? []);
    const files: File[] = [];
    for (const item of items) {
      if (item.kind !== "file") {
        continue;
      }
      const file = item.getAsFile();
      if (file) {
        files.push(file);
      }
    }
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    void uploadFiles(files);
  }, [uploadFiles]);

  const onComposerDragEnter = useCallback((event: React.DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current += 1;
    if (event.dataTransfer.types.includes("Files")) {
      setDragActive(true);
    }
  }, []);

  const onComposerDragOver = useCallback((event: React.DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    if (event.dataTransfer.types.includes("Files")) {
      setDragActive(true);
    }
  }, []);

  const onComposerDragLeave = useCallback((event: React.DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setDragActive(false);
    }
  }, []);

  const onComposerDrop = useCallback((event: React.DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setDragActive(false);
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length === 0) {
      return;
    }
    void uploadFiles(files);
  }, [uploadFiles]);

  const removeAttachment = (index: number) => {
    setPendingAttachments((current) => current.filter((_, currentIndex) => currentIndex !== index));
  };

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const sent = await sendPrompt(command, pendingAttachments);
    if (sent) {
      setCommand("");
      setPendingAttachments([]);
      setUploadError(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const updateRoom = (roomId: string, patch: Partial<RoomConfig>) => {
    setRooms((current) =>
      ensureMainRoom(current).map((room) =>
        room.id === roomId
          ? {
              ...room,
              ...patch,
            }
          : room,
      ),
    );
  };

  const removeRoom = (roomId: string) => {
    if (roomId === MAIN_ROOM_ID) {
      return;
    }
    setRooms((current) => ensureMainRoom(current).filter((room) => room.id !== roomId));
    if (roomId === effectiveActiveRoomId) {
      setActiveRoomId(MAIN_ROOM_ID);
    }
  };

  const addRoom = () => {
    const defaultAgent = agents.find((agent) => agent.isDefault)?.id ?? agents[0]?.id ?? "main";
    const nextRoom: RoomConfig = {
      id: createRoomId(),
      name: `room-${roomList.length}`,
      agentId: defaultAgent,
    };
    setRooms((current) => ensureMainRoom([...current, nextRoom]));
    setShowSettings(true);
  };

  const selectRoom = async (roomId: string) => {
    const room = roomList.find((item) => item.id === roomId) ?? roomList.find((item) => item.id === MAIN_ROOM_ID);
    const nextRoomId = room?.id ?? MAIN_ROOM_ID;
    setActiveRoomId(nextRoomId);
    if (!connected) {
      return;
    }
    if (!room) {
      return;
    }
    const targetAgentId = resolveRoomAgentId(room);
    await switchAgent(targetAgentId);
  };

  return (
    <div className="app-shell">
      <div className="background-noise" />
      <div className="background-rings" />

      <header className="topbar">
        <div className="topbar-title-wrap">
          <h1 className="topbar-title">OpenClaw Visual Gateway</h1>
          <span className={`status-badge status-${status}`}>{STATUS_TEXT[status]}</span>
          <span className="status-session">Session: {sessionKey}</span>
        </div>

        <div className="topbar-controls">
          <label className="field">
            <span>Gateway URL</span>
            <input
              value={gatewayUrl}
              onChange={(event) => setGatewayUrl(event.target.value)}
              placeholder="ws://127.0.0.1:18789"
            />
          </label>

          <label className="field">
            <span>Token</span>
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="OpenClaw token"
            />
          </label>

          <button
            type="button"
            className="connect-button"
            onClick={() => {
              if (connected) {
                disconnect();
                return;
              }
              void connect();
            }}
          >
            {connected ? "断开" : "连接"}
          </button>

          <button
            type="button"
            className="settings-button"
            onClick={() => {
              setShowSettings(true);
            }}
          >
            设置
          </button>
        </div>
      </header>

      <main className="main-grid">
        <section className="scene-card" aria-label="3D 机器人">
          <FutureScene connected={connected} streaming={isStreaming} />
          <div className="scene-caption">Robot Console</div>
        </section>

        <section className="chat-card" aria-label="问答面板">
          <div className="chat-head">
            <h2>对话屏幕</h2>
            <span>
              {agentSwitching
                ? "切换房间中..."
                : isStreaming
                  ? "OpenClaw 正在回复..."
                  : activeRoom
                    ? `当前房间: ${activeRoom.name}`
                    : "等待指令"}
            </span>
          </div>

          <div className="chat-body">
            <aside className="agent-list-panel" aria-label="房间列表">
              <div className="agent-list-head">Rooms</div>
              <div className="agent-list-scroll">
                {roomList.map((room) => (
                  <button
                    type="button"
                    key={room.id}
                    className={`agent-item ${effectiveActiveRoomId === room.id ? "active" : ""}`}
                    disabled={agentSwitching || isStreaming}
                    onClick={async () => {
                      await selectRoom(room.id);
                    }}
                  >
                    <span className="agent-name">{room.name}</span>
                    <span className="agent-id">agent: {room.agentId}</span>
                    <span className="agent-model">{agentModels[resolveRoomAgentId(room)] ?? "模型: auto/default"}</span>
                  </button>
                ))}
              </div>
            </aside>

            <div className="chat-scroll" ref={chatScrollRef}>
              {chatMessages.map((message) => (
                <article
                  key={message.id}
                  className={`chat-row chat-${message.role}${message.streaming ? " chat-streaming" : ""}`}
                >
                  <div className="chat-role">
                    {message.role === "user" ? "你" : message.role === "assistant" ? "OpenClaw" : "系统"}
                  </div>
                  {message.text ? <pre className="chat-text">{message.text}</pre> : null}
                  {message.role === "user" && Array.isArray(message.images) && message.images.length > 0 ? (
                    <div className="chat-images">
                      {message.images.map((image) => (
                        <button
                          key={`${message.id}-${image.id}`}
                          type="button"
                          className="chat-image-button"
                          onClick={() => {
                            setPreviewImage({
                              src: image.dataUrl,
                              title: image.fileName || "图片预览",
                            });
                          }}
                          title={image.fileName || "查看图片"}
                        >
                          <img src={image.dataUrl} alt={image.fileName || "chat image"} className="chat-image" />
                        </button>
                      ))}
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          </div>

          <form
            onSubmit={onSubmit}
            className={`chat-input-form ${dragActive ? "drag-active" : ""}`}
            onDragEnter={onComposerDragEnter}
            onDragOver={onComposerDragOver}
            onDragLeave={onComposerDragLeave}
            onDrop={onComposerDrop}
          >
            {dragActive ? <div className="drop-hint">松开即可上传文件</div> : null}
            <div className="composer-toolbar">
              <input
                ref={fileInputRef}
                type="file"
                className="file-input-hidden"
                multiple
                onChange={onPickAttachments}
              />
              <button
                type="button"
                className="upload-button"
                disabled={!connected || isStreaming || agentSwitching || uploading}
                onClick={() => {
                  fileInputRef.current?.click();
                }}
              >
                {uploading ? "上传中..." : "上传图片/附件"}
              </button>
              <span className="upload-tip">支持粘贴图片和拖拽文件到输入区</span>
              {uploadError ? <span className="upload-error">{uploadError}</span> : null}
            </div>

            {imageAttachments.length > 0 ? (
              <div className="attachment-image-strip">
                {imageAttachments.map((attachment) => (
                  <button
                    key={`thumb-${attachment.relativePath}`}
                    type="button"
                    className={`attachment-thumb-button ${previewImage?.src === attachment.imageDataUrl ? "active" : ""}`}
                    onClick={() => {
                      if (!attachment.imageDataUrl) {
                        return;
                      }
                      setPreviewImage({
                        src: attachment.imageDataUrl,
                        title: attachment.fileName,
                      });
                    }}
                    title={`查看大图: ${attachment.fileName}`}
                  >
                    <img src={attachment.imageDataUrl} alt={attachment.fileName} className="attachment-thumb-image" />
                  </button>
                ))}
              </div>
            ) : null}

            {pendingAttachments.length > 0 ? (
              <div className="attachment-list">
                {pendingAttachments.map((attachment, index) => (
                  <div key={`${attachment.relativePath}-${index}`} className="attachment-item">
                    <span className="attachment-name">{attachment.fileName}</span>
                    <span className="attachment-meta">{formatFileSize(attachment.size)}</span>
                    <button
                      type="button"
                      className="attachment-remove"
                      disabled={isStreaming || agentSwitching}
                      onClick={() => {
                        removeAttachment(index);
                      }}
                    >
                      移除
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="composer-input-row">
              <input
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                onPaste={onInputPaste}
                placeholder={connected ? "输入问题，或直接粘贴图片 / 拖拽文件..." : "请先连接 Gateway"}
                disabled={!connected || isStreaming || agentSwitching}
              />
              <button
                type="submit"
                disabled={!connected || isStreaming || agentSwitching || uploading || (!command.trim() && pendingAttachments.length === 0)}
              >
                {isStreaming ? "处理中..." : "发送"}
              </button>
            </div>
          </form>
        </section>
      </main>

      {previewImage ? (
        <section
          className="image-preview-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="图片预览"
          onClick={() => {
            setPreviewImage(null);
          }}
        >
          <div
            className="image-preview-panel"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <div className="image-preview-head">
              <span className="image-preview-title">{previewImage.title}</span>
              <button
                type="button"
                className="image-preview-close"
                onClick={() => {
                  setPreviewImage(null);
                }}
              >
                关闭
              </button>
            </div>
            <img src={previewImage.src} alt={previewImage.title} className="image-preview-full" />
          </div>
        </section>
      ) : null}

      {showSettings ? (
        <section className="settings-overlay" role="dialog" aria-modal="true" aria-label="房间设置">
          <div className="settings-panel">
            <div className="settings-head">
              <div>
                <h3>房间设置</h3>
                <p>管理房间，并为每个房间绑定一个 Agent。</p>
              </div>
              <button
                type="button"
                className="settings-close"
                onClick={() => {
                  setShowSettings(false);
                }}
              >
                关闭
              </button>
            </div>

            <div className="settings-grid">
              <section className="settings-section">
                <div className="settings-section-head">All Agents</div>
                <div className="settings-agent-list">
                  {agentsLoading ? <div className="settings-empty">加载 Agent 列表中...</div> : null}
                  {!agentsLoading && agents.length === 0 ? (
                    <div className="settings-empty">未拉取到 Agent，连接 Gateway 后会自动加载。</div>
                  ) : null}
                  {agents.map((agent) => (
                    <article key={agent.id} className="settings-agent-item">
                      <div className="settings-agent-name">{agent.name}</div>
                      <div className="settings-agent-meta">ID: {agent.id}</div>
                      <div className="settings-agent-meta">模型: {agentModels[agent.id] ?? "auto/default"}</div>
                    </article>
                  ))}
                </div>
              </section>

              <section className="settings-section">
                <div className="settings-section-head with-action">
                  <span>Rooms</span>
                  <button
                    type="button"
                    className="add-room-button"
                    onClick={addRoom}
                  >
                    + 添加房间
                  </button>
                </div>
                <div className="settings-room-list">
                  {roomList.map((room) => (
                    <article key={room.id} className="settings-room-item">
                      <label className="settings-field">
                        <span>房间名</span>
                        <input
                          value={room.name}
                          disabled={room.id === MAIN_ROOM_ID}
                          onChange={(event) => {
                            updateRoom(room.id, { name: event.target.value });
                          }}
                        />
                      </label>

                      <label className="settings-field">
                        <span>绑定 Agent</span>
                        <select
                          value={room.agentId}
                          onChange={(event) => {
                            updateRoom(room.id, { agentId: event.target.value });
                          }}
                        >
                          {agentOptions.map((agent) => (
                            <option key={agent.id} value={agent.id}>
                              {agent.name} ({agent.id})
                            </option>
                          ))}
                        </select>
                      </label>

                      <div className="settings-room-actions">
                        <button
                          type="button"
                          className="room-select-button"
                          onClick={async () => {
                            await selectRoom(room.id);
                            setShowSettings(false);
                          }}
                        >
                          切换到此房间
                        </button>
                        <button
                          type="button"
                          className="room-delete-button"
                          disabled={room.id === MAIN_ROOM_ID}
                          onClick={() => {
                            removeRoom(room.id);
                          }}
                        >
                          删除
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            </div>
          </div>
        </section>
      ) : null}

      {lastError ? <aside className="error-banner">{lastError}</aside> : null}
    </div>
  );
}

export default App;
