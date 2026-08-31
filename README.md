# cf-ai-gw

将 Cloudflare Workers AI 转成 OpenAI / Anthropic 兼容 API 的网关，自带管理面板。支持多账号负载均衡、故障自动切换。

## 部署模式

| 模式 | 入口文件 | 调用方式 | 账号模式 | 规避检查 |
|------|---------|---------|---------|---------|
| **模式 A：Worker + AI Binding** | `src/index.js` | `env.AI.run()` 内部 RPC | 单账号 | ⭐⭐⭐ 最佳 |
| **模式 B：Worker + REST API** | `_worker.js` | `fetch()` 公网 REST | 多账号 failover | ⭐⭐ 良好 |

## 快速部署（推荐）

### 1. 创建 Worker 项目

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages**
2. 点 **创建应用程序** → 切到 **Worker** 标签 → **Import a repository** → **开始使用**
3. 授权 GitHub，选择 `cf-ai-gw` 仓库，分支 `main`
4. 保存并部署

### 2. 配置绑定和环境变量

部署完成后，进入 Worker 的 **Settings**：

| 配置项 | 位置 | 说明 |
|--------|------|------|
| KV 绑定 | Settings → **Bindings** | 添加 KV 命名空间，Variable name 填 `KV` |
| `ADMIN_PASSWORD` | Settings → **Variables & Secrets** | 管理面板登录密码（必填） |

> **注意**：`wrangler.toml` 已精简，不再包含 KV/AI/环境变量配置。所有绑定和变量均在 Dashboard 中配置，推代码不会覆盖。

### 3. 配置 Cloudflare 账号（模式 B）

1. 访问 Worker 地址，打开 `/admin` 管理面板
2. 输入 `ADMIN_PASSWORD` 登录
3. 在「账号管理」中添加 Cloudflare 账号：
   - **Account ID**：Cloudflare 账号 ID
   - **API Token**：有 Workers AI 权限的 API Token
   - **名称**：任意，用于区分多个账号

> 支持添加多个账号，自动负载均衡和故障切换。账号信息以明文存储在 KV 中。

### 4. 创建 API Key

在管理面板的「API Key」中创建 Key，客户端调用时使用：

```bash
curl https://cf-ai-gw.YOUR_SUBDOMAIN.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <API_KEY>" \
  -d '{"model": "glm-4.7-flash", "messages": [{"role": "user", "content": "你好"}]}'
```

## 切换模式

编辑 `wrangler.toml` 修改 `main` 字段后推送即可：

```toml
# 模式 A：Worker + AI Binding（需在 Dashboard 添加 AI Binding）
main = "src/index.js"

# 模式 B：Worker + REST API（多账号 failover）
main = "_worker.js"
```

## 模式对比

| 维度 | 模式 A（Binding） | 模式 B（REST） |
|------|-------------------|----------------|
| 调用路径 | Worker → AI Binding RPC → Workers AI | Worker → 公网 HTTPS → api.cloudflare.com |
| 认证方式 | Worker 账号自动认证 | API Token 显式认证 |
| HTTP 开销 | 无 TLS / 无网关跳转 | 每次请求经 Cloudflare 网关 |
| 账号管理 | 单账号（绑定即账号） | 多账号 failover（KV 存 Token） |
| 风控规避 | ⭐⭐⭐ 内部 RPC，不触发网关检测 | ⭐⭐ 默认 Worker UA + 串行请求 + 退避重试 |
| 用量查询 | 无需 | 调 GraphQL 拉取 Neurons |
| 模型列表 | 仅 `@cf/` 开头，按 token 降序 | 全部映射模型，按 token 降序 |
| 安全增强 | 熔断器 + 断供闩 + 过大闸 | 多账号 failover + 可恢复流 |

## API 端点

### OpenAI 兼容

| 端点 | 方法 |
|------|------|
| `/v1/chat/completions` | POST |
| `/v1/completions` | POST |
| `/v1/embeddings` | POST |
| `/v1/models` | GET |
| `/v1/models/{model}` | GET |
| `/v1/images/generations` | POST |
| `/v1/audio/transcriptions` | POST |
| `/v1/audio/translations` | POST |
| `/v1/audio/speech` | POST |

### Anthropic 兼容

| 端点 | 方法 |
|------|------|
| `/v1/messages` | POST |
| `/v1/messages/count_tokens` | POST |

### 管理面板

| 端点 | 说明 |
|------|------|
| `/admin` | 可视化管理面板 |
| `/api/auth/login` | 登录 |
| `/api/tokens/today` | 今日 Token 统计 |
| `/api/usage/summary` | 用量汇总 |
| `/api/keys` | API Key 管理 |
| `/api/settings` | 模型映射配置 |
| `/api/limits` | 限额配置 |
| `/api/accounts` | 账号管理（仅模式 B） |
| `/api/models/search` | 搜索 CF 可用模型（仅模式 B） |

