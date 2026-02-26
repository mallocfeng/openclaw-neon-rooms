import { useCallback, useEffect, useMemo, useState } from "react";
import "./ConfigStudioPage.css";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type ValueType = "string" | "number" | "boolean" | "null" | "object" | "array";
type StudioTabKey = "start" | "gateway" | "channels" | "security" | "models" | "agents" | "advanced";
type PathSegment = string | number;

type ConfigTargetItem = {
  id: string;
  label: string;
  path: string;
  exists: boolean;
};

type ConfigTargetsResponse = {
  ok: boolean;
  targets?: ConfigTargetItem[];
  defaultPath?: string;
  error?: string;
};

type ConfigReadResponse = {
  ok: boolean;
  path?: string;
  exists?: boolean;
  rawText?: string;
  json?: unknown;
  parseError?: string | null;
  updatedAt?: string | null;
  bytes?: number;
  error?: string;
};

type FieldHint = {
  label?: string;
  description: string;
  options?: string[];
};

const ROOT_SECTION = "__root__";

const FIELD_HINTS: Array<{ pattern: RegExp; hint: FieldHint }> = [
  {
    pattern: /^gateway\.auth\.mode$/,
    hint: {
      label: "网关鉴权模式",
      description: "控制 Gateway 的鉴权方式。常见值为 token / none。",
      options: ["token", "none"],
    },
  },
  {
    pattern: /^gateway\.auth\.token$/,
    hint: {
      label: "网关访问令牌",
      description: "用于客户端连接 Gateway 的 token，建议使用高强度随机字符串。",
    },
  },
  {
    pattern: /^gateway\.remote\.enabled$/,
    hint: {
      label: "远程访问开关",
      description: "开启后允许远程管理能力，建议与独立 remote token 搭配使用。",
    },
  },
  {
    pattern: /^gateway\.remote\.token$/,
    hint: {
      label: "远程访问 Token",
      description: "用于远程 CLI/管理请求，不等同 gateway.auth.token。",
    },
  },
  {
    pattern: /^gateway\.host$/,
    hint: {
      label: "监听地址",
      description: "网关监听地址，例如 127.0.0.1 或 0.0.0.0。",
    },
  },
  {
    pattern: /^gateway\.port$/,
    hint: {
      label: "监听端口",
      description: "网关监听端口。",
    },
  },
  {
    pattern: /^channels\.[^.]+\.enabled$/,
    hint: {
      label: "渠道开关",
      description: "控制该渠道是否启用。",
    },
  },
  {
    pattern: /^channels\.[^.]+\.token$/,
    hint: {
      label: "渠道 Token",
      description: "渠道机器人或 API 的认证凭据。",
    },
  },
  {
    pattern: /^channels\.[^.]+\.dmPolicy$/,
    hint: {
      label: "私聊策略",
      description: "定义私聊消息如何进入系统。",
      options: ["pairing", "allowlist", "open", "disabled"],
    },
  },
  {
    pattern: /^channels\.[^.]+\.groupPolicy$/,
    hint: {
      label: "群聊策略",
      description: "定义群聊消息如何进入系统。",
      options: ["allowlist", "mention", "open", "disabled"],
    },
  },
  {
    pattern: /^channels\.[^.]+\.allowFrom$/,
    hint: {
      label: "私聊白名单",
      description: "仅允许该列表中的用户与机器人私聊。",
    },
  },
  {
    pattern: /^channels\.[^.]+\.groupAllowFrom$/,
    hint: {
      label: "群组白名单",
      description: "仅允许该列表中的群组接入。",
    },
  },
  {
    pattern: /^channels\.[^.]+\.accounts$/,
    hint: {
      label: "多账号配置",
      description: "为同一渠道配置多账号，每个账号可覆盖 token 与策略。",
    },
  },
  {
    pattern: /^logging\.level$/,
    hint: {
      label: "日志等级",
      description: "日志详细程度，建议生产使用 info/warn。",
      options: ["debug", "info", "warn", "error"],
    },
  },
];

const DEFAULT_TOP_LEVEL_SECTIONS = ["gateway", "channels", "agents", "security", "logging"];
const AUTH_MODE_OPTIONS = ["token", "none"];
const LOG_LEVEL_OPTIONS = ["debug", "info", "warn", "error"];
const DM_POLICY_OPTIONS = ["pairing", "allowlist", "open", "disabled"];
const GROUP_POLICY_OPTIONS = ["allowlist", "mention", "open", "disabled"];

const CHANNEL_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "telegram", label: "Telegram" },
  { id: "discord", label: "Discord" },
  { id: "slack", label: "Slack" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "feishu", label: "Feishu" },
  { id: "googlechat", label: "Google Chat" },
  { id: "msteams", label: "Microsoft Teams" },
  { id: "matrix", label: "Matrix" },
  { id: "line", label: "LINE" },
];

const MODEL_PROVIDER_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "google", label: "Google" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "azure", label: "Azure OpenAI" },
];

const MODEL_OPTIONS_BY_PROVIDER: Record<string, string[]> = {
  openai: ["gpt-5", "gpt-5-mini", "gpt-4.1", "o4-mini"],
  anthropic: ["claude-sonnet-4.5", "claude-opus-4.1", "claude-haiku-4.5"],
  google: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
  openrouter: ["openai/gpt-5", "anthropic/claude-sonnet-4.5", "google/gemini-2.5-pro"],
  azure: ["gpt-4.1", "gpt-4o", "gpt-5"],
  custom: [],
};

const PROVIDER_API_OPTIONS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-language",
];

const MODEL_BASE_URL_OPTIONS: Record<string, Array<{ label: string; value: string }>> = {
  openai: [{ label: "OpenAI API", value: "https://api.openai.com/v1" }],
  anthropic: [{ label: "Anthropic API", value: "https://api.anthropic.com" }],
  google: [{ label: "Google Generative Language", value: "https://generativelanguage.googleapis.com/v1beta" }],
  openrouter: [{ label: "OpenRouter API", value: "https://openrouter.ai/api/v1" }],
  azure: [{ label: "Azure OpenAI (需替换 resource-name)", value: "https://<resource-name>.openai.azure.com/openai/deployments" }],
  custom: [],
};

const MODEL_PROFILE_CANDIDATES = ["agents.main", "agents.default", "model", "llm", "providers.default"];
const TEMPERATURE_PRESETS = [0, 0.1, 0.2, 0.5, 0.8, 1];
const MAX_TOKEN_OPTIONS = [512, 1024, 2048, 4096, 8192, 16384];
const TOP_P_PRESETS = [0.5, 0.7, 0.9, 1];
const PENALTY_PRESETS = [-1, -0.5, 0, 0.5, 1];
const TIMEOUT_OPTIONS = [15000, 30000, 60000, 120000];
const RETRY_OPTIONS = [0, 1, 2, 3, 5];
const REASONING_EFFORT_OPTIONS = ["low", "medium", "high"];
const STUDIO_TABS: Array<{ key: StudioTabKey; label: string; title: string; description: string; docUrl: string }> = [
  {
    key: "start",
    label: "Start",
    title: "开始配置",
    description: "按文档的入门流程，先做初始化与最小可用配置。",
    docUrl: "https://docs.openclaw.ai/start/getting-started",
  },
  {
    key: "gateway",
    label: "Gateway",
    title: "Gateway 配置",
    description: "监听地址、端口、日志等网关运行参数。",
    docUrl: "https://docs.openclaw.ai/gateway/configuration",
  },
  {
    key: "channels",
    label: "Channels",
    title: "渠道配置",
    description: "按渠道启用、填 token、设置 DM/群聊策略。",
    docUrl: "https://docs.openclaw.ai/channels/telegram",
  },
  {
    key: "security",
    label: "Security",
    title: "安全与远程",
    description: "鉴权模式、token、remote 管理能力。",
    docUrl: "https://docs.openclaw.ai/gateway/security",
  },
  {
    key: "models",
    label: "Models",
    title: "模型与 Agent",
    description: "Provider、模型、API Key、温度、token 上限。",
    docUrl: "https://docs.openclaw.ai/gateway/configuration-reference",
  },
  {
    key: "agents",
    label: "Agents",
    title: "Sub Agent 管理",
    description: "创建/删除 sub agent，并为每个 sub agent 指定模型参数。",
    docUrl: "https://docs.openclaw.ai/start/wizard",
  },
  {
    key: "advanced",
    label: "Advanced JSON",
    title: "完整 JSON 编辑",
    description: "用于处理非常规字段或高级结构。",
    docUrl: "https://docs.openclaw.ai/gateway/configuration-examples",
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pathToSegments(path: string): PathSegment[] {
  const normalized = path.trim().replace(/\[(\d+)\]/g, ".$1");
  if (!normalized) {
    return [];
  }
  return normalized
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

function getPathValue(root: JsonObject, path: string): JsonValue | undefined {
  const segments = pathToSegments(path);
  if (segments.length === 0) {
    return root;
  }
  let cursor: unknown = root;
  for (const segment of segments) {
    if (typeof segment === "number") {
      if (!Array.isArray(cursor) || segment < 0 || segment >= cursor.length) {
        return undefined;
      }
      cursor = cursor[segment];
      continue;
    }
    if (!isRecord(cursor) || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = cursor[segment];
    if (typeof cursor === "undefined") {
      return undefined;
    }
  }
  return normalizeJsonValue(cursor);
}

function setPathValue(root: JsonObject, path: string, value: JsonValue): JsonObject {
  const segments = pathToSegments(path);
  if (segments.length === 0) {
    return isRecord(value) && !Array.isArray(value) ? (value as JsonObject) : root;
  }

  const apply = (current: unknown, depth: number): JsonValue => {
    if (depth >= segments.length) {
      return normalizeJsonValue(value);
    }
    const segment = segments[depth];
    const nextDepth = depth + 1;
    const nextSegment = segments[nextDepth];

    if (typeof segment === "number") {
      const arrayNode = Array.isArray(current) ? current.slice() : [];
      const existing = arrayNode[segment];
      const fallbackNode =
        typeof nextSegment === "number"
          ? []
          : isRecord(existing) && !Array.isArray(existing)
            ? { ...(existing as JsonObject) }
            : {};
      arrayNode[segment] = apply(typeof existing === "undefined" ? fallbackNode : existing, nextDepth);
      return arrayNode.map((item) => normalizeJsonValue(item));
    }

    const objectNode = isRecord(current) && !Array.isArray(current) ? { ...(current as JsonObject) } : {};
    const existing = objectNode[segment];
    const fallbackNode =
      typeof nextSegment === "number"
        ? []
        : isRecord(existing) && !Array.isArray(existing)
          ? { ...(existing as JsonObject) }
          : {};
    objectNode[segment] = apply(typeof existing === "undefined" ? fallbackNode : existing, nextDepth);
    return objectNode;
  };

  const updated = apply(root, 0);
  return isRecord(updated) && !Array.isArray(updated) ? (updated as JsonObject) : root;
}

function removePathValue(root: JsonObject, path: string): JsonObject {
  const segments = pathToSegments(path);
  if (segments.length === 0) {
    return root;
  }

  const removeAt = (current: unknown, depth: number): unknown => {
    const segment = segments[depth];
    const isLeaf = depth === segments.length - 1;

    if (typeof segment === "number") {
      if (!Array.isArray(current)) {
        return current;
      }
      const cloned = current.slice();
      if (isLeaf) {
        if (segment >= 0 && segment < cloned.length) {
          cloned.splice(segment, 1);
        }
        return cloned;
      }
      cloned[segment] = removeAt(cloned[segment], depth + 1);
      return cloned;
    }

    if (!isRecord(current) || Array.isArray(current)) {
      return current;
    }
    const cloned: Record<string, unknown> = { ...current };
    if (isLeaf) {
      delete cloned[segment];
      return cloned;
    }
    cloned[segment] = removeAt(cloned[segment], depth + 1);
    return cloned;
  };

  const updated = removeAt(root, 0);
  return isRecord(updated) && !Array.isArray(updated) ? normalizeJsonValue(updated) as JsonObject : root;
}

function asStringValue(value: JsonValue | undefined, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function asNumberValue(value: JsonValue | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function asBooleanValue(value: JsonValue | undefined, fallback = false): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(lowered)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(lowered)) {
      return false;
    }
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  return fallback;
}

function collectModelProfilePaths(root: JsonObject): string[] {
  const found = new Set<string>();
  const modelLikeKeys = new Set(["provider", "model", "apiKey", "baseUrl", "temperature", "maxTokens"]);

  const walk = (node: JsonObject, currentPath: string, depth: number) => {
    if (depth > 5) {
      return;
    }
    const keys = Object.keys(node);
    if (currentPath && keys.some((key) => modelLikeKeys.has(key))) {
      found.add(currentPath);
    }
    for (const [key, value] of Object.entries(node)) {
      if (!isRecord(value) || Array.isArray(value)) {
        continue;
      }
      const childPath = currentPath ? `${currentPath}.${key}` : key;
      walk(value as JsonObject, childPath, depth + 1);
    }
  };

  walk(root, "", 0);
  return Array.from(found).sort();
}

type AgentQuickItem = {
  id: string;
  path: string;
  source: string;
  name: string;
  provider: string;
  model: string;
  enabled: boolean;
};

type ProviderModelOption = {
  id: string;
  label: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
};

type ProviderCatalogItem = {
  id: string;
  label: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  models: ProviderModelOption[];
};

type ProviderSelectOption = {
  id: string;
  label: string;
};

type ProviderAuthState = {
  profileCount: number;
  oauth: boolean;
  modes: string[];
};

function splitModelReference(rawModel: string): { provider: string; model: string } {
  const normalized = rawModel.trim();
  if (!normalized.includes("/")) {
    return { provider: "", model: normalized };
  }
  const [provider, ...rest] = normalized.split("/");
  if (!provider || rest.length === 0) {
    return { provider: "", model: normalized };
  }
  return {
    provider,
    model: rest.join("/"),
  };
}

function collectProviderCatalog(root: JsonObject): ProviderCatalogItem[] {
  const providersNode = getPathValue(root, "models.providers");
  if (!isRecord(providersNode) || Array.isArray(providersNode)) {
    return [];
  }

  const providerLabelMap = new Map(MODEL_PROVIDER_OPTIONS.map((item) => [item.id, item.label]));
  const catalog: ProviderCatalogItem[] = [];

  for (const [providerId, providerValue] of Object.entries(providersNode)) {
    if (!isRecord(providerValue) || Array.isArray(providerValue)) {
      continue;
    }

    const rawModels = Array.isArray(providerValue.models) ? providerValue.models : [];
    const models: ProviderModelOption[] = [];
    for (const entry of rawModels) {
      if (!isRecord(entry) || Array.isArray(entry)) {
        continue;
      }
      const id = asStringValue((entry.id as JsonValue | undefined) ?? (entry.model as JsonValue | undefined), "").trim();
      if (!id) {
        continue;
      }
      const name = asStringValue((entry.name as JsonValue | undefined), id).trim() || id;
      const contextWindowRaw = asNumberValue(entry.contextWindow as JsonValue | undefined, 0);
      const maxTokensRaw = asNumberValue(entry.maxTokens as JsonValue | undefined, 0);
      const contextWindow = contextWindowRaw > 0 ? contextWindowRaw : undefined;
      const maxTokens = maxTokensRaw > 0 ? maxTokensRaw : undefined;
      const details = [name, contextWindow ? `ctx ${contextWindow}` : "", maxTokens ? `max ${maxTokens}` : ""]
        .filter(Boolean)
        .join(" · ");
      const modelOption: ProviderModelOption = {
        id,
        name,
        label: `${id}${details ? ` (${details})` : ""}`,
      };
      if (contextWindow) {
        modelOption.contextWindow = contextWindow;
      }
      if (maxTokens) {
        modelOption.maxTokens = maxTokens;
      }
      models.push(modelOption);
    }

    const label = providerLabelMap.get(providerId) ?? providerId;
    catalog.push({
      id: providerId,
      label,
      baseUrl: asStringValue(providerValue.baseUrl as JsonValue | undefined, ""),
      api: asStringValue(providerValue.api as JsonValue | undefined, PROVIDER_API_OPTIONS[0]),
      apiKey: asStringValue(providerValue.apiKey as JsonValue | undefined, ""),
      models,
    });
  }

  return catalog.sort((a, b) => a.id.localeCompare(b.id));
}

function collectProviderAuthStates(root: JsonObject): Record<string, ProviderAuthState> {
  const profilesNode = getPathValue(root, "auth.profiles");
  if (!isRecord(profilesNode) || Array.isArray(profilesNode)) {
    return {};
  }

  const authMap = new Map<string, { profileCount: number; oauth: boolean; modes: Set<string> }>();

  for (const [profileId, profileValue] of Object.entries(profilesNode)) {
    if (!isRecord(profileValue) || Array.isArray(profileValue)) {
      continue;
    }
    const fallbackProvider = profileId.includes(":") ? profileId.split(":")[0] : "";
    const provider = asStringValue(
      (profileValue.provider as JsonValue | undefined),
      fallbackProvider,
    ).trim();
    if (!provider) {
      continue;
    }

    const mode = asStringValue(profileValue.mode as JsonValue | undefined, "").trim().toLowerCase();
    const current = authMap.get(provider) ?? { profileCount: 0, oauth: false, modes: new Set<string>() };
    current.profileCount += 1;
    if (mode) {
      current.modes.add(mode);
      if (mode === "oauth") {
        current.oauth = true;
      }
    }
    authMap.set(provider, current);
  }

  const result: Record<string, ProviderAuthState> = {};
  for (const [provider, value] of authMap.entries()) {
    result[provider] = {
      profileCount: value.profileCount,
      oauth: value.oauth,
      modes: Array.from(value.modes.values()).sort((a, b) => a.localeCompare(b)),
    };
  }

  return result;
}

function getProviderConfigStatus(
  providerId: string,
  catalogMap: Map<string, ProviderCatalogItem>,
  authStates: Record<string, ProviderAuthState>,
): { configured: boolean; label: string } {
  const providerConfig = catalogMap.get(providerId);
  const hasProviderEntry = Boolean(providerConfig);
  const hasApiKey = Boolean(providerConfig?.apiKey?.trim());
  const authState = authStates[providerId];
  const hasAuthProfiles = Boolean(authState && authState.profileCount > 0);
  const hasOauth = Boolean(authState?.oauth);

  if (hasApiKey && hasOauth) {
    return { configured: true, label: "已配置: API Key + OAuth" };
  }
  if (hasOauth) {
    return { configured: true, label: "已配置: OAuth" };
  }
  if (hasApiKey) {
    return { configured: true, label: "已配置: API Key" };
  }
  if (hasAuthProfiles) {
    return { configured: true, label: "已配置: Auth Profile" };
  }
  if (hasProviderEntry) {
    return { configured: true, label: "已配置: Provider 参数" };
  }

  return { configured: false, label: "未配置认证" };
}

function buildAuthStatusMessage(prefix: string, status: { label: string }): string {
  if (status.label === "未配置认证") {
    return `${prefix}${status.label}。请在 Terminal 执行 openclaw config 完成授权。`;
  }
  return `${prefix}${status.label}`;
}

function buildProviderSelectOptions(
  catalog: ProviderCatalogItem[],
  authStates: Record<string, ProviderAuthState>,
  currentIds: string[] = [],
): ProviderSelectOption[] {
  const staticLabelMap = new Map(MODEL_PROVIDER_OPTIONS.map((item) => [item.id, item.label]));
  const catalogMap = new Map(catalog.map((item) => [item.id, item]));
  const allProviderIds = new Set<string>();

  for (const provider of catalog) {
    allProviderIds.add(provider.id);
  }

  for (const preset of MODEL_PROVIDER_OPTIONS) {
    allProviderIds.add(preset.id);
  }

  for (const providerId of Object.keys(authStates)) {
    allProviderIds.add(providerId);
  }

  for (const currentId of currentIds) {
    const normalized = currentId.trim();
    if (!normalized) {
      continue;
    }
    allProviderIds.add(normalized);
  }

  const optionsMap = new Map<string, ProviderSelectOption>();
  for (const providerId of allProviderIds) {
    const baseLabel = staticLabelMap.get(providerId) ?? providerId;
    const status = getProviderConfigStatus(providerId, catalogMap, authStates);
    const suffix = status.configured ? `（${status.label}）` : "";
    optionsMap.set(providerId, {
      id: providerId,
      label: `${baseLabel}${suffix}`,
    });
  }

  return Array.from(optionsMap.values());
}

function collectConfiguredModelRefsByProvider(root: JsonObject): Record<string, string[]> {
  const refs = new Map<string, Set<string>>();

  const pushRef = (rawRef: string) => {
    const { provider, model } = splitModelReference(rawRef);
    if (!provider || !model) {
      return;
    }
    const bucket = refs.get(provider) ?? new Set<string>();
    bucket.add(model);
    refs.set(provider, bucket);
  };

  const walk = (node: unknown, depth: number) => {
    if (depth > 7) {
      return;
    }

    if (Array.isArray(node)) {
      for (const entry of node) {
        walk(entry, depth + 1);
      }
      return;
    }

    if (!isRecord(node) || Array.isArray(node)) {
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === "model" && typeof value === "string") {
        pushRef(value);
      }

      if (key === "models" && isRecord(value) && !Array.isArray(value)) {
        for (const modelRef of Object.keys(value)) {
          pushRef(modelRef);
        }
      }

      if (key === "primary" && typeof value === "string") {
        pushRef(value);
      }

      if (key === "fallbacks" && Array.isArray(value)) {
        for (const fallback of value) {
          if (typeof fallback === "string") {
            pushRef(fallback);
          }
        }
      }

      walk(value, depth + 1);
    }
  };

  walk(root, 0);

  const result: Record<string, string[]> = {};
  for (const [provider, models] of refs.entries()) {
    result[provider] = Array.from(models).sort((a, b) => a.localeCompare(b));
  }
  return result;
}

function collectAgentItems(root: JsonObject): AgentQuickItem[] {
  const items: AgentQuickItem[] = [];
  const visitedContainers = new Set<string>();
  const defaultsPrimaryModelRef = asStringValue(getPathValue(root, "agents.defaults.model.primary"), "");
  const defaultsPrimaryModelParts = splitModelReference(defaultsPrimaryModelRef);
  const pushAgentItem = (id: string, path: string, source: string, node: Record<string, unknown>) => {
    const llmNode = isRecord(node.llm) && !Array.isArray(node.llm) ? (node.llm as Record<string, unknown>) : null;
    const modelNode = isRecord(node.model) && !Array.isArray(node.model) ? (node.model as Record<string, unknown>) : null;
    const rawProvider = asStringValue(
      (node.provider as JsonValue | undefined) ??
        (node.modelProvider as JsonValue | undefined) ??
        (llmNode?.provider as JsonValue | undefined),
      "",
    );
    const directModel = asStringValue(node.model as JsonValue | undefined, "");
    const rawModel = directModel || asStringValue(
      (node.model as JsonValue | undefined) ??
        (node.modelId as JsonValue | undefined) ??
        (node.defaultModel as JsonValue | undefined) ??
        (llmNode?.model as JsonValue | undefined) ??
        (modelNode?.primary as JsonValue | undefined),
      "",
    );
    const modelRef = splitModelReference(rawModel);
    const provider = (
      rawProvider ||
      modelRef.provider ||
      defaultsPrimaryModelParts.provider ||
      "openai"
    ).toLowerCase();
    const model = modelRef.model || rawModel || defaultsPrimaryModelParts.model || "";
    const name = asStringValue(
      (node.name as JsonValue | undefined) ??
        (node.displayName as JsonValue | undefined) ??
        (node.title as JsonValue | undefined),
      id,
    );
    const disabledValue = typeof node.disabled === "boolean" ? !node.disabled : undefined;
    const enabled = asBooleanValue(
      (node.enabled as JsonValue | undefined) ??
        (disabledValue as JsonValue | undefined),
      true,
    );
    items.push({ id, path, source, name, provider, model, enabled });
  };

  const collectFromContainer = (containerPath: string, container: unknown) => {
    if (visitedContainers.has(containerPath)) {
      return;
    }
    visitedContainers.add(containerPath);

    if (Array.isArray(container)) {
      container.forEach((entry, index) => {
        if (!isRecord(entry) || Array.isArray(entry)) {
          return;
        }
        const id = asStringValue((entry.id as JsonValue | undefined) ?? (entry.name as JsonValue | undefined), `agent-${index + 1}`);
        const path = `${containerPath}[${index}]`;
        pushAgentItem(id, path, containerPath, entry);
      });
      return;
    }

    if (!isRecord(container) || Array.isArray(container)) {
      return;
    }

    const looksLikeSingleAgent =
      Object.prototype.hasOwnProperty.call(container, "provider") ||
      Object.prototype.hasOwnProperty.call(container, "model") ||
      Object.prototype.hasOwnProperty.call(container, "llm");

    if (looksLikeSingleAgent) {
      const fallbackId = containerPath.split(".").pop() || "agent";
      pushAgentItem(fallbackId, containerPath, containerPath, container);
      return;
    }

    const collectListNode = (listKey: string, listNode: unknown) => {
      const listPath = `${containerPath}.${listKey}`;
      if (Array.isArray(listNode)) {
        listNode.forEach((entry, index) => {
          if (!isRecord(entry) || Array.isArray(entry)) {
            return;
          }
          const id = asStringValue(
            (entry.id as JsonValue | undefined) ??
              (entry.name as JsonValue | undefined) ??
              (entry.agentId as JsonValue | undefined),
            `agent-${index + 1}`,
          );
          pushAgentItem(id, `${listPath}[${index}]`, listPath, entry);
        });
        return;
      }
      if (isRecord(listNode) && !Array.isArray(listNode)) {
        for (const [entryKey, entryValue] of Object.entries(listNode)) {
          if (!isRecord(entryValue) || Array.isArray(entryValue)) {
            continue;
          }
          const id = asStringValue((entryValue.id as JsonValue | undefined) ?? (entryValue.name as JsonValue | undefined), entryKey);
          pushAgentItem(id, `${listPath}.${entryKey}`, listPath, entryValue);
        }
      }
    };

    const listLikeKeys = ["list", "items", "entries"];
    for (const listKey of listLikeKeys) {
      if (Object.prototype.hasOwnProperty.call(container, listKey)) {
        collectListNode(listKey, (container as Record<string, unknown>)[listKey]);
      }
    }

    for (const [entryKey, entryValue] of Object.entries(container)) {
      if (entryKey === "list" || entryKey === "items" || entryKey === "entries") {
        continue;
      }
      // `agents.defaults` / `agents.default` 是模板配置，不是可运行实例，避免混入 Sub Agent 列表。
      if (/^defaults?$/i.test(entryKey)) {
        continue;
      }
      if (!isRecord(entryValue) || Array.isArray(entryValue)) {
        continue;
      }
      const path = `${containerPath}.${entryKey}`;
      pushAgentItem(entryKey, path, containerPath, entryValue);
    }
  };

  const candidateContainerPaths = [
    "agents",
    "subagents",
    "agentProfiles",
    "subagentProfiles",
    "profiles.agents",
    "profiles.subagents",
    "runtime.agents",
    "runtime.subagents",
  ];
  for (const candidatePath of candidateContainerPaths) {
    collectFromContainer(candidatePath, getPathValue(root, candidatePath));
  }

  const scanForContainers = (node: unknown, currentPath: string, depth: number) => {
    if (depth > 5 || !isRecord(node) || Array.isArray(node)) {
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const nextPath = currentPath ? `${currentPath}.${key}` : key;
      if (/^agents?$/i.test(key) || /^subagents?$/i.test(key) || /agentprofiles?/i.test(key) || /subagentprofiles?/i.test(key)) {
        collectFromContainer(nextPath, value);
      }
      if (isRecord(value) && !Array.isArray(value)) {
        scanForContainers(value, nextPath, depth + 1);
      }
    }
  };

  scanForContainers(root, "", 0);

  const deduped = new Map<string, AgentQuickItem>();
  for (const item of items) {
    deduped.set(item.path, item);
  }

  return Array.from(deduped.values()).sort((a, b) => {
    const byId = a.id.localeCompare(b.id);
    if (byId !== 0) {
      return byId;
    }
    return a.path.localeCompare(b.path);
  });
}

function joinBasePath(subPath: string): string {
  const base = import.meta.env.BASE_URL ?? "/";
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  const normalizedSub = subPath.startsWith("/") ? subPath.slice(1) : subPath;
  return `${normalizedBase}${normalizedSub}`;
}

function valueTypeOf(value: JsonValue): ValueType {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "object";
  }
}

function createDefaultValue(type: ValueType): JsonValue {
  switch (type) {
    case "string":
      return "";
    case "number":
      return 0;
    case "boolean":
      return false;
    case "null":
      return null;
    case "array":
      return [];
    case "object":
    default:
      return {};
  }
}

function convertValueType(current: JsonValue, targetType: ValueType): JsonValue {
  if (targetType === valueTypeOf(current)) {
    return current;
  }
  if (targetType === "string") {
    if (current === null) {
      return "";
    }
    if (typeof current === "string") {
      return current;
    }
    return JSON.stringify(current);
  }
  if (targetType === "number") {
    if (typeof current === "number") {
      return current;
    }
    if (typeof current === "boolean") {
      return current ? 1 : 0;
    }
    if (typeof current === "string") {
      const parsed = Number(current);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }
  if (targetType === "boolean") {
    if (typeof current === "boolean") {
      return current;
    }
    if (typeof current === "number") {
      return current !== 0;
    }
    if (typeof current === "string") {
      const lowered = current.trim().toLowerCase();
      return lowered === "true" || lowered === "1" || lowered === "yes";
    }
    return false;
  }
  if (targetType === "null") {
    return null;
  }
  if (targetType === "array") {
    if (Array.isArray(current)) {
      return current;
    }
    return [];
  }
  if (isRecord(current) && !Array.isArray(current)) {
    const next: JsonObject = {};
    for (const [key, child] of Object.entries(current)) {
      next[key] = normalizeJsonValue(child);
    }
    return next;
  }
  return {};
}

function normalizeJsonValue(input: unknown): JsonValue {
  if (
    input === null ||
    typeof input === "string" ||
    typeof input === "number" ||
    typeof input === "boolean"
  ) {
    return input;
  }
  if (Array.isArray(input)) {
    return input.map((item) => normalizeJsonValue(item));
  }
  if (isRecord(input)) {
    const result: JsonObject = {};
    for (const [key, value] of Object.entries(input)) {
      result[key] = normalizeJsonValue(value);
    }
    return result;
  }
  return String(input ?? "");
}

function resolveFieldHint(path: string): FieldHint | null {
  for (const item of FIELD_HINTS) {
    if (item.pattern.test(path)) {
      return item.hint;
    }
  }
  return null;
}

function countNodes(value: JsonValue): number {
  if (value === null) {
    return 1;
  }
  if (Array.isArray(value)) {
    return value.reduce<number>((total, item) => total + countNodes(item), 1);
  }
  if (typeof value === "object") {
    return Object.values(value).reduce<number>((total, item) => total + countNodes(item), 1);
  }
  return 1;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let current = value;
  let index = 0;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  return `${current >= 10 || index === 0 ? current.toFixed(0) : current.toFixed(1)} ${units[index]}`;
}

function PathHint({ path }: { path: string }) {
  if (!path) {
    return null;
  }
  const hint = resolveFieldHint(path);
  if (!hint) {
    return null;
  }
  return (
    <div className="json-node-hint">
      <strong>{hint.label ?? "字段提示"}:</strong> {hint.description}
      {hint.options && hint.options.length > 0 ? (
        <span className="json-node-options">建议值: {hint.options.join(" / ")}</span>
      ) : null}
    </div>
  );
}

type PrimitiveEditorProps = {
  path: string;
  value: JsonPrimitive;
  onChange: (next: JsonValue) => void;
};

function PrimitiveEditor({ path, value, onChange }: PrimitiveEditorProps) {
  const hint = resolveFieldHint(path);
  if (typeof value === "boolean") {
    return (
      <label className="toggle-row">
        <input type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} />
        <span>{value ? "true" : "false"}</span>
      </label>
    );
  }
  if (typeof value === "number") {
    return (
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        onChange={(event) => {
          const next = Number(event.target.value);
          onChange(Number.isFinite(next) ? next : 0);
        }}
      />
    );
  }
  if (value === null) {
    return <div className="null-badge">null</div>;
  }

  const stringValue = String(value);
  const useTextArea = stringValue.length > 70 || stringValue.includes("\n");
  return (
    <div className="string-editor">
      {useTextArea ? (
        <textarea value={stringValue} onChange={(event) => onChange(event.target.value)} rows={4} />
      ) : (
        <input type="text" value={stringValue} onChange={(event) => onChange(event.target.value)} />
      )}
      {hint?.options && hint.options.length > 0 ? (
        <div className="quick-options">
          {hint.options.map((option) => (
            <button
              key={`${path}-${option}`}
              type="button"
              onClick={() => {
                onChange(option);
              }}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

type JsonNodeEditorProps = {
  path: string;
  label: string;
  value: JsonValue;
  onChange: (next: JsonValue) => void;
  onRemove?: () => void;
  depth?: number;
};

function JsonNodeEditor({ path, label, value, onChange, onRemove, depth = 0 }: JsonNodeEditorProps) {
  const valueType = valueTypeOf(value);

  return (
    <section className={`json-node ${depth > 0 ? "json-node-nested" : ""}`}>
      <header className="json-node-head">
        <div className="json-node-title-wrap">
          <h4>{label}</h4>
          <span className={`value-type-badge type-${valueType}`}>{valueType}</span>
          {path ? <code>{path}</code> : null}
        </div>
        <div className="json-node-actions">
          <label>
            类型
            <select
              value={valueType}
              onChange={(event) => {
                const nextType = event.target.value as ValueType;
                onChange(convertValueType(value, nextType));
              }}
            >
              <option value="object">object</option>
              <option value="array">array</option>
              <option value="string">string</option>
              <option value="number">number</option>
              <option value="boolean">boolean</option>
              <option value="null">null</option>
            </select>
          </label>
          {onRemove ? (
            <button type="button" className="danger-text" onClick={onRemove}>
              删除
            </button>
          ) : null}
        </div>
      </header>

      <PathHint path={path} />

      {valueType === "object" ? (
        <ObjectEditor
          path={path}
          value={value as JsonObject}
          depth={depth}
          onChange={(next) => onChange(next)}
        />
      ) : null}
      {valueType === "array" ? (
        <ArrayEditor
          path={path}
          value={value as JsonValue[]}
          depth={depth}
          onChange={(next) => onChange(next)}
        />
      ) : null}
      {valueType !== "array" && valueType !== "object" ? (
        <PrimitiveEditor
          path={path}
          value={value as JsonPrimitive}
          onChange={(next) => onChange(next)}
        />
      ) : null}
    </section>
  );
}

type ObjectEditorProps = {
  path: string;
  value: JsonObject;
  depth: number;
  onChange: (next: JsonObject) => void;
};

function ObjectEditor({ path, value, depth, onChange }: ObjectEditorProps) {
  const [newKey, setNewKey] = useState("");
  const [newType, setNewType] = useState<ValueType>("string");
  const [error, setError] = useState("");

  const entries = useMemo(() => Object.entries(value), [value]);

  const addField = useCallback(() => {
    const trimmed = newKey.trim();
    if (!trimmed) {
      setError("请输入字段名");
      return;
    }
    if (Object.prototype.hasOwnProperty.call(value, trimmed)) {
      setError("字段已存在");
      return;
    }
    onChange({
      ...value,
      [trimmed]: createDefaultValue(newType),
    });
    setNewKey("");
    setNewType("string");
    setError("");
  }, [newKey, newType, onChange, value]);

  return (
    <div className="json-object-body">
      {entries.length === 0 ? <div className="empty-tip">当前对象为空，可在下方新增字段。</div> : null}
      {entries.map(([key, child]) => {
        const childPath = path ? `${path}.${key}` : key;
        return (
          <JsonNodeEditor
            key={childPath}
            path={childPath}
            label={key}
            value={child}
            depth={depth + 1}
            onChange={(next) => {
              onChange({
                ...value,
                [key]: next,
              });
            }}
            onRemove={() => {
              const next: JsonObject = {};
              for (const [entryKey, entryValue] of entries) {
                if (entryKey === key) {
                  continue;
                }
                next[entryKey] = entryValue;
              }
              onChange(next);
            }}
          />
        );
      })}

      <div className="json-add-row">
        <input
          type="text"
          value={newKey}
          placeholder="新字段名，例如 auth"
          onChange={(event) => setNewKey(event.target.value)}
        />
        <select value={newType} onChange={(event) => setNewType(event.target.value as ValueType)}>
          <option value="object">object</option>
          <option value="array">array</option>
          <option value="string">string</option>
          <option value="number">number</option>
          <option value="boolean">boolean</option>
          <option value="null">null</option>
        </select>
        <button type="button" onClick={addField}>
          + 添加字段
        </button>
      </div>
      {error ? <div className="inline-error">{error}</div> : null}
    </div>
  );
}

type ArrayEditorProps = {
  path: string;
  value: JsonValue[];
  depth: number;
  onChange: (next: JsonValue[]) => void;
};

function ArrayEditor({ path, value, depth, onChange }: ArrayEditorProps) {
  const [newType, setNewType] = useState<ValueType>("string");

  return (
    <div className="json-array-body">
      {value.length === 0 ? <div className="empty-tip">当前数组为空，可在下方新增元素。</div> : null}
      {value.map((item, index) => {
        const childPath = `${path}[${index}]`;
        return (
          <JsonNodeEditor
            key={childPath}
            path={childPath}
            label={`[${index}]`}
            value={item}
            depth={depth + 1}
            onChange={(next) => {
              const updated = value.slice();
              updated[index] = next;
              onChange(updated);
            }}
            onRemove={() => {
              onChange(value.filter((_entry, idx) => idx !== index));
            }}
          />
        );
      })}
      <div className="json-add-row">
        <select value={newType} onChange={(event) => setNewType(event.target.value as ValueType)}>
          <option value="object">object</option>
          <option value="array">array</option>
          <option value="string">string</option>
          <option value="number">number</option>
          <option value="boolean">boolean</option>
          <option value="null">null</option>
        </select>
        <button
          type="button"
          onClick={() => {
            onChange([...value, createDefaultValue(newType)]);
          }}
        >
          + 添加元素
        </button>
      </div>
    </div>
  );
}

function ConfigStudioPage() {
  const configApiPath = useMemo(() => joinBasePath("api/config-json"), []);
  const configTargetsApiPath = useMemo(() => joinBasePath("api/config-json/targets"), []);

  const [targets, setTargets] = useState<ConfigTargetItem[]>([]);
  const [pathInput, setPathInput] = useState("~/.openclaw/openclaw.json");
  const [activeSection, setActiveSection] = useState(ROOT_SECTION);
  const [jsonDraft, setJsonDraft] = useState<JsonValue>({});
  const [rawDraft, setRawDraft] = useState("{}");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("等待加载配置文件");
  const [fileExists, setFileExists] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState(0);
  const [rawMode, setRawMode] = useState(false);
  const [rawModeError, setRawModeError] = useState<string | null>(null);
  const [newTopKey, setNewTopKey] = useState("");
  const [activeDocTab, setActiveDocTab] = useState<StudioTabKey>("start");
  const [selectedModelProfile, setSelectedModelProfile] = useState(MODEL_PROFILE_CANDIDATES[0]);
  const [selectedChannel, setSelectedChannel] = useState(CHANNEL_OPTIONS[0]?.id ?? "telegram");
  const [selectedAgentPathKey, setSelectedAgentPathKey] = useState("");
  const [newAgentId, setNewAgentId] = useState("");
  const [newAgentName, setNewAgentName] = useState("");
  const [selectedProviderConfigId, setSelectedProviderConfigId] = useState("");
  const [newProviderId, setNewProviderId] = useState("");
  const [selectedProviderModelId, setSelectedProviderModelId] = useState("");

  const loadTargets = useCallback(async () => {
    try {
      const response = await fetch(configTargetsApiPath);
      const payload = (await response.json()) as ConfigTargetsResponse;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error ?? "加载配置文件候选失败");
      }
      setTargets(payload.targets ?? []);
      if (payload.defaultPath) {
        setPathInput((current) => (current.trim() ? current : payload.defaultPath ?? current));
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    }
  }, [configTargetsApiPath]);

  const applyJsonChange = useCallback((next: JsonValue) => {
    setJsonDraft(next);
    setRawDraft(JSON.stringify(next, null, 2));
    setDirty(true);
  }, []);

  const loadConfig = useCallback(async (targetPath: string) => {
    const trimmedPath = targetPath.trim();
    if (!trimmedPath) {
      setStatusMessage("请先输入配置文件路径");
      return;
    }

    setLoading(true);
    setStatusMessage("正在读取配置文件...");
    setRawModeError(null);
    try {
      const response = await fetch(`${configApiPath}?path=${encodeURIComponent(trimmedPath)}`);
      const payload = (await response.json()) as ConfigReadResponse;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error ?? "读取配置失败");
      }

      const normalized = normalizeJsonValue(payload.json ?? {});
      setJsonDraft(normalized);
      setRawDraft(JSON.stringify(normalized, null, 2));
      setPathInput(payload.path ?? trimmedPath);
      setDirty(false);
      setParseError(payload.parseError ?? null);
      setStatusMessage(payload.exists ? "已读取配置文件" : "目标文件不存在，已使用空模板");
      setFileExists(Boolean(payload.exists));
      setUpdatedAt(payload.updatedAt ?? null);
      setFileSize(typeof payload.bytes === "number" ? payload.bytes : 0);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [configApiPath]);

  const saveConfig = useCallback(async () => {
    const trimmedPath = pathInput.trim();
    if (!trimmedPath) {
      setStatusMessage("请先输入配置文件路径");
      return;
    }

    setSaving(true);
    setStatusMessage("正在保存配置...");
    try {
      const response = await fetch(configApiPath, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          path: trimmedPath,
          json: jsonDraft,
        }),
      });
      const payload = (await response.json()) as ConfigReadResponse;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error ?? "保存失败");
      }
      const normalized = normalizeJsonValue(payload.json ?? {});
      setJsonDraft(normalized);
      setRawDraft(JSON.stringify(normalized, null, 2));
      setPathInput(payload.path ?? trimmedPath);
      setDirty(false);
      setParseError(payload.parseError ?? null);
      setStatusMessage("保存成功");
      setFileExists(true);
      setUpdatedAt(payload.updatedAt ?? null);
      setFileSize(typeof payload.bytes === "number" ? payload.bytes : 0);
      void loadTargets();
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [configApiPath, jsonDraft, loadTargets, pathInput]);

  useEffect(() => {
    void loadTargets();
  }, [loadTargets]);

  useEffect(() => {
    const nextRaw = JSON.stringify(jsonDraft, null, 2);
    setRawDraft(nextRaw);
  }, [jsonDraft]);

  const rootObject = useMemo(() => {
    if (valueTypeOf(jsonDraft) !== "object") {
      return null;
    }
    return jsonDraft as JsonObject;
  }, [jsonDraft]);

  const safeRootObject = useMemo<JsonObject>(() => rootObject ?? {}, [rootObject]);

  const readQuickValue = useCallback((path: string) => getPathValue(safeRootObject, path), [safeRootObject]);

  const setQuickValues = useCallback((changes: Array<[string, JsonValue]>) => {
    let nextRoot = safeRootObject;
    for (const [path, value] of changes) {
      nextRoot = setPathValue(nextRoot, path, value);
    }
    applyJsonChange(nextRoot);
  }, [applyJsonChange, safeRootObject]);

  const providerCatalog = useMemo(() => collectProviderCatalog(safeRootObject), [safeRootObject]);
  const providerCatalogMap = useMemo(() => new Map(providerCatalog.map((item) => [item.id, item])), [providerCatalog]);
  const providerAuthStates = useMemo(() => collectProviderAuthStates(safeRootObject), [safeRootObject]);
  const configuredModelRefsByProvider = useMemo(() => collectConfiguredModelRefsByProvider(safeRootObject), [safeRootObject]);

  useEffect(() => {
    if (providerCatalog.length === 0) {
      setSelectedProviderConfigId("");
      return;
    }
    if (!selectedProviderConfigId || !providerCatalog.some((item) => item.id === selectedProviderConfigId)) {
      setSelectedProviderConfigId(providerCatalog[0].id);
    }
  }, [providerCatalog, selectedProviderConfigId]);

  const modelProfileOptions = useMemo(() => {
    const found = collectModelProfilePaths(safeRootObject);
    const unique = new Set<string>();
    const options: string[] = [];
    for (const item of [...found, ...MODEL_PROFILE_CANDIDATES]) {
      const normalized = item.trim();
      if (!normalized || unique.has(normalized)) {
        continue;
      }
      unique.add(normalized);
      options.push(normalized);
    }
    return options;
  }, [safeRootObject]);

  useEffect(() => {
    if (modelProfileOptions.length === 0) {
      return;
    }
    if (!modelProfileOptions.includes(selectedModelProfile)) {
      setSelectedModelProfile(modelProfileOptions[0]);
    }
  }, [modelProfileOptions, selectedModelProfile]);

  const activeModelProfile = modelProfileOptions.includes(selectedModelProfile)
    ? selectedModelProfile
    : modelProfileOptions[0] ?? MODEL_PROFILE_CANDIDATES[0];

  const modelProviderPath = `${activeModelProfile}.provider`;
  const modelNamePath = `${activeModelProfile}.model`;
  const modelApiKeyPath = `${activeModelProfile}.apiKey`;
  const modelBaseUrlPath = `${activeModelProfile}.baseUrl`;
  const modelTemperaturePath = `${activeModelProfile}.temperature`;
  const modelMaxTokensPath = `${activeModelProfile}.maxTokens`;

  const modelProviderRaw = asStringValue(readQuickValue(modelProviderPath), "openai").trim();
  const modelProvider = modelProviderRaw || "openai";
  const modelProviderOptions = buildProviderSelectOptions(providerCatalog, providerAuthStates, [modelProvider]);
  const modelProviderStatus = getProviderConfigStatus(modelProvider, providerCatalogMap, providerAuthStates);
  const configuredModelOptions = providerCatalogMap.get(modelProvider)?.models ?? [];
  const configuredRefOptions = (configuredModelRefsByProvider[modelProvider] ?? []).map((id) => ({
    id,
    label: `${id}（来自现有配置）`,
    name: id,
  }));
  const fallbackModelOptions = (MODEL_OPTIONS_BY_PROVIDER[modelProvider] ?? []).map((id) => ({ id, label: id, name: id }));
  const modelOptionsMap = new Map<string, { id: string; label: string; name: string }>();
  for (const option of [...configuredModelOptions, ...configuredRefOptions, ...fallbackModelOptions]) {
    if (!modelOptionsMap.has(option.id)) {
      modelOptionsMap.set(option.id, option);
    }
  }
  const modelOptions = Array.from(modelOptionsMap.values());
  const selectedModelName = asStringValue(readQuickValue(modelNamePath), modelOptions[0]?.id ?? "");
  const selectedModelApiKey = asStringValue(readQuickValue(modelApiKeyPath), "");
  const selectedModelBaseUrl = asStringValue(readQuickValue(modelBaseUrlPath), "");
  const selectedModelTemperature = Math.min(1, Math.max(0, asNumberValue(readQuickValue(modelTemperaturePath), 0.2)));
  const selectedModelMaxTokens = asNumberValue(readQuickValue(modelMaxTokensPath), 2048);
  const modelBaseUrlOptions = MODEL_BASE_URL_OPTIONS[modelProvider] ?? [];

  const gatewayHost = asStringValue(readQuickValue("gateway.host"), "127.0.0.1");
  const gatewayPort = asNumberValue(readQuickValue("gateway.port"), 18789);
  const gatewayAuthModeRaw = asStringValue(readQuickValue("gateway.auth.mode"), AUTH_MODE_OPTIONS[0]);
  const gatewayAuthMode = AUTH_MODE_OPTIONS.includes(gatewayAuthModeRaw) ? gatewayAuthModeRaw : AUTH_MODE_OPTIONS[0];
  const gatewayAuthToken = asStringValue(readQuickValue("gateway.auth.token"), "");
  const gatewayRemoteEnabled = asBooleanValue(readQuickValue("gateway.remote.enabled"), false);
  const gatewayRemoteToken = asStringValue(readQuickValue("gateway.remote.token"), "");
  const logLevelRaw = asStringValue(readQuickValue("logging.level"), LOG_LEVEL_OPTIONS[1]);
  const logLevel = LOG_LEVEL_OPTIONS.includes(logLevelRaw) ? logLevelRaw : LOG_LEVEL_OPTIONS[1];

  const channelEnabled = asBooleanValue(readQuickValue(`channels.${selectedChannel}.enabled`), false);
  const channelToken = asStringValue(readQuickValue(`channels.${selectedChannel}.token`), "");
  const channelDmPolicyRaw = asStringValue(readQuickValue(`channels.${selectedChannel}.dmPolicy`), DM_POLICY_OPTIONS[0]);
  const channelDmPolicy = DM_POLICY_OPTIONS.includes(channelDmPolicyRaw) ? channelDmPolicyRaw : DM_POLICY_OPTIONS[0];
  const channelGroupPolicyRaw = asStringValue(readQuickValue(`channels.${selectedChannel}.groupPolicy`), GROUP_POLICY_OPTIONS[0]);
  const channelGroupPolicy = GROUP_POLICY_OPTIONS.includes(channelGroupPolicyRaw)
    ? channelGroupPolicyRaw
    : GROUP_POLICY_OPTIONS[0];

  const modelTopPPath = `${activeModelProfile}.topP`;
  const modelFrequencyPenaltyPath = `${activeModelProfile}.frequencyPenalty`;
  const modelPresencePenaltyPath = `${activeModelProfile}.presencePenalty`;
  const modelTimeoutPath = `${activeModelProfile}.timeoutMs`;
  const modelRetryPath = `${activeModelProfile}.maxRetries`;
  const modelStreamPath = `${activeModelProfile}.stream`;
  const modelReasoningPath = `${activeModelProfile}.reasoningEffort`;

  const selectedModelTopP = Math.min(1, Math.max(0, asNumberValue(readQuickValue(modelTopPPath), 1)));
  const selectedModelFrequencyPenalty = Math.min(2, Math.max(-2, asNumberValue(readQuickValue(modelFrequencyPenaltyPath), 0)));
  const selectedModelPresencePenalty = Math.min(2, Math.max(-2, asNumberValue(readQuickValue(modelPresencePenaltyPath), 0)));
  const selectedModelTimeout = asNumberValue(readQuickValue(modelTimeoutPath), 60000);
  const selectedModelRetries = asNumberValue(readQuickValue(modelRetryPath), 2);
  const selectedModelStream = asBooleanValue(readQuickValue(modelStreamPath), true);
  const selectedModelReasoningRaw = asStringValue(readQuickValue(modelReasoningPath), "medium");
  const selectedModelReasoning = REASONING_EFFORT_OPTIONS.includes(selectedModelReasoningRaw)
    ? selectedModelReasoningRaw
    : "medium";

  const agentItems = useMemo(() => collectAgentItems(safeRootObject), [safeRootObject]);

  useEffect(() => {
    if (agentItems.length === 0) {
      setSelectedAgentPathKey("");
      return;
    }
    if (!selectedAgentPathKey || !agentItems.some((item) => item.path === selectedAgentPathKey)) {
      setSelectedAgentPathKey(agentItems[0].path);
    }
  }, [agentItems, selectedAgentPathKey]);

  const selectedAgent = useMemo(
    () => agentItems.find((item) => item.path === selectedAgentPathKey) ?? null,
    [agentItems, selectedAgentPathKey],
  );

  const selectedAgentPath = selectedAgent?.path ?? "";
  const selectedAgentProviderPath = selectedAgentPath ? `${selectedAgentPath}.provider` : "";
  const selectedAgentModelPath = selectedAgentPath ? `${selectedAgentPath}.model` : "";
  const selectedAgentNamePath = selectedAgentPath ? `${selectedAgentPath}.name` : "";
  const selectedAgentEnabledPath = selectedAgentPath ? `${selectedAgentPath}.enabled` : "";
  const selectedAgentTemperaturePath = selectedAgentPath ? `${selectedAgentPath}.temperature` : "";
  const selectedAgentMaxTokensPath = selectedAgentPath ? `${selectedAgentPath}.maxTokens` : "";
  const selectedAgentProviderDefined = selectedAgentPath
    ? typeof readQuickValue(selectedAgentProviderPath) !== "undefined"
    : false;
  const selectedAgentModelRaw = selectedAgentPath
    ? asStringValue(readQuickValue(selectedAgentModelPath), selectedAgent?.model ?? "")
    : "";
  const selectedAgentModelRef = splitModelReference(selectedAgentModelRaw);

  const selectedAgentProviderRaw = selectedAgentPath
    ? asStringValue(readQuickValue(selectedAgentProviderPath), selectedAgentModelRef.provider || selectedAgent?.provider || "openai").trim()
    : "openai";
  const selectedAgentProvider = selectedAgentProviderRaw || "openai";
  const agentProviderOptions = buildProviderSelectOptions(providerCatalog, providerAuthStates, [selectedAgentProvider]);
  const selectedAgentProviderStatus = getProviderConfigStatus(selectedAgentProvider, providerCatalogMap, providerAuthStates);
  const configuredAgentModelOptions = providerCatalogMap.get(selectedAgentProvider)?.models ?? [];
  const configuredAgentRefOptions = (configuredModelRefsByProvider[selectedAgentProvider] ?? []).map((id) => ({
    id,
    label: `${id}（来自现有配置）`,
    name: id,
  }));
  const fallbackAgentModelOptions = (MODEL_OPTIONS_BY_PROVIDER[selectedAgentProvider] ?? []).map((id) => ({ id, label: id, name: id }));
  const selectedAgentModelOptionsMap = new Map<string, { id: string; label: string; name: string }>();
  for (const option of [...configuredAgentModelOptions, ...configuredAgentRefOptions, ...fallbackAgentModelOptions]) {
    if (!selectedAgentModelOptionsMap.has(option.id)) {
      selectedAgentModelOptionsMap.set(option.id, option);
    }
  }
  const selectedAgentModelOptions = Array.from(selectedAgentModelOptionsMap.values());
  const selectedAgentModel = selectedAgentPath
    ? selectedAgentModelRef.model || selectedAgentModelRaw || selectedAgentModelOptions[0]?.id || ""
    : "";
  const selectedAgentName = selectedAgentPath ? asStringValue(readQuickValue(selectedAgentNamePath), selectedAgent?.id ?? "") : "";
  const selectedAgentEnabled = selectedAgentPath ? asBooleanValue(readQuickValue(selectedAgentEnabledPath), true) : true;
  const selectedAgentTemperature = selectedAgentPath
    ? Math.min(1, Math.max(0, asNumberValue(readQuickValue(selectedAgentTemperaturePath), 0.2)))
    : 0.2;
  const selectedAgentMaxTokens = selectedAgentPath
    ? asNumberValue(readQuickValue(selectedAgentMaxTokensPath), 4096)
    : 4096;

  const selectedProviderConfig = selectedProviderConfigId ? providerCatalogMap.get(selectedProviderConfigId) ?? null : null;
  const selectedProviderConfigStatus = selectedProviderConfigId
    ? getProviderConfigStatus(selectedProviderConfigId, providerCatalogMap, providerAuthStates)
    : { configured: false, label: "未配置认证" };
  const selectedProviderPath = selectedProviderConfigId ? `models.providers.${selectedProviderConfigId}` : "";
  const selectedProviderBaseUrlPath = selectedProviderPath ? `${selectedProviderPath}.baseUrl` : "";
  const selectedProviderApiPath = selectedProviderPath ? `${selectedProviderPath}.api` : "";
  const selectedProviderApiKeyPath = selectedProviderPath ? `${selectedProviderPath}.apiKey` : "";
  const selectedProviderModels = useMemo(() => selectedProviderConfig?.models ?? [], [selectedProviderConfig]);

  useEffect(() => {
    if (selectedProviderModels.length === 0) {
      setSelectedProviderModelId("");
      return;
    }
    if (!selectedProviderModelId || !selectedProviderModels.some((item) => item.id === selectedProviderModelId)) {
      setSelectedProviderModelId(selectedProviderModels[0].id);
    }
  }, [selectedProviderModelId, selectedProviderModels]);

  const selectedProviderModelIndex = selectedProviderModels.findIndex((item) => item.id === selectedProviderModelId);
  const selectedProviderModelPath =
    selectedProviderPath && selectedProviderModelIndex >= 0 ? `${selectedProviderPath}.models[${selectedProviderModelIndex}]` : "";
  const selectedProviderModelData = selectedProviderModelIndex >= 0 ? selectedProviderModels[selectedProviderModelIndex] : null;
  const selectedProviderModelIdPath = selectedProviderModelPath ? `${selectedProviderModelPath}.id` : "";
  const selectedProviderModelNamePath = selectedProviderModelPath ? `${selectedProviderModelPath}.name` : "";
  const selectedProviderModelContextPath = selectedProviderModelPath ? `${selectedProviderModelPath}.contextWindow` : "";
  const selectedProviderModelMaxTokensPath = selectedProviderModelPath ? `${selectedProviderModelPath}.maxTokens` : "";

  const sectionKeys = useMemo(() => {
    if (!rootObject) {
      return [];
    }
    return Object.keys(rootObject);
  }, [rootObject]);

  useEffect(() => {
    if (!rootObject) {
      setActiveSection(ROOT_SECTION);
      return;
    }
    if (activeSection !== ROOT_SECTION && !Object.prototype.hasOwnProperty.call(rootObject, activeSection)) {
      setActiveSection(ROOT_SECTION);
    }
  }, [activeSection, rootObject]);

  const selectedValue = useMemo(() => {
    if (!rootObject || activeSection === ROOT_SECTION) {
      return jsonDraft;
    }
    return rootObject[activeSection];
  }, [activeSection, jsonDraft, rootObject]);

  const selectedPath = activeSection === ROOT_SECTION ? "" : activeSection;
  const selectedLabel = activeSection === ROOT_SECTION ? "根配置 (root)" : activeSection;

  const handleApplyRawDraft = () => {
    try {
      const parsed = JSON.parse(rawDraft) as unknown;
      applyJsonChange(normalizeJsonValue(parsed));
      setRawModeError(null);
      setStatusMessage("已应用原始 JSON 文本");
    } catch (error) {
      setRawModeError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleAddTopLevelSection = () => {
    if (!rootObject) {
      setStatusMessage("根节点不是对象，无法新增顶层章节。请先把 root 类型切换为 object。");
      return;
    }
    const trimmed = newTopKey.trim();
    if (!trimmed) {
      setStatusMessage("请输入顶层章节名");
      return;
    }
    if (Object.prototype.hasOwnProperty.call(rootObject, trimmed)) {
      setStatusMessage("该章节已存在");
      return;
    }
    applyJsonChange({
      ...rootObject,
      [trimmed]: {},
    });
    setNewTopKey("");
    setActiveSection(trimmed);
  };

  const normalizeAgentId = (raw: string) => raw.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");

  const handleCreateAgent = () => {
    const normalizedId = normalizeAgentId(newAgentId || newAgentName);
    if (!normalizedId) {
      setStatusMessage("请输入 sub agent ID（支持 a-z、0-9、-、_）。");
      return;
    }
    if (normalizedId === "main") {
      setStatusMessage("`main` 为保留主 agent，不在这里创建。请创建业务用 sub agent（例如 support-bot）。");
      return;
    }
    if (agentItems.some((item) => item.id === normalizedId)) {
      setStatusMessage(`sub agent "${normalizedId}" 已存在。`);
      const existing = agentItems.find((item) => item.id === normalizedId);
      if (existing) {
        setSelectedAgentPathKey(existing.path);
      }
      return;
    }

    const defaultProvider = modelProvider || "openai";
    const defaultModel =
      selectedModelName ||
      providerCatalogMap.get(defaultProvider)?.models[0]?.id ||
      configuredModelRefsByProvider[defaultProvider]?.[0] ||
      MODEL_OPTIONS_BY_PROVIDER[defaultProvider]?.[0] ||
      "gpt-5-mini";
    const agentsListNode = getPathValue(safeRootObject, "agents.list");
    const shouldUseAgentsList = Array.isArray(agentsListNode);
    const createPath = shouldUseAgentsList
      ? `agents.list[${(agentsListNode as unknown[]).length}]`
      : `agents.${normalizedId}`;
    const createPayload: JsonObject = shouldUseAgentsList
      ? {
          id: normalizedId,
          name: newAgentName.trim() || normalizedId,
          enabled: true,
          model: `${defaultProvider}/${defaultModel}`,
          temperature: 0.2,
          maxTokens: 4096,
        }
      : {
          name: newAgentName.trim() || normalizedId,
          enabled: true,
          provider: defaultProvider,
          model: defaultModel,
          temperature: 0.2,
          maxTokens: 4096,
        };

    setQuickValues([
      [createPath, createPayload],
    ]);

    setSelectedAgentPathKey(createPath);
    setNewAgentId("");
    setNewAgentName("");
    setStatusMessage(`已创建 sub agent "${normalizedId}"，可继续指定模型。`);
  };

  const handleDeleteAgent = (agentPath: string, agentId: string) => {
    const nextRoot = removePathValue(safeRootObject, agentPath);
    applyJsonChange(nextRoot);
    if (selectedAgentPathKey === agentPath) {
      setSelectedAgentPathKey("");
    }
    setStatusMessage(`已删除 sub agent "${agentId}"。`);
  };

  const missingDefaultSections = useMemo(() => {
    if (!rootObject) {
      return DEFAULT_TOP_LEVEL_SECTIONS;
    }
    return DEFAULT_TOP_LEVEL_SECTIONS.filter((section) => !Object.prototype.hasOwnProperty.call(rootObject, section));
  }, [rootObject]);

  const activeTabDef = useMemo(
    () => STUDIO_TABS.find((item) => item.key === activeDocTab) ?? STUDIO_TABS[0],
    [activeDocTab],
  );

  return (
    <div className="config-page-shell">
      <div className="config-bg-layer config-bg-grid" />
      <div className="config-bg-layer config-bg-glow" />

      <header className="config-topbar">
        <div>
          <h1>OpenClaw Config Studio</h1>
          <p>可视化管理 JSON 配置文件，逐字段编辑并直接保存。</p>
        </div>
        <div className="config-top-actions">
          <a href="#/chat" className="ghost-link">
            返回聊天页
          </a>
          <button
            type="button"
            className="solid-button"
            disabled={loading}
            onClick={() => {
              void loadConfig(pathInput);
            }}
          >
            {loading ? "读取中..." : "读取配置"}
          </button>
          <button type="button" className="solid-button accent" disabled={saving} onClick={() => void saveConfig()}>
            {saving ? "保存中..." : dirty ? "保存更改" : "保存"}
          </button>
        </div>
      </header>

      <section className="config-file-panel">
        <label className="config-field">
          <span>配置路径</span>
          <input
            type="text"
            value={pathInput}
            placeholder="~/.openclaw/openclaw.json"
            onChange={(event) => setPathInput(event.target.value)}
          />
        </label>
        <label className="config-field">
          <span>快速选择</span>
          <select
            value=""
            onChange={(event) => {
              const next = event.target.value;
              if (!next) {
                return;
              }
              setPathInput(next);
              void loadConfig(next);
            }}
          >
            <option value="">选择已有配置文件...</option>
            {targets.map((target) => (
              <option key={target.id} value={target.path}>
                {target.label} {target.exists ? "" : "(不存在)"}
              </option>
            ))}
          </select>
        </label>
        <div className="config-meta-grid">
          <div>
            <span>文件状态</span>
            <strong>{fileExists ? "已存在" : "不存在"}</strong>
          </div>
          <div>
            <span>字段节点</span>
            <strong>{countNodes(jsonDraft)}</strong>
          </div>
          <div>
            <span>文件大小</span>
            <strong>{formatBytes(fileSize)}</strong>
          </div>
          <div>
            <span>更新时间</span>
            <strong>{updatedAt ? new Date(updatedAt).toLocaleString() : "-"}</strong>
          </div>
        </div>
        <div className={`status-line ${parseError ? "warning" : ""}`}>{parseError ?? statusMessage}</div>
      </section>

      <section className="quick-config-panel" aria-label="常用配置快捷编辑">
        <div className="quick-config-head">
          <h2>按文档结构配置</h2>
          <span>板块按 docs.openclaw.ai 划分，先选标签再配置。</span>
        </div>

        <div className="docs-tab-row" role="tablist" aria-label="配置板块">
          {STUDIO_TABS.map((tab) => (
            <button
              type="button"
              role="tab"
              aria-selected={activeDocTab === tab.key}
              key={`tab-${tab.key}`}
              className={`docs-tab ${activeDocTab === tab.key ? "active" : ""}`}
              onClick={() => {
                setActiveDocTab(tab.key);
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="docs-tab-meta">
          <div>
            <strong>{activeTabDef.title}</strong>
            <span>{activeTabDef.description}</span>
          </div>
          <a href={activeTabDef.docUrl} target="_blank" rel="noreferrer noopener">
            查看对应文档
          </a>
        </div>

        <div className={`quick-config-grid quick-config-grid-${activeDocTab}`}>
          {activeDocTab === "start" ? (
            <article className="quick-card">
              <header>
                <h3>Start 快速初始化</h3>
                <code>/start/getting-started</code>
              </header>

              <div className="quick-inline-actions">
                <button
                  type="button"
                  onClick={() => {
                    setQuickValues([
                      ["gateway.host", "127.0.0.1"],
                      ["gateway.port", 18789],
                      ["gateway.auth.mode", "token"],
                      ["logging.level", "info"],
                      ["channels.telegram.enabled", false],
                      ["channels.discord.enabled", false],
                      ["channels.slack.enabled", false],
                    ]);
                    setStatusMessage("已套用最小启动模板。下一步：切到 Models 和 Channels 补全凭据。");
                  }}
                >
                  套用最小启动模板
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setQuickValues([
                      ["gateway.host", "0.0.0.0"],
                      ["gateway.port", 18789],
                    ]);
                    setStatusMessage("已切换到局域网可访问模式。");
                  }}
                >
                  局域网访问模板
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActiveDocTab("models");
                  }}
                >
                  下一步：配置模型
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActiveDocTab("channels");
                  }}
                >
                  下一步：配置渠道
                </button>
              </div>

              <div className="start-checklist">
                <div>1. Start：先准备最小结构</div>
                <div>2. Models：设置 Provider/模型/API Key</div>
                <div>3. Channels：开启渠道并填 token</div>
                <div>4. Agents：创建不同角色的 sub agent 并绑定模型</div>
                <div>5. Security：配置 auth 与 remote token</div>
                <div>6. Advanced JSON：处理高级字段</div>
              </div>
            </article>
          ) : null}
          {activeDocTab === "models" ? (
          <article className="quick-card quick-card-model">
            <header>
              <h3>模型配置</h3>
              <code>Provider / Model</code>
            </header>

            <div className="quick-two-columns model-provider-row">
              <label className="config-field">
                <span>Provider</span>
                <select
                  value={modelProvider}
                  onChange={(event) => {
                    const nextProvider = event.target.value;
                    const nextConfiguredOptions = providerCatalogMap.get(nextProvider)?.models ?? [];
                    const nextFallbackOptions = (MODEL_OPTIONS_BY_PROVIDER[nextProvider] ?? []).map((id) => ({ id, label: id, name: id }));
                    const nextModelOptions = nextConfiguredOptions.length > 0 ? nextConfiguredOptions : nextFallbackOptions;
                    const nextBaseUrl = MODEL_BASE_URL_OPTIONS[nextProvider]?.[0]?.value ?? "";
                    const changes: Array<[string, JsonValue]> = [[modelProviderPath, nextProvider]];
                    if (nextModelOptions.length > 0 && !nextModelOptions.some((item) => item.id === selectedModelName)) {
                      changes.push([modelNamePath, nextModelOptions[0].id]);
                    }
                    if (nextBaseUrl && !selectedModelBaseUrl) {
                      changes.push([modelBaseUrlPath, nextBaseUrl]);
                    }
                    setQuickValues(changes);
                  }}
                >
                  {modelProviderOptions.map((provider) => (
                    <option key={`provider-${provider.id}`} value={provider.id}>
                      {provider.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="config-field">
                <span>Model</span>
                <select
                  value={selectedModelName}
                  onChange={(event) => {
                    setQuickValues([[modelNamePath, event.target.value]]);
                  }}
                >
                  {!selectedModelName ? <option value="">未设置</option> : null}
                  {modelOptions.length === 0 ? <option value="">暂无模型，请先在下方 Provider 目录添加</option> : null}
                  {modelOptions.map((modelOption) => (
                    <option key={`model-${modelOption.id}`} value={modelOption.id}>
                      {modelOption.label}
                    </option>
                  ))}
                  {selectedModelName && !modelOptions.some((item) => item.id === selectedModelName) ? (
                    <option value={selectedModelName}>当前值: {selectedModelName}</option>
                  ) : null}
                </select>
              </label>
            </div>
            <div className={`provider-status-line ${modelProviderStatus.configured ? "ok" : "warn"}`}>
              {buildAuthStatusMessage("认证状态：", modelProviderStatus)}
            </div>

            <div className="quick-two-columns">
              <label className="config-field">
                <span>Base URL 预设</span>
                <select
                  value={
                    modelBaseUrlOptions.some((item) => item.value === selectedModelBaseUrl)
                      ? selectedModelBaseUrl
                      : "__custom__"
                  }
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    if (nextValue === "__custom__") {
                      return;
                    }
                    setQuickValues([[modelBaseUrlPath, nextValue]]);
                  }}
                >
                  <option value="">自动/默认</option>
                  {modelBaseUrlOptions.map((item) => (
                    <option key={`base-url-${item.value}`} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                  <option value="__custom__">自定义 URL</option>
                </select>
              </label>

              <label className="config-field">
                <span>最大 Token</span>
                <select
                  value={selectedModelMaxTokens}
                  onChange={(event) => {
                    setQuickValues([[modelMaxTokensPath, Number(event.target.value)]]);
                  }}
                >
                  {!MAX_TOKEN_OPTIONS.includes(selectedModelMaxTokens) ? (
                    <option value={selectedModelMaxTokens}>当前值: {selectedModelMaxTokens}</option>
                  ) : null}
                  {MAX_TOKEN_OPTIONS.map((value) => (
                    <option key={`max-token-${value}`} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="config-field">
              <span>Base URL（自定义时填写）</span>
              <input
                type="text"
                value={selectedModelBaseUrl}
                placeholder="https://api.openai.com/v1"
                onChange={(event) => {
                  setQuickValues([[modelBaseUrlPath, event.target.value]]);
                }}
              />
            </label>

            <label className="config-field">
              <span>API Key</span>
              <input
                type="password"
                value={selectedModelApiKey}
                placeholder="sk-..."
                onChange={(event) => {
                  setQuickValues([[modelApiKeyPath, event.target.value]]);
                }}
              />
            </label>

            <div className="quick-slider-block">
              <div className="quick-slider-head">
                <span>Temperature</span>
                <strong>{selectedModelTemperature.toFixed(2)}</strong>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={selectedModelTemperature}
                onChange={(event) => {
                  setQuickValues([[modelTemperaturePath, Number(event.target.value)]]);
                }}
              />
              <div className="quick-chip-row">
                {TEMPERATURE_PRESETS.map((preset) => (
                  <button
                    type="button"
                    key={`temp-${preset}`}
                    onClick={() => {
                      setQuickValues([[modelTemperaturePath, preset]]);
                    }}
                  >
                    {preset}
                  </button>
                ))}
              </div>
            </div>

            <div className="quick-inline-actions">
              <button
                type="button"
                onClick={() => {
                  setQuickValues([
                    [modelProviderPath, "openai"],
                    [modelNamePath, "gpt-5-mini"],
                    [modelBaseUrlPath, "https://api.openai.com/v1"],
                    [modelTemperaturePath, 0.2],
                    [modelMaxTokensPath, 4096],
                  ]);
                }}
              >
                OpenAI 推荐
              </button>
              <button
                type="button"
                onClick={() => {
                  setQuickValues([
                    [modelProviderPath, "anthropic"],
                    [modelNamePath, "claude-sonnet-4.5"],
                    [modelBaseUrlPath, "https://api.anthropic.com"],
                    [modelTemperaturePath, 0.2],
                    [modelMaxTokensPath, 4096],
                  ]);
                }}
              >
                Claude 推荐
              </button>
              <button
                type="button"
                onClick={() => {
                  setQuickValues([
                    [modelProviderPath, "google"],
                    [modelNamePath, "gemini-2.5-flash"],
                    [modelBaseUrlPath, "https://generativelanguage.googleapis.com/v1beta"],
                    [modelTemperaturePath, 0.2],
                    [modelMaxTokensPath, 4096],
                  ]);
                }}
              >
                Gemini 推荐
              </button>
            </div>
          </article>
          ) : null}

          {activeDocTab === "models" ? (
            <article className="quick-card quick-card-model">
              <header>
                <h3>Provider 目录（可编辑）</h3>
                <code>models.providers.*</code>
              </header>

              <div className="quick-two-columns">
                <label className="config-field">
                  <span>选择 Provider</span>
                  <select
                    value={selectedProviderConfigId}
                    onChange={(event) => {
                      setSelectedProviderConfigId(event.target.value);
                    }}
                  >
                    {providerCatalog.length === 0 ? <option value="">暂无 provider，请先新增</option> : null}
                    {providerCatalog.map((provider) => (
                      <option key={`provider-catalog-${provider.id}`} value={provider.id}>
                        {provider.id} · {provider.models.length} models
                      </option>
                    ))}
                  </select>
                </label>

                <label className="config-field">
                  <span>新增 Provider ID</span>
                  <input
                    type="text"
                    value={newProviderId}
                    placeholder="例如 openai-codex"
                    onChange={(event) => {
                      setNewProviderId(event.target.value);
                    }}
                  />
                </label>
              </div>
              <div className="empty-tip">{buildAuthStatusMessage("当前 Provider 认证状态：", selectedProviderConfigStatus)}</div>

              <div className="quick-inline-actions">
                <button
                  type="button"
                  onClick={() => {
                    const normalized = newProviderId.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");
                    if (!normalized) {
                      setStatusMessage("请输入 provider ID。");
                      return;
                    }
                    if (providerCatalogMap.has(normalized)) {
                      setSelectedProviderConfigId(normalized);
                      setStatusMessage(`provider "${normalized}" 已存在，已切换。`);
                      return;
                    }
                    setQuickValues([
                      [`models.providers.${normalized}`, {
                        baseUrl: "",
                        api: "openai-completions",
                        apiKey: "",
                        models: [],
                      }],
                    ]);
                    setSelectedProviderConfigId(normalized);
                    setNewProviderId("");
                    setStatusMessage(`已新增 provider "${normalized}"。`);
                  }}
                >
                  + 新增 Provider
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActiveDocTab("agents");
                  }}
                >
                  去 Agents 绑定模型
                </button>
              </div>

              {selectedProviderConfig ? (
                <>
                  <div className="quick-two-columns">
                    <label className="config-field">
                      <span>Base URL</span>
                      <input
                        type="text"
                        value={selectedProviderConfig.baseUrl}
                        placeholder="https://api.openai.com/v1"
                        onChange={(event) => {
                          if (!selectedProviderBaseUrlPath) {
                            return;
                          }
                          setQuickValues([[selectedProviderBaseUrlPath, event.target.value]]);
                        }}
                      />
                    </label>
                    <label className="config-field">
                      <span>API 协议</span>
                      <select
                        value={selectedProviderConfig.api}
                        onChange={(event) => {
                          if (!selectedProviderApiPath) {
                            return;
                          }
                          setQuickValues([[selectedProviderApiPath, event.target.value]]);
                        }}
                      >
                        {PROVIDER_API_OPTIONS.map((apiType) => (
                          <option key={`provider-api-${apiType}`} value={apiType}>
                            {apiType}
                          </option>
                        ))}
                        {selectedProviderConfig.api && !PROVIDER_API_OPTIONS.includes(selectedProviderConfig.api) ? (
                          <option value={selectedProviderConfig.api}>当前值: {selectedProviderConfig.api}</option>
                        ) : null}
                      </select>
                    </label>
                  </div>

                  <label className="config-field">
                    <span>API Key / Profile</span>
                    <input
                      type="password"
                      value={selectedProviderConfig.apiKey}
                      placeholder="sk-... 或 profile id"
                      onChange={(event) => {
                        if (!selectedProviderApiKeyPath) {
                          return;
                        }
                        setQuickValues([[selectedProviderApiKeyPath, event.target.value]]);
                      }}
                    />
                  </label>

                  <div className="quick-two-columns">
                    <label className="config-field">
                      <span>模型列表</span>
                      <select
                        value={selectedProviderModelId}
                        onChange={(event) => {
                          setSelectedProviderModelId(event.target.value);
                        }}
                      >
                        {selectedProviderModels.length === 0 ? <option value="">暂无模型，请先新增</option> : null}
                        {selectedProviderModels.map((model) => (
                          <option key={`provider-model-${model.id}`} value={model.id}>
                            {model.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="quick-inline-actions">
                      <button
                        type="button"
                        onClick={() => {
                          if (!selectedProviderPath) {
                            return;
                          }
                          const rawModels = readQuickValue(`${selectedProviderPath}.models`);
                          const nextIndex = Array.isArray(rawModels) ? rawModels.length : 0;
                          const nextModelId = `model-${nextIndex + 1}`;
                          setQuickValues([
                            [`${selectedProviderPath}.models[${nextIndex}]`, {
                              id: nextModelId,
                              name: `Model ${nextIndex + 1}`,
                              contextWindow: 128000,
                              maxTokens: 4096,
                            }],
                          ]);
                          setSelectedProviderModelId(nextModelId);
                          setStatusMessage(`已在 ${selectedProviderConfig.id} 下新增模型 ${nextModelId}。`);
                        }}
                      >
                        + 新增模型
                      </button>
                      <button
                        type="button"
                        className="danger-text"
                        onClick={() => {
                          if (!selectedProviderPath || selectedProviderModelIndex < 0) {
                            return;
                          }
                          const nextRoot = removePathValue(safeRootObject, `${selectedProviderPath}.models[${selectedProviderModelIndex}]`);
                          applyJsonChange(nextRoot);
                          setSelectedProviderModelId("");
                          setStatusMessage("已删除当前模型。");
                        }}
                      >
                        删除当前模型
                      </button>
                    </div>
                  </div>

                  {selectedProviderModelData ? (
                    <div className="quick-two-columns">
                      <label className="config-field">
                        <span>模型 ID</span>
                        <input
                          type="text"
                          value={selectedProviderModelData.id}
                          onChange={(event) => {
                            if (!selectedProviderModelIdPath) {
                              return;
                            }
                            const nextId = event.target.value;
                            setQuickValues([[selectedProviderModelIdPath, nextId]]);
                            setSelectedProviderModelId(nextId);
                          }}
                        />
                      </label>
                      <label className="config-field">
                        <span>模型名称</span>
                        <input
                          type="text"
                          value={selectedProviderModelData.name}
                          onChange={(event) => {
                            if (!selectedProviderModelNamePath) {
                              return;
                            }
                            setQuickValues([[selectedProviderModelNamePath, event.target.value]]);
                          }}
                        />
                      </label>
                    </div>
                  ) : null}

                  {selectedProviderModelData ? (
                    <div className="quick-two-columns">
                      <label className="config-field">
                        <span>Context Window</span>
                        <input
                          type="number"
                          min={1024}
                          step={1024}
                          value={selectedProviderModelData.contextWindow ?? 128000}
                          onChange={(event) => {
                            if (!selectedProviderModelContextPath) {
                              return;
                            }
                            setQuickValues([[selectedProviderModelContextPath, Number(event.target.value)]]);
                          }}
                        />
                      </label>
                      <label className="config-field">
                        <span>Max Tokens</span>
                        <select
                          value={selectedProviderModelData.maxTokens ?? 4096}
                          onChange={(event) => {
                            if (!selectedProviderModelMaxTokensPath) {
                              return;
                            }
                            setQuickValues([[selectedProviderModelMaxTokensPath, Number(event.target.value)]]);
                          }}
                        >
                          {MAX_TOKEN_OPTIONS.map((value) => (
                            <option key={`provider-model-max-token-${value}`} value={value}>
                              {value}
                            </option>
                          ))}
                          {selectedProviderModelData.maxTokens && !MAX_TOKEN_OPTIONS.includes(selectedProviderModelData.maxTokens) ? (
                            <option value={selectedProviderModelData.maxTokens}>当前值: {selectedProviderModelData.maxTokens}</option>
                          ) : null}
                        </select>
                      </label>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="empty-tip">先新增一个 Provider，再配置模型目录。</div>
              )}
            </article>
          ) : null}

          {activeDocTab === "agents" ? (
            <article className="quick-card quick-card-model">
              <header>
                <h3>Sub Agent 管理工作台</h3>
                <code>agents.list[*] / agents.&lt;id&gt;</code>
              </header>

              <div className="quick-two-columns">
                <label className="config-field">
                  <span>新 Sub Agent ID</span>
                  <input
                    type="text"
                    value={newAgentId}
                    placeholder="例如 support-bot"
                    onChange={(event) => {
                      setNewAgentId(event.target.value);
                    }}
                  />
                </label>
                <label className="config-field">
                  <span>显示名称（可选）</span>
                  <input
                    type="text"
                    value={newAgentName}
                    placeholder="例如 客服 Sub Agent"
                    onChange={(event) => {
                      setNewAgentName(event.target.value);
                    }}
                  />
                </label>
              </div>

              <div className="quick-inline-actions">
                <button type="button" onClick={handleCreateAgent}>
                  + 创建 Sub Agent
                </button>
              </div>

              <div className="agent-chip-list">
                {agentItems.length === 0 ? <div className="empty-tip">还没有 sub agent，先创建一个。</div> : null}
                {agentItems.map((agent) => (
                  <button
                    key={`agent-chip-${agent.path}`}
                    type="button"
                    className={`agent-chip ${selectedAgentPathKey === agent.path ? "active" : ""}${agent.enabled ? " on" : ""}`}
                    onClick={() => {
                      setSelectedAgentPathKey(agent.path);
                    }}
                  >
                    <span>{agent.name || agent.id}</span>
                    <small>{agent.id}</small>
                    <small>{agent.source}</small>
                    <small>
                      {agent.provider} / {
                        (() => {
                          const modelMeta = providerCatalogMap.get(agent.provider)?.models.find((item) => item.id === agent.model);
                          return modelMeta ? `${agent.model} (${modelMeta.name})` : (agent.model || "-");
                        })()
                      }
                    </small>
                  </button>
                ))}
              </div>

              {selectedAgent ? (
                <div className="agent-editor">
                  <div className="quick-two-columns model-provider-row">
                    <label className="config-field">
                      <span>Sub Agent 名称</span>
                      <input
                        type="text"
                        value={selectedAgentName}
                        onChange={(event) => {
                          if (!selectedAgentNamePath) {
                            return;
                          }
                          setQuickValues([[selectedAgentNamePath, event.target.value]]);
                        }}
                      />
                    </label>

                    <label className="config-field">
                      <span>Provider</span>
                      <select
                        value={selectedAgentProvider}
                        onChange={(event) => {
                          if (!selectedAgentProviderPath || !selectedAgentModelPath) {
                            return;
                          }
                          const nextProvider = event.target.value;
                          const nextConfiguredModels = providerCatalogMap.get(nextProvider)?.models ?? [];
                          const nextFallbackModels = (MODEL_OPTIONS_BY_PROVIDER[nextProvider] ?? []).map((id) => ({ id, label: id, name: id }));
                          const nextModels = nextConfiguredModels.length > 0 ? nextConfiguredModels : nextFallbackModels;
                          const nextModel = nextModels[0]?.id ?? selectedAgentModel;
                          if (selectedAgentProviderDefined) {
                            setQuickValues([
                              [selectedAgentProviderPath, nextProvider],
                              [selectedAgentModelPath, nextModel],
                            ]);
                            return;
                          }
                          const normalizedProvider = nextProvider || selectedAgentProviderRaw || "openai";
                          setQuickValues([[selectedAgentModelPath, `${normalizedProvider}/${nextModel}`]]);
                        }}
                      >
                        {agentProviderOptions.map((provider) => (
                          <option key={`agent-provider-${provider.id}`} value={provider.id}>
                            {provider.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className={`provider-status-line ${selectedAgentProviderStatus.configured ? "ok" : "warn"}`}>
                    {buildAuthStatusMessage("认证状态：", selectedAgentProviderStatus)}
                  </div>

                  <div className="quick-two-columns">
                    <label className="config-field">
                      <span>Model</span>
                      <select
                        value={selectedAgentModel}
                        onChange={(event) => {
                          if (!selectedAgentModelPath) {
                            return;
                          }
                          if (selectedAgentProviderDefined) {
                            setQuickValues([[selectedAgentModelPath, event.target.value]]);
                            return;
                          }
                          const providerForRef = selectedAgentProviderRaw || "openai";
                          setQuickValues([[selectedAgentModelPath, `${providerForRef}/${event.target.value}`]]);
                        }}
                      >
                        {selectedAgentModelOptions.length === 0 ? (
                          <option value="">暂无模型，请先到 Models 配置 Provider 目录</option>
                        ) : null}
                        {selectedAgentModelOptions.map((modelOption) => (
                          <option key={`agent-model-${modelOption.id}`} value={modelOption.id}>
                            {modelOption.label}
                          </option>
                        ))}
                        {selectedAgentModel && !selectedAgentModelOptions.some((item) => item.id === selectedAgentModel) ? (
                          <option value={selectedAgentModel}>当前值: {selectedAgentModel}</option>
                        ) : null}
                      </select>
                    </label>
                    <div className="quick-toggle-line">
                      <label className="toggle-row">
                        <input
                          type="checkbox"
                          checked={selectedAgentEnabled}
                          onChange={(event) => {
                            if (!selectedAgentEnabledPath) {
                              return;
                            }
                            setQuickValues([[selectedAgentEnabledPath, event.target.checked]]);
                          }}
                        />
                        <span>{selectedAgentEnabled ? "已启用" : "已停用"}</span>
                      </label>
                    </div>
                  </div>

                  <div className="quick-two-columns">
                    <label className="config-field">
                      <span>Temperature</span>
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        value={selectedAgentTemperature}
                        onChange={(event) => {
                          if (!selectedAgentTemperaturePath) {
                            return;
                          }
                          setQuickValues([[selectedAgentTemperaturePath, Number(event.target.value)]]);
                        }}
                      />
                    </label>
                    <label className="config-field">
                      <span>最大 Token</span>
                      <select
                        value={selectedAgentMaxTokens}
                        onChange={(event) => {
                          if (!selectedAgentMaxTokensPath) {
                            return;
                          }
                          setQuickValues([[selectedAgentMaxTokensPath, Number(event.target.value)]]);
                        }}
                      >
                        {MAX_TOKEN_OPTIONS.map((value) => (
                          <option key={`agent-max-token-${value}`} value={value}>
                            {value}
                          </option>
                        ))}
                        {!MAX_TOKEN_OPTIONS.includes(selectedAgentMaxTokens) ? (
                          <option value={selectedAgentMaxTokens}>当前值: {selectedAgentMaxTokens}</option>
                        ) : null}
                      </select>
                    </label>
                  </div>

                  <div className="quick-inline-actions">
                    <button
                      type="button"
                      onClick={() => {
                        if (!selectedAgentModelPath || !selectedAgentTemperaturePath || !selectedAgentMaxTokensPath) {
                          return;
                        }
                        const updates: Array<[string, JsonValue]> = [
                          [selectedAgentModelPath, selectedAgentProviderDefined ? "gpt-5-mini" : "openai/gpt-5-mini"],
                          [selectedAgentTemperaturePath, 0.2],
                          [selectedAgentMaxTokensPath, 4096],
                        ];
                        if (selectedAgentProviderDefined && selectedAgentProviderPath) {
                          updates.unshift([selectedAgentProviderPath, "openai"]);
                        }
                        setQuickValues(updates);
                      }}
                    >
                      设为通用推荐配置
                    </button>
                    <button
                      type="button"
                      className="danger-text"
                      onClick={() => {
                        handleDeleteAgent(selectedAgent.path, selectedAgent.id);
                      }}
                    >
                      删除当前 Sub Agent
                    </button>
                  </div>
                </div>
              ) : null}
            </article>
          ) : null}

          {activeDocTab === "models" ? (
            <article className="quick-card">
              <header>
                <h3>模型高级参数</h3>
                <code>Sampling / Retry / Timeout</code>
              </header>

              <div className="quick-two-columns">
                <label className="config-field">
                  <span>Top P</span>
                  <select
                    value={selectedModelTopP}
                    onChange={(event) => {
                      setQuickValues([[modelTopPPath, Number(event.target.value)]]);
                    }}
                  >
                    {TOP_P_PRESETS.map((value) => (
                      <option key={`top-p-${value}`} value={value}>
                        {value}
                      </option>
                    ))}
                    {!TOP_P_PRESETS.includes(selectedModelTopP) ? (
                      <option value={selectedModelTopP}>当前值: {selectedModelTopP}</option>
                    ) : null}
                  </select>
                </label>
                <label className="config-field">
                  <span>Reasoning</span>
                  <select
                    value={selectedModelReasoning}
                    onChange={(event) => {
                      setQuickValues([[modelReasoningPath, event.target.value]]);
                    }}
                  >
                    {REASONING_EFFORT_OPTIONS.map((level) => (
                      <option key={`reasoning-${level}`} value={level}>
                        {level}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="quick-two-columns">
                <label className="config-field">
                  <span>frequency_penalty</span>
                  <input
                    type="number"
                    min={-2}
                    max={2}
                    step={0.1}
                    value={selectedModelFrequencyPenalty}
                    onChange={(event) => {
                      setQuickValues([[modelFrequencyPenaltyPath, Number(event.target.value)]]);
                    }}
                  />
                  <div className="quick-chip-row">
                    {PENALTY_PRESETS.map((preset) => (
                      <button
                        type="button"
                        key={`frequency-penalty-${preset}`}
                        onClick={() => {
                          setQuickValues([[modelFrequencyPenaltyPath, preset]]);
                        }}
                      >
                        {preset}
                      </button>
                    ))}
                  </div>
                </label>
                <label className="config-field">
                  <span>presence_penalty</span>
                  <input
                    type="number"
                    min={-2}
                    max={2}
                    step={0.1}
                    value={selectedModelPresencePenalty}
                    onChange={(event) => {
                      setQuickValues([[modelPresencePenaltyPath, Number(event.target.value)]]);
                    }}
                  />
                  <div className="quick-chip-row">
                    {PENALTY_PRESETS.map((preset) => (
                      <button
                        type="button"
                        key={`presence-penalty-${preset}`}
                        onClick={() => {
                          setQuickValues([[modelPresencePenaltyPath, preset]]);
                        }}
                      >
                        {preset}
                      </button>
                    ))}
                  </div>
                </label>
              </div>

              <div className="quick-two-columns">
                <label className="config-field">
                  <span>请求超时 (ms)</span>
                  <select
                    value={selectedModelTimeout}
                    onChange={(event) => {
                      setQuickValues([[modelTimeoutPath, Number(event.target.value)]]);
                    }}
                  >
                    {TIMEOUT_OPTIONS.map((value) => (
                      <option key={`timeout-${value}`} value={value}>
                        {value}
                      </option>
                    ))}
                    {!TIMEOUT_OPTIONS.includes(selectedModelTimeout) ? (
                      <option value={selectedModelTimeout}>当前值: {selectedModelTimeout}</option>
                    ) : null}
                  </select>
                </label>
                <label className="config-field">
                  <span>重试次数</span>
                  <select
                    value={selectedModelRetries}
                    onChange={(event) => {
                      setQuickValues([[modelRetryPath, Number(event.target.value)]]);
                    }}
                  >
                    {RETRY_OPTIONS.map((value) => (
                      <option key={`retry-${value}`} value={value}>
                        {value}
                      </option>
                    ))}
                    {!RETRY_OPTIONS.includes(selectedModelRetries) ? (
                      <option value={selectedModelRetries}>当前值: {selectedModelRetries}</option>
                    ) : null}
                  </select>
                </label>
              </div>

              <div className="quick-toggle-line">
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={selectedModelStream}
                    onChange={(event) => {
                      setQuickValues([[modelStreamPath, event.target.checked]]);
                    }}
                  />
                  <span>启用流式输出 (stream)</span>
                </label>
              </div>

              <div className="quick-inline-actions">
                <button
                  type="button"
                  onClick={() => {
                    setQuickValues([
                      [modelTopPPath, 1],
                      [modelFrequencyPenaltyPath, 0],
                      [modelPresencePenaltyPath, 0],
                      [modelTimeoutPath, 60000],
                      [modelRetryPath, 2],
                      [modelStreamPath, true],
                      [modelReasoningPath, "medium"],
                    ]);
                  }}
                >
                  还原推荐高级参数
                </button>
              </div>
            </article>
          ) : null}

          {activeDocTab === "gateway" || activeDocTab === "security" ? (
          <article className="quick-card">
            <header>
              <h3>{activeDocTab === "gateway" ? "Gateway 配置" : "安全与远程配置"}</h3>
              <code>{activeDocTab === "gateway" ? "gateway.* / logging.level" : "gateway.auth.* / gateway.remote.*"}</code>
            </header>

            {activeDocTab === "gateway" ? (
              <>
                <div className="quick-two-columns">
                  <label className="config-field">
                    <span>监听地址</span>
                    <select
                      value={["127.0.0.1", "0.0.0.0", "localhost"].includes(gatewayHost) ? gatewayHost : "__custom__"}
                      onChange={(event) => {
                        const next = event.target.value;
                        if (next === "__custom__") {
                          return;
                        }
                        setQuickValues([["gateway.host", next]]);
                      }}
                    >
                      <option value="127.0.0.1">127.0.0.1 (仅本机)</option>
                      <option value="0.0.0.0">0.0.0.0 (局域网)</option>
                      <option value="localhost">localhost</option>
                      <option value="__custom__">自定义地址</option>
                    </select>
                  </label>
                  <label className="config-field">
                    <span>端口</span>
                    <select
                      value={gatewayPort}
                      onChange={(event) => {
                        setQuickValues([["gateway.port", Number(event.target.value)]]);
                      }}
                    >
                      {![18789, 18788, 17890, 8080, 3000].includes(gatewayPort) ? (
                        <option value={gatewayPort}>当前值: {gatewayPort}</option>
                      ) : null}
                      {[18789, 18788, 17890, 8080, 3000].map((port) => (
                        <option key={`gateway-port-${port}`} value={port}>
                          {port}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {["127.0.0.1", "0.0.0.0", "localhost"].includes(gatewayHost) ? null : (
                  <label className="config-field">
                    <span>自定义监听地址</span>
                    <input
                      type="text"
                      value={gatewayHost}
                      placeholder="例如 gateway.internal.local"
                      onChange={(event) => {
                        setQuickValues([["gateway.host", event.target.value]]);
                      }}
                    />
                  </label>
                )}

                <label className="config-field">
                  <span>日志等级</span>
                  <select
                    value={logLevel}
                    onChange={(event) => {
                      setQuickValues([["logging.level", event.target.value]]);
                    }}
                  >
                    {LOG_LEVEL_OPTIONS.map((level) => (
                      <option key={`log-level-${level}`} value={level}>
                        {level}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : (
              <>
                <label className="config-field">
                  <span>鉴权模式</span>
                  <select
                    value={gatewayAuthMode}
                    onChange={(event) => {
                      setQuickValues([["gateway.auth.mode", event.target.value]]);
                    }}
                  >
                    {AUTH_MODE_OPTIONS.map((mode) => (
                      <option key={`auth-mode-${mode}`} value={mode}>
                        {mode}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="config-field">
                  <span>网关 Token</span>
                  <input
                    type="password"
                    value={gatewayAuthToken}
                    placeholder="gateway auth token"
                    onChange={(event) => {
                      setQuickValues([["gateway.auth.token", event.target.value]]);
                    }}
                  />
                </label>

                <div className="quick-toggle-line">
                  <label className="toggle-row">
                    <input
                      type="checkbox"
                      checked={gatewayRemoteEnabled}
                      onChange={(event) => {
                        setQuickValues([["gateway.remote.enabled", event.target.checked]]);
                      }}
                    />
                    <span>开启远程管理</span>
                  </label>
                </div>

                {gatewayRemoteEnabled ? (
                  <label className="config-field">
                    <span>远程管理 Token</span>
                    <input
                      type="password"
                      value={gatewayRemoteToken}
                      placeholder="remote token"
                      onChange={(event) => {
                        setQuickValues([["gateway.remote.token", event.target.value]]);
                      }}
                    />
                  </label>
                ) : null}
              </>
            )}
          </article>
          ) : null}

          {activeDocTab === "channels" ? (
          <article className="quick-card">
            <header>
              <h3>渠道快捷配置</h3>
              <code>channels.*</code>
            </header>

            <div className="quick-channel-row">
              {CHANNEL_OPTIONS.map((channel) => {
                const enabled = asBooleanValue(readQuickValue(`channels.${channel.id}.enabled`), false);
                return (
                  <button
                    key={`channel-pill-${channel.id}`}
                    type="button"
                    className={`quick-channel-pill ${selectedChannel === channel.id ? "active" : ""}${enabled ? " on" : ""}`}
                    onClick={() => {
                      setSelectedChannel(channel.id);
                    }}
                  >
                    {channel.label}
                  </button>
                );
              })}
            </div>

            <div className="quick-two-columns">
              <label className="config-field">
                <span>当前渠道</span>
                <select
                  value={selectedChannel}
                  onChange={(event) => {
                    setSelectedChannel(event.target.value);
                  }}
                >
                  {CHANNEL_OPTIONS.map((channel) => (
                    <option key={`channel-select-${channel.id}`} value={channel.id}>
                      {channel.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="quick-toggle-line">
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={channelEnabled}
                    onChange={(event) => {
                      setQuickValues([[`channels.${selectedChannel}.enabled`, event.target.checked]]);
                    }}
                  />
                  <span>{channelEnabled ? "已启用" : "未启用"}</span>
                </label>
              </div>
            </div>

            <div className="quick-two-columns">
              <label className="config-field">
                <span>私聊策略</span>
                <select
                  value={channelDmPolicy}
                  onChange={(event) => {
                    setQuickValues([[`channels.${selectedChannel}.dmPolicy`, event.target.value]]);
                  }}
                >
                  {DM_POLICY_OPTIONS.map((policy) => (
                    <option key={`dm-policy-${policy}`} value={policy}>
                      {policy}
                    </option>
                  ))}
                </select>
              </label>
              <label className="config-field">
                <span>群聊策略</span>
                <select
                  value={channelGroupPolicy}
                  onChange={(event) => {
                    setQuickValues([[`channels.${selectedChannel}.groupPolicy`, event.target.value]]);
                  }}
                >
                  {GROUP_POLICY_OPTIONS.map((policy) => (
                    <option key={`group-policy-${policy}`} value={policy}>
                      {policy}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="config-field">
              <span>渠道 Token</span>
              <input
                type="password"
                value={channelToken}
                placeholder={`${selectedChannel} token`}
                onChange={(event) => {
                  setQuickValues([[`channels.${selectedChannel}.token`, event.target.value]]);
                }}
              />
            </label>

            <div className="quick-inline-actions">
              <button
                type="button"
                onClick={() => {
                  setQuickValues([
                    [`channels.${selectedChannel}.enabled`, true],
                    [`channels.${selectedChannel}.dmPolicy`, DM_POLICY_OPTIONS[0]],
                    [`channels.${selectedChannel}.groupPolicy`, GROUP_POLICY_OPTIONS[0]],
                  ]);
                }}
              >
                应用推荐渠道策略
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveDocTab("advanced");
                  setActiveSection("channels");
                }}
              >
                打开 channels 全量配置
              </button>
            </div>
          </article>
          ) : null}

          {activeDocTab === "security" ? (
            <article className="quick-card quick-card-note">
              <header>
                <h3>安全建议</h3>
                <code>best-practice</code>
              </header>
              <div className="start-checklist">
                <div>建议保持 `gateway.auth.mode = token`。</div>
                <div>`gateway.auth.token` 与 `gateway.remote.token` 建议不同。</div>
                <div>未必要开放远程管理时，保持 `gateway.remote.enabled = false`。</div>
              </div>
            </article>
          ) : null}

          {activeDocTab === "advanced" ? (
            <article className="quick-card">
              <header>
                <h3>Advanced JSON</h3>
                <code>/gateway/configuration-examples</code>
              </header>
              <div className="start-checklist">
                <div>用于配置复杂嵌套、数组、多账号和不在快捷页里的字段。</div>
                <div>下方已开启完整 JSON 编辑器区域。</div>
              </div>
              <div className="quick-inline-actions">
                <button
                  type="button"
                  onClick={() => {
                    setActiveSection(ROOT_SECTION);
                    setRawMode(false);
                  }}
                >
                  打开可视化全量编辑
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRawMode(true);
                  }}
                >
                  打开原始 JSON 模式
                </button>
              </div>
            </article>
          ) : null}
        </div>
      </section>

      {activeDocTab === "advanced" ? (
      <main className="config-main-grid">
        <aside className="config-sections">
          <div className="section-head">
            <h3>配置章节</h3>
            <span>{sectionKeys.length} 项</span>
          </div>

          <button
            type="button"
            className={`section-item ${activeSection === ROOT_SECTION ? "active" : ""}`}
            onClick={() => setActiveSection(ROOT_SECTION)}
          >
            root
          </button>

          {sectionKeys.map((section) => (
            <button
              type="button"
              key={section}
              className={`section-item ${activeSection === section ? "active" : ""}`}
              onClick={() => setActiveSection(section)}
            >
              {section}
            </button>
          ))}

          <div className="section-add-box">
            <input
              type="text"
              value={newTopKey}
              placeholder="新增顶层章节名"
              onChange={(event) => setNewTopKey(event.target.value)}
            />
            <button type="button" onClick={handleAddTopLevelSection}>
              + 添加
            </button>
          </div>

          {missingDefaultSections.length > 0 ? (
            <div className="recommended-box">
              <div className="recommended-title">建议补齐</div>
              <div className="recommended-items">{missingDefaultSections.join(" / ")}</div>
            </div>
          ) : null}
        </aside>

        <section className="config-editor-panel">
          <div className="editor-head">
            <h2>{selectedLabel}</h2>
            <div className="editor-head-actions">
              <button type="button" className="ghost-link-like" onClick={() => setRawMode((current) => !current)}>
                {rawMode ? "回到可视化编辑" : "切换原始 JSON"}
              </button>
            </div>
          </div>

          {rawMode ? (
            <div className="raw-mode-panel">
              <textarea value={rawDraft} onChange={(event) => setRawDraft(event.target.value)} rows={20} />
              <div className="raw-actions">
                <button type="button" onClick={handleApplyRawDraft}>
                  应用文本到可视化
                </button>
                {rawModeError ? <span className="inline-error">{rawModeError}</span> : null}
              </div>
            </div>
          ) : (
            <JsonNodeEditor
              path={selectedPath}
              label={selectedLabel}
              value={selectedValue}
              onChange={(next) => {
                if (!rootObject || activeSection === ROOT_SECTION) {
                  applyJsonChange(next);
                  return;
                }
                applyJsonChange({
                  ...rootObject,
                  [activeSection]: next,
                });
              }}
              onRemove={
                rootObject && activeSection !== ROOT_SECTION
                  ? () => {
                      const next: JsonObject = {};
                      for (const [key, item] of Object.entries(rootObject)) {
                        if (key === activeSection) {
                          continue;
                        }
                        next[key] = item;
                      }
                      applyJsonChange(next);
                      setActiveSection(ROOT_SECTION);
                    }
                  : undefined
              }
            />
          )}
        </section>
      </main>
      ) : null}
    </div>
  );
}

export default ConfigStudioPage;
