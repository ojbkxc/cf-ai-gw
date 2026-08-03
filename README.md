# cf-ai-gw

将 Cloudflare Workers AI 转成 OpenAI / Anthropic 兼容 API 的网关，单账号 AI Binding 直连，自带管理面板。

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR_GITHUB_USERNAME/cf-ai-gw)

## 一键部署

1. 点击上方的 **Deploy to Cloudflare Workers** 按钮
2. 授权 GitHub 登录 Cloudflare
3. 仓库会自动 fork 到你账号下，Workers 会自动部署
4. 部署完成后，在 Cloudflare Dashboard 中配置以下两项：
   - **KV 命名空间**：创建一个 KV，绑定名为 `KV`
   - **环境变量**：修改 `ADMIN_PASSWORD` 为你的密码

## 手动部署

```bash
# 1. 安装 wrangler
npm install -g wrangler

# 2. 登录
wrangler login

# 3. 创建 KV 命名空间
wrangler kv:namespace create KV

# 4. 将返回的 id 填入 wrangler.toml 的 YOUR_KV_NAMESPACE_ID

# 5. 修改 wrangler.toml 中的 ADMIN_PASSWORD

# 6. 部署
wrangler deploy
```

## 配置说明

| 配置项 | 位置 | 说明 |
|--------|------|------|
| `ADMIN_PASSWORD` | wrangler.toml `[vars]` | 管理面板登录密码（必填） |
| `KV` | wrangler.toml `[[kv_namespaces]]` | KV 命名空间绑定，名称必须为 `KV` |
| `AI` | wrangler.toml `[ai]` | Workers AI 绑定，自动生效 |

### 可选环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DAILY_LIMIT` | 10000 | 每日 token 限额 |
| `MONTHLY_LIMIT` | 100000 | 每月 token 限额 |
| `USAGE_THRESHOLD` | 0 | 限额拦截阈值（0=仅统计不拦截） |
| `OVERSIZE_TOKENS` | 200000 | 请求过大 token 闸（0=关闭） |
| `CB_WINDOW_MS` | 10000 | 熔断器窗口（毫秒） |
| `CB_FAIL_THRESHOLD` | 8 | 熔断器失败阈值 |
| `CB_COOLDOWN_MS` | 4000 | 熔断器冷却时间（毫秒） |
| `MODEL_DOWN_FAILS` | 3 | 模型断供判死连续失败数 |
| `MODEL_DOWN_AFTER_MS` | 60000 | 模型断供判死持续时间（毫秒） |

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
| ... | 更多见 `src/index.js` DEFAULT_MODEL_MAP |

## 特性

- **AI Binding 直连**：通过 `env.AI.run()` 内部 RPC 调用，无 HTTP/TLS 开销
- **熔断器**：短时间内容量失败过多自动开闸快速失败
- **模型断供闩**：连续 4006 错误自动跳过重试
- **过大闸**：CJK 感知的 token 估算，拒绝超大请求
- **友好报错**：将 Workers AI 错误码翻译为中文提示
- **SSE 流式**：OpenAI / Anthropic 双协议流式支持，10 秒 ping 保活
- **管理面板**：用量统计、API Key 管理、模型映射配置