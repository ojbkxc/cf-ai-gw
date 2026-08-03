# cf-ai-gw

将 Cloudflare Workers AI 转成 OpenAI / Anthropic 兼容 API 的网关，自带管理面板。

支持两种部署模式，按需选择其一即可，API 行为完全一致（客户端无感切换）。

| 模式 | 入口文件 | 调用方式 | 账号模式 | 规避检查 |
|------|---------|---------|---------|---------|
| **模式 A：Worker + AI Binding（推荐）** | `src/index.js` | `env.AI.run()` 内部 RPC | 单账号 | ⭐⭐⭐ 最佳 |
| **模式 B：Worker + REST API** | `_worker.js` | `fetch()` 公网 REST | 多账号 failover | ⭐ 一般 |

## 一键部署

两个按钮均可直接部署，Cloudflare 会自动 fork 仓库到你的 GitHub 账号并部署，无需手动绑定。

### 模式 A：Worker + AI Binding（推荐，规避检查）

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ojbkxc/cf-ai-gw)

> 使用 `main` 分支部署。调用不经公网，Cloudflare 网关无法识别为代理。

### 模式 B：Worker + REST API（多账号 failover）

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ojbkxc/cf-ai-gw/tree/deploy-rest)

> 使用 `deploy-rest` 分支部署。支持多账号轮换，但调用经公网 HTTPS。

> **注意**：模式 B 按钮需要仓库存在 `deploy-rest` 分支。如尚未创建，请仓库维护者运行：
> ```bash
> bash create-deploy-rest-branch.sh
> git push origin deploy-rest
> ```

## 两种模式对比

| 维度 | Worker + Binding（`src/index.js`） | REST API（`_worker.js`） |
|------|-----------------------------------|------------------------|
| 调用路径 | Worker → AI Binding RPC → Workers AI | Worker → 公网 HTTPS → `api.cloudflare.com` |
| 认证方式 | Worker 账号自动认证，无 API Token | 显式 `Authorization: Bearer <token>` |
| HTTP 开销 | 无 TLS / 无网关跳转 | 每次请求经 Cloudflare 网关 |
| 账号管理 | 单账号（绑定即账号） | 多账号 failover（KV 存 Token） |
| 风控规避 | ⭐⭐⭐ 内部 RPC，不被网关识别为外部调用 | ⭐ 公网 REST，易被识别为代理转发 |
| 用量查询 | 无需（无 GraphQL） | 需调 GraphQL 拉取 Neurons |
| 部署目标 | Cloudflare Workers | Cloudflare Workers 或 Pages Functions |
| 模型列表 | 仅 `@cf/` 开头 | 全部映射模型 |
| 安全增强 | 熔断器 + 断供闩 + 过大闸 | 仅 failover 重试 |
| 错误提示 | 中文友好提示 | 英文原始消息 |

### 规避 Cloudflare 检查

- **Worker + Binding 模式**：调用不经过公网 HTTP，Cloudflare 网关仅看到一次内部 RPC，无法通过流量特征识别为代理
- **REST API 模式**：每次调用都是 `api.cloudflare.com` 的公网 HTTPS 请求，频率高时容易被识别为代理转发，建议配合多账号轮换降低单账号频率

## 一键部署步骤

1. 点击上方任一部署按钮
2. 授权 GitHub 登录 Cloudflare
3. 仓库会自动 fork 到你账号下；部署前请先参考下方「手动部署」创建 KV 命名空间 `cf-ai-gw` 并填入 `wrangler.toml` / Dashboard 绑定
4. 部署完成后，在 Cloudflare Dashboard 中修改环境变量 `ADMIN_PASSWORD` 为你的密码

## 手动部署

### 模式 A：Worker + AI Binding（推荐）

```bash
# 1. 安装 wrangler
npm install -g wrangler

# 2. 登录
wrangler login

# 3. 创建 KV 命名空间（名称随意，只记 ID）
wrangler kv:namespace create cf-ai-gw

# 4. 将返回的 id 填入 wrangler.toml 的 YOUR_KV_NAMESPACE_ID

# 5. 修改 wrangler.toml 中的 ADMIN_PASSWORD

# 6. 部署（入口自动指向 src/index.js）
wrangler deploy
```

### 模式 B：Pages / Worker + REST API（多账号）

```bash
# 1. 安装 wrangler
npm install -g wrangler

# 2. 登录
wrangler login

# 3. 创建 KV 命名空间
wrangler kv:namespace create cf-ai-gw

# 4. 将返回的 id 填入 wrangler.toml 的 YOUR_KV_NAMESPACE_ID

# 5. 修改 wrangler.toml：
#    - main = "_worker.js"
#    - 注释 [ai] binding（REST 模式不需要）
#    - 修改 ADMIN_PASSWORD

# 6. 登录管理面板，在「账号管理」中添加 Cloudflare 账号
#    （填写 Account ID + API Token，支持多账号负载均衡）

# 7. 部署
wrangler deploy
```

