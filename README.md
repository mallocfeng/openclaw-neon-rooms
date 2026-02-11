# OpenClaw Neon Rooms

Language / 语言: [English](#english) | [中文](#中文)

---

## English

A room-based web chat client for OpenClaw Gateway, optimized for desktop and mobile usage.

### What This App Does

- Connects to OpenClaw Gateway over WebSocket with token auth
- Supports room-based Q&A (`1 room -> 1 agent`)
- Supports real-time streaming replies (`delta` / `final`)
- Supports Markdown rendering in assistant bubbles
- Supports paste-image, drag-drop file upload, and image preview
- Persists attachments in the project folder
- Persists room configuration in the project folder (shared across devices)
- Mobile-first room switching UX (bottom sheet on small screens)
- Auto-collapses the top connection bar after successful connection

### Tech Stack

- React 19 + TypeScript
- Vite 7
- `react-markdown` + `remark-gfm`
- Native WebSocket client for OpenClaw Gateway protocol
- Vite middleware APIs for uploads / room config / gateway ws proxy

### Project Structure

- `src/lib/openclawGateway.ts`: Gateway transport + protocol messages
- `src/hooks/useOpenClawChat.ts`: connection/session/chat state + stream handling
- `src/App.tsx`: room UI, chat UI, upload interactions, responsive layout
- `vite.config.ts`:
  - `/api/uploads` file upload API
  - `/api/rooms` room config API
  - `/api/gateway/ws` WebSocket reverse proxy

### Requirements

- Node.js 18+ (20+ recommended)
- npm 9+
- Running OpenClaw Gateway (default: `ws://127.0.0.1:18789`)
- Valid Gateway token

### Install

```bash
npm install
cp .env.example .env
```

### Configuration

Edit `.env`:

```env
VITE_OPENCLAW_WS_URL=ws://127.0.0.1:18789
VITE_OPENCLAW_TOKEN=your_openclaw_token_here
```

Optional proxy settings (for Vite server -> local Gateway):

```env
# OPENCLAW_GATEWAY_WS_URL=ws://127.0.0.1:18789
# OPENCLAW_GATEWAY_WS_ORIGIN=http://127.0.0.1:18789
```

### Run

```bash
npm run dev
```

Open:

- `http://localhost:5173`
- or `http://<LAN-IP>:5173` from phone/tablet

### LAN Access (Gateway localhost-only)

If Gateway is bound to localhost but the web page is opened from another device:

- Keep frontend reachable via LAN (Vite host)
- Use ws proxy route in UI: `ws://<host>:5173/api/gateway/ws`
- If gateway requires Origin, configure `OPENCLAW_GATEWAY_WS_ORIGIN`

### Data Storage

Files under project root `uploads/`:

- `uploads/files/`: uploaded files
- `uploads/uploads-log.jsonl`: upload log
- `uploads/rooms.json`: shared room config
- `uploads/rooms-backups/`: automatic backups of room config

### Room Behavior

- `main` room always exists
- each room maps to one agent
- switching room switches active agent session
- room list is shared via `uploads/rooms.json`
- localStorage is used as client cache and legacy migration source

### Build / Preview / Lint

```bash
npm run build
npm run preview
npm run lint
```

### Troubleshooting

- `HTTP 404` on upload/rooms API:
  - run with `npm run dev` or `npm run preview` (middleware APIs are served by Vite server)
- Phone sees only `main` room:
  - verify `uploads/rooms.json` actually contains all rooms
  - refresh desktop once to sync room config
- No response from gateway:
  - check URL/token/gateway status
  - check if ws proxy target/origin are correct

### Security

- never commit real tokens
- keep `.env` private
- use least-privileged gateway token

---

## 中文

一个面向 OpenClaw Gateway 的房间化 Web 聊天客户端，兼顾桌面和手机端体验。

### 功能概览

- 通过 WebSocket + Token 连接 OpenClaw Gateway
- 支持房间问答（`一个房间绑定一个 agent`）
- 支持流式回复（`delta` / `final`）
- 助手消息支持 Markdown 渲染
- 输入区支持粘贴图片、拖拽上传、图片预览
- 上传附件保存到项目目录
- 房间配置保存到项目目录，可跨设备共享
- 手机端使用底部弹层切换房间
- 连接成功后顶部连接栏自动折叠，节省空间

### 技术栈

- React 19 + TypeScript
- Vite 7
- `react-markdown` + `remark-gfm`
- 原生 WebSocket Gateway 协议客户端
- Vite 中间件 API（上传 / 房间配置 / 网关代理）

### 目录说明

- `src/lib/openclawGateway.ts`：Gateway 传输与协议消息
- `src/hooks/useOpenClawChat.ts`：连接、会话、对话状态与流式处理
- `src/App.tsx`：房间 UI、聊天 UI、上传交互、响应式布局
- `vite.config.ts`：
  - `/api/uploads` 上传接口
  - `/api/rooms` 房间配置接口
  - `/api/gateway/ws` WebSocket 反向代理

### 环境要求

- Node.js 18+（推荐 20+）
- npm 9+
- 本地运行中的 OpenClaw Gateway（默认 `ws://127.0.0.1:18789`）
- 可用 Gateway Token

### 安装

```bash
npm install
cp .env.example .env
```

### 配置

编辑 `.env`：

```env
VITE_OPENCLAW_WS_URL=ws://127.0.0.1:18789
VITE_OPENCLAW_TOKEN=your_openclaw_token_here
```

可选代理配置（Vite 服务转发到本机 Gateway）：

```env
# OPENCLAW_GATEWAY_WS_URL=ws://127.0.0.1:18789
# OPENCLAW_GATEWAY_WS_ORIGIN=http://127.0.0.1:18789
```

### 启动

```bash
npm run dev
```

访问：

- `http://localhost:5173`
- 或手机访问 `http://<局域网IP>:5173`

### 局域网访问（Gateway 仅 localhost）

当 Gateway 只监听本机但网页从其他设备打开时：

- 保证前端可通过局域网访问
- 在页面中使用代理地址：`ws://<主机IP>:5173/api/gateway/ws`
- 如果 Gateway 做了 Origin 校验，配置 `OPENCLAW_GATEWAY_WS_ORIGIN`

### 数据存储位置

项目根目录 `uploads/` 下：

- `uploads/files/`：上传文件
- `uploads/uploads-log.jsonl`：上传日志
- `uploads/rooms.json`：共享房间配置
- `uploads/rooms-backups/`：房间配置自动备份

### 房间机制

- `main` 房间始终存在
- 每个房间绑定一个 agent
- 切换房间会切换对应 agent 会话
- 房间列表通过 `uploads/rooms.json` 跨设备共享
- localStorage 仅作为客户端缓存与旧版本迁移来源

### 构建 / 预览 / 检查

```bash
npm run build
npm run preview
npm run lint
```

### 常见问题

- 上传或房间接口 `HTTP 404`：
  - 请用 `npm run dev` 或 `npm run preview` 启动（中间件接口由 Vite 提供）
- 手机只看到 `main`：
  - 检查 `uploads/rooms.json` 是否包含完整房间
  - 桌面端刷新一次触发同步
- 对话无回复：
  - 检查 URL、Token、Gateway 运行状态
  - 检查 ws 代理目标和 Origin 配置

### 安全建议

- 不要提交真实 Token
- `.env` 仅本地使用
- 建议使用最小权限 Token