## 可选环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DAILY_LIMIT` | 10000 | 每日 token 限额 |
| `MONTHLY_LIMIT` | 100000 | 每月 token 限额 |
| `USAGE_THRESHOLD` | 0 | 限额拦截阈值（0=仅统计不拦截） |
| `OVERSIZE_TOKENS` | 200000 | 请求过大 token 闸（仅模式 A） |
| `CB_WINDOW_MS` | 10000 | 熔断器窗口（毫秒，仅模式 A） |
| `CB_FAIL_THRESHOLD` | 8 | 熔断器失败阈值（仅模式 A） |
| `CB_COOLDOWN_MS` | 4000 | 熔断器冷却时间（毫秒，仅模式 A） |
| `MODEL_DOWN_FAILS` | 3 | 模型断供判死连续失败数（仅模式 A） |
| `MODEL_DOWN_AFTER_MS` | 60000 | 模型断供判死持续时间（毫秒，仅模式 A） |

## 内置模型

管理面板中可自定义模型映射，内置默认映射如下。`/v1/models` 端点按 token 上限从大到小排序返回。

### 文本生成模型

| 模型名 | Cloudflare 模型 | Tokens |
|--------|----------------|--------|
| `deepseek-v4-pro-0813` | `@cf/deepseek-ai/deepseek-v4-pro-0813` | 1,048,576 |
| `deepseek-v4-flash-0731` | `@cf/deepseek-ai/deepseek-v4-flash-0731` | 1,310,720 |
| `glm-5.3` | `@cf/zai-org/glm-5.3` | 1,048,576 |
| `glm-5.3-flash` | `@cf/zai-org/glm-5.3-flash` | 1,048,576 |
| `glm-5.2` | `@cf/zai-org/glm-5.2` | 262,144 |
| `kimi-k2.7-code` | `@cf/moonshotai/kimi-k2.7-code` | 262,144 |
| `kimi-k2.6` | `@cf/moonshotai/kimi-k2.6` | 262,144 |
| `nemotron-3-120b-a12b` | `@cf/nvidia/nemotron-3-120b-a12b` | 256,000 |
| `glm-4.7-flash` | `@cf/zai-org/glm-4.7-flash` | 131,072 |
| `gemma-4-26b-a4b-it` | `@cf/google/gemma-4-26b-a4b-it` | 131,072 |
| `gemma-sea-lion-v4-27b-it` | `@cf/aisingapore/gemma-sea-lion-v4-27b-it` | 131,072 |
| `llama-3.1-8b-instruct-fast` | `@cf/meta/llama-3.1-8b-instruct-fast` | 131,072 |
| `llama-3.2-1b-instruct` | `@cf/meta/llama-3.2-1b-instruct` | 131,072 |
| `llama-3.2-11b-vision-instruct` | `@cf/meta/llama-3.2-11b-vision-instruct` | 131,072 |
| `llama-4-scout-17b-16e-instruct` | `@cf/meta/llama-4-scout-17b-16e-instruct` | 131,000 |
| `qwen3.8-27b` | `@cf/qwen/qwen3.8-27b` | 131,072 |
| `mistral-small-3.1-24b-instruct` | `@cf/mistral/mistral-small-3.1-24b-instruct` | 131,072 |
| `granite-4.0-h-micro` | `@cf/ibm/granite-4.0-h-micro` | 131,072 |
| `qwen3-30b-a3b-fp8` | `@cf/qwen/qwen3-30b-a3b-fp8` | 32,768 |
| `qwq-32b` | `@cf/qwen/qwq-32b` | 32,768 |
| `llama-3.3-70b-instruct-fp8-fast` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 24,000 |
| `gpt-oss-20b` | `@cf/openai/gpt-oss-20b` | — |
| `gpt-oss-120b` | `@cf/openai/gpt-oss-120b` | — |
| `llama-3.2-3b` | `@cf/meta/llama-3.2-3b-instruct` | — |

### 向量嵌入模型

| 模型名 | Cloudflare 模型 |
|--------|----------------|
| `embeddinggemma-300m` | `@cf/google/embeddinggemma-300m` |
| `qwen3-embedding-0.6b` | `@cf/qwen/qwen3-embedding-0.6b` |
| `bge-m3` | `@cf/baai/bge-m3` |
| `bge-large-en` | `@cf/baai/bge-large-en-v1.5` |
| `bge-base-en-v1.5` | `@cf/baai/bge-base-en-v1.5` |
| `bge-reranker-base` | `@cf/baai/bge-reranker-base` |

### 多模态模型

| 模型名 | Cloudflare 模型 |
|--------|----------------|
| `llava-1.5-7b` | `@cf/llava-hf/llava-1.5-7b-hf` |
| `moondream3.1-9B-A2B` | `@cf/moondream/moondream3.1-9B-A2B` |
| `flux-1-schnell` | `@cf/black-forest-labs/flux-1-schnell` |
| `flux` | `@cf/deepgram/flux` |
| `sdxl` | `@cf/stabilityai/stable-diffusion-xl-base-1.0` |

### 语音模型

| 模型名 | Cloudflare 模型 |
|--------|----------------|
| `whisper` | `@cf/openai/whisper` |
| `whisper-tiny-en` | `@cf/openai/whisper-tiny-en` |
| `whisper-large-v3-turbo` | `@cf/openai/whisper-large-v3-turbo` |
| `nova-3` | `@cf/deepgram/nova-3` |
| `tts` | `@cf/myshell-ai/tts` |
| `aura-2-en` | `@cf/deepgram/aura-2-en` |

> `owned_by` 字段由 `getModelOwnedBy` 从 `@cf/` 路径自动提取（如 `@cf/meta/xxx` → `meta`），无需维护前缀表。完整列表见代码中的 `DEFAULT_MODEL_MAP`。