## 切换模式

编辑 `wrangler.toml`，修改 `main` 字段即可：

```toml
# 模式 A：Worker + AI Binding（推荐，规避检查）
name = "cf-ai-gw"
main = "src/index.js"

[ai]
binding = "AI"

# 模式 B：REST API（多账号 failover）
# name = "cf-ai-gw"
# main = "_worker.js"
# （注释掉 [ai] binding）
```

切换模式后重新 `wrangler deploy` 即可，客户端无需任何改动。

## 配置说明

### 通用配置

| 配置项 | 位置 | 说明 |
|--------|------|------|
| `ADMIN_PASSWORD` | wrangler.toml `[vars]` | 管理面板登录密码（必填） |
| `KV` | wrangler.toml `[[kv_namespaces]]` | KV 命名空间绑定，绑定名必须为 `KV` |

### 模式 A 专属

| 配置项 | 位置 | 说明 |
|--------|------|------|
| `AI` | wrangler.toml `[ai]` | Workers AI 绑定，自动生效，无需配置 Token |

### 模式 B 专属

| 配置项 | 位置 | 说明 |
|--------|------|------|
| Cloudflare 账号 | 管理面板「账号管理」 | Account ID + API Token，支持多账号 |

### 可选环境变量（两种模式通用）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DAILY_LIMIT` | 10000 | 每日 token 限额 |
| `MONTHLY_LIMIT` | 100000 | 每月 token 限额 |
| `USAGE_THRESHOLD` | 0 | 限额拦截阈值（0=仅统计不拦截） |
| `OVERSIZE_TOKENS` | 200000 | 请求过大 token 闸（0=关闭，仅模式 A 生效） |
| `CB_WINDOW_MS` | 10000 | 熔断器窗口（毫秒，仅模式 A） |
| `CB_FAIL_THRESHOLD` | 8 | 熔断器失败阈值（仅模式 A） |
| `CB_COOLDOWN_MS` | 4000 | 熔断器冷却时间（毫秒，仅模式 A） |
| `MODEL_DOWN_FAILS` | 3 | 模型断供判死连续失败数（仅模式 A） |
| `MODEL_DOWN_AFTER_MS` | 60000 | 模型断供判死持续时间（毫秒，仅模式 A） |

## API 端点

两种模式的 API 端点完全一致，客户端无需区分。

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

## 调用示例

```bash
curl https://cf-ai-gw.YOUR_SUBDOMAIN.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <面板中创建的API Key>" \
  -d '{
    "model": "glm-5.2",
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

## 内置模型

管理面板中可自定义模型映射，内置默认映射：

| 模型名 | Cloudflare 模型 |
|--------|----------------|
| `glm-5.2` | `@cf/zai-org/glm-5.2` |
| `glm-4.7-flash` | `@cf/zai-org/glm-4.7-flash` |
| `kimi-k2.7-code` | `@cf/moonshotai/kimi-k2.7-code` |
| `kimi-k2.6` | `@cf/moonshotai/kimi-k2.6` |
| `gemma-4-26b-a4b-it` | `@cf/google/gemma-4-26b-a4b-it` |
| `deepseek-r1-distill-qwen-32b` | `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` |
| `llama-3.1-8b` | `@cf/meta/llama-3.1-8b-instruct` |
| ... | 更多见 `src/index.js` 或 `_worker.js` 的 `DEFAULT_MODEL_MAP` |

> **注意**：模式 A（Binding）的 `/v1/models` 仅返回 `@cf/` 开头的模型；模式 B（REST）返回全部映射模型。

## 特性

### 两种模式共有

- **OpenAI / Anthropic 兼容**：同一套 API 端点，客户端无感切换
- **SSE 流式**：双协议流式支持，10 秒 ping 保活
- **管理面板**：用量统计、API Key 管理、模型映射配置、限额配置
- **用量统计**：Token 级别的输入/输出/推理/缓存统计
- **CSRF 防护**：管理面板写操作需携带 CSRF Token

### 模式 A 专属（Worker + Binding）

- **AI Binding 直连**：通过 `env.AI.run()` 内部 RPC 调用，无 HTTP/TLS 开销
- **熔断器**：短时间内容量失败过多自动开闸快速失败
- **模型断供闩**：连续 4006 错误自动跳过重试
- **过大闸**：CJK 感知的 token 估算，拒绝超大请求
- **友好报错**：将 Workers AI 错误码翻译为中文提示

### 模式 B 专属（REST API）

- **多账号 failover**：账号轮换 + 故障自动切换，每账号最多重试 3 次
- **可恢复流**：`createResumableStream` 机制，流中断后自动重连
- **GraphQL 用量查询**：从 Cloudflare Analytics 拉取 Neurons 用量
- **用量缓存**：10 分钟缓存 + 3 并发限制，降低风控触发概率
