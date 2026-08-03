// 升级版独享中转：原生绑定 + 三协议 + 默认开思考·推理透传 + 友好报错 + 25万上下文
// 新增：自管钥匙/有效期/有效次数/已用/成功率（存 KV）+ 客户自查页 /usage + 遥控口 /admin/api/*
// 数据存在 KV(STORE) 的单条记录 "acct"。
//
// 本版优化（聚焦客户使用稳定性）：
//   · 真·token 级流式（上游 stream:true + ReadableStream 实时改写）
//   · 首 token 纳入重试：开场帧延迟到拿到第一个 token 才发，pre-token 失败可无损重试/干净报错
//   · 503 带 Retry-After，客户端可自动退避重试
//   · SSE 心跳 + 看门狗超时：大上下文静默期保活，上游卡死可中止
//   · 流式中断补发协议错误帧（OpenAI / Claude / Responses 各自格式）
//   · 客户端断开时主动 abort 上游，停止生成、省容量省钱
//   · 模型白名单：非白名单 model 一律回落默认模型，杜绝越权调用任意 Workers AI 模型
//   · count_tokens 中文加权；stream_options.include_usage 支持
//   · 默认开启思考：推理走独立 reasoning_content 字段，分离透传（OpenAI reasoning_content / Claude thinking 块 /
//     Responses reasoning 项），正文 content 保持干净；客户端可显式关闭

const MODELS = {
  "glm-5.2": "@cf/zai-org/glm-5.2",
  "kimi-k2.7-code": "@cf/moonshotai/kimi-k2.7-code",
};
const PUBLIC_MODELS = ["glm-5.2", "kimi-k2.7-code"];
const ALLOWED_MODELS = new Set(Object.values(MODELS)); // 允许直传的完整模型 ID
const DEFAULT_MODEL = "@cf/zai-org/glm-5.2";
const MAX_OUTPUT = 8192;
const REC_KEY = "acct";
const SENTINEL_SCHEMA_VERSION = 1;
// rate_limited_3021 从 capacity_3040 里拆出来：两者处置完全不同——3040 是账号容量(换号/等)，
// 3021 是每分钟推理限速(该号该开 GLOBAL_RPM_LIMIT 全局令牌桶)。混在一个桶里就看不出该开闸。
const SENTINEL_ERROR_CLASSES = new Set(["none", "capacity_3040", "rate_limited_3021", "context_5021", "connect_stall", "prefill_timeout", "upstream_stalled", "gate_full", "circuit_open", "auth", "client_abort", "gate_oversize", "unknown"]);
const SETUP_PS1_BASE64 = "W0NtZGxldEJpbmRpbmcoKV0KcGFyYW0oCiAgICBbVmFsaWRhdGVTZXQoInpjb2RlIiwgImNsYXVkZSIsICJvcGVuYWkiLCAiYWxsIildCiAgICBbc3RyaW5nXSRUYXJnZXQgPSAiIiwKICAgIFtzdHJpbmddJEJhc2VVcmwgPSAie3tSRUxBWV9VUkx9fSIsCiAgICBbc3RyaW5nXSRBcGlLZXkgPSAiIiwKICAgIFtzdHJpbmddJEhvbWVEaXJlY3RvcnkgPSAkSE9NRQopCgpTZXQtU3RyaWN0TW9kZSAtVmVyc2lvbiBMYXRlc3QKJEVycm9yQWN0aW9uUHJlZmVyZW5jZSA9ICJTdG9wIgoKZnVuY3Rpb24gU2V0LUpzb25Qcm9wZXJ0eSB7CiAgICBwYXJhbShbb2JqZWN0XSRPYmplY3QsIFtzdHJpbmddJE5hbWUsIFtvYmplY3RdJFZhbHVlKQogICAgJHByb3BlcnR5ID0gJE9iamVjdC5QU09iamVjdC5Qcm9wZXJ0aWVzWyROYW1lXQogICAgaWYgKCRudWxsIC1lcSAkcHJvcGVydHkpIHsKICAgICAgICAkT2JqZWN0IHwgQWRkLU1lbWJlciAtTm90ZVByb3BlcnR5TmFtZSAkTmFtZSAtTm90ZVByb3BlcnR5VmFsdWUgJFZhbHVlCiAgICB9IGVsc2UgewogICAgICAgICRwcm9wZXJ0eS5WYWx1ZSA9ICRWYWx1ZQogICAgfQp9CgpmdW5jdGlvbiBSZW1vdmUtSnNvblByb3BlcnR5IHsKICAgIHBhcmFtKFtvYmplY3RdJE9iamVjdCwgW3N0cmluZ10kTmFtZSkKICAgIGlmICgkbnVsbCAtbmUgJE9iamVjdC5QU09iamVjdC5Qcm9wZXJ0aWVzWyROYW1lXSkgewogICAgICAgICRPYmplY3QuUFNPYmplY3QuUHJvcGVydGllcy5SZW1vdmUoJE5hbWUpCiAgICB9Cn0KCmZ1bmN0aW9uIFJlYWQtSnNvbkZpbGUgewogICAgcGFyYW0oW3N0cmluZ10kUGF0aCkKICAgIGlmICgtbm90IChUZXN0LVBhdGggLUxpdGVyYWxQYXRoICRQYXRoKSkgewogICAgICAgIHJldHVybiBbcHNjdXN0b21vYmplY3RdQHt9CiAgICB9CiAgICB0cnkgewogICAgICAgIHJldHVybiBHZXQtQ29udGVudCAtUmF3IC1FbmNvZGluZyBVVEY4IC1MaXRlcmFsUGF0aCAkUGF0aCB8IENvbnZlcnRGcm9tLUpzb24KICAgIH0gY2F0Y2ggewogICAgICAgIHRocm93ICLphY3nva7mlofku7bkuI3mmK/lkIjms5VKU09O77yM5pyq5L2c5L+u5pS577yaJFBhdGgiCiAgICB9Cn0KCmZ1bmN0aW9uIEJhY2t1cC1GaWxlIHsKICAgIHBhcmFtKFtzdHJpbmddJFBhdGgpCiAgICBpZiAoVGVzdC1QYXRoIC1MaXRlcmFsUGF0aCAkUGF0aCkgewogICAgICAgICRzdGFtcCA9IEdldC1EYXRlIC1Gb3JtYXQgInl5eXlNTWRkLUhIbW1zcyIKICAgICAgICAkYmFja3VwID0gIiRQYXRoLmJhY2t1cC4kc3RhbXAiCiAgICAgICAgQ29weS1JdGVtIC1MaXRlcmFsUGF0aCAkUGF0aCAtRGVzdGluYXRpb24gJGJhY2t1cCAtRm9yY2UKICAgICAgICBXcml0ZS1Ib3N0ICLlt7LlpIfku73vvJokYmFja3VwIiAtRm9yZWdyb3VuZENvbG9yIERhcmtHcmF5CiAgICB9Cn0KCmZ1bmN0aW9uIFNhdmUtSnNvbkZpbGUgewogICAgcGFyYW0oW3N0cmluZ10kUGF0aCwgW29iamVjdF0kVmFsdWUpCiAgICAkZGlyZWN0b3J5ID0gU3BsaXQtUGF0aCAtUGFyZW50ICRQYXRoCiAgICBOZXctSXRlbSAtSXRlbVR5cGUgRGlyZWN0b3J5IC1Gb3JjZSAtUGF0aCAkZGlyZWN0b3J5IHwgT3V0LU51bGwKICAgICRqc29uID0gJFZhbHVlIHwgQ29udmVydFRvLUpzb24gLURlcHRoIDEwMAogICAgJHV0ZjggPSBOZXctT2JqZWN0IFN5c3RlbS5UZXh0LlVURjhFbmNvZGluZygkZmFsc2UpCiAgICBbU3lzdGVtLklPLkZpbGVdOjpXcml0ZUFsbFRleHQoJFBhdGgsICRqc29uICsgW0Vudmlyb25tZW50XTo6TmV3TGluZSwgJHV0ZjgpCn0KCmZ1bmN0aW9uIE5vcm1hbGl6ZS1CYXNlVXJsIHsKICAgIHBhcmFtKFtzdHJpbmddJFZhbHVlKQogICAgJHZhbHVlID0gJFZhbHVlLlRyaW0oKS5UcmltRW5kKCcvJykKICAgIGlmICgkdmFsdWUuRW5kc1dpdGgoJy92MScsIFtTeXN0ZW0uU3RyaW5nQ29tcGFyaXNvbl06Ok9yZGluYWxJZ25vcmVDYXNlKSkgewogICAgICAgICR2YWx1ZSA9ICR2YWx1ZS5TdWJzdHJpbmcoMCwgJHZhbHVlLkxlbmd0aCAtIDMpLlRyaW1FbmQoJy8nKQogICAgfQogICAgJHVyaSA9ICRudWxsCiAgICBpZiAoLW5vdCBbVXJpXTo6VHJ5Q3JlYXRlKCR2YWx1ZSwgW1VyaUtpbmRdOjpBYnNvbHV0ZSwgW3JlZl0kdXJpKSAtb3IKICAgICAgICAoJHVyaS5TY2hlbWUgLW5lICdodHRwcycgLWFuZCAkdXJpLlNjaGVtZSAtbmUgJ2h0dHAnKSkgewogICAgICAgIHRocm93ICLmjqXlj6PlnLDlnYDmoLzlvI/plJnor6/vvIzor7fovpPlhaXnsbvkvLwgaHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20g55qE5Zyw5Z2AIgogICAgfQogICAgcmV0dXJuICR2YWx1ZQp9CgpmdW5jdGlvbiBSZWFkLVNlY3JldFRleHQgewogICAgJHNlY3VyZSA9IFJlYWQtSG9zdCAi6K+36L6T5YWlQVBJIEtleSIgLUFzU2VjdXJlU3RyaW5nCiAgICAkcG9pbnRlciA9IFtSdW50aW1lLkludGVyb3BTZXJ2aWNlcy5NYXJzaGFsXTo6U2VjdXJlU3RyaW5nVG9CU1RSKCRzZWN1cmUpCiAgICB0cnkgewogICAgICAgIHJldHVybiBbUnVudGltZS5JbnRlcm9wU2VydmljZXMuTWFyc2hhbF06OlB0clRvU3RyaW5nQlNUUigkcG9pbnRlcikKICAgIH0gZmluYWxseSB7CiAgICAgICAgW1J1bnRpbWUuSW50ZXJvcFNlcnZpY2VzLk1hcnNoYWxdOjpaZXJvRnJlZUJTVFIoJHBvaW50ZXIpCiAgICB9Cn0KCmZ1bmN0aW9uIENvbmZpZ3VyZS1aQ29kZSB7CiAgICBwYXJhbShbc3RyaW5nXSRSb290VXJsLCBbc3RyaW5nXSRLZXksIFtzdHJpbmddJFVzZXJIb21lKQoKICAgICRjb25maWdQYXRoID0gSm9pbi1QYXRoICRVc2VySG9tZSAiLnpjb2RlXHYyXGNvbmZpZy5qc29uIgogICAgQmFja3VwLUZpbGUgJGNvbmZpZ1BhdGgKICAgICRjb25maWcgPSBSZWFkLUpzb25GaWxlICRjb25maWdQYXRoCgogICAgaWYgKCRudWxsIC1lcSAkY29uZmlnLlBTT2JqZWN0LlByb3BlcnRpZXNbJ3Byb3ZpZGVyJ10pIHsKICAgICAgICBTZXQtSnNvblByb3BlcnR5ICRjb25maWcgJ3Byb3ZpZGVyJyAoW3BzY3VzdG9tb2JqZWN0XUB7fSkKICAgIH0KICAgICRwcm92aWRlcnMgPSAkY29uZmlnLnByb3ZpZGVyCiAgICBpZiAoJHByb3ZpZGVycyAtaXNub3QgW1N5c3RlbS5NYW5hZ2VtZW50LkF1dG9tYXRpb24uUFNDdXN0b21PYmplY3RdKSB7CiAgICAgICAgdGhyb3cgIlpDb2Rl6YWN572u5Lit55qEcHJvdmlkZXLlrZfmrrXmoLzlvI/lvILluLjvvIzmnKrkvZzkv67mlLnvvJokY29uZmlnUGF0aCIKICAgIH0KCiAgICAkZXhpc3RpbmcgPSAkcHJvdmlkZXJzLlBTT2JqZWN0LlByb3BlcnRpZXMgfAogICAgICAgIFdoZXJlLU9iamVjdCB7ICRfLlZhbHVlLm5hbWUgLWVxICfnn6XmtbdBUEknIC1hbmQgJF8uVmFsdWUuc291cmNlIC1lcSAnY3VzdG9tJyB9IHwKICAgICAgICBTZWxlY3QtT2JqZWN0IC1GaXJzdCAxCgogICAgaWYgKCRudWxsIC1lcSAkZXhpc3RpbmcpIHsKICAgICAgICAkcHJvdmlkZXJJZCA9IFtHdWlkXTo6TmV3R3VpZCgpLlRvU3RyaW5nKCkKICAgICAgICAkcHJvdmlkZXIgPSBbcHNjdXN0b21vYmplY3RdQHt9CiAgICB9IGVsc2UgewogICAgICAgICRwcm92aWRlcklkID0gJGV4aXN0aW5nLk5hbWUKICAgICAgICAkcHJvdmlkZXIgPSAkZXhpc3RpbmcuVmFsdWUKICAgIH0KCiAgICBTZXQtSnNvblByb3BlcnR5ICRwcm92aWRlciAnbmFtZScgJ+efpea1t0FQSScKICAgIFNldC1Kc29uUHJvcGVydHkgJHByb3ZpZGVyICdraW5kJyAnb3BlbmFpLWNvbXBhdGlibGUnCiAgICBTZXQtSnNvblByb3BlcnR5ICRwcm92aWRlciAnb3B0aW9ucycgKFtwc2N1c3RvbW9iamVjdF1AewogICAgICAgIGFwaUtleSA9ICRLZXkKICAgICAgICBiYXNlVVJMID0gIiRSb290VXJsL3YxIgogICAgICAgIGFwaUtleVJlcXVpcmVkID0gJHRydWUKICAgIH0pCiAgICBTZXQtSnNvblByb3BlcnR5ICRwcm92aWRlciAnc291cmNlJyAnY3VzdG9tJwogICAgU2V0LUpzb25Qcm9wZXJ0eSAkcHJvdmlkZXIgJ21vZGVscycgKFtwc2N1c3RvbW9iamVjdF1AewogICAgICAgICdnbG0tNS4yJyA9IFtwc2N1c3RvbW9iamVjdF1AewogICAgICAgICAgICBsaW1pdCA9IFtwc2N1c3RvbW9iamVjdF1AeyBjb250ZXh0ID0gMjAwMDAwIH0KICAgICAgICAgICAgbW9kYWxpdGllcyA9IFtwc2N1c3RvbW9iamVjdF1AewogICAgICAgICAgICAgICAgaW5wdXQgPSBAKCd0ZXh0JykKICAgICAgICAgICAgICAgIG91dHB1dCA9IEAoJ3RleHQnKQogICAgICAgICAgICB9CiAgICAgICAgfQogICAgICAgICdraW1pLWsyLjctY29kZScgPSBbcHNjdXN0b21vYmplY3RdQHsKICAgICAgICAgICAgbGltaXQgPSBbcHNjdXN0b21vYmplY3RdQHsgY29udGV4dCA9IDIwMDAwMCB9CiAgICAgICAgICAgIG1vZGFsaXRpZXMgPSBbcHNjdXN0b21vYmplY3RdQHsKICAgICAgICAgICAgICAgIGlucHV0ID0gQCgndGV4dCcpCiAgICAgICAgICAgICAgICBvdXRwdXQgPSBAKCd0ZXh0JykKICAgICAgICAgICAgfQogICAgICAgIH0KICAgIH0pCgogICAgaWYgKCRudWxsIC1lcSAkZXhpc3RpbmcpIHsKICAgICAgICAkcHJvdmlkZXJzIHwgQWRkLU1lbWJlciAtTm90ZVByb3BlcnR5TmFtZSAkcHJvdmlkZXJJZCAtTm90ZVByb3BlcnR5VmFsdWUgJHByb3ZpZGVyCiAgICB9CgogICAgU2F2ZS1Kc29uRmlsZSAkY29uZmlnUGF0aCAkY29uZmlnCiAgICBXcml0ZS1Ib3N0ICJaQ29kZemFjee9ruWujOaIkO+8miRjb25maWdQYXRoIiAtRm9yZWdyb3VuZENvbG9yIEdyZWVuCn0KCmZ1bmN0aW9uIENvbmZpZ3VyZS1DbGF1ZGVDb2RlIHsKICAgIHBhcmFtKFtzdHJpbmddJFJvb3RVcmwsIFtzdHJpbmddJEtleSwgW3N0cmluZ10kVXNlckhvbWUpCgogICAgJHNldHRpbmdzUGF0aCA9IEpvaW4tUGF0aCAkVXNlckhvbWUgIi5jbGF1ZGVcc2V0dGluZ3MuanNvbiIKICAgIEJhY2t1cC1GaWxlICRzZXR0aW5nc1BhdGgKICAgICRzZXR0aW5ncyA9IFJlYWQtSnNvbkZpbGUgJHNldHRpbmdzUGF0aAoKICAgIGlmICgkbnVsbCAtZXEgJHNldHRpbmdzLlBTT2JqZWN0LlByb3BlcnRpZXNbJ2VudiddKSB7CiAgICAgICAgU2V0LUpzb25Qcm9wZXJ0eSAkc2V0dGluZ3MgJ2VudicgKFtwc2N1c3RvbW9iamVjdF1Ae30pCiAgICB9CiAgICAkZW52QmxvY2sgPSAkc2V0dGluZ3MuZW52CiAgICBpZiAoJGVudkJsb2NrIC1pc25vdCBbU3lzdGVtLk1hbmFnZW1lbnQuQXV0b21hdGlvbi5QU0N1c3RvbU9iamVjdF0pIHsKICAgICAgICB0aHJvdyAiQ2xhdWRlIENvZGXphY3nva7kuK3nmoRlbnblrZfmrrXmoLzlvI/lvILluLjvvIzmnKrkvZzkv67mlLnvvJokc2V0dGluZ3NQYXRoIgogICAgfQoKICAgIFJlbW92ZS1Kc29uUHJvcGVydHkgJGVudkJsb2NrICdBTlRIUk9QSUNfQVBJX0tFWScKICAgIFNldC1Kc29uUHJvcGVydHkgJGVudkJsb2NrICdBTlRIUk9QSUNfQkFTRV9VUkwnICRSb290VXJsCiAgICBTZXQtSnNvblByb3BlcnR5ICRlbnZCbG9jayAnQU5USFJPUElDX0FVVEhfVE9LRU4nICRLZXkKICAgIFNldC1Kc29uUHJvcGVydHkgJGVudkJsb2NrICdBTlRIUk9QSUNfTU9ERUwnICdnbG0tNS4yJwogICAgU2V0LUpzb25Qcm9wZXJ0eSAkZW52QmxvY2sgJ0FOVEhST1BJQ19ERUZBVUxUX09QVVNfTU9ERUwnICdnbG0tNS4yJwogICAgU2V0LUpzb25Qcm9wZXJ0eSAkZW52QmxvY2sgJ0FOVEhST1BJQ19ERUZBVUxUX1NPTk5FVF9NT0RFTCcgJ2dsbS01LjInCiAgICBTZXQtSnNvblByb3BlcnR5ICRlbnZCbG9jayAnQU5USFJPUElDX0RFRkFVTFRfSEFJS1VfTU9ERUwnICdnbG0tNS4yJwogICAgU2V0LUpzb25Qcm9wZXJ0eSAkZW52QmxvY2sgJ0NMQVVERV9DT0RFX1NVQkFHRU5UX01PREVMJyAnZ2xtLTUuMicKICAgIFNldC1Kc29uUHJvcGVydHkgJGVudkJsb2NrICdDTEFVREVfQ09ERV9FTkFCTEVfR0FURVdBWV9NT0RFTF9ESVNDT1ZFUlknICcxJwogICAgU2V0LUpzb25Qcm9wZXJ0eSAkZW52QmxvY2sgJ0NMQVVERV9DT0RFX0FVVE9fQ09NUEFDVF9XSU5ET1cnICcxODAwMDAnCiAgICBTZXQtSnNvblByb3BlcnR5ICRlbnZCbG9jayAnQ0xBVURFX0NPREVfTUFYX09VVFBVVF9UT0tFTlMnICc4MTkyJwogICAgU2V0LUpzb25Qcm9wZXJ0eSAkZW52QmxvY2sgJ0NMQVVERV9DT0RFX0RJU0FCTEVfMU1fQ09OVEVYVCcgJzEnCiAgICBTZXQtSnNvblByb3BlcnR5ICRzZXR0aW5ncyAnbW9kZWwnICdnbG0tNS4yJwoKICAgIFNhdmUtSnNvbkZpbGUgJHNldHRpbmdzUGF0aCAkc2V0dGluZ3MKICAgIFdyaXRlLUhvc3QgIkNsYXVkZSBDb2Rl6YWN572u5a6M5oiQ77yaJHNldHRpbmdzUGF0aCIgLUZvcmVncm91bmRDb2xvciBHcmVlbgp9CgpmdW5jdGlvbiBDb25maWd1cmUtT3BlbkFJIHsKICAgIHBhcmFtKFtzdHJpbmddJFJvb3RVcmwsIFtzdHJpbmddJEtleSkKCiAgICAkYmFzZSA9ICIkUm9vdFVybC92MSIKICAgIFtFbnZpcm9ubWVudF06OlNldEVudmlyb25tZW50VmFyaWFibGUoJ09QRU5BSV9BUElfS0VZJywgJEtleSwgJ1VzZXInKQogICAgW0Vudmlyb25tZW50XTo6U2V0RW52aXJvbm1lbnRWYXJpYWJsZSgnT1BFTkFJX0JBU0VfVVJMJywgJGJhc2UsICdVc2VyJykKICAgIFdyaXRlLUhvc3QgIk9wZW5BSSDnjq/looPlj5jph4/lt7Lorr7nva7vvIhPUEVOQUlfQVBJX0tFWSAvIE9QRU5BSV9CQVNFX1VSTO+8iSIgLUZvcmVncm91bmRDb2xvciBHcmVlbgogICAgV3JpdGUtSG9zdCAiIgogICAgV3JpdGUtSG9zdCAiPT09PSBPcGVuQUkg5a6i5oi356uv5omL5Yqo6YWN572u5Y2hID09PT0iIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbgogICAgV3JpdGUtSG9zdCAi5ZyoIENoZXJyeSBTdHVkaW8gLyBDaGF0Qm94IC8gTmV4dENoYXQg562J5a6i5oi356uv55qE6K6+572u6YeM5aGr6L+Z5LiJ5qC377yaIgogICAgV3JpdGUtSG9zdCAoIiAg5o6l5Y+j5Zyw5Z2AIChCYXNlIFVSTCk6IHswfSIgLWYgJGJhc2UpIC1Gb3JlZ3JvdW5kQ29sb3IgWWVsbG93CiAgICBXcml0ZS1Ib3N0ICgiICDlr4bpkqUgKEFQSSBLZXkpOiAgICAgIHswfSIgLWYgJEtleSkgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgIFdyaXRlLUhvc3QgICIgIOaooeWeiyAoTW9kZWwpOiAgICAgICAgZ2xtLTUuMiIgLUZvcmVncm91bmRDb2xvciBZZWxsb3cKICAgIFdyaXRlLUhvc3QgIu+8iOmDqOWIhuWuouaIt+err+S8muiHquWKqOivu+S4iumdouiuvueahOeOr+Wig+WPmOmHj++8jOmHjeWQr+WuouaIt+err+WNs+WPr+eUn+aViO+8iSIKfQoKdHJ5IHsKICAgIFdyaXRlLUhvc3QgIiIKICAgIFdyaXRlLUhvc3QgIuefpea1t0FQSSDkuIDplK7phY3nva4iIC1Gb3JlZ3JvdW5kQ29sb3IgQ3lhbgogICAgV3JpdGUtSG9zdCAiMS4gWkNvZGUiCiAgICBXcml0ZS1Ib3N0ICIyLiBDbGF1ZGUgQ29kZSIKICAgIFdyaXRlLUhvc3QgIjMuIE9wZW5BSSDlrqLmiLfnq68gKENoZXJyeSBTdHVkaW8gLyBDaGF0Qm94IOetiSkiCiAgICBXcml0ZS1Ib3N0ICI0LiDlhajpg6jphY3nva4iCgogICAgaWYgKFtzdHJpbmddOjpJc051bGxPcldoaXRlU3BhY2UoJFRhcmdldCkpIHsKICAgICAgICAkY2hvaWNlID0gKFJlYWQtSG9zdCAi6K+36YCJ5oupIFsxLzIvMy8077yM6buY6K6kNF0iKS5UcmltKCkKICAgICAgICAkVGFyZ2V0ID0gc3dpdGNoICgkY2hvaWNlKSB7CiAgICAgICAgICAgICcxJyB7ICd6Y29kZScgfQogICAgICAgICAgICAnMicgeyAnY2xhdWRlJyB9CiAgICAgICAgICAgICczJyB7ICdvcGVuYWknIH0KICAgICAgICAgICAgZGVmYXVsdCB7ICdhbGwnIH0KICAgICAgICB9CiAgICB9CgogICAgaWYgKFtzdHJpbmddOjpJc051bGxPcldoaXRlU3BhY2UoJEJhc2VVcmwpKSB7CiAgICAgICAgJEJhc2VVcmwgPSBSZWFkLUhvc3QgIuivt+i+k+WFpeaOpeWPo+WcsOWdgCIKICAgIH0KICAgICRyb290VXJsID0gTm9ybWFsaXplLUJhc2VVcmwgJEJhc2VVcmwKCiAgICBpZiAoW3N0cmluZ106OklzTnVsbE9yV2hpdGVTcGFjZSgkQXBpS2V5KSkgewogICAgICAgICRBcGlLZXkgPSBSZWFkLVNlY3JldFRleHQKICAgIH0KICAgIGlmIChbc3RyaW5nXTo6SXNOdWxsT3JXaGl0ZVNwYWNlKCRBcGlLZXkpKSB7CiAgICAgICAgdGhyb3cgIkFQSSBLZXnkuI3og73kuLrnqboiCiAgICB9CgogICAgaWYgKCRUYXJnZXQgLWVxICd6Y29kZScgLW9yICRUYXJnZXQgLWVxICdhbGwnKSB7CiAgICAgICAgQ29uZmlndXJlLVpDb2RlICRyb290VXJsICRBcGlLZXkgJEhvbWVEaXJlY3RvcnkKICAgIH0KICAgIGlmICgkVGFyZ2V0IC1lcSAnY2xhdWRlJyAtb3IgJFRhcmdldCAtZXEgJ2FsbCcpIHsKICAgICAgICBDb25maWd1cmUtQ2xhdWRlQ29kZSAkcm9vdFVybCAkQXBpS2V5ICRIb21lRGlyZWN0b3J5CiAgICB9CiAgICBpZiAoJFRhcmdldCAtZXEgJ29wZW5haScgLW9yICRUYXJnZXQgLWVxICdhbGwnKSB7CiAgICAgICAgQ29uZmlndXJlLU9wZW5BSSAkcm9vdFVybCAkQXBpS2V5CiAgICB9CgogICAgV3JpdGUtSG9zdCAiIgogICAgV3JpdGUtSG9zdCAi6YWN572u5a6M5oiQ77yM6K+35a6M5YWo6YCA5Ye65bm26YeN5paw5ZCv5Yqo5a+55bqU6L2v5Lu244CCIiAtRm9yZWdyb3VuZENvbG9yIEN5YW4KICAgIFdyaXRlLUhvc3QgIuaooeWei++8mmdsbS01LjIgLyBraW1pLWsyLjctY29kZSIKICAgIFdyaXRlLUhvc3QgIuaOpeWPo++8miRyb290VXJsIgogICAgaWYgKCRUYXJnZXQgLWVxICdjbGF1ZGUnIC1vciAkVGFyZ2V0IC1lcSAnYWxsJykgewogICAgICAgIFdyaXRlLUhvc3QgIkNsYXVkZSBDb2Rl5Lit5Y+v6L+Q6KGMIC9tb2RlbCDliIfmjaLmqKHlnovjgIIiCiAgICB9Cn0gY2F0Y2ggewogICAgV3JpdGUtSG9zdCAiIgogICAgV3JpdGUtSG9zdCAi6YWN572u5aSx6LSl77yaJCgkXy5FeGNlcHRpb24uTWVzc2FnZSkiIC1Gb3JlZ3JvdW5kQ29sb3IgUmVkCiAgICBleGl0IDEKfQoK";
const SETUP_SH_BASE64 = "IyEvdXNyL2Jpbi9lbnYgYmFzaAojIFN1cHBvcnRzIG1hY09TLCBMaW51eCwgV1NMLCBhbmQgR2l0IEJhc2guCgpzZXQgLWV1byBwaXBlZmFpbAp1bWFzayAwNzcKClRBUkdFVD0iJHsxOi19IgpCQVNFX1VSTD0iJHsyOi17e1JFTEFZX1VSTH19fSIKQVBJX0tFWT0iJHszOi19IgpIT01FX0RJUj0iJHtaSElIQUlfSE9NRTotJEhPTUV9IgoKZWNobwplY2hvICLnn6XmtbdBUEkg5LiA6ZSu6YWN572uIgplY2hvICIxLiBaQ29kZSIKZWNobyAiMi4gQ2xhdWRlIENvZGUiCmVjaG8gIjMuIE9wZW5BSSDlrqLmiLfnq68gKENoZXJyeSBTdHVkaW8gLyBDaGF0Qm94IOetiSkiCmVjaG8gIjQuIOWFqOmDqOmFjee9riIKCmlmIFtbIC16ICIkVEFSR0VUIiBdXTsgdGhlbgogIHJlYWQgLXIgLXAgIuivt+mAieaLqSBbMS8yLzMvNO+8jOm7mOiupDRdOiAiIENIT0lDRQogIGNhc2UgIiR7Q0hPSUNFOi00fSIgaW4KICAgIDEpIFRBUkdFVD0iemNvZGUiIDs7CiAgICAyKSBUQVJHRVQ9ImNsYXVkZSIgOzsKICAgIDMpIFRBUkdFVD0ib3BlbmFpIiA7OwogICAgKikgVEFSR0VUPSJhbGwiIDs7CiAgZXNhYwpmaQoKY2FzZSAiJFRBUkdFVCIgaW4KICB6Y29kZXxjbGF1ZGV8b3BlbmFpfGFsbCkgOzsKICAqKSBlY2hvICLphY3nva7nm67moIfml6DmlYjvvJokVEFSR0VUIiA+JjI7IGV4aXQgMSA7Owplc2FjCgppZiBbWyAteiAiJEJBU0VfVVJMIiBdXTsgdGhlbgogIHJlYWQgLXIgLXAgIuivt+i+k+WFpeaOpeWPo+WcsOWdgDogIiBCQVNFX1VSTApmaQoKQkFTRV9VUkw9IiR7QkFTRV9VUkwlL30iCmlmIFtbICIkQkFTRV9VUkwiID09ICovdjEgXV07IHRoZW4KICBCQVNFX1VSTD0iJHtCQVNFX1VSTCUvdjF9IgpmaQpCQVNFX1VSTD0iJHtCQVNFX1VSTCUvfSIKCmlmIFtbICEgIiRCQVNFX1VSTCIgPX4gXmh0dHBzPzovL1teWzpzcGFjZTpdXSskIF1dOyB0aGVuCiAgZWNobyAi5o6l5Y+j5Zyw5Z2A5qC85byP6ZSZ6K+v77yM6K+36L6T5YWl57G75Ly8IGh0dHBzOi8vYXBpLmV4YW1wbGUuY29tIOeahOWcsOWdgCIgPiYyCiAgZXhpdCAxCmZpCgppZiBbWyAteiAiJEFQSV9LRVkiIF1dOyB0aGVuCiAgcmVhZCAtciAtcyAtcCAi6K+36L6T5YWlQVBJIEtleTogIiBBUElfS0VZCiAgZWNobwpmaQppZiBbWyAteiAiJEFQSV9LRVkiIF1dOyB0aGVuCiAgZWNobyAiQVBJIEtleeS4jeiDveS4uuepuiIgPiYyCiAgZXhpdCAxCmZpCgppZiAhIGNvbW1hbmQgLXYgbm9kZSA+L2Rldi9udWxsIDI+JjE7IHRoZW4KICBlY2hvICLmnKrmo4DmtYvliLBOb2RlLmpz77yM5peg5rOV5a6J5YWo5ZCI5bm2546w5pyJSlNPTumFjee9ruOAgiIgPiYyCiAgZXhpdCAxCmZpCgpleHBvcnQgWkhfVEFSR0VUPSIkVEFSR0VUIgpleHBvcnQgWkhfQkFTRV9VUkw9IiRCQVNFX1VSTCIKZXhwb3J0IFpIX0FQSV9LRVk9IiRBUElfS0VZIgpleHBvcnQgWkhfSE9NRV9ESVI9IiRIT01FX0RJUiIKCmNvbmZpZ3VyZV9vcGVuYWkoKSB7CiAgbG9jYWwgYmFzZT0iJHtCQVNFX1VSTH0vdjEiCiAgbG9jYWwgcmMKICBmb3IgcmMgaW4gIiRIT01FX0RJUi8uenNocmMiICIkSE9NRV9ESVIvLmJhc2hyYyI7IGRvCiAgICB0b3VjaCAiJHJjIiAyPi9kZXYvbnVsbCB8fCB0cnVlCiAgICBncmVwIC1xICIjIHpoaWhhaS1vcGVuYWkiICIkcmMiIDI+L2Rldi9udWxsICYmIHNlZCAtaS56aGJhayAnLyMgemhpaGFpLW9wZW5haS9kJyAiJHJjIiAyPi9kZXYvbnVsbCB8fCB0cnVlCiAgICBybSAtZiAiJHJjLnpoYmFrIiAyPi9kZXYvbnVsbCB8fCB0cnVlCiAgICBwcmludGYgJ2V4cG9ydCBPUEVOQUlfQVBJX0tFWT0iJXMiICMgemhpaGFpLW9wZW5haVxuZXhwb3J0IE9QRU5BSV9CQVNFX1VSTD0iJXMiICMgemhpaGFpLW9wZW5haVxuJyAiJEFQSV9LRVkiICIkYmFzZSIgPj4gIiRyYyIgMj4vZGV2L251bGwgfHwgdHJ1ZQogIGRvbmUKICBlY2hvICJPcGVuQUkg546v5aKD5Y+Y6YeP5bey5YaZ5YWlIH4vLnpzaHJjIOWSjCB+Ly5iYXNocmPvvIhPUEVOQUlfQVBJX0tFWSAvIE9QRU5BSV9CQVNFX1VSTO+8iSIKICBlY2hvCiAgZWNobyAiPT09PSBPcGVuQUkg5a6i5oi356uv5omL5Yqo6YWN572u5Y2hID09PT0iCiAgZWNobyAi5ZyoIENoZXJyeSBTdHVkaW8gLyBDaGF0Qm94IC8gTmV4dENoYXQg562J5a6i5oi356uv6K6+572u6YeM5aGr6L+Z5LiJ5qC377yaIgogIGVjaG8gIiAg5o6l5Y+j5Zyw5Z2AIChCYXNlIFVSTCk6ICR7YmFzZX0iCiAgZWNobyAiICDlr4bpkqUgKEFQSSBLZXkpOiAgICAgICR7QVBJX0tFWX0iCiAgZWNobyAiICDmqKHlnosgKE1vZGVsKTogICAgICAgIGdsbS01LjIiCiAgZWNobyAi77yI6YOo5YiG5a6i5oi356uv5Lya6Ieq5Yqo6K+75LiK6Z2i546v5aKD5Y+Y6YeP77yM6YeN5byA57uI56uvL+WuouaIt+err+WNs+WPr+eUn+aViO+8iSIKfQoKbm9kZSA8PCdOT0RFJwpjb25zdCBmcyA9IHJlcXVpcmUoImZzIik7CmNvbnN0IHBhdGggPSByZXF1aXJlKCJwYXRoIik7CmNvbnN0IGNyeXB0byA9IHJlcXVpcmUoImNyeXB0byIpOwoKY29uc3QgdGFyZ2V0ID0gcHJvY2Vzcy5lbnYuWkhfVEFSR0VUOwpjb25zdCByb290VXJsID0gcHJvY2Vzcy5lbnYuWkhfQkFTRV9VUkw7CmNvbnN0IGFwaUtleSA9IHByb2Nlc3MuZW52LlpIX0FQSV9LRVk7CmNvbnN0IGhvbWUgPSBwcm9jZXNzLmVudi5aSF9IT01FX0RJUjsKCmZ1bmN0aW9uIHJlYWRKc29uKGZpbGUpIHsKICBpZiAoIWZzLmV4aXN0c1N5bmMoZmlsZSkpIHJldHVybiB7fTsKICB0cnkgewogICAgcmV0dXJuIEpTT04ucGFyc2UoZnMucmVhZEZpbGVTeW5jKGZpbGUsICJ1dGY4IikpOwogIH0gY2F0Y2ggewogICAgdGhyb3cgbmV3IEVycm9yKGDphY3nva7mlofku7bkuI3mmK/lkIjms5VKU09O77yM5pyq5L2c5L+u5pS577yaJHtmaWxlfWApOwogIH0KfQoKZnVuY3Rpb24gc2F2ZUpzb24oZmlsZSwgdmFsdWUpIHsKICBmcy5ta2RpclN5bmMocGF0aC5kaXJuYW1lKGZpbGUpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTsKICBpZiAoZnMuZXhpc3RzU3luYyhmaWxlKSkgewogICAgY29uc3Qgc3RhbXAgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkucmVwbGFjZSgvWy06VF0vZywgIiIpLnNsaWNlKDAsIDE0KTsKICAgIGNvbnN0IGJhY2t1cCA9IGAke2ZpbGV9LmJhY2t1cC4ke3N0YW1wfWA7CiAgICBmcy5jb3B5RmlsZVN5bmMoZmlsZSwgYmFja3VwKTsKICAgIGNvbnNvbGUubG9nKGDlt7LlpIfku73vvJoke2JhY2t1cH1gKTsKICB9CiAgZnMud3JpdGVGaWxlU3luYyhmaWxlLCBgJHtKU09OLnN0cmluZ2lmeSh2YWx1ZSwgbnVsbCwgMil9XG5gLCB7IG1vZGU6IDBvNjAwIH0pOwogIHRyeSB7IGZzLmNobW9kU3luYyhmaWxlLCAwbzYwMCk7IH0gY2F0Y2gge30KfQoKZnVuY3Rpb24gY29uZmlndXJlWkNvZGUoKSB7CiAgY29uc3QgZmlsZSA9IHBhdGguam9pbihob21lLCAiLnpjb2RlIiwgInYyIiwgImNvbmZpZy5qc29uIik7CiAgY29uc3QgY29uZmlnID0gcmVhZEpzb24oZmlsZSk7CiAgaWYgKGNvbmZpZy5wcm92aWRlciAhPSBudWxsICYmICh0eXBlb2YgY29uZmlnLnByb3ZpZGVyICE9PSAib2JqZWN0IiB8fCBBcnJheS5pc0FycmF5KGNvbmZpZy5wcm92aWRlcikpKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYFpDb2Rl6YWN572u5Lit55qEcHJvdmlkZXLlrZfmrrXmoLzlvI/lvILluLjvvIzmnKrkvZzkv67mlLnvvJoke2ZpbGV9YCk7CiAgfQogIGNvbmZpZy5wcm92aWRlciB8fD0ge307CgogIGxldCBpZCA9IE9iamVjdC5rZXlzKGNvbmZpZy5wcm92aWRlcikuZmluZCgoa2V5KSA9PiB7CiAgICBjb25zdCBwcm92aWRlciA9IGNvbmZpZy5wcm92aWRlcltrZXldOwogICAgcmV0dXJuIHByb3ZpZGVyPy5uYW1lID09PSAi55+l5rW3QVBJIiAmJiBwcm92aWRlcj8uc291cmNlID09PSAiY3VzdG9tIjsKICB9KTsKICBpZiAoIWlkKSBpZCA9IGNyeXB0by5yYW5kb21VVUlEKCk7CgogIGNvbmZpZy5wcm92aWRlcltpZF0gPSB7CiAgICAuLi5jb25maWcucHJvdmlkZXJbaWRdLAogICAgbmFtZTogIuefpea1t0FQSSIsCiAgICBraW5kOiAib3BlbmFpLWNvbXBhdGlibGUiLAogICAgb3B0aW9uczogewogICAgICBhcGlLZXksCiAgICAgIGJhc2VVUkw6IGAke3Jvb3RVcmx9L3YxYCwKICAgICAgYXBpS2V5UmVxdWlyZWQ6IHRydWUKICAgIH0sCiAgICBzb3VyY2U6ICJjdXN0b20iLAogICAgbW9kZWxzOiB7CiAgICAgICJnbG0tNS4yIjogewogICAgICAgIGxpbWl0OiB7IGNvbnRleHQ6IDIwMDAwMCB9LAogICAgICAgIG1vZGFsaXRpZXM6IHsgaW5wdXQ6IFsidGV4dCJdLCBvdXRwdXQ6IFsidGV4dCJdIH0KICAgICAgfSwKICAgICAgImtpbWktazIuNy1jb2RlIjogewogICAgICAgIGxpbWl0OiB7IGNvbnRleHQ6IDIwMDAwMCB9LAogICAgICAgIG1vZGFsaXRpZXM6IHsgaW5wdXQ6IFsidGV4dCJdLCBvdXRwdXQ6IFsidGV4dCJdIH0KICAgICAgfQogICAgfQogIH07CgogIHNhdmVKc29uKGZpbGUsIGNvbmZpZyk7CiAgY29uc29sZS5sb2coYFpDb2Rl6YWN572u5a6M5oiQ77yaJHtmaWxlfWApOwp9CgpmdW5jdGlvbiBjb25maWd1cmVDbGF1ZGVDb2RlKCkgewogIGNvbnN0IGZpbGUgPSBwYXRoLmpvaW4oaG9tZSwgIi5jbGF1ZGUiLCAic2V0dGluZ3MuanNvbiIpOwogIGNvbnN0IHNldHRpbmdzID0gcmVhZEpzb24oZmlsZSk7CiAgaWYgKHNldHRpbmdzLmVudiAhPSBudWxsICYmICh0eXBlb2Ygc2V0dGluZ3MuZW52ICE9PSAib2JqZWN0IiB8fCBBcnJheS5pc0FycmF5KHNldHRpbmdzLmVudikpKSB7CiAgICB0aHJvdyBuZXcgRXJyb3IoYENsYXVkZSBDb2Rl6YWN572u5Lit55qEZW525a2X5q615qC85byP5byC5bi477yM5pyq5L2c5L+u5pS577yaJHtmaWxlfWApOwogIH0KICBzZXR0aW5ncy5lbnYgfHw9IHt9OwogIGRlbGV0ZSBzZXR0aW5ncy5lbnYuQU5USFJPUElDX0FQSV9LRVk7CiAgT2JqZWN0LmFzc2lnbihzZXR0aW5ncy5lbnYsIHsKICAgIEFOVEhST1BJQ19CQVNFX1VSTDogcm9vdFVybCwKICAgIEFOVEhST1BJQ19BVVRIX1RPS0VOOiBhcGlLZXksCiAgICBBTlRIUk9QSUNfTU9ERUw6ICJnbG0tNS4yIiwKICAgIEFOVEhST1BJQ19ERUZBVUxUX09QVVNfTU9ERUw6ICJnbG0tNS4yIiwKICAgIEFOVEhST1BJQ19ERUZBVUxUX1NPTk5FVF9NT0RFTDogImdsbS01LjIiLAogICAgQU5USFJPUElDX0RFRkFVTFRfSEFJS1VfTU9ERUw6ICJnbG0tNS4yIiwKICAgIENMQVVERV9DT0RFX1NVQkFHRU5UX01PREVMOiAiZ2xtLTUuMiIsCiAgICBDTEFVREVfQ09ERV9FTkFCTEVfR0FURVdBWV9NT0RFTF9ESVNDT1ZFUlk6ICIxIiwKICAgIENMQVVERV9DT0RFX0FVVE9fQ09NUEFDVF9XSU5ET1c6ICIxODAwMDAiLAogICAgQ0xBVURFX0NPREVfTUFYX09VVFBVVF9UT0tFTlM6ICI4MTkyIiwKICAgIENMQVVERV9DT0RFX0RJU0FCTEVfMU1fQ09OVEVYVDogIjEiCiAgfSk7CiAgc2V0dGluZ3MubW9kZWwgPSAiZ2xtLTUuMiI7CgogIHNhdmVKc29uKGZpbGUsIHNldHRpbmdzKTsKICBjb25zb2xlLmxvZyhgQ2xhdWRlIENvZGXphY3nva7lrozmiJDvvJoke2ZpbGV9YCk7Cn0KCmlmICh0YXJnZXQgPT09ICJ6Y29kZSIgfHwgdGFyZ2V0ID09PSAiYWxsIikgY29uZmlndXJlWkNvZGUoKTsKaWYgKHRhcmdldCA9PT0gImNsYXVkZSIgfHwgdGFyZ2V0ID09PSAiYWxsIikgY29uZmlndXJlQ2xhdWRlQ29kZSgpOwpOT0RFCgppZiBbWyAiJFRBUkdFVCIgPT0gIm9wZW5haSIgfHwgIiRUQVJHRVQiID09ICJhbGwiIF1dOyB0aGVuCiAgY29uZmlndXJlX29wZW5haQpmaQoKdW5zZXQgWkhfQVBJX0tFWSBBUElfS0VZCgplY2hvCmVjaG8gIumFjee9ruWujOaIkO+8jOivt+WujOWFqOmAgOWHuuW5tumHjeaWsOWQr+WKqOWvueW6lOi9r+S7tuOAgiIKZWNobyAi5qih5Z6L77yaZ2xtLTUuMiAvIGtpbWktazIuNy1jb2RlIgplY2hvICLmjqXlj6PvvJokQkFTRV9VUkwiCmlmIFtbICIkVEFSR0VUIiA9PSAiY2xhdWRlIiB8fCAiJFRBUkdFVCIgPT0gImFsbCIgXV07IHRoZW4KICBlY2hvICJDbGF1ZGUgQ29kZeS4reWPr+i/kOihjCAvbW9kZWwg5YiH5o2i5qih5Z6L44CCIgpmaQoK";
const RELAY_URL_PLACEHOLDER = "{{RELAY_URL}}";
let ISOLATE_ID = "";

// 默认【关】思考（B方案）：默认快；客户端显式请求才开（Claude Code 的 think / enable_thinking / thinking:{type:enabled}）。
// THINKING 表数据驱动：新模型加一行即可，逻辑里不硬编码模型名。客户端显式传参可覆盖（见 clientThinkingPref）。
const DEFAULT_THINKING = false;
const THINKING = {
  "@cf/zai-org/glm-5.2": { kind: "param" },             // 需 chat_template_kwargs.enable_thinking
  "@cf/moonshotai/kimi-k2.7-code": { kind: "native" },  // 原生吐推理，无开关参数（不可关）
};

// 重试策略：容量重试次数统一由 CAP_RETRIES/capState 控制；RETRY_* 现只保留退避 base 和重请求非流式超时策略。
// 注意：不再有“首 token 超时主动放弃”——那正是大请求 503 的根因。慢 prefill 改为早回 200 + 心跳保活。
const RETRY_NORMAL = { retries: 2, base: 500 }; // 重试调温柔：3→2，满载时少打一枪
const RETRY_HEAVY = { retries: 3, base: 800 };  // 重请求使用更温和的非流式超时/退避策略
const HEAVY_CHARS = 120000; // ≥ 视为重请求（现仅影响非流式上游超时上限）

// 流式时序（毫秒，均可用同名 env 覆盖，便于按部署调优 / 测试）
const GRACE_MS = 4000;             // 出字前“可静默”上限：超了就早回 200 + 心跳保活（不再自我放弃）
const PREFILL_MAX_MS = 240000;     // 回 200 后、首 token 前的最长等待；超了才发流内错误（给得宽：CF 无墙钟上限、心跳保活、不耗 CPU）
const HEARTBEAT_MS = 10000;        // 心跳间隔（出字前的 prefill 期间也发）
const STREAM_IDLE_MAX_MS = 600000; // 出字之后，逐字间隔的看门狗（B 实证 2026-07-06：glm 写大 JSON 中途单次停顿常 >2min，120s 会误杀重任务判 upstream_stalled/kind:content → 抬到 600s。放宽安全：连接真死靠 read() 立即报错、不靠此计时器，心跳保活客户端，Workers 流式无墙钟上限。可用 env STREAM_IDLE_MAX_MS 覆盖）
// 非流式上游硬超时（子代理多走非流式工具往返；上游卡死时到点干净失败 503，而不是无限挂到客户端 30min 超时）。
const NONSTREAM_MAX_MS = 240000;       // 普通非流式单次上游上限
const NONSTREAM_HEAVY_MAX_MS = 280000; // 重请求放宽

const TIMEOUT = Symbol("timeout");
const RETRY_EMPTY = Symbol("retry-empty");
const EMPTY_RESPONSE_RETRIES = 3; // 仅空回复加力；容量重试走 CAP_* 专用预算。
const CAP_RETRIES = 6;            // 3040/容量专用：默认最多 6 次重试（不含首次）。
const CAP_BACKOFF_BASE_MS = 2000;  // 容量退避 full-jitter 初始上限。
const CAP_BACKOFF_MAX_MS = 20000;  // 容量退避 full-jitter 最大上限。
const CAP_TOTAL_MS = 50000;        // 容量专用总预算，避免无限保活。
const MODEL_CTX_TOKENS = 260000;   // 模型单轮硬上限（输入+回复+工具都挤在这一份里），只用来对客户解释闸设在哪。
const OVERSIZE_TOKENS = 200000;     // 请求过大 token 闸；env OVERSIZE_TOKENS 覆盖，0=关闸。
                                    // 为什么是 20 万不是 26 万：回复和工具调用要从同一份里扣，
                                    // 顶着硬上限发过去会在半路炸（那时候钱已经花了、话还没说完），
                                    // 留 6 万余量是让它有地方把话说完 —— 跟省钱没关系，对客说明别写成"我们调低了额度"。
const OVERSIZE_CHARS = 0;          // 兼容旧字符闸；env OVERSIZE_CHARS > 0 时仍生效。
/* ===== 两个诊断响应头（2026-07-31）=====
   x-deny-reason：只要这次拒绝是【本 relay 自己做的】，就带上机器可读的原因码
   （bad_key / disabled / expired / quota_exhausted / oversize / client_abort）。
   为什么要它：客户报"我这边 403"时，以前只能靠肉眼比对报错文案是不是中文 JSON 来判断是不是我们拒的
   （某客户那次就是卡在这），现在一条 curl -i 看有没有这个头就能分清是我们还是他自己的线路/代理。
   x-upstream-model：这次真正跑的上游模型。响应体里的 model 字段回的是【客户请求的那个名字】——
   这是故意的，很多客户端会校验"响应 model == 请求 model"，改了会把它们弄崩；
   但客户写 claude-sonnet-4-5 之类不认识的名字时会静默回落到默认模型，体里就看不出真相。
   放响应头是唯一两头都不得罪的位置：不动任何客户端的校验，又让"到底跑的谁"可查。
   两个头都只加信息、不改任何放行/拒绝的判断，热路径零额外开销（值本来就算好了）。 */
const DENY_REASON_HEADER = "x-deny-reason";
const UPSTREAM_MODEL_HEADER = "x-upstream-model";
/* ===== 三个上下文观测响应头（2026-08-01）=====
   x-context-tokens：这次请求估出来的输入 token（estimateReqTokens，与过大闸同一把尺子）
   x-context-limit ：本号当前的过大闸上限（oversizeTokenLimit(env)；0 = 闸关）
   x-context-pct   ：前者占后者的百分比，整数（闸关时没有分母，恒回 0）
   为什么要它：客户跑自动长任务（agent 循环）时历史只增不减，撞顶前没有任何征兆，
   一撞就是 400 + 任务死，而自动任务旁边没有人。这三个头把"离顶还有多远"变成每次响应白送的可观测量。
   跟上面两个诊断头同一条道理：只加信息，不改任何放行/拒绝判断；没有开关、永远发；
   客户端不认识就忽略，认识就是免费的诊断信息 —— 客户零配置。
   【别图省事换成流式那个 estInput】estInput 走 estimateMessagesTokens，只看 m.content，
   不算 tool_calls、不算 tools 定义。Claude Code 那种 3 万 token 工具定义 + 满是 tool_calls 的请求
   它能少报三到五成 —— 拿它填 pct，真实 21 万会报成 65%，警戒线永远不触发。 */
const CONTEXT_TOKENS_HEADER = "x-context-tokens";
const CONTEXT_LIMIT_HEADER = "x-context-limit";
const CONTEXT_PCT_HEADER = "x-context-pct";
/* ===== 救援截断 RESCUE_TRIM（2026-08-01 批二·只做救援那一半）=====
   只在【这次请求本来就会被过大闸判 400】的时候才动手：裁掉最旧的几轮，让它能过去。
   没超限的请求一个字节都不碰 —— 判据写死在调用点：闸门没判超，handler 里那行 if 直接是 false，
   不重建 messages、不复制数组、不多算一遍。
   为什么只做救援那一半：另一半（没超限时也主动裁，省成本）会动到所有正常请求，
   估算误差会变成"客户的对话被悄悄删了"；救援这一半的最坏结果等于现状（本来就失败），风险为零。
   最坏情况：裁完还超 → 原样回今天那个 400。所以这一笔只可能把"本来失败"变成"成功"，反过来不可能。
   x-context-trimmed：只在真的裁了才出现，dropped=条数;before=裁前token;after=裁后token。
   【绝不往 messages 里插提示文字】客户端可能是无人值守的 agent，插进去的文字会被当成指令执行，
   也会污染客户自己保存的对话文件（执行单 v2 第六节 C2/C3）。告知只走响应头。 */
const CONTEXT_TRIMMED_HEADER = "x-context-trimmed";
/* 截断专用的保守系数：闸门与截断的最优偏向【相反】——
   闸门算多了 = 误拦冤枉客户（2026-07 真事故），所以闸门那套(CJK 0.6)特意选"宁可少拦"；
   截断算少了 = 裁完还超顶、白删一场内容（最坏）。所以截断在闸门的估算上再乘 1.15，宁可多裁一轮。
   这是"解耦"：estimateReqTokens / estimateJsonTokens / CJK_TOKEN_WEIGHT / OVERSIZE_TOKENS 一个字不动。 */
const RESCUE_TRIM_SAFETY = 1.15;
const RESCUE_TRIM_TARGET_RATIO = 0.85;   // 裁到闸值的 85%，留出估算误差的余地
const RESCUE_TRIM_RESERVE_DEFAULT = 8192; // maxTokens 缺省时的回复余量（OpenAI 协议下大量自研脚本不传，
const RESCUE_TRIM_RESERVE_MIN = 4096;     // 写成"上限-maxTokens"会算出 NaN → 所有比较变 false →
const RESCUE_TRIM_RESERVE_MAX = 32768;    // 截断静默不生效、客户照旧吃 400，日志里还看不出异常）
// CJK 每字折算多少 token。glm/kimi 这类中文词表把常见二字词并成一个 token，实测约 0.6，
// 老值 1.0 把中文请求高估近一倍 → 真实 ~13 万 token（模型上限 262144）就被上面的闸误判过大、
// 回不可重试 400。改 0.6 后闸门口径贴近真实；偏保守的一侧是"少拦一点"，最坏也只是让上游自己报错，
// 不会像误拦那样把正常客户直接挡在门外。真实偏差由 token_est_drift 诊断日志持续校准。
const CJK_TOKEN_WEIGHT = 0.6;
// 近 1 小时 3021（每分钟推理限速）达到这个次数，就在 /admin/api/health 与 2h 自探针里
// 提示"该号建议开全局闸"。只提示，不自动开闸。
const RATE_LIMIT_HINT_MIN = 20;
/* ===== 全局闸建议值的来历（2026-07-30 第三方审计第 5 条；2026-07-31 基线修正）=====
   审计说的是实话：闸门数字比真实上限高了快一个量级，等于没闸。
   但第一次改的时候【用错了基线】，所以只治了一半 —— 完整经过写在这里，别再走一遍。

   —— 真实形状（2026-07-31 夜 B 项目实测钉死，别改数字）——
   glm-5.2 的每分钟推理限速，【每个 CF 账号是一个令牌桶】：
       桶装 40 个名额，每分钟只补 20 个。
   报错原文 `3021: rate limiting: inference request per min rate reached`。
   所以【稳态速率是 20】；40 那个数是突发额度，一分钟内用完就没了。
   限速【按 CF 账号算，不按 Worker 算】——同一个号加 10 个 Worker 吞吐纹丝不动（2026-07-29 实测）。

   —— 「27 次/分」是怎么来的（错的，已作废）——
       40（桶）+ 20 + 20 = 80 条 / 180 秒 ÷ 3 分钟 = 26.7 ≈ 27
   本项目 2026-07-29 的原始数据 `20/20/0/20/0/20`（30 秒一格、共 80 次/180 秒）严丝合缝。
   【测的没错，错在把"含突发那一下的三分钟总量"除以 3，当成了稳态速率。】
   27 从来不存在，它是测法造成的假象。

   —— 【测量纪律】（最重要，别再踩）——
   测每分钟限速，必须【连续压 3 分钟以上，并按"第几分钟"分开统计】。
   只压一分钟测到的是【桶容量 40】不是【速率 20】，会得出偏高一倍的错结论 —— 27 就是这么来的。
   档与档之间还要留够时间让桶回满，否则前一档污染后一档。

   —— 建议值（24 错在哪：不是"不会响"，是"响了也没用"）——
   两个桶的形状不一样，这是关键：
       我们的闸（设 24）：`bucketLease` 的桶容量 = limit = 24，每分钟补 24
       CF 真实的：        桶容量 40，          每分钟补 20
   累计放行量 我们 `24+24t` vs CF `40+20t`，t < 4 分钟时【我们更小 → 突发阶段是我们先拒】，
   此时 CF 还剩 16 个令牌没用，被我们白拦掉了；4 分钟之后才反过来，
   稳态 24 > 20，每分钟稳定漏 4 条出去撞 3021。【两头不讨好】：
   该放的时候拦，该拦的时候放。
   18 才对：18 既低于桶容量 40、也低于补充速率 20，【任何时刻都是我们先响】，3021 不会发生。
   （= 真实速率 20 打九折，headroom 0.9。）
   （旧注释里那个 `GLOBAL_RPM_LIMIT=240` 是没实测数据时凭感觉写的，是真实值的 12 倍，完全惰性。）
   `RATE_LIMIT_RPM_MEASURED` 可以用环境变量覆盖：以后压出新基线，改变量就行，不用改代码。

   —— 一条别误解的 ——
   3021 是【计数器不是容量】，超了只会被拒，打不坏号，也不会"越压号越虚"。
   它是可预测的限流，不是故障，不要当事故处理。
   （尚未验证：以上都是闲时段测的。高峰时段会不会在限速之上再叠一层容量约束，没测过，别当已知。）

   两件明确【不做】的事，理由写在这里免得下一个人当成漏做：
   1. 不动 `GLOBAL_RPM_LIMIT` 的默认值（仍是 0 = 闸关）。开闸会实打实改变在用客户的流量形状，
      属于政策决定，按铁律五/八必须由人对着具体某个号拍板，机器只负责把该开的号指出来。
   2. 不把本地 `RPM_LIMIT`（250）改成 20。那是【每个实例】各算各的桶，不是账号总量：
      同一个号同时跑着几个实例时，各设 20 加起来照样超；只有一个实例时，20 又会把
      正常的短突发直接掐死（真实桶本来就允许 40 的突发）。账号级的量只有 DO 全局桶数得准，
      本地那个桶的定位是"防单实例跑飞"的兜底，不是账号上限 —— 这一点原来没写清楚，
      才让 250 看着像账号闸。 */
const RATE_LIMIT_RPM_MEASURED = 20;   // 实测单账号稳态补充速率（glm-5.2；桶 40 / 每分钟补 20，2026-07-31）
const RATE_LIMIT_RPM_HEADROOM = 0.9;  // 建议值压在实测值以下，才谈得上"提前削平"
function suggestedGlobalRpm(env) {
  const n = Number(env && env.RATE_LIMIT_RPM_MEASURED);
  const measured = Number.isFinite(n) && n > 0 ? n : RATE_LIMIT_RPM_MEASURED;
  return Math.max(1, Math.floor(measured * RATE_LIMIT_RPM_HEADROOM));
}

export class SentinelRollup {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    state.blockConcurrencyWhile(async () => {
      this.state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS minute_rollup (minute INTEGER PRIMARY KEY, volume INTEGER NOT NULL, ok INTEGER NOT NULL, error INTEGER NOT NULL, estimated INTEGER NOT NULL, classes TEXT NOT NULL, ttfts TEXT NOT NULL)`);
      // 计数档搬进 DO（审计②根治）：只有这一行、id 恒为 1。DO 单实例 = 天生串行，
      // 多 isolate 并发进来也排队，不再互相盖。KV 从此只是它的镜像（面板/客户页照旧读 KV）。
      this.state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS usage_state (id INTEGER PRIMARY KEY, doc TEXT NOT NULL, dirty INTEGER NOT NULL, mirroredAt INTEGER NOT NULL)`);
    });
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/event" && request.method === "POST") {
      const point = await request.json().catch(() => null);
      if (!point) return Response.json({ ok: false, error: "invalid_event" }, { status: 400 });
      this.record(point);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/health") return Response.json(this.health());
    // ↓ 计数档三个口。都不在客户请求的热路径上：记账走 ctx.waitUntil 旁路，清零/探针是运维动作。
    if (url.pathname === "/usage/delta" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body || !body.delta || typeof body.delta !== "object") return Response.json({ ok: false, error: "invalid_delta" }, { status: 400 });
      const doc = await this.usageApply(body.delta);
      return Response.json({ ok: true, usedCalls: doc.usedCalls, failCalls: doc.failCalls });
    }
    if (url.pathname === "/usage/reset" && request.method === "POST") {
      await this.usageQueue(async () => {
        const doc = clearCounters(await this.usageDoc());
        await this.usageStore(doc, true);               // 清零要立刻见效，不等节流
      });
      return Response.json({ ok: true });
    }
    if (url.pathname === "/usage/probe" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body) return Response.json({ ok: false, error: "invalid_probe" }, { status: 400 });
      await this.usageQueue(async () => {
        const doc = await this.usageDoc();
        doc.aiProbe = body.probe || null;
        await this.usageStore(doc, true);
      });
      return Response.json({ ok: true });
    }
    if (url.pathname === "/usage/doc") return Response.json({ ok: true, doc: await this.usageQueue(() => this.usageDoc()) });
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  /* ===== 计数档（审计②根治：把"谁来加"收成一个人）=====
     一次性种子：这张表空的时候，从 KV 把现有计数搬进来（更老的号还在 acct 里，一并认）。
     搬完之后 DO 就是唯一的真数，KV 只被 DO 写。**worker 侧任何直写 acct:usage 的路都必须改道**，
     否则会拿一份旧快照把 DO 镜下来的新数盖回去。 */
  /* 自己再排一道队。DO 的输入闸只在"等自己的 storage"时关，等 KV/网络时是不关的——
     而计数档有两处要等 KV：① 第一次搬家读种子；② 镜像回写。光靠 DO 单实例还不够，
     首次搬家那一瞬间的并发照样能各读各的空档、互相盖。所以所有计数操作串成一条链。 */
  usageQueue(fn) {
    const p = (this.usageTail || Promise.resolve()).then(fn, fn);
    this.usageTail = p.then(() => {}, () => {});
    return p;
  }
  usageRow() { return this.state.storage.sql.exec("SELECT doc, dirty, mirroredAt FROM usage_state WHERE id = 1").toArray()[0]; }
  async usageDoc() {
    const row = this.usageRow();
    if (row) { try { return usageFrom(JSON.parse(row.doc)); } catch (_) { return usageFrom(null); } }
    return usageFrom(await this.usageSeed());
  }
  async usageSeed() {
    if (!this.env || !this.env.STORE) return null;
    for (const k of [USAGE_KEY, REC_KEY]) {                     // 先看新 key，没有再回头认 acct 里的老计数
      try { const v = await this.env.STORE.get(k); if (v) return JSON.parse(v); } catch (_) {}
    }
    return null;
  }
  usageSave(doc, dirty, mirroredAt) {
    this.state.storage.sql.exec("INSERT OR REPLACE INTO usage_state (id, doc, dirty, mirroredAt) VALUES (1, ?, ?, ?)", JSON.stringify(doc), dirty ? 1 : 0, mirroredAt);
  }
  usageApply(delta) {
    return this.usageQueue(async () => {
      const doc = applyDelta(await this.usageDoc(), deltaFrom(delta));
      await this.usageStore(doc, false);
      return doc;
    });
  }
  /* 落地两步走：① 先写进 DO 自己的 SQL（**这一步就已经不会丢了**——SQL 是持久的，
     实例被回收也还在）；② 再镜像给 KV，同一把 key 每秒只能写 1 次，所以镜像节流在 1 秒，
     没轮到就标脏 + 挂闹钟到点补镜。客户/面板读的还是 KV，所以最多晚一秒看到，但数是准的。 */
  async usageStore(doc, now_) {
    const row = this.usageRow();
    const mirroredAt = row ? Number(row.mirroredAt || 0) : 0;
    const now = Date.now();
    if (now_ || now - mirroredAt >= USAGE_MIRROR_MS) {
      this.usageSave(doc, false, now);
      await this.usageMirror(doc);
      return;
    }
    this.usageSave(doc, true, mirroredAt);
    await this.usageArm(mirroredAt + USAGE_MIRROR_MS);
  }
  async usageMirror(doc) {
    try {
      if (this.env && this.env.STORE) await this.env.STORE.put(USAGE_KEY, JSON.stringify(doc));
    } catch (_) {
      // 镜像失败不动 DO 里的真数（那才是账），只标脏等下一次补镜。
      const row = this.usageRow();
      this.usageSave(doc, true, row ? Number(row.mirroredAt || 0) : 0);
      await this.usageArm(Date.now() + USAGE_MIRROR_MS);
    }
  }
  async usageArm(at) {
    try {
      const cur = await this.state.storage.getAlarm();
      if (cur === null || cur === undefined || cur > at) await this.state.storage.setAlarm(at);
    } catch (_) {}
  }
  async alarm() {
    const row = this.usageRow();
    if (!row || !Number(row.dirty)) return;
    let doc;
    try { doc = usageFrom(JSON.parse(row.doc)); } catch (_) { return; }
    this.usageSave(doc, false, Date.now());
    await this.usageMirror(doc);
  }
  record(point) {
    const minute = Math.floor(Date.now() / 60000);
    const blobs = Array.isArray(point.blobs) ? point.blobs : [];
    const doubles = Array.isArray(point.doubles) ? point.doubles : [];
    const status = blobs[1] === "ok" ? "ok" : "error";
    const errorClass = SENTINEL_ERROR_CLASSES.has(blobs[2]) ? blobs[2] : "unknown";
    const row = this.state.storage.sql.exec("SELECT * FROM minute_rollup WHERE minute = ?", minute).toArray()[0];
    const classes = row ? JSON.parse(row.classes || "{}") : {};
    const ttfts = row ? JSON.parse(row.ttfts || "[]") : [];
    const volume = (row ? Number(row.volume) : 0) + 1;
    const ok = (row ? Number(row.ok) : 0) + (status === "ok" ? 1 : 0);
    const error = (row ? Number(row.error) : 0) + (status === "ok" ? 0 : 1);
    const estimated = (row ? Number(row.estimated) : 0) + (blobs[6] === "1" ? 1 : 0);
    if (status !== "ok") classes[errorClass] = (classes[errorClass] || 0) + 1;
    const ttft = Number(doubles[0]);
    if (Number.isFinite(ttft) && ttft >= 0) addBoundedSample(ttfts, ttft, volume);
    this.state.storage.sql.exec("INSERT OR REPLACE INTO minute_rollup (minute, volume, ok, error, estimated, classes, ttfts) VALUES (?, ?, ?, ?, ?, ?, ?)", minute, volume, ok, error, estimated, JSON.stringify(classes), JSON.stringify(ttfts));
    this.state.storage.sql.exec("DELETE FROM minute_rollup WHERE minute < ?", minute - 180);
  }
  health() {
    const end = Math.floor(Date.now() / 60000) + 1;
    // rateLimited60m：近 1 小时 3021 次数。桶留 180 分钟，60 分钟窗口一定取得到。
    // 用途见 RATE_LIMIT_HINT_MIN：机器给"这号该开全局闸"的提示，开不开仍由人拍板（铁律五/八）。
    const rateLimited60m = this.classCount(end - 60, end, "rate_limited_3021");
    // oversizeBlocked60m（P0-5）：近 1 小时被自己的过大闸挡下的次数。
    // 这类请求根本没发给上游，既不算成功也不算失败，成功率里看不见它——不单列就等于隐形。
    const oversizeBlocked60m = this.classCount(end - 60, end, "gate_oversize");
    return {
      ok: true, configured: true, schemaVersion: SENTINEL_SCHEMA_VERSION, customer: "rollup", window: { seconds: 300 },
      current: this.window(end - 5, end), previous: this.window(end - 10, end - 5),
      rateLimited60m, suggestGlobalRpmLimit: rateLimited60m >= RATE_LIMIT_HINT_MIN,
      // 建议值一并给出来：光说"该开闸"没用，得说开成多少。18 = 实测 20 打九折，见上面那段注释。
      suggestGlobalRpmValue: suggestedGlobalRpm(this.env),
      oversizeBlocked60m,
    };
  }
  classCount(startMinute, endMinute, cls) {
    return sumClassCounts(this.state.storage.sql.exec("SELECT classes FROM minute_rollup WHERE minute >= ? AND minute < ?", startMinute, endMinute).toArray(), cls);
  }
  window(startMinute, endMinute) {
    const rows = this.state.storage.sql.exec("SELECT volume, ok, error, estimated, classes, ttfts FROM minute_rollup WHERE minute >= ? AND minute < ? ORDER BY minute ASC", startMinute, endMinute).toArray();
    let volume = 0, ok = 0, error = 0, estimated = 0;
    const byClass = {}, ttfts = [];
    for (const row of rows) {
      volume += Number(row.volume || 0); ok += Number(row.ok || 0); error += Number(row.error || 0); estimated += Number(row.estimated || 0);
      const classes = JSON.parse(row.classes || "{}");
      for (const [k, v] of Object.entries(classes)) byClass[k] = (byClass[k] || 0) + Number(v || 0);
      for (const v of JSON.parse(row.ttfts || "[]")) if (Number.isFinite(Number(v))) ttfts.push(Number(v));
    }
    ttfts.sort((a, b) => a - b);
    return { successRate: volume ? ok / volume : null, errCount: { total: error, byClass }, ttftP50: quantile(ttfts, 0.50), ttftP95: quantile(ttfts, 0.95), volume, estimatedRatio: volume ? estimated / volume : null };
  }
}
// 把若干分钟行里某一类错误的次数加起来。抽成纯函数是为了能单测（DO 的 sql.exec 没法在 node 里跑）。
function sumClassCounts(rows, cls) {
  let n = 0;
  for (const row of rows || []) { try { n += Number(JSON.parse((row && row.classes) || "{}")[cls] || 0); } catch (_) {} }
  return n;
}
function addBoundedSample(samples, value, seen) { const cap = 256; if (samples.length < cap) samples.push(value); else samples[seen % cap] = value; }
function quantile(values, q) { if (!values.length) return null; const i = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * q) - 1)); return values[i]; }

/* ===== 3021 根治：DO 全局令牌桶（跨 isolate 共享账号级每分钟推理配额）=====
   现有 GATE 的 RPM 桶是每-isolate 的：多 isolate 各持整份配额，叠加打爆上游账号级限速（3021）。
   这里以单实例 DO 为唯一记账点；isolate 批量租令牌本地消耗（见 LEASE），DO 不在每请求热路径上。 */
// 纯函数桶算法（便于单测注入 now）：按流逝时间回填后授予 min(want, floor(tokens))；授不出时给 waitMs。
function bucketLease(bucket, limit, want, now) {
  if (bucket.limit !== limit || !bucket.updatedAt) { bucket.limit = limit; bucket.tokens = limit; bucket.updatedAt = now; }
  else {
    bucket.tokens = Math.min(limit, bucket.tokens + (now - bucket.updatedAt) * limit / 60000);
    bucket.updatedAt = now;
  }
  const granted = Math.max(0, Math.min(Math.floor(want), Math.floor(bucket.tokens)));
  bucket.tokens -= granted;
  const waitMs = granted > 0 ? 0 : Math.ceil((1 - bucket.tokens) * 60000 / limit);
  return { granted, waitMs };
}
// 桶只放内存：DO 被驱逐则满桶重来（最多短暂多放行一轮，可接受），不吃存储费、无 alarm。
export class GlobalLimiter {
  constructor(state, env) { this.state = state; this.env = env; this.bucket = { tokens: 0, limit: 0, updatedAt: 0 }; }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/lease" && request.method === "POST") {
      const want = Math.max(1, Math.min(64, Math.floor(Number(url.searchParams.get("want")) || 1)));
      const limit = Math.floor(Number(url.searchParams.get("limit")) || 0);
      if (!(limit > 0)) return Response.json({ error: "bad_limit" }, { status: 400 });
      return Response.json(bucketLease(this.bucket, limit, want, Date.now()));
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }
}

export default {
  async scheduled(event, env, ctx) {
    if (ctx && ctx.waitUntil) ctx.waitUntil(runAiProbe(env, "cron").catch(e => logDiagFailure("ai_probe_cron", e, {})));
  },
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors() });
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      // 公开
      if (p === "/") return html(USAGE_HTML);
      if (p === "/healthz") return json({ status: "ok" });
      if (request.method === "GET" && (p === "/setup" || p === "/setup.ps1")) return setupScript(SETUP_PS1_BASE64, url);
      if (request.method === "GET" && p === "/setup.sh") return setupScript(SETUP_SH_BASE64, url);
      if (p === "/v1/models") return json({ object: "list", data: PUBLIC_MODELS.map(id => ({ id, object: "model", created: 0, owned_by: "cloudflare" })) });
      if (p === "/usage" && request.method === "GET") return html(USAGE_HTML);
      if (p === "/usage" && request.method === "POST") return await handleUsageQuery(request, env);
      // 遥控口（管理密码）
      if (p.startsWith("/admin/api/")) return await handleAdmin(request, env, p);
      // 客户接口（鉴权 + 有效期 + 次数）
      if (p === "/v1/messages/count_tokens") {
        const auth = await authCustomer(request, env); if (!auth.ok) return auth.resp;
        const body = await request.json().catch(() => null);
        if (!body) return json({ error: { message: "请求体不是合法 JSON", type: "invalid_request_error" } }, 400);
        return json({ input_tokens: estimateTokens(JSON.stringify(body)) });
      }
      if (p === "/v1/messages" || p === "/v1/responses" || p === "/v1/chat/completions") {
        const auth = await authCustomer(request, env); if (!auth.ok) return auth.resp;
        let body;
        try { body = await request.json(); }
        catch { return json({ error: { message: "请求体不是合法 JSON", type: "invalid_request_error" } }, 400); }
        let rescuePath = null;   // 非 null = 过大闸判了超限，但放行到 handler 去试救援截断（见 rescueTrim）
        if (shouldRejectOversize(body, env)) {
          // 只有【token 闸】判超的这一种才有救：截断按 token 算，救回来才能确定它真的够小了。
          // 老字符闸（OVERSIZE_CHARS，默认 0=关）按 body 的字符算，截断这边没有对应口径 → 照旧当场 400。
          if (rescueTrimOn(env) && !oversizeByChars(body, env)) rescuePath = p;
          else {
            recordGateBlocked(env, ctx, body, p);   // 旁路记账，不 await；不能让它挡住返回
            return errResp(oversizeError(env));
          }
        }
        const affinity = await sessionAffinity(request, env); // 前缀缓存：同 key/同会话 → 路由同实例
        logDiagContentRequest(env, ctx, p, body, request.headers);
        // API 路径单独 try：失败记一次 failCalls，并按 503 带 Retry-After 友好报错。
        try {
          if (p === "/v1/messages") return await handleClaude(body, env, ctx, affinity, request.signal, rescuePath);
          if (p === "/v1/responses") return await handleResponses(body, env, ctx, affinity, request.signal, rescuePath);
          return await handleChat(body, env, ctx, affinity, request.signal, rescuePath);
        } catch (e) {
          logDiagContentFailure(env, ctx, p, body, request.headers);
          logDiagFailure("api_path", e, { path: p, request: summarizeAiRequest(body) });
          const msg = String((e && e.message) || e).toLowerCase();
          if (msg.includes("client abort") || msg.includes("aborted")) {
            return errResp({ status: 499, type: "invalid_request_error", reason: "client_abort", message: "客户端已断开" });
          }
          ctx.waitUntil(recordUsageSafe(env, false, null, classifyError(e)));   // 带上错误类：客户自查页要按"忙/太密集/对话太长"分开说
          return errResp(friendlyError(e));
        }
      }
      return json({ error: "Not Found" }, 404);
    } catch (e) {
      logDiagFailure("fetch", e, { path: p });
      return errResp(friendlyError(e));
    }
  }
};

function setupScript(encoded, url) {
  const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
  const script = new TextDecoder().decode(bytes);
  return new Response(script.replaceAll(RELAY_URL_PLACEHOLDER, "https://" + url.host), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/* ===== 存储 ===== */
async function getRec(env) {
  if (!env.STORE) return null;
  const v = await env.STORE.get(REC_KEY);
  return v ? JSON.parse(v) : null;
}
async function putRec(env, rec) { if (env.STORE) await env.STORE.put(REC_KEY, JSON.stringify(rec)); }
/* ===== 热计数单独一把 key（2026-07-30，第三方审计第 1 条）=====
   acct        = 开通档：钥匙、开关、到期、次数上限、备注。只有遥控口写，一天写不了几次。
   acct:usage  = 计数档：次数、token、按天、失败分类、过大闸、探针结果。每个请求都写。

   为什么非分不可：记账走的是"读整档 → 改 → 写回整档"，而 KV 的读带最长 60 秒边缘缓存。
   于是刚做完的 admin 改动（换钥匙 / 停用 / 改到期），会被 60 秒内收尾的某个请求
   拿着旧快照原样写回去——被撤销的偏偏都是安全动作：钥匙泄露刚换掉又活了、
   号刚停用又能调了。分开存之后，记账只写 acct:usage、遥控口只写 acct，两边不可能再互相盖。
   （计数自己之间互相盖是另一条：同一个 key 每秒只能写 1 次，不在这条的范围里。）

   迁移不用脚本：老号的计数还留在 acct 里，acct:usage 不存在时就拿 acct 里的旧值当种子，
   下一次记账自然落盘到新 key。acct 里的旧计数字段保持不动，万一回滚也还读得到
   （只是会停在迁移那一刻的数，不会丢）。 */
const USAGE_KEY = REC_KEY + ":usage";
function usageFrom(src) {
  const s = src || {};
  return {
    usedCalls: s.usedCalls || 0, successCalls: s.successCalls || 0, failCalls: s.failCalls || 0,
    tok: s.tok || {}, days: s.days || {}, lastCallAt: s.lastCallAt || 0,
    fail: s.fail || null, blocked: s.blocked || null, aiProbe: s.aiProbe || null,
  };
}
// rec 传进来能省一次读；没传且需要种子时才回头去读 acct（只发生在没迁移过的号身上）
// Raw = 只看 KV 里落了盘的那份，不含本实例还攒着没写下去的差值。只有落盘自己该用它。
async function getUsageRaw(env, rec) {
  if (!env.STORE) return usageFrom(null);
  const v = await env.STORE.get(USAGE_KEY);
  if (v) { try { const u = JSON.parse(v); if (u && typeof u === "object") return usageFrom(u); } catch (_) {} }
  return usageFrom(rec !== undefined ? rec : await getRec(env));
}
// 对外的读一律"落了盘的 + 还没落盘的"，否则刚打的量在面板上看不见、次数上限也会被冲过头
async function getUsage(env, rec) {
  const cur = await getUsageRaw(env, rec);
  return usagePending() ? applyDelta(cur, USAGE_DELTA) : cur;
}
async function putUsage(env, u) { if (env.STORE) await env.STORE.put(USAGE_KEY, JSON.stringify(u)); }
/* ===== 计数写合并（2026-07-30，第三方审计第 2 条）=====
   KV 同一把 key 每秒只能写 1 次，超了那次写直接被丢；读还带最长 60 秒边缘缓存。
   原来每个请求都"读整档 → +1 → 写回整档"：一秒里来 20 条，20 条读到的是同一份旧快照，
   写又只有一次落得下去 —— 20 次调用最后记成 1 次。号越忙账越少，忙到一定程度基本不涨。

   现在改成【攒差值 + 限速落盘】：
   - 请求只往内存里的差值上加（+1 次、+n token…），完全不碰 KV，快且不会互相盖；
   - 距上次落盘满 1 秒才落一次，落盘时【重新读 KV → 把差值加上去 → 写回】。
     加的是差值不是快照，所以这期间别的实例写过、或者遥控口清了零，都不会被我们盖回去
     （清零之后我们是在 0 上加，得到的正是清零后新产生的量）。
   - 落盘失败（限速/网络）把差值原样还回去，下一次接着落，不丢。
   - 读计数一律 KV 值 + 还没落盘的差值，否则刚打的量看不见、次数上限会被冲过头。

   还剩什么没解决（说清楚免得下一个人以为已经是审计级了）：
   多个实例（不同 colo、同 colo 多 isolate）各攒各的，落盘那一刻仍可能互相盖，
   高并发下 token 还是会少算几个百分点。要做到一条不差得把计数搬进 Durable Object，
   热路径上多一跳 + 多一份计费，这次不做。 */
let USAGE_FLUSH_MS = 1000;                   // KV 同 key 每秒 1 写，落盘间隔就卡在这（只有单测会改）
const USAGE_MIRROR_MS = 1000;                // DO 把真数镜回 KV 的节流，同样卡在"每秒 1 写"
function emptyDelta() { return { usedCalls: 0, successCalls: 0, failCalls: 0, tok: {}, days: {}, lastCallAt: 0, fail: null, blocked: null, n: 0 }; }
// 差值过一趟 JSON 再回来（worker → DO），字段可能缺/被改成别的类型，进 applyDelta 前先补齐
function deltaFrom(d) {
  const s = d && typeof d === "object" ? d : {};
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const tok = {};
  if (s.tok && typeof s.tok === "object") for (const m of Object.keys(s.tok)) {
    const t = s.tok[m] || {};
    tok[m] = { in: num(t.in), out: num(t.out), cached: num(t.cached) };
  }
  const days = {};
  if (s.days && typeof s.days === "object") for (const k of Object.keys(s.days)) {
    const t = s.days[k] || {};
    days[k] = { calls: num(t.calls), in: num(t.in), out: num(t.out) };
  }
  const fail = s.fail && typeof s.fail === "object"
    ? { by: (s.fail.by && typeof s.fail.by === "object") ? s.fail.by : {}, lastAt: num(s.fail.lastAt), lastBucket: s.fail.lastBucket || "" } : null;
  const blocked = s.blocked && typeof s.blocked === "object"
    ? { count: num(s.blocked.count), lastAt: num(s.blocked.lastAt), lastTokens: num(s.blocked.lastTokens), maxTokens: num(s.blocked.maxTokens) } : null;
  return { usedCalls: num(s.usedCalls), successCalls: num(s.successCalls), failCalls: num(s.failCalls), tok, days, lastCallAt: num(s.lastCallAt), fail, blocked, n: num(s.n) };
}
let USAGE_DELTA = emptyDelta();              // 本实例攒着还没落盘的差值
let USAGE_LAST_FLUSH = 0;                    // 上次落盘时刻（ms）
let USAGE_FLUSHING = null;                   // 正在落盘的那个 promise，避免同一实例并发写同一把 key
// 把差值加到一份计数档上（纯函数式：base 会被就地改，调用方自己保证 base 是刚读出来的）
function applyDelta(base, d) {
  const u = usageFrom(base);
  u.usedCalls += d.usedCalls; u.successCalls += d.successCalls; u.failCalls += d.failCalls;
  for (const m of Object.keys(d.tok)) {
    const t = u.tok[m] || { in: 0, out: 0, cached: 0 }, s = d.tok[m];
    t.in += s.in; t.out += s.out; t.cached += s.cached;
    u.tok[m] = t;
  }
  for (const k of Object.keys(d.days)) {
    const s = d.days[k];
    u.days = bumpDay(u.days, k, s.calls, s.in, s.out);   // 复用同一套裁天逻辑，只留最近 DAY_KEEP 天
  }
  if (d.lastCallAt > (u.lastCallAt || 0)) u.lastCallAt = d.lastCallAt;
  if (d.fail) {
    const f = u.fail || { by: {}, lastAt: 0, lastBucket: "" };
    f.by = f.by || {};
    for (const b of Object.keys(d.fail.by)) f.by[b] = (f.by[b] || 0) + d.fail.by[b];
    if (d.fail.lastAt >= (f.lastAt || 0)) { f.lastAt = d.fail.lastAt; f.lastBucket = d.fail.lastBucket; }
    u.fail = f;
  }
  if (d.blocked) {
    const b = u.blocked || { count: 0, lastAt: 0, lastTokens: 0, maxTokens: 0 };
    b.count = (b.count || 0) + d.blocked.count;
    if (d.blocked.lastAt >= (b.lastAt || 0)) { b.lastAt = d.blocked.lastAt; b.lastTokens = d.blocked.lastTokens; }
    if (d.blocked.maxTokens > (b.maxTokens || 0)) b.maxTokens = d.blocked.maxTokens;
    u.blocked = b;
  }
  return u;
}
// 把两份差值并起来：落盘失败要把差值还回去，期间可能已经又攒了新的，不能直接覆盖
function mergeDelta(a, b) {
  const d = applyDelta(a, b);                 // 计数部分的合并规则跟"加到档上"完全一样
  return { usedCalls: d.usedCalls, successCalls: d.successCalls, failCalls: d.failCalls, tok: d.tok, days: d.days, lastCallAt: d.lastCallAt, fail: d.fail, blocked: d.blocked, n: a.n + b.n };
}
function usagePending() { return USAGE_DELTA.n > 0; }
/* ===== 计数搬 DO（2026-07-31，审计②根治）=====
   上面那套"攒差值 + 每秒落一次盘"只治得了同一个 isolate 内部：多个 isolate（不同 colo、
   同 colo 多实例）各攒各的，落盘那一刻仍然是各读各的旧数、互相盖 —— 实测同时打 20 条只记到 7。
   现在把"加"这个动作交给 SentinelRollup DO：DO 是单实例、请求天生排队，
   谁先到谁先加，一条不差。KV 退成 DO 的镜像，客户页/面板读法一个字没改。
   - **不新建 DO 类**：复用 45 个号上早就绑好的 SENTINEL_ROLLUP，所以不用改 wrangler.toml，
     也就不碰"新账号必须 new_sqlite_classes"那个坑（见 docs/40 2026-07-23）。
   - **不上热路径**：记账本来就在 ctx.waitUntil 旁路；读计数照旧走 KV，客户请求不多一跳。
   - **DO 挂了怎么办**：差值原样留在内存里，下一次接着送（跟落盘失败的处理一样）。
     **故意不退回"直写 KV"**——DO 可能已经加过了，退回去等于有机会重复计数，
     那是把数算多、客户吃亏；宁可少算（我们吃亏）也不能多算。
   - **关闸开关**：`USAGE_IN_DO=0` 立刻退回旧路（旧路仍然全须全尾地留着）。 */
function usageDoStub(env) {
  if (!env || !env.SENTINEL_ROLLUP) return null;
  if (String(env.USAGE_IN_DO || "") === "0") return null;
  try { return env.SENTINEL_ROLLUP.get(env.SENTINEL_ROLLUP.idFromName("relay-rollup")); } catch (_) { return null; }
}
async function usageDoCall(stub, path, body) {
  const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) };
  const r = await stub.fetch("https://sentinel-rollup" + path, init);
  if (!r || !r.ok) throw new Error("usage_do_" + (r ? r.status : "no_response"));
  return r;
}
function pushUsageDelta(stub, delta) { return usageDoCall(stub, "/usage/delta", { delta }); }
// 落盘：读最新 KV → 加差值 → 写回。force=true 用于遥控口那种必须立刻落的场合。
async function flushUsage(env, force) {
  if (!env || !env.STORE || !usagePending()) return false;
  if (USAGE_FLUSHING) return USAGE_FLUSHING;                       // 已经有人在落了，蹭同一次
  const now = Date.now();
  if (!force && now - USAGE_LAST_FLUSH < USAGE_FLUSH_MS) return false;   // 没到 1 秒，继续攒
  const mine = USAGE_DELTA;
  USAGE_DELTA = emptyDelta();
  USAGE_LAST_FLUSH = now;
  const job = (async () => {
    try {
      const stub = usageDoStub(env);
      if (stub) { await pushUsageDelta(stub, mine); return true; }   // 交给 DO 累加（它串行，不会互相盖）
      const cur = await getUsageRaw(env);
      await putUsage(env, applyDelta(cur, mine));
      return true;
    } catch (e) {
      USAGE_DELTA = mergeDelta(mine, USAGE_DELTA);                 // 还回去，下次接着落
      throw e;
    } finally { USAGE_FLUSHING = null; }
  })();
  USAGE_FLUSHING = job;
  return job;
}
/* 收尾落盘：一波请求打完就没人再来了，最后攒的那点差值不能一直躺在内存里
   （实例随时会被回收，躺着就是真丢）。所以没轮到落盘的那次，挂一个"到点再落"的定时器，
   由 ctx.waitUntil 拽着不让实例提前收工。同一时刻只挂一个，后来的都蹭它。 */
let USAGE_TRAILING = null;
let USAGE_TRAIL_FIRE = null;                 // 提前把定时器捅响（只有单测用，不然一条断言要真等一个落盘间隔）
let USAGE_ENV = null;                        // 落盘时拿最近一次请求的 env（每个请求的 env 是新对象，STORE 绑定是同一个）
function scheduleFlush() {
  if (USAGE_TRAILING) return USAGE_TRAILING;
  const wait = Math.max(0, USAGE_FLUSH_MS - (Date.now() - USAGE_LAST_FLUSH));
  const p = new Promise((r) => { const t = setTimeout(r, wait); USAGE_TRAIL_FIRE = () => { clearTimeout(t); r(); }; })
    .then(() => { USAGE_TRAILING = null; USAGE_TRAIL_FIRE = null; return flushUsage(USAGE_ENV, true); })
    .catch((e) => { USAGE_TRAILING = null; USAGE_TRAIL_FIRE = null; throw e; });
  USAGE_TRAILING = p;
  return p;
}
function __testFireUsageTrailing() { if (USAGE_TRAIL_FIRE) USAGE_TRAIL_FIRE(); }
// 差值攒完催一次落盘：到点了当场落，没到点就挂个到点再落的
function bumpUsage(env, mut) {
  USAGE_ENV = env;
  mut(USAGE_DELTA);
  USAGE_DELTA.n++;
  const now = Date.now();
  if (now - USAGE_LAST_FLUSH >= USAGE_FLUSH_MS) return Promise.resolve(flushUsage(env, false)).then(() => {});
  return scheduleFlush().then(() => {});
}
function __testResetUsageCoalesce(ms) {
  __testFireUsageTrailing();                       // 上一条测试挂着的定时器先捅响，别让它拖住整个进程
  USAGE_DELTA = emptyDelta(); USAGE_LAST_FLUSH = 0; USAGE_FLUSHING = null; USAGE_TRAILING = null; USAGE_ENV = null;
  if (ms !== undefined) USAGE_FLUSH_MS = ms;      // 单测把落盘间隔调小，不然每条断言都要真等 1 秒
}
/* 清零：必须先把攒着还没落盘的差值落下去再清。
   不然清完零，那份差值会在下一秒被加回 KV —— 面板上就是"点了清零，过一会儿数字又冒出来一点"。
   落盘失败也照清（客户已经点了清零，不能因为 KV 抽风就不清），只是那点差值会跟着丢，可接受。 */
async function resetUsageDoc(env, rec) {
  try { await flushUsage(env, true); if (usagePending()) await flushUsage(env, true); } catch (_) {}
  USAGE_DELTA = emptyDelta();
  // DO 在管账时必须由它来清：直接写 KV 只会被 DO 的下一次镜像盖回去（数字"清完又冒出来"）
  const stub = usageDoStub(env);
  if (stub) { try { await usageDoCall(stub, "/usage/reset", {}); return; } catch (_) {} }
  await putUsage(env, clearCounters(await getUsageRaw(env, rec)));
}
// 清零：口径跟改造前一模一样——只清次数/token/过大闸，按天、失败分类、探针结果都保留
function clearCounters(t) { t.usedCalls = 0; t.successCalls = 0; t.failCalls = 0; t.tok = {}; t.blocked = null; return t; }
async function getAiProbe(env) { return (await getUsage(env)).aiProbe || null; }
async function putAiProbe(env, probe) {
  const rec = await getRec(env);
  if (!rec) return false;                       // 没开通的号不落盘（与改造前一致）
  // 探针只改 aiProbe 一个字段，读的必须是 Raw：带上还没落盘的差值再整档写回，
  // 那份差值就等于提前落了一次，等真落盘时会被再加一遍 —— 次数凭空翻倍。
  const stub = usageDoStub(env);                // 同清零：DO 在管账时，整档写 KV 会被它盖回去
  if (stub) { try { await usageDoCall(stub, "/usage/probe", { probe }); return true; } catch (_) {} }
  const u = await getUsageRaw(env, rec);
  u.aiProbe = probe;
  await putUsage(env, u);
  return true;
}

/* ===== 客户鉴权 + 有效期 + 次数 ===== */
function extractKey(req) {
  const a = req.headers.get("authorization");
  if (a) { const m = a.match(/^Bearer\s+(.+)$/i); return (m ? m[1] : a).trim(); }
  return (req.headers.get("x-api-key") || "").trim();
}
// 会话亲和（Workers AI 前缀缓存）：客户端传了 x-session-affinity 则优先透传；否则用 API key 的哈希做稳定 ID。
// 同一客户连续请求路由到同一实例 → 命中前缀缓存（输入便宜 ~80%、降首包）。绝不用明文 key 当头值。
async function sessionAffinity(request, env) {
  const passed = (request.headers.get("x-session-affinity") || "").trim();
  if (passed) return passed;
  const key = extractKey(request);
  return key ? await sha256(key) : null;
}
/* ===== 换钥匙宽限期（双钥匙过渡）=====
   老行为：面板一按"换钥匙"，旧钥匙当场作废 → 正在跑的客户端（ZCode/ClaudeCode/脚本）立刻全红，
   客户得在被打断的情况下手忙脚乱改配置。
   现在：换钥匙时旧钥匙的 hash 存进 prevKeyHash，在 prevKeyExpiresAt 之前仍然放行，
   客户有一整天从容切换。钥匙泄露要立刻断，换钥匙时传 graceHours=0（旧钥匙当场作废，等于老行为）。
   宽限期只对"上一把"有效，且只保留一把——连按两次换钥匙，第一把立即失效。 */
const ROTATE_GRACE_HOURS_DEFAULT = 24;
const ROTATE_GRACE_SEC_MAX = 30 * 86400;
// 返回 "cur"（当前钥匙）/ "prev"（宽限期内的旧钥匙）/ null（都不是）
function matchRecKey(rec, h) {
  if (rec.keyHash && safeEqual(h, rec.keyHash)) return "cur";
  if (rec.prevKeyHash && rec.prevKeyExpiresAt > nowSec() && safeEqual(h, rec.prevKeyHash)) return "prev";
  return null;
}
async function authCustomer(req, env) {
  const rec = await getRec(env);
  const key = extractKey(req);
  if (!rec || !key) return deny(401, "API Key 无效", "bad_key");
  const h = await sha256(key);
  const via = matchRecKey(rec, h);
  if (!via) return deny(401, "API Key 无效", "bad_key");
  if (!rec.enabled) return deny(403, "该服务已停用", "disabled");
  if (rec.expiresAt != null && nowSec() >= rec.expiresAt) return deny(403, "服务已到期，请联系续期", "expired");
  // 次数上限：只有真限量的号才多读一次计数档，不限量的号（绝大多数）不为这一句多花一次 KV 读
  if (rec.maxCalls >= 0 && (await getUsage(env, rec)).usedCalls >= rec.maxCalls) return deny(403, "调用次数已用尽，请联系充值", "quota_exhausted");
  return { ok: true, rec, via };
}
// reason 只进响应头（机器可读），不进给客户看的文案 —— 文案照旧是中文人话。
function deny(status, message, reason) {
  return { ok: false, resp: json({ error: { message, type: "invalid_request_error" } }, status, reason ? { [DENY_REASON_HEADER]: reason } : undefined) };
}
/* ===== 按天用量（客户自查页的"最近 7 天"）=====
   为什么按北京时间分天：看这页的是国内客户，用 UTC 分天会让"今天"在早上 8 点前算成昨天，
   客户一看就觉得数字不对。存的 key 是 YYYY-MM-DD（北京），只保留最近 DAY_KEEP 天，记录不会无限长。 */
const DAY_KEEP = 7;
function dayKeyCN(ms) { return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10); }
// 纯函数（便于单测）：往 days 里累加一天，并裁掉过老的天。days 是 { "YYYY-MM-DD": {calls,in,out} }
function bumpDay(days, key, calls, inp, out) {
  const d = { ...(days || {}) };
  const cur = d[key] || { calls: 0, in: 0, out: 0 };
  d[key] = { calls: cur.calls + (calls || 0), in: cur.in + (inp || 0), out: cur.out + (out || 0) };
  const keys = Object.keys(d).sort();                       // 字典序 = 时间序（定长 YYYY-MM-DD）
  for (const k of keys.slice(0, Math.max(0, keys.length - DAY_KEEP))) delete d[k];
  return d;
}
// 最近 7 天补齐成数组（缺的那天补 0，前端才画得出连续柱子）
function recentDays(days, now = Date.now()) {
  const out = [];
  for (let i = DAY_KEEP - 1; i >= 0; i--) {
    const k = dayKeyCN(now - i * 86400000);
    const v = (days || {})[k] || { calls: 0, in: 0, out: 0 };
    out.push({ d: k, calls: v.calls || 0, in: v.in || 0, out: v.out || 0 });
  }
  return out;
}
/* 失败原因说人话：把内部错误类（classifyError 的口径）折成客户看得懂、且**能自己动手**的四类。
   只给客户这四类，不给原文——原文里可能有上游/账号措辞，那是我们的内务，不该出现在客户页上。 */
const FAIL_BUCKETS = { busy: "服务器忙", dense: "请求太密集", toolong: "对话太长", other: "其他错误" };
function failBucket(cls) {
  if (cls === "rate_limited_3021" || cls === "gate_full") return "dense";
  if (cls === "context_5021") return "toolong";
  if (cls === "capacity_3040" || cls === "upstream_stalled" || cls === "prefill_timeout" || cls === "circuit_open" || cls === "connect_stall") return "busy";
  return "other";
}
// 每类配一句"你该怎么办"，客户自己就能解决大半，不用来找人
function failAdvice(bucket) {
  if (bucket === "dense") return "发得太快被限速了，把并发降一点或稍等再试";
  if (bucket === "toolong") return "这轮对话太长了，新开一个会话再问";
  if (bucket === "busy") return "上游当时挤，过一会儿重试通常就好";
  return "偶发错误，重试一次；一直这样请联系我们";
}
// 记账：次数（同前）+ 可选的 token 用量（按模型分桶累加）+ 按天用量 + 最近一次调用 + 失败原因分类。
// usage 省略/为空 → 只记次数（失败路径、或拿不到 usage 时），次数口径与改造前完全一致。
// 仍是 KV 读-改-写：高并发偶发丢更新 → token 可能少算几个百分点（看趋势准、非审计级），可接受。
// 但读写的是【计数档】(acct:usage)，碰不到钥匙/开关/到期——记账再怎么并发也撤销不了 admin 的动作。
async function recordUsage(env, success, usage, errClass) {
  if (!env.STORE) return;
  // 只往内存差值上加，不读 KV 也不写 KV；写不写、什么时候写由 bumpUsage 里的限速决定
  return bumpUsage(env, (u) => {
    if (success) { u.usedCalls++; u.successCalls++; }
    else { u.failCalls++; }
    if (usage && usage.model && ((usage.in || 0) + (usage.out || 0) + (usage.cached || 0) > 0)) {
      const t = u.tok[usage.model] || { in: 0, out: 0, cached: 0 };
      t.in += usage.in || 0; t.out += usage.out || 0; t.cached += usage.cached || 0; // cached ⊆ in（上游 prompt_tokens_details 语义），成本侧再扣减
      u.tok[usage.model] = t;
    }
    const nowMs = Date.now();
    u.lastCallAt = nowSec();
    // 按天只记成功的次数与 token：失败那笔另有 fail 计数，混进来会让"我今天用了多少"虚高
    u.days = bumpDay(u.days, dayKeyCN(nowMs), success ? 1 : 0, usage && usage.in, usage && usage.out);
    if (!success) {
      const b = failBucket(errClass);
      u.fail = u.fail || { by: {}, lastAt: 0, lastBucket: "" };
      u.fail.by[b] = (u.fail.by[b] || 0) + 1;
      u.fail.lastAt = nowSec();
      u.fail.lastBucket = b;
    }
  });
}
// 记账是旁路：写失败绝不能影响客户请求，但也不该悄无声息。
// 此前一律 ctx.waitUntil(裸 recordUsage(...))，KV 写失败(限速/配额/网络)时 reject 被 waitUntil 吞掉，
// 表现为"次数/token 莫名少算"且日志里一点痕迹都没有。现在统一走这里，失败留一条诊断。
function recordUsageSafe(env, success, usage, errClass) {
  return recordUsage(env, success, usage, errClass).catch((e) => logDiagFailure("record_usage", e, { success: !!success, model: usage && usage.model }));
}
// 过大闸拒绝：单独计一笔。
// 为什么不并进 failCalls：那是"上游失败率"的口径，被自己闸门挡下的请求根本没到上游，
// 混进去会把成功率的含义弄脏。为什么必须计：这个 return 在记账 try 之前，此前既不计 failCalls
// 也不计 usedCalls，于是一个天天被误拦的号在面板上成功率照样 100% —— P0-3 潜了这么久没人报，
// 就是因为它在统计上完全隐形（2026-07-27 靠算术推出来的，不是系统报的）。
// 外层同步：writeSentinel 自己要用 ctx.waitUntil 写 rollup，必须在请求作用域里直接调，
// 不能套在另一个 waitUntil 里（嵌套注册在 ctx 已收尾时会抛）。KV 那步才是异步旁路。
function recordGateBlocked(env, ctx, options, path) {
  const est = estimateReqTokens(options);          // 记忆化：闸门刚算过，这里不会重复遍历请求体
  console.log("[zcode-diag]", JSON.stringify({
    tag: "oversize_blocked", path, est, tokenLimit: oversizeTokenLimit(env),
    chars: estimateReqChars(options), charLimit: oversizeLimit(env),
  }));
  // 观测点：让 /admin/api/health 的时间窗里能看见 gate_oversize（与上游错误分开计类）
  try { writeSentinel(env, ctx, sentinelPoint(env, options, false, Date.now(), "error", "gate_oversize", -1, { input: est, output: 0 })); } catch (_) {}
  const p = bumpBlockedCount(env, est).catch((e) => logDiagFailure("record_blocked", e, { path }));
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
  return p;
}
async function bumpBlockedCount(env, est) {
  if (!env.STORE) return;
  return bumpUsage(env, (u) => {                    // 同上：只动计数档，而且只往差值上加
    const b = u.blocked || { count: 0, lastAt: 0, lastTokens: 0, maxTokens: 0 };
    b.count = (b.count || 0) + 1;
    b.lastAt = nowSec();
    b.lastTokens = est;
    if (est > (b.maxTokens || 0)) b.maxTokens = est;
    u.blocked = b;
  });
}
// 组装一条 token 记账：model 统一用 resolveModel 后的真实 @cf/... ID（与价格表对得上）。
function tokRec(model, inp, out, cached) { return { model, in: inp || 0, out: out || 0, cached: cached || 0 }; }
// 流式：从 finalize 出来的上游 usage 取真实 token（缺则回退到 estInput/长度估算，与回给客户端的 usage 同源）。
function streamTok(options, fin, estInput) {
  const u = usageOut(fin, fin.text, estInput);
  const model = resolveModel(options.model);
  if (!u.isEstimated) logTokenEstimateDrift(model, options, u.input);   // 只有拿到上游真数才有校准价值
  return tokRec(model, u.input, u.output, u.cached);
}

/* ===== 客户自查 ===== */
/* ===== 客户能看到的"服务状态" =====
   把 2h 自探针的结论翻成客户版：只给档位 + 实测毫秒 + 机房，**绝不带错误原文**。
   原文里可能有账号/订阅/上游措辞（如 "Workers Free plan"），那是我们的内务，不该出现在客户页上。
   探针超过 6 小时没更新就一律 unknown（跟面板同一个保质期）——没验过就别发绿灯，
   宁可显示"运行中"也不能对客户撒一句"服务正常"。 */
const PROBE_STALE_MS = 6 * 3600 * 1000;
const COLO_CN = { LAX: "洛杉矶", SJC: "圣何塞", SEA: "西雅图", ORD: "芝加哥", IAD: "华盛顿", EWR: "纽约", DFW: "达拉斯", MIA: "迈阿密", NRT: "东京", KIX: "大阪", ICN: "首尔", HKG: "香港", TPE: "台北", SIN: "新加坡", FRA: "法兰克福", LHR: "伦敦", AMS: "阿姆斯特丹", CDG: "巴黎" };
function coloCN(colo) { return colo ? (COLO_CN[String(colo).toUpperCase()] || String(colo)) : ""; }
function svcSummary(probe, now = Date.now()) {
  if (!probe || !probe.lastProbeAt) return { state: "unknown", latencyMs: null, place: "", checkedAt: 0 };
  const at = Date.parse(probe.lastProbeAt);
  if (!(at >= 0) || now - at > PROBE_STALE_MS) return { state: "unknown", latencyMs: null, place: "", checkedAt: 0 };
  const state = probe.aiOk ? "ok" : ((probe.soft || probe.upstreamBusy) ? "busy" : "down");
  return { state, latencyMs: probe.aiOk ? (probe.latencyMs || null) : null, place: coloCN(probe.colo), checkedAt: Math.floor(at / 1000) };
}
async function handleUsageQuery(request, env) {
  const rec = await getRec(env);
  const key = extractKey(request);
  if (!rec || !key) return json({ ok: false, error: { message: "密钥无效" } }, 401);
  const via = matchRecKey(rec, await sha256(key));
  if (!via) return json({ ok: false, error: { message: "密钥无效" } }, 401);
  const u = await getUsage(env, rec);   // 数字一律以计数档为准（老号自动拿 acct 里的旧值打底）
  const fail = u.fail || null;
  return json({
    ok: true, label: rec.label || "", enabled: !!rec.enabled,
    // 用的是宽限期里的旧钥匙时，明确告诉客户"该换了、还剩多久"，别等它突然失效才发现
    usingOldKey: via === "prev",
    oldKeyExpiresAt: via === "prev" ? rec.prevKeyExpiresAt : null,
    notice: via === "prev" ? "你用的是已被替换的旧密钥，仅在宽限期内可用，请尽快换成新密钥" : "",
    expiresAt: rec.expiresAt == null ? null : rec.expiresAt,
    expired: rec.expiresAt != null && nowSec() >= rec.expiresAt,
    maxCalls: rec.maxCalls, usedCalls: u.usedCalls || 0,
    remaining: rec.maxCalls < 0 ? -1 : Math.max(0, rec.maxCalls - (u.usedCalls || 0)),
    successCalls: u.successCalls || 0, failCalls: u.failCalls || 0,
    tok: u.tok || {},
    // 下面这些是给客户"看得见的用量"：最近一次调用、按天趋势、失败原因（人话）、被过大闸挡下的次数、服务状态
    lastCallAt: u.lastCallAt || 0,
    days: recentDays(u.days),
    fail: fail ? { lastAt: fail.lastAt || 0, last: FAIL_BUCKETS[fail.lastBucket] || "", advice: fail.lastBucket ? failAdvice(fail.lastBucket) : "", by: Object.keys(fail.by || {}).map((k) => ({ name: FAIL_BUCKETS[k] || k, n: fail.by[k] })) } : null,
    blocked: u.blocked ? { count: u.blocked.count || 0, lastAt: u.blocked.lastAt || 0, lastTokens: u.blocked.lastTokens || 0, maxTokens: u.blocked.maxTokens || 0, limit: oversizeTokenLimit(env), ctx: MODEL_CTX_TOKENS } : null,
    svc: svcSummary(u.aiProbe),
  });
}

/* ===== 遥控口（管理密码）===== */
/* 密码失败计数拿两份（审计零碎条之一）：KV 那份读带最长 60 秒边缘缓存、同一 key 每秒只能写 1 次，
   并发爆破的一整波里它读出来永远是 0、写还成批失败——等于没锁。
   内存这份在本 isolate 里瞬时生效：高速爆破必然打进同一机房的少数 isolate，第 9 发当场 429；
   慢速的跨 isolate 爆破（隔秒一发）KV 写得动，仍由 KV 那份管。两份取大。 */
const ADMIN_FAIL_MAX = 8, ADMIN_FAIL_WINDOW_MS = 900000;
const ADMIN_FAILS = new Map();               // ip -> { n, until }
function adminFailGet(ip) {
  const e = ADMIN_FAILS.get(ip);
  if (!e || Date.now() > e.until) { ADMIN_FAILS.delete(ip); return 0; }
  return e.n;
}
function adminFailBump(ip) {
  const n = adminFailGet(ip) + 1;
  ADMIN_FAILS.set(ip, { n, until: Date.now() + ADMIN_FAIL_WINDOW_MS });
  // 条目只增不减会吃内存（CF-Connecting-IP 是 CF 打的、伪造不了，但真实 IP 也可能很多）：过千先清过期的
  if (ADMIN_FAILS.size > 1000) for (const [k, v] of ADMIN_FAILS) { if (Date.now() > v.until) ADMIN_FAILS.delete(k); }
  return n;
}
function __testResetAdminFails() { ADMIN_FAILS.clear(); }
async function handleAdmin(request, env, p) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const fk = "lf:" + ip;
  const kvFails = env.STORE ? (parseInt(await env.STORE.get(fk) || "0", 10) || 0) : 0;
  const fails = Math.max(kvFails, adminFailGet(ip));
  if (fails >= ADMIN_FAIL_MAX) return json({ error: "尝试次数过多，请 15 分钟后再试" }, 429);
  const tok = request.headers.get("x-admin-token") || "";
  if (!env.ADMIN_TOKEN || !safeEqual(tok, env.ADMIN_TOKEN)) {
    adminFailBump(ip);
    // KV 那份尽力写：爆破波里这个 put 会被每秒 1 写顶回来，不能让它把 401 炸成 500
    if (env.STORE) try { await env.STORE.put(fk, String(fails + 1), { expirationTtl: 900 }); } catch (_) {}
    return json({ error: "管理密码无效" }, 401);
  }
  ADMIN_FAILS.delete(ip);
  if (env.STORE && kvFails) await env.STORE.delete(fk);
  if (p === "/admin/api/status" && request.method === "GET") {
    const rec = await getRec(env);
    if (!rec) return json({ ok: true, exists: false });
    const u = await getUsage(env, rec);          // 计数一律以计数档为准
    const tot = (u.successCalls || 0) + (u.failCalls || 0);
    return json({ ok: true, exists: true, label: rec.label, keyPrefix: rec.keyPrefix, enabled: !!rec.enabled,
      // 宽限期里的旧钥匙（给面板显示"旧钥匙还能用到几点"，过期了就当没有）
      prevKeyPrefix: rec.prevKeyExpiresAt > nowSec() ? (rec.prevKeyPrefix || "") : "",
      prevKeyExpiresAt: rec.prevKeyExpiresAt > nowSec() ? rec.prevKeyExpiresAt : 0,
      createdAt: rec.createdAt, expiresAt: rec.expiresAt, maxCalls: rec.maxCalls, usedCalls: u.usedCalls || 0,
      remaining: rec.maxCalls < 0 ? -1 : Math.max(0, rec.maxCalls - (u.usedCalls || 0)),
      successCalls: u.successCalls || 0, failCalls: u.failCalls || 0,
      // 被自己的过大闸挡下的次数：与 failCalls 分开，成功率里不含它（它们根本没到上游）
      blocked: u.blocked || { count: 0, lastAt: 0, lastTokens: 0, maxTokens: 0 },
      tok: u.tok || {},
      aiProbe: u.aiProbe || null,
      successRate: tot ? Math.round((u.successCalls || 0) / tot * 1000) / 10 : null });
  }
  if (p === "/admin/api/aitest" && request.method === "GET") return await handleAiTest(env);
  if (p === "/admin/api/health" && request.method === "GET") return await handleSentinelHealth(env);
  if (p === "/admin/api/config" && request.method === "POST") {
    const rec = (await getRec(env)) || newRec();
    const b = await request.json().catch(() => ({}));
    if (typeof b.label === "string") rec.label = b.label.slice(0, 80);
    if (typeof b.enabled === "boolean") rec.enabled = b.enabled;
    if (b.maxCalls !== undefined) rec.maxCalls = toInt(b.maxCalls, -1);
    if (b.expiresInDays !== undefined && b.expiresInDays !== null && b.expiresInDays !== "") rec.expiresAt = nowSec() + Math.round(Number(b.expiresInDays) * 86400);
    else if (b.expiresAt !== undefined) rec.expiresAt = b.expiresAt === null ? null : toInt(b.expiresAt, null);
    await putRec(env, rec);
    return json({ ok: true });
  }
  if (p === "/admin/api/rotate" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const rec = (await getRec(env)) || newRec();
    const raw = mintKey();
    // 旧钥匙进宽限期：默认 24 小时内仍可用，客户不会被当场踢下线。
    // graceHours=0（或负数）= 旧钥匙当场作废（钥匙泄露时用）。上限 30 天。
    const gh = (b.graceHours === undefined || b.graceHours === null || b.graceHours === "")
      ? ROTATE_GRACE_HOURS_DEFAULT : Number(b.graceHours);
    const graceSec = Number.isFinite(gh) && gh > 0 ? Math.min(Math.round(gh * 3600), ROTATE_GRACE_SEC_MAX) : 0;
    if (graceSec > 0 && rec.keyHash) {
      rec.prevKeyHash = rec.keyHash;            // 只保留上一把：连按两次换钥匙，第一把立即失效
      rec.prevKeyPrefix = rec.keyPrefix || "";
      rec.prevKeyExpiresAt = nowSec() + graceSec;
    } else {
      rec.prevKeyHash = ""; rec.prevKeyPrefix = ""; rec.prevKeyExpiresAt = 0;
    }
    rec.keyHash = await sha256(raw);
    rec.keyPrefix = raw.slice(0, 12);
    if (typeof b.label === "string") rec.label = b.label.slice(0, 80);
    if (b.maxCalls !== undefined) rec.maxCalls = toInt(b.maxCalls, rec.maxCalls);
    if (b.expiresInDays !== undefined && b.expiresInDays !== null && b.expiresInDays !== "") rec.expiresAt = nowSec() + Math.round(Number(b.expiresInDays) * 86400);
    // 清零要两边一起清：计数档是现在的真数，acct 里那份是给回滚兜底的旧字段，留着不清会诈尸
    if (b.resetUsage) { clearCounters(rec); await resetUsageDoc(env, rec); }
    rec.enabled = true;
    await putRec(env, rec);
    return json({ ok: true, key: raw, keyPrefix: rec.keyPrefix, prevKeyPrefix: rec.prevKeyPrefix || "", prevKeyExpiresAt: rec.prevKeyExpiresAt || 0 });
  }
  // 立刻作废宽限期里的旧钥匙（发现泄露、或客户已经换好了不想再等）
  if (p === "/admin/api/revoke-prev" && request.method === "POST") {
    const rec = await getRec(env); if (!rec) return json({ ok: true, revoked: false });
    const had = !!(rec.prevKeyHash && rec.prevKeyExpiresAt > nowSec());
    rec.prevKeyHash = ""; rec.prevKeyPrefix = ""; rec.prevKeyExpiresAt = 0;
    await putRec(env, rec);
    return json({ ok: true, revoked: had });
  }
  if (p === "/admin/api/reset" && request.method === "POST") {
    const rec = await getRec(env); if (!rec) return json({ ok: true });
    await resetUsageDoc(env, rec);                                 // 计数档才是现在的真数（清之前先把没落盘的差值落掉）
    clearCounters(rec);                                            // acct 里那份旧字段一并清，免得回滚时诈尸
    await putRec(env, rec);
    return json({ ok: true });
  }
  return json({ error: "Not Found" }, 404);
}
// prevKeyHash/prevKeyPrefix/prevKeyExpiresAt = 换钥匙宽限期用的"上一把钥匙"（见 matchRecKey）。
// 老记录里没有这三个字段，读出来是 undefined，matchRecKey 走的是假值分支，行为与改造前完全一致，不用迁移。
function newRec() { return { label: "", keyHash: "", keyPrefix: "", prevKeyHash: "", prevKeyPrefix: "", prevKeyExpiresAt: 0, enabled: false, createdAt: nowSec(), expiresAt: null, maxCalls: -1, usedCalls: 0, successCalls: 0, failCalls: 0 }; }

async function handleAiTest(env) {
  return json(await runAiProbe(env, "manual"));
}

async function runAiProbe(env, source) {
  const runId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : rid();
  const started = Date.now();
  const utcTime = new Date().toISOString();
  let colo = null;
  let aiOk = false;
  let latencyMs = null;
  let lastError = null;
  let lastThrown = null;
  let attempts = 0;
  try { colo = await probeColo(); } catch (_) { colo = null; }
  try {
    const model = resolveModel("glm-5.2");
    const req = { messages: [{ role: "user", content: "ping" }], stream: false, max_completion_tokens: 1 };
    for (let attempt = 0; attempt < 3; attempt++) {
      attempts = attempt + 1;
      const attemptStarted = Date.now();
      try {
        await withTimeout(env.AI.run(model, req), 30000);
        aiOk = true;
        latencyMs = Date.now() - attemptStarted;
        lastError = null;
        break;
      } catch (e) {
        lastThrown = e;
        lastError = aiProbeError(e);
        if (attempt < 2) {
          try { await sleep(10000); } catch (_) {}
        }
      }
    }
  } catch (e) {
    lastThrown = e;
    lastError = aiProbeError(e);
  }
  const nowIso = new Date().toISOString();
  const failureFlags = aiProbeFailureFlags(aiOk, lastThrown);
  const rl = await probeRateLimitHint(env);   // 顺带把"近 1 小时 3021 次数"带出来（不额外多写一次 KV）
  const probe = {
    aiOk,
    ...failureFlags,
    ...rl,
    latencyMs: aiOk ? latencyMs : null,
    lastError: aiOk ? null : lastError,
    lastProbeAt: nowIso,
    lastSuccessAt: aiOk ? nowIso : ((await getAiProbe(env).catch(() => null)) || {}).lastSuccessAt || null,
    colo,
    attempts,
    source
  };
  try { await putAiProbe(env, probe); } catch (_) {}
  return { aiOk, ...failureFlags, latencyMs: probe.latencyMs, attempts, lastError: probe.lastError, colo, runId, source, utcTime, cnTime: cnTime(started) };
}

/* 3021 开闸信号（P1-1）：根治用的 DO 全局令牌桶已全网就位，但默认不设 GLOBAL_RPM_LIMIT = 闸关，
   此前完全没有"哪个号该开闸"的信号——只能等客诉。这里在 2h 自探针里顺手读一次 rollup，
   把近 1 小时 3021 次数和建议写进探针记录（面板读的就是它）。只提示，开闸仍由人拍板。
   DO 不通/没绑定一律静默返回空，绝不能因为这个可选信号把自探针搞失败。 */
async function probeRateLimitHint(env) {
  try {
    if (!env || !env.SENTINEL_ROLLUP) return {};
    const stub = env.SENTINEL_ROLLUP.get(env.SENTINEL_ROLLUP.idFromName("relay-rollup"));
    const data = await (await stub.fetch("https://sentinel-rollup/health")).json();
    if (!data || typeof data.rateLimited60m !== "number") return {};
    // 建议值带上：老版本的 DO 还没有这个字段，本地按同一套实测值兜底，探针记录里不会缺
    return {
      rateLimited60m: data.rateLimited60m,
      suggestGlobalRpmLimit: !!data.suggestGlobalRpmLimit,
      suggestGlobalRpmValue: Number(data.suggestGlobalRpmValue) > 0 ? Number(data.suggestGlobalRpmValue) : suggestedGlobalRpm(env),
    };
  } catch (_) { return {}; }
}
function aiProbeFailureFlags(aiOk, lastThrown) {
  const soft = !aiOk && isCapacityError(lastThrown);
  return { soft, upstreamBusy: soft };
}

async function probeColo() {
  const r = await fetch("https://cloudflare.com/cdn-cgi/trace");
  const txt = await r.text();
  const m = txt.match(/^colo=(.+)$/m);
  return m ? m[1].trim() : null;
}
function cnTime(ms) {
  try {
    return new Date(ms).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  } catch (_) {
    return new Date(ms + 8 * 3600 * 1000).toISOString().replace("T", " ").replace("Z", "+08:00");
  }
}
function aiProbeError(e) {
  const s = String((e && (e.message || e.name)) || e || "");
  const low = s.toLowerCase();
  if (low.includes("timeout") || low.includes("aborted")) return "timeout";
  if (s.includes("3040")) return "3040";
  if (s.includes("403") || low.includes("forbidden")) return "403";
  if (s.includes("401") || low.includes("unauthorized")) return "401";
  return redactSecrets(s).slice(0, 160) || "unknown";
}
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))
  ]);
}

/* ===== 模型调用（绑定 + 关思考 + 容量退避）===== */
// 归一化模型名：去首尾空白/引号 → 小写 → 去 @cf/ 与厂商前缀 → 去 :tag/@日期 后缀 → 空格下划线折成连字符。
// 只做"认名字"，不放宽白名单：归一化后仍要命中下面的别名表才算数，认不出照旧回落默认模型。
function normModelKey(s) {
  let x = String(s).trim().toLowerCase().replace(/^["'`]+|["'`]+$/g, "");
  x = x.replace(/^@?cf\//, "");            // @cf/ 或 cf/
  x = x.replace(/^[a-z0-9][a-z0-9_.-]*\//, ""); // 厂商段：zai-org/、moonshotai/、误写的 openai/ 等
  x = x.replace(/[:@][^/]*$/, "");         // :latest、@2025-06 之类版本后缀
  x = x.replace(/[\s_]+/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
  x = x.replace(/-latest$/, "");
  return x;
}
// 别名表：由 MODELS 自动派生（别名本身 + 完整 ID 归一后的短名），再补几个客户常见的错写法。
const MODEL_ALIASES = (() => {
  const t = Object.create(null);
  const put = (k, v) => { const n = normModelKey(k); if (n && !t[n]) t[n] = v; };
  for (const [alias, full] of Object.entries(MODELS)) { put(alias, full); put(full, full); }
  const GLM = MODELS["glm-5.2"], KIMI = MODELS["kimi-k2.7-code"];
  // 漏点、点写成横线、只写牌子、漏 -code 后缀
  for (const k of ["glm", "glm5.2", "glm-5-2", "glm52", "glm-5", "zai", "zai-glm"]) put(k, GLM);
  for (const k of ["kimi", "kimi-k2.7", "kimi-k2-7", "kimi-k27", "k2.7-code", "k2.7", "moonshot", "moonshotai"]) put(k, KIMI);
  return t;
})();
// 模型白名单：已知别名 → 映射；完整 ID 命中白名单 → 放行；归一化后能认出的错写 → 映射；
// 其它一律回落默认模型（堵越权调用）。
function resolveModel(m) {
  if (!m || typeof m !== "string") return DEFAULT_MODEL;
  if (MODELS[m]) return MODELS[m];
  if (ALLOWED_MODELS.has(m)) return m;
  const n = normModelKey(m);
  if (n && MODEL_ALIASES[n]) return MODEL_ALIASES[n];
  return DEFAULT_MODEL;
}
// 关键的 token 边界：过小的 max_tokens 抬到默认 8192，再封顶 32768（输出预留），勿动。
function clampTokens(mt) { const n = Number(mt); const v = (Number.isFinite(n) && n >= 1024) ? n : MAX_OUTPUT; return Math.min(v, 32768); }
const IMAGE_DATA_URI_BASE64_RE = /data:image\/[^;\s]*;base64,/gi;
function neutralizeImageDataMarkers(value) {
  if (typeof value === "string") return value.replace(IMAGE_DATA_URI_BASE64_RE, "[image-data-uri]");
  if (Array.isArray(value)) return value.map(neutralizeImageDataMarkers);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = neutralizeImageDataMarkers(v);
  return out;
}
// 构造上游请求体。stream 由调用方决定。
function buildReq(model, options, stream) {
  // 空请求（常见于客户端"测试连接/检测"探测，如 Cherry Studio 检测）会让 glm 回 8007「Messages cannot be empty」。
  // 注入一句最小消息让 glm 正常应答 → 检测通过，而非报错。真实聊天永远有消息、不受影响。
  let msgs = options.messages;
  if (msgs == null || (Array.isArray(msgs) && msgs.length === 0)) msgs = [{ role: "user", content: "hi" }];
  else if (!Array.isArray(msgs)) throw mkErr("BadRequest: messages 必须是数组");
  const req = { messages: neutralizeImageDataMarkers(msgs), stream, max_completion_tokens: clampTokens(options.maxTokens) };
  // 思考开关：param 型模型（glm）写 chat_template_kwargs.enable_thinking，默认开、客户端可覆盖；
  // native 型（kimi）原生吐推理，无需也无法用参数控制。
  const cap = THINKING[model];
  if (cap && cap.kind === "param") req.chat_template_kwargs = { enable_thinking: options.thinking == null ? DEFAULT_THINKING : !!options.thinking };
  if (options.tools && options.tools.length) { req.tools = neutralizeImageDataMarkers(options.tools); req.tool_choice = "auto"; req.parallel_tool_calls = true; }
  return req;
}
// 解析客户端显式的思考偏好：true/false 覆盖默认，undefined 用默认。各协议各自的表达都认。
function clientThinkingPref(body) {
  if (!body || typeof body !== "object") return undefined;
  const k = body.chat_template_kwargs;
  if (k && typeof k.enable_thinking === "boolean") return k.enable_thinking;
  if (typeof body.enable_thinking === "boolean") return body.enable_thinking;
  if (body.thinking && typeof body.thinking === "object") {            // Claude 风格 {type:"enabled"|"disabled"}
    if (body.thinking.type === "disabled") return false;
    if (body.thinking.type === "enabled") return true;
  }
  if (body.reasoning_effort === "none") return false;                   // OpenAI chat 风格
  if (body.reasoning && body.reasoning.effort === "none") return false; // Responses 风格
  return undefined;
}
function isCapacityError(e) {
  const low = String((e && e.message) || e).toLowerCase();
  if (low.includes("8007") || low.includes("badrequest")) return false;
  // 3046 "Request timeout"：上游连接/请求超时（2026-07-04 哪吒 811558 真实采集）。之前不认 → 不重试、
  // 客户吃 500 原始报错。归入容量类：退避重试 + CB/AIMD 记账 + 客户看到 503"服务繁忙"（可优雅重试）。
  // 3021 "per min rate"：上游每分钟推理限速（B 项目实采）。A 无网关换号可切，退避重试等桶回填是最优解；
  //   重试耗尽由 friendlyError 的 3021 分支给 429（在容量 503 分支之前判定）。
  // "NNNN: Internal server error"：统一覆盖 4009/8005/8008 及后续 glm 内部错误码；这些错误常与 3040 交替出现。
  //   归容量类后走退避重试 + CB/AIMD，瞬时错误尽量捞回，耗尽统一回 503"服务繁忙"。
  return low.includes("capacity") || low.includes("3040") || low.includes("429") || low.includes("overload") || low.includes("3046") || low.includes("request timeout") || low.includes("3021") || low.includes("per min rate") || low.includes("per-min rate") || low.includes("internal server error") || low.includes("network connection lost") || low.includes("connection reset") || low.includes("connection refused") || low.includes("connection error") || low.includes("fetch failed") || low.includes("network error");
}
// 重试调温柔·件1：full jitter —— 在指数上限内取全随机，让并发重试散开、不再对齐成批砸上游。
function backoff(base, attempt) { const ceil = Math.min(5000, base * 2 ** attempt); return Math.floor(Math.random() * ceil); }
function positiveIntEnv(env, name, fallback) {
  const n = Number(env && env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
function capRetries(env) { return positiveIntEnv(env, "CAP_RETRIES", CAP_RETRIES); }
function capBackoffBaseMs(env) { return positiveIntEnv(env, "CAP_BACKOFF_BASE_MS", CAP_BACKOFF_BASE_MS); }
function capBackoffMaxMs(env) { return Math.max(1, positiveIntEnv(env, "CAP_BACKOFF_MAX_MS", CAP_BACKOFF_MAX_MS)); }
function capTotalMs(env) { return Math.max(1, positiveIntEnv(env, "CAP_TOTAL_MS", CAP_TOTAL_MS)); }
function oversizeTokenLimit(env) { return positiveIntEnv(env, "OVERSIZE_TOKENS", OVERSIZE_TOKENS); }
function oversizeLimit(env) { return positiveIntEnv(env, "OVERSIZE_CHARS", OVERSIZE_CHARS); }
// model 可不传（老调用方按原行为走）；传了且该模型正处在「断供」闩里 → 重试降到 0，见下方 MODEL_DOWN 那段。
function capState(env, model) { return { retries: modelDown(env, model) ? 0 : capRetries(env), deadline: Date.now() + capTotalMs(env) }; }
function capDelayMs(env, attempt, state) {
  const remaining = state.deadline - Date.now();
  if (remaining <= 0) return -1;
  const base = capBackoffBaseMs(env);
  const max = capBackoffMaxMs(env);
  const ceil = Math.max(0, Math.min(max, base * 2 ** attempt));
  return Math.min(remaining, Math.floor(Math.random() * (ceil + 1)));
}
async function sleepCapacityBackoff(env, attempt, state) {
  const ms = capDelayMs(env, attempt, state);
  if (ms < 0) return false;
  await sleep(ms);
  return Date.now() <= state.deadline;
}

/* ===== 断供快速失败闩（2026-08-02）=====
   CF 把某个账号的某个模型断供时回 4006 `Service temporarily at capacity`。
   CF 自己 1.3 秒就给出这个答案，而我们要退避重试 6 次、耗 37~52 秒才把【同一个答案】交给客户。
   等 50 秒的失败比等 1 秒的失败糟得多：客户端容易判成超时，看着像"卡死"而不是"这个号不行"。
   实测依据（docs/40 2026-08-02）：拿坏号自己的 API Token 绕开 Worker 直接打 CF 官方 REST，
   glm-5.2 照样 4006、同号 kimi 照样 200 —— 绑定路和 REST 路共用同一份配额，重试改不了任何东西。

   但【绝不能】一见 4006 就不重试：偶发的"真挤爆"用的也是这个码，几秒后自己会好，
   一刀切等于把健康号的瞬时抖动变成硬失败，那是净亏。所以设一道闩，两个条件同时满足才判死：
   连续 MODEL_DOWN_FAILS 条请求首发都是断供错（中间一次成功都没有），
   且最早那次距今已超过 MODEL_DOWN_AFTER_MS —— 也就是"持续一分钟以上、连着几条都这样"。

   闩只降重试次数、【不拦请求】：每条请求仍然实打实打一次上游，那一次就是探针。
   所以 CF 一放开，下一条请求立刻成功并把闩清零，不需要人工干预、也不需要 TTL。
   计数只算 attempt=0（同 cbOnCapacityFail 的道理）：一条请求的 6 次重试是同一轮的余波，
   都算进去的话一条请求就自己把闩顶满了，那就不叫"连着几条请求"了。 */
const MODEL_DOWN = new Map();                          // 模型 → { fails, firstAt }；isolate 内存态，无 KV/DO
const MODEL_DOWN_FAILS = 3, MODEL_DOWN_AFTER_MS = 60000;
function modelDownFails(env) { return Math.max(1, positiveIntEnv(env, "MODEL_DOWN_FAILS", MODEL_DOWN_FAILS)); }
function modelDownAfterMs(env) { return positiveIntEnv(env, "MODEL_DOWN_AFTER_MS", MODEL_DOWN_AFTER_MS); }
/* 只认上游真的断供：4006（CF 对"断供 / 免费额度耗尽"复用了这一个码）或明写 temporarily at capacity。
   我们自己造的 "capacity (gate full)" / "capacity (circuit open)" 是本地闸门的错误，
   绝不能算进来 —— 否则本地一忙就把模型判死，等于自己把自己的重试关掉。 */
function isModelDownError(e) {
  const low = String((e && e.message) || e).toLowerCase();
  if (low.includes("gate full") || low.includes("circuit open")) return false;
  return low.includes("4006") || (e && e.code === 4006) || low.includes("temporarily at capacity");
}
// 别的错（3021/3040/超时…）不是断供，直接清零：宁可少判一次，也不要误把能重试救回来的号关掉重试。
function noteModelFail(env, model, e, attempt) {
  if (!model || attempt > 0) return;
  if (!isModelDownError(e)) { MODEL_DOWN.delete(model); return; }
  const s = MODEL_DOWN.get(model);
  if (s) s.fails++; else MODEL_DOWN.set(model, { fails: 1, firstAt: Date.now() });
}
function noteModelOk(model) { if (model) MODEL_DOWN.delete(model); }
function modelDown(env, model) {
  const s = model ? MODEL_DOWN.get(model) : null;
  return !!s && s.fails >= modelDownFails(env) && Date.now() - s.firstAt >= modelDownAfterMs(env);
}

function mkErr(msg) { return new Error(msg); }

/* ===== 重试调温柔（thundering-herd 防护）：熔断降载 + 并发闸门 =====
   isolate 内模块级状态，无 KV/DO；只包在两处上游调用（aiRunWithRetry/primeWithGrace+startStreaming）外层，
   不碰模型参数/保活/协议/缓存。阈值均有同名 env 覆盖，可不重部署只调参。 */
const CB = { fails: [], openUntil: 0 };                 // 最近“容量类失败”时间戳 + 开闸截止时刻
const CB_WINDOW_MS = 10000, CB_FAIL_THRESHOLD = 8, CB_COOLDOWN_MS = 4000;
function cbWindow(env){ return Number(env && env.CB_WINDOW_MS) || CB_WINDOW_MS; }
function cbThreshold(env){ return Number(env && env.CB_FAIL_THRESHOLD) || CB_FAIL_THRESHOLD; }
function cbCooldown(env){ return Number(env && env.CB_COOLDOWN_MS) || CB_COOLDOWN_MS; }
function cbOpen(){ return Date.now() < CB.openUntil; } // 开闸期：新请求源头快速失败，不打上游
// attempt = 这条请求的第几次尝试。只有第 0 次（首发）才算一票。
// 为什么（2026-07-30，第三方审计第 4 条）：老实现在每一次重试里都调一遍，cap.retries=5 时
// 一条请求就自己投了 6 票 —— AIMD 把准入从 16 一路乘 0.7 砍到地板 1（0.7⁶≈1.9），
// 熔断器的 8 次阈值也被一条请求吃掉大半。而爬回来要每 10 秒 +1 且必须有成功流量，
// 塌一次要 150 秒。AIMD 的本意是"每个反馈轮次减一次"，重试是同一轮的余波，不该重复计。
// 不传 attempt 的调用方按首发算（与改造前同）。
function cbOnCapacityFail(env, attempt){
  if (attempt > 0) return;
  const now = Date.now(); aimdOnCapacityFail(env);
  CB.fails = CB.fails.filter(t => now - t < cbWindow(env)); CB.fails.push(now);
  if (CB.fails.length >= cbThreshold(env)) { CB.openUntil = now + cbCooldown(env); CB.fails.length = 0; }
}
function cbOnSuccess(env){ aimdOnSuccess(env); CB.fails.length = 0; CB.openUntil = 0; } // 一次成功即恢复（CLOSED）
const GATE = { inflight: 0, admissionLimit: 0, admissionMax: 0, lastCapacityAt: 0, lastRecoverAt: 0, rpmTokens: 0, rpmUpdatedAt: 0, rpmMax: 0, waiters: [] };
const MAX_INFLIGHT = 16, GATE_WAIT_MS = 20000, STREAM_GATE_WAIT_MS = 10000, STREAM_QUEUE_WAIT_MS = 45000, GATE_QUEUE_MAX = 32, RPM_LIMIT = 250, AIMD_DECAY = 0.7, AIMD_HEALTH_MS = 10000, AIMD_RESET_MS = 60000;
function numEnv(env, name, fallback){ const n = Number(env && env[name]); return Number.isFinite(n) && n >= 0 ? n : fallback; }
function maxInflight(env){ return numEnv(env, "MAX_INFLIGHT", MAX_INFLIGHT) || MAX_INFLIGHT; }
function gateWaitMs(env, queued, stream){
  if (queued && stream) return numEnv(env, "STREAM_QUEUE_WAIT_MS", STREAM_QUEUE_WAIT_MS); // 流式已早回200+心跳保活：可久等再入场，而非10s就甩"请求过于密集"
  if (queued) return numEnv(env, "GATE_WAIT_MS", GATE_WAIT_MS);
  return numEnv(env, "STREAM_GATE_WAIT_MS", STREAM_GATE_WAIT_MS);
}
function gateQueueMax(env){ return numEnv(env, "GATE_QUEUE_MAX", GATE_QUEUE_MAX); }
/* RPM_LIMIT = 250 是【每个实例各自】的桶，不是账号上限，别把它当账号闸看（审计第 5 条）。
   账号的真上限实测是【桶 40 / 每分钟补 20】（见文件头 RATE_LIMIT_RPM_MEASURED），比 250 低一个量级 ——
   也就是说这个桶在现实里基本不会响，它的定位只是"防单实例跑飞"的兜底。
   要按账号封顶只有 DO 全局桶（GLOBAL_RPM_LIMIT + GLOBAL_LIMITER）数得准：
   同一个号可能同时跑着好几个实例，本地桶各算各的，加起来照样超。 */
function rpmLimit(env){ const n = numEnv(env, "RPM_LIMIT", RPM_LIMIT); return n > 0 ? n : Infinity; }
function aimdDecay(env){ const n = Number(env && env.AIMD_DECAY); return Number.isFinite(n) && n > 0 && n < 1 ? n : AIMD_DECAY; }
function aimdHealthMs(env){ return numEnv(env, "AIMD_HEALTH_MS", AIMD_HEALTH_MS); }
function aimdResetMs(env){ return numEnv(env, "AIMD_RESET_MS", AIMD_RESET_MS) || AIMD_RESET_MS; }
function ensureAdmission(env) {
  const max = maxInflight(env);
  if (!GATE.admissionLimit || GATE.admissionMax !== max) { GATE.admissionMax = max; GATE.admissionLimit = max; }
  // 静默恢复：距上一次容量失败超过 AIMD_RESET_MS（默认 60 秒）就把准入放回满档。
  // 老实现只有 aimdOnSuccess 一条恢复路径：每 10 秒 +1、且必须有成功流量喂它。
  // 于是塌到地板 1 之后要 150 秒才爬满；更糟的是流量一停就永远停在 1 ——
  // 下一波请求进来先被我们自己卡成串行，看起来像"上游又挤了"，其实是上一轮的疤。
  if (GATE.admissionLimit < max && GATE.lastCapacityAt && Date.now() - GATE.lastCapacityAt >= aimdResetMs(env)) {
    GATE.admissionLimit = max; GATE.lastRecoverAt = Date.now();
  }
  return max;
}
function aimdOnCapacityFail(env) {
  ensureAdmission(env);
  GATE.admissionLimit = Math.max(1, Math.floor(GATE.admissionLimit * aimdDecay(env)));
  GATE.lastCapacityAt = Date.now();
}
function aimdOnSuccess(env) {
  const max = ensureAdmission(env);
  const now = Date.now();
  const healthy = now - GATE.lastCapacityAt >= aimdHealthMs(env);
  if (healthy && GATE.admissionLimit < max && now - GATE.lastRecoverAt >= aimdHealthMs(env)) {
    GATE.admissionLimit++;
    GATE.lastRecoverAt = now;
  }
}
function refillRpm(env) {
  const limit = rpmLimit(env);
  if (!Number.isFinite(limit)) { GATE.rpmTokens = Infinity; GATE.rpmMax = Infinity; GATE.rpmUpdatedAt = Date.now(); return; }
  const now = Date.now();
  if (GATE.rpmMax !== limit || !GATE.rpmUpdatedAt) { GATE.rpmMax = limit; GATE.rpmTokens = limit; GATE.rpmUpdatedAt = now; return; }
  const add = (now - GATE.rpmUpdatedAt) * limit / 60000;
  GATE.rpmTokens = Math.min(limit, GATE.rpmTokens + add);
  GATE.rpmUpdatedAt = now;
}
/* ===== 3021 根治·isolate 侧租约池：从 GlobalLimiter DO 批量租令牌本地消耗 =====
   启用条件：env.GLOBAL_RPM_LIMIT > 0 且存在 GLOBAL_LIMITER 绑定；缺任一 → 行为与旧版逐字节一致。
   fail-open：DO 超时/报错进入冷却期，期间退回本地 RPM 限速——限流器故障绝不放大为拒绝服务。 */
const LEASE = { tokens: 0, leasedAt: 0, refilling: false, refillStartedAt: 0, failUntil: 0, waitUntil: 0 };
const GLOBAL_LEASE_TOKENS = 8, GLOBAL_FAIL_COOLDOWN_MS = 5000, GLOBAL_LEASE_TIMEOUT_MS = 1500, GLOBAL_LEASE_TTL_MS = 60000;
// 0 = 闸关（默认）。要开就设成 suggestedGlobalRpm(env)（当前 18 = 实测稳态 20 打九折）。
// 别设 240（旧注释里那个，12 倍），也别设 24（按作废的"27 次/分"算的）——
// 24 会响，但响得两头不讨好：我们的桶容量=limit=24 小于 CF 的 40，突发阶段白拦 CF 本来放的；
// 稳态 24 又高于 20，每分钟仍漏 4 条撞 3021。【只有低于 20 才拦得住 3021】，详见文件头那段来历。
function globalRpmLimit(env) { const n = numEnv(env, "GLOBAL_RPM_LIMIT", 0); return n > 0 ? Math.floor(n) : 0; }
function globalLimiterOn(env) { return globalRpmLimit(env) > 0 && !!(env && env.GLOBAL_LIMITER); }
function leaseTimeoutMs(env) { return Math.max(200, numEnv(env, "GLOBAL_LEASE_TIMEOUT_MS", GLOBAL_LEASE_TIMEOUT_MS) || GLOBAL_LEASE_TIMEOUT_MS); }
function failCooldownMs(env) { return Math.max(500, numEnv(env, "GLOBAL_FAIL_COOLDOWN_MS", GLOBAL_FAIL_COOLDOWN_MS) || GLOBAL_FAIL_COOLDOWN_MS); }
function leaseTtlMs(env) { return Math.max(1000, numEnv(env, "GLOBAL_LEASE_TTL_MS", GLOBAL_LEASE_TTL_MS) || GLOBAL_LEASE_TTL_MS); }
// 单次租量随全局上限缩放：上限小(如 60)时别一把租 8 造成搁浅欠放；ceil(limit/16) 封顶配置值。
function leaseWant(env) {
  const cfg = Math.max(1, Math.min(64, Math.floor(numEnv(env, "GLOBAL_LEASE_TOKENS", GLOBAL_LEASE_TOKENS)) || GLOBAL_LEASE_TOKENS));
  return Math.max(1, Math.min(cfg, Math.ceil(globalRpmLimit(env) / 16)));
}
function kickLeaseRefill(env) {
  const now = Date.now();
  if (now < LEASE.failUntil || now < LEASE.waitUntil) return;
  // 🟡4：refilling 卡死超过 timeout+缓冲 视为 stale(触发请求上下文被运行时取消 → 协程可能永不落地)，允许重入自愈
  if (LEASE.refilling && now - LEASE.refillStartedAt < leaseTimeoutMs(env) + 1000) return;
  LEASE.refilling = true;
  LEASE.refillStartedAt = now;
  (async () => {
    try {
      const ns = env.GLOBAL_LIMITER;
      const stub = ns.get(ns.idFromName("rpm"));
      const res = await Promise.race([
        stub.fetch("https://do/lease?want=" + leaseWant(env) + "&limit=" + globalRpmLimit(env), { method: "POST" }),
        sleep(leaseTimeoutMs(env)).then(() => { throw mkErr("lease timeout"); }),
      ]);
      if (!res.ok) throw mkErr("lease http " + res.status);
      const body = await res.json().catch(() => null);
      const granted = body && Number.isFinite(Number(body.granted)) ? Math.max(0, Math.floor(Number(body.granted))) : 0;
      if (granted > 0) { LEASE.tokens += granted; LEASE.leasedAt = Date.now(); }
      else {
        const w = Number(body && body.waitMs);
        LEASE.waitUntil = Date.now() + Math.min(2000, Math.max(100, Number.isFinite(w) ? w : 250));
      }
    } catch (e) {
      LEASE.failUntil = Date.now() + failCooldownMs(env);
      // 🟡5：进入 fail-open 前钳制本地 RPM 桶——全局模式下 rpmTokens 一直回填从不消耗=满桶，
      // 直接甩给 fallback 会 N×满桶突发(正是 3021 原形)。钳到全局上限,退化成一个正常本地桶。
      GATE.rpmTokens = Math.min(GATE.rpmTokens, globalRpmLimit(env));
    } finally {
      LEASE.refilling = false;
    }
  })();
}
function tryTakeAdmission(env) {
  ensureAdmission(env);
  refillRpm(env);
  if (GATE.inflight >= GATE.admissionLimit) return false;
  if (globalLimiterOn(env) && Date.now() >= LEASE.failUntil) {
    // 全局桶健康：只消耗 DO 租约，不动本地 RPM 桶（本地桶保持回填，作 fail-open 后备）
    // 🟡3：租约过期作废——搁浅令牌代表的是"这一分钟的配额",过 TTL 未用则本分钟已过,清零免误放/欠放
    if (LEASE.tokens > 0 && Date.now() - LEASE.leasedAt > leaseTtlMs(env)) LEASE.tokens = 0;
    if (LEASE.tokens < 1) { kickLeaseRefill(env); return false; }
    LEASE.tokens -= 1;
  } else {
    if (GATE.rpmTokens < 1) return false;
    GATE.rpmTokens -= 1;
  }
  GATE.inflight++;
  return true;
}
async function gateAcquire(env, opts = {}) {
  const queued = !!opts.queue;
  if (tryTakeAdmission(env)) return;
  if (!queued) {
    const deadline = Date.now() + gateWaitMs(env, false);
    while (Date.now() <= deadline) {
      await sleep(50 + Math.floor(Math.random() * 100));
      if (tryTakeAdmission(env)) return;
    }
    throw mkErr("capacity (gate full)");
  }
  if (GATE.waiters.length >= gateQueueMax(env)) throw mkErr("rate limited (queue full)");
  return await waitQueuedAdmission(env, opts.signal, !!opts.stream);
}
function waitQueuedAdmission(env, signal, stream) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + gateWaitMs(env, true, stream);
    const entry = { env, done: false, timer: null, resolve: null, reject: null, onAbort: null };
    const cleanup = () => {
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.onAbort && signal) signal.removeEventListener("abort", entry.onAbort);
      const i = GATE.waiters.indexOf(entry);
      if (i >= 0) GATE.waiters.splice(i, 1);
    };
    const fail = (msg) => { if (entry.done) return; entry.done = true; cleanup(); reject(mkErr(msg)); pumpQueue(); };
    entry.resolve = () => { if (entry.done) return; entry.done = true; cleanup(); resolve(); };
    entry.reject = fail;
    entry.onAbort = () => fail("client abort");
    const tick = () => {
      if (entry.done) return;
      if (Date.now() > deadline) return fail("rate limited (queue timeout)");
      pumpQueue();
      if (!entry.done) entry.timer = setTimeout(tick, 50 + Math.floor(Math.random() * 100));
    };
    if (signal) {
      if (signal.aborted) return fail("client abort");
      signal.addEventListener("abort", entry.onAbort, { once: true });
    }
    GATE.waiters.push(entry);
    tick();
  });
}
function pumpQueue() {
  while (GATE.waiters.length) {
    const entry = GATE.waiters[0];
    if (entry.done) { GATE.waiters.shift(); continue; }
    if (!tryTakeAdmission(entry.env)) return;
    entry.resolve();
  }
}
function gateRelease(env){ if (GATE.inflight > 0) GATE.inflight--; pumpQueue(); }
// 非流式上游超时上限：env 可覆盖（普通 / 重请求各一）。
function nonstreamMaxMs(env, heavy){ const o = heavy ? (env && env.NONSTREAM_HEAVY_MAX_MS) : (env && env.NONSTREAM_MAX_MS); return o ? Number(o) : (heavy ? NONSTREAM_HEAVY_MAX_MS : NONSTREAM_MAX_MS); }
// 带超时跑一次非流式上游：到点抛 "upstream stalled"（friendlyError→503+Retry-After）。
// 无法真 abort env.AI.run，故 .catch 防游离 rejection；超时后本调用的闸门名额由 aiRunWithRetry 的 finally 释放（堵上"挂死占名额→毒化闸门"连锁坑）。
async function aiRunBounded(env, model, req, runOpts, ms){
  const p = env.AI.run(model, req, runOpts);
  p.catch((e) => logDiagFailure("ai_run_async", e, { mode: "nonstream", model, request: summarizeAiRequest(req) }));
  let timer;
  const to = new Promise((_, rej) => { timer = setTimeout(() => rej(mkErr("upstream stalled")), ms); });
  try { return await Promise.race([p, to]); }
  finally { clearTimeout(timer); }
}
// 流式时序读取（env 同名键可覆盖默认常量）。
function graceMs(env) { const o = env && env.STREAM_GRACE_MS; return o ? Number(o) : GRACE_MS; }
// 早回 200 后透明重连次数上限（默认 2，env STREAM_REPRIME_MAX 可覆盖）。仅在尚未出字时生效。
function reprimeMaxStream(env) { const o = env && env.STREAM_REPRIME_MAX; return o != null && o !== "" ? Number(o) : 2; }
function prefillMaxMs(env) { const o = env && env.PREFILL_MAX_MS; return o ? Number(o) : PREFILL_MAX_MS; }
function heartbeatMs(env) { const o = env && env.HEARTBEAT_MS; return o ? Number(o) : HEARTBEAT_MS; }
function idleMaxMs(env) { const o = env && env.STREAM_IDLE_MAX_MS; return o ? Number(o) : STREAM_IDLE_MAX_MS; }
// 出字前的心跳是否携带极小真 reasoning 增量（喂活 ai-sdk 的空闲计时器；默认关，仅按部署开）。
// 仅作用于出字前（!sawContent）且仅 chat sink 提供 keepalive —— claude/responses 维持官方 ping，不动 thinking 顺序。
function prefillKeepalive(env) { const v = env && env.PREFILL_KEEPALIVE; return v === true || v === 1 || /^(1|true|yes|on)$/i.test(String(v || "")); }
// 大内容"处理中"预告：默认开(全网)，可用 env PROGRESS_HINT=off/0/false 单号关闭。大请求出字前发一句可读的 reasoning 帧，让客户端别对着死屏幕干等。走已验证安全的 reasoning 通路，不进正文；只发一次、不刷屏。
function progressHint(env) { const v = env ? env.PROGRESS_HINT : undefined; return !/^(0|false|no|off)$/i.test(String(v == null ? "" : v)); }
function progressHintText(env) { const t = env && env.PROGRESS_HINT_TEXT; return (typeof t === "string" && t) ? t : "检测到大内容，正在处理，请稍候……（大内容首字较慢属正常）\n"; }
// env.AI.run 的第三参 options：带上会话亲和头用于前缀缓存（无亲和则返回 undefined）。
function runOptions(options) { return (options && options.affinity) ? { extraHeaders: { "x-session-affinity": options.affinity } } : undefined; }
// 非流式：退避重试，仅对容量类错误重试。
// S2 修复（2026-07-04，docs/40 待办④）：容量退避期间【释放准入名额、重打上游前再入场】——
// 与流式 gateCtl 同一机制。此前非流式退避抱着名额睡最长 50s，叠加 AIMD 地板=1 会饿死他人（自伤式"请求过于密集"）。
async function aiRunWithRetry(env, model, req, policy, runOpts, signal, sharedCap) {
  const isHeavy = (policy === RETRY_HEAVY);              // 重请求放宽非流式超时上限
  if (cbOpen()) throw mkErr("capacity (circuit open)"); // 开闸期：源头快速失败，不再砸上游
  await gateAcquire(env, { queue: true, signal });        // 非流式：超额/RPM 耗尽时进有界 FIFO 队列削峰
  let gateHeld = true;
  const release = () => { if (gateHeld) { gateHeld = false; gateRelease(env); } };                    // 幂等释放
  const reacquire = async () => { if (!gateHeld) { await gateAcquire(env, { queue: true, signal }); gateHeld = true; } }; // 退避后再入场（仍走有界队列；排不进抛 queue timeout→429）
  let lastErr;
  const cap = sharedCap || capState(env, model);
  try {
    for (let attempt = 0; attempt <= cap.retries; attempt++) {
      try { const r = await aiRunBounded(env, model, req, runOpts, nonstreamMaxMs(env, isHeavy)); cbOnSuccess(env); noteModelOk(model); return r; } // 非流式硬超时兜底：上游卡死→到点 503，不再无限挂
      catch (e) {
        lastErr = e;
        if (isCapacityError(e)) cbOnCapacityFail(env, attempt);
        noteModelFail(env, model, e, attempt);                 // 断供闩记账（只算首发）
        if (!isCapacityError(e) || attempt >= cap.retries) throw e;
        release();                                            // 退避不占名额（B 修复非流式版）
        if (!await sleepCapacityBackoff(env, attempt, cap)) throw e;
        await reacquire();
      }
    }
    throw lastErr;
  } finally { release(); }
}
/* 估算记忆化：同一个请求体在一次请求里要被走好几遍——过大闸(estimateReqTokens)、
   pickPolicy 选超时策略(每次容量重试都会再调一次，最多 CAP_RETRIES+1 次)、
   流式开头的"处理中"预告判定、诊断里的 approxChars。每一遍都是整棵消息树的深度遍历
   （12 万字符的重请求尤其贵，纯烧 CPU）。用 WeakMap 按对象缓存：请求体在一次请求内是只读的，
   结果必然相同；请求结束对象被回收，缓存自动消失，不会跨请求串味、也不占常驻内存。 */
const REQ_CHARS_MEMO = new WeakMap();
const REQ_TOKENS_MEMO = new WeakMap();
function memoized(memo, options, compute) {
  if (!options || typeof options !== "object") return compute(options);
  const hit = memo.get(options);
  if (hit !== undefined) return hit;
  const v = compute(options);
  memo.set(options, v);
  return v;
}
function estimateReqChars(options) { return memoized(REQ_CHARS_MEMO, options, estimateReqCharsUncached); }
function estimateReqTokens(options) { return memoized(REQ_TOKENS_MEMO, options, estimateReqTokensUncached); }
// 粗估请求规模，覆盖三协议真实形态：字符串 content、数组 content(含 vision)、tool_calls 参数、tools 定义。
function estimateReqCharsUncached(options) {
  let n = 0;
  n += estimateContentChars(options && options.system);
  n += estimateContentChars(options && options.instructions);
  for (const m of (options && options.messages) || []) {
    if (!m) continue;
    n += estimateContentChars(m.content);
    if (m.tool_calls) { try { n += JSON.stringify(m.tool_calls).length; } catch {} }
  }
  n += estimateResponsesInputChars(options && options.input);
  if (options && options.tools) { try { n += JSON.stringify(options.tools).length; } catch {} }
  return n;
}
function estimateReqTokensUncached(options) {
  let n = 0;
  n += estimateContentTokens(options && options.system);
  n += estimateContentTokens(options && options.instructions);
  for (const m of (options && options.messages) || []) {
    if (!m) continue;
    n += estimateContentTokens(m.content);
    if (m.tool_calls) n += estimateJsonTokens(m.tool_calls);
  }
  n += estimateResponsesInputTokens(options && options.input);
  if (options && options.tools) n += estimateJsonTokens(options.tools);
  return n;
}
function estimateContentChars(c) {
  if (typeof c === "string") return c.length;
  if (Array.isArray(c)) return c.reduce((n, x) => n + estimateContentPartChars(x), 0);
  return estimateContentPartChars(c);
}
function estimateContentPartChars(c) {
  if (typeof c === "string") return c.length;
  if (!c || typeof c !== "object") return 0;
  let n = 0;
  if (typeof c.text === "string") n += c.text.length;
  if (typeof c.input_text === "string") n += c.input_text.length;
  if (typeof c.output === "string") n += c.output.length;
  if (Array.isArray(c.content)) n += estimateContentChars(c.content);
  else if (c.content != null) n += String(c.content).length;
  if (c.input != null) {
    try { n += JSON.stringify(c.input).length; } catch {}
  }
  return n;
}
function estimateResponsesInputChars(input) {
  if (typeof input === "string") return input.length;
  if (!Array.isArray(input)) return 0;
  let n = 0;
  for (const item of input) {
    if (typeof item === "string") n += item.length;
    else if (item && typeof item === "object") {
      if (item.content != null) n += estimateContentChars(item.content);
      else n += estimateContentPartChars(item);
      if (item.arguments) n += String(item.arguments).length;
      if (item.tool_calls) { try { n += JSON.stringify(item.tool_calls).length; } catch {} }
    }
  }
  return n;
}
function estimateContentTokens(c) {
  if (typeof c === "string") return estimateTokens(c);
  if (Array.isArray(c)) return c.reduce((n, x) => n + estimateContentPartTokens(x), 0);
  return estimateContentPartTokens(c);
}
function estimateContentPartTokens(c) {
  if (typeof c === "string") return estimateTokens(c);
  if (!c || typeof c !== "object") return 0;
  let n = 0;
  if (typeof c.text === "string") n += estimateTokens(c.text);
  if (typeof c.input_text === "string") n += estimateTokens(c.input_text);
  if (typeof c.output === "string") n += estimateTokens(c.output);
  if (Array.isArray(c.content)) n += estimateContentTokens(c.content);
  else if (c.content != null) n += estimateTokens(String(c.content));
  if (c.input != null) n += estimateJsonTokens(c.input);
  return n;
}
function estimateResponsesInputTokens(input) {
  if (typeof input === "string") return estimateTokens(input);
  if (!Array.isArray(input)) return 0;
  let n = 0;
  for (const item of input) {
    if (typeof item === "string") n += estimateTokens(item);
    else if (item && typeof item === "object") {
      if (item.content != null) n += estimateContentTokens(item.content);
      else n += estimateContentPartTokens(item);
      if (item.arguments) n += estimateJsonTokens(item.arguments);
      if (item.tool_calls) n += estimateJsonTokens(item.tool_calls);
    }
  }
  return n;
}
function estimateJsonTokens(value) {
  try { return Math.ceil((typeof value === "string" ? value : JSON.stringify(value)).length / 4); }
  catch { return 0; }
}
function shouldRejectOversize(options, env) {
  const tokenLimit = oversizeTokenLimit(env);
  const charLimit = oversizeLimit(env);
  return (tokenLimit > 0 && estimateReqTokens(options) > tokenLimit)
    || (charLimit > 0 && estimateReqChars(options) > charLimit);
}
function oversizeError(env) {
  const wan = Math.max(1, Math.round(oversizeTokenLimit(env) / 10000));
  const ctxWan = Math.max(1, Math.round(MODEL_CTX_TOKENS / 10000));
  // 同上：先说清 26 万是模型的天花板、20 万是给回复和工具留的余量，别让人读成"你们把额度调低了"。
  return { status: 400, type: "invalid_request_error", reason: "oversize", message: `上下文过长：一轮最多发 ${wan} 万 token。模型一轮总共只装得下 ${ctxWan} 万 token，回复和工具调用要从同一份里扣，所以发送部分留了余量，免得话说到一半被截断。请在客户端用 /compact 压缩对话或开新会话后重试；重试相同内容无效。` };
}
/* ===== 救援截断 =====（来历与红线见文件头 CONTEXT_TRIMMED_HEADER 那段注释）
   只有过大闸判超的请求才会走到这里；没超限的请求连这几个函数都不会被调用一次。
   规则（一条都不能松，松哪条都可能把上游打成 400）：
   · system 消息永不裁；最后一条 user 消息永不裁（那是客户当前要问的）。
   · 切点只能落在【不含 tool_calls 的 assistant 消息】之后 —— 这天然保证 assistant.tool_calls
     与它对应的 role:"tool" 结果永远成组进出，绝不留下没有主人的 tool 结果（上游会 400）。
   · 裁不动（没有合法切点 / 裁完还超）就原样回今天那个 400，绝不硬裁、绝不硬发。
   · 全程 try/catch：畸形 messages 让这里抛错，也只是退回今天的 400，不会把请求打挂。
   已知局限（不是 bug，别当 bug 修）：整段历史里一条"纯文本 assistant"都没有的纯工具循环，
   没有合法切点 → 救不了，回今天那个 400。放宽切点规则要单独立项 + 单独走四步仪式。 */
function rescueTrimOn(env) { const v = env ? env.RESCUE_TRIM : undefined; return !/^(0|false|no|off)$/i.test(String(v == null ? "" : v)); }
function oversizeByChars(options, env) { const charLimit = oversizeLimit(env); return charLimit > 0 && estimateReqChars(options) > charLimit; }
function rescueTrimScale(n) { return Math.ceil(n * RESCUE_TRIM_SAFETY); }
function rescueTrimTarget(env, options) {
  // maxTokens 缺省/畸形一律回落到 8192：Number(undefined)=NaN，NaN 会让所有 > 比较变 false、截断静默失效。
  const want = Number(options && options.maxTokens);
  const reserve = Math.min(RESCUE_TRIM_RESERVE_MAX, Math.max(RESCUE_TRIM_RESERVE_MIN, Number.isFinite(want) && want > 0 ? want : RESCUE_TRIM_RESERVE_DEFAULT));
  return Math.floor(oversizeTokenLimit(env) * RESCUE_TRIM_TARGET_RATIO) - reserve;
}
function rescueHasToolCalls(m) { return Array.isArray(m.tool_calls) ? m.tool_calls.length > 0 : !!m.tool_calls; }
function rescueIsAnchor(m) { return !!m && typeof m === "object" && m.role === "assistant" && !rescueHasToolCalls(m); }
// 单条消息的 token 数，口径与 estimateReqTokensUncached 的循环体逐字一致 —— 全部加起来必须恰好等于
// estimateReqTokens(裁后的 options)，否则 x-context-trimmed 里的 after 会跟 x-context-tokens 对不上。
function rescueMsgTokens(m) {
  if (!m || typeof m !== "object") return 0;
  let n = estimateContentTokens(m.content);
  if (m.tool_calls) n += estimateJsonTokens(m.tool_calls);
  return n;
}
// 有没有"没有主人的 tool 结果"。切点规则本身就保证不会切出孤儿，这里是兜底：
// 客户端本来就发了孤儿（畸形请求）时别让我们裁完背这个锅，直接判裁不动、回今天那个 400。
function rescueHasOrphanTool(list) {
  let armed = false;
  for (const m of list) {
    const role = m && typeof m === "object" ? m.role : null;
    if (role === "tool") { if (!armed) return true; continue; }
    armed = role === "assistant" && rescueHasToolCalls(m);
  }
  return false;
}
/* 返回 { options, header, blocked }：
   blocked=true → 救不回来，调用方照旧 recordGateBlocked + 回今天那个 400（错误码/文案/不可重试标记全不变）。
   blocked=false 且 header=null → 不用裁就够小（闸门算的是 body、这里算的是三协议收敛后的 options，
   两者口径本来就不同：服务端工具被过滤、tool_use 块被摊平，options 常比 body 小一截）。 */
function rescueTrim(options, env) {
  try {
    const msgs = options && options.messages;
    const target = rescueTrimTarget(env, options);
    if (!Array.isArray(msgs) || !msgs.length || !(target > 0)) return { options, header: null, blocked: true };
    // 基座（system/instructions/input/tools）永不裁，先一次性算出来
    let base = estimateContentTokens(options.system) + estimateContentTokens(options.instructions) + estimateResponsesInputTokens(options.input);
    if (options.tools) base += estimateJsonTokens(options.tools);
    // 逐条算一遍存下来。绝不能实现成"每删一条就整体重算"——estimateTokens 是逐码点遍历，
    // 24 万 token ≈ 几十万字符，O(n²) 就是上千万次迭代、秒级 CPU。
    const tok = new Array(msgs.length);
    let total = base;
    for (let i = 0; i < msgs.length; i++) { tok[i] = rescueMsgTokens(msgs[i]); total += tok[i]; }
    if (rescueTrimScale(total) <= target) return { options, header: null, blocked: false };

    let lastUser = -1;
    for (let i = msgs.length - 1; i >= 0; i--) { const m = msgs[i]; if (m && typeof m === "object" && m.role === "user") { lastUser = i; break; } }
    const keepAlways = (i) => { const m = msgs[i]; return !m || typeof m !== "object" || m.role === "system" || i === lastUser; };

    // 从最旧一端往后扫，累计"删掉能省多少"，停在【第一个】够用的合法切点：只删够用的那几条，不多删。
    let freed = 0, count = 0, cut = -1, cutFreed = 0, cutCount = 0;
    for (let i = 0; i < msgs.length - 1; i++) {   // 末条永远留着：切点最多到倒数第二条之后
      if (!keepAlways(i)) { freed += tok[i]; count++; }
      if (!rescueIsAnchor(msgs[i])) continue;
      if (rescueTrimScale(total - freed) <= target) { cut = i + 1; cutFreed = freed; cutCount = count; break; }
    }
    if (cut < 0 || cutCount === 0) return { options, header: null, blocked: true };

    const kept = [];
    for (let i = 0; i < msgs.length; i++) if (i >= cut || keepAlways(i)) kept.push(msgs[i]);
    if (!kept.length || rescueHasOrphanTool(kept)) return { options, header: null, blocked: true };

    const after = total - cutFreed;
    // 换一个新 options 对象，不改客户传进来的那份：REQ_TOKENS_MEMO 是 WeakMap 按对象做 key，
    // 就地改 messages 会让后面所有人读到裁前的缓存值（估算、头、estInput 全错）。
    return {
      options: { ...options, messages: kept },
      header: { [CONTEXT_TRIMMED_HEADER]: "dropped=" + cutCount + ";before=" + total + ";after=" + after },
      blocked: false,
    };
  } catch (e) {
    try { console.log("[zcode-diag] rescue-trim-failed " + JSON.stringify({ err: String((e && e.message) || e).slice(0, 200) })); } catch (_) {} // 只记错误，绝不记内容
    return { options, header: null, blocked: true };
  }
}
// 三协议 handler 共用的一行：救得回来就换成裁后的 options，救不回来就回与今天完全相同的 400。
function rescueOrReject(body, env, ctx, options, gatePath) {
  const t = rescueTrim(options, env);
  if (!t.blocked) return { options: t.options, header: t.header };
  recordGateBlocked(env, ctx, body, gatePath);   // 计数口径不变：仍按【客户发来的原始 body】记，不记裁后的
  return { resp: errResp(oversizeError(env)) };
}
// 重请求现只切换更宽的非流式超时上限；容量重试次数统一由 CAP_RETRIES/capState 控制。
function pickPolicy(options) { return estimateReqChars(options) >= HEAVY_CHARS ? RETRY_HEAVY : RETRY_NORMAL; }
function __testGateSnapshot() { return { inflight: GATE.inflight, waiters: GATE.waiters.length, admissionLimit: GATE.admissionLimit, rpmTokens: GATE.rpmTokens }; }
function __testResetGate() {
  GATE.inflight = 0; GATE.admissionLimit = 0; GATE.admissionMax = 0; GATE.lastCapacityAt = 0; GATE.lastRecoverAt = 0;
  GATE.rpmTokens = 0; GATE.rpmUpdatedAt = 0; GATE.rpmMax = 0; GATE.waiters.length = 0;
  CB.fails.length = 0; CB.openUntil = 0;
}
function __testOpenCircuit(ms = 1000) { CB.openUntil = Date.now() + ms; }
function __testCbSnapshot() { return { fails: CB.fails.length, open: cbOpen() }; }
function __testSetLastCapacityAt(ms) { GATE.lastCapacityAt = ms; }
function __testLeaseSnapshot() { return { tokens: LEASE.tokens, leasedAt: LEASE.leasedAt, refilling: LEASE.refilling, refillStartedAt: LEASE.refillStartedAt, failUntil: LEASE.failUntil, waitUntil: LEASE.waitUntil }; }
function __testSetLease(patch) { Object.assign(LEASE, patch); }
function __testSetRpmTokens(n) { GATE.rpmTokens = n; GATE.rpmUpdatedAt = Date.now(); GATE.rpmMax = n; }
function __testResetLease() { LEASE.tokens = 0; LEASE.leasedAt = 0; LEASE.refilling = false; LEASE.refillStartedAt = 0; LEASE.failUntil = 0; LEASE.waitUntil = 0; }
export { estimateReqChars, estimateReqTokens, shouldRejectOversize, oversizeLimit, __testGateSnapshot, __testResetGate, __testOpenCircuit, freshConnecting as __testFreshConnecting, classifyError as __testClassifyError, claudeToOpenAI as __testClaudeToOpenAI, isReprimable as __testReprimable, aiProbeFailureFlags }; // 供单测直接验估算器/闸门状态（Workers 运行时只用 default 导出，命名导出无副作用）
export { bucketLease as __bucketLease, __testLeaseSnapshot, __testResetLease, __testSetLease, __testSetRpmTokens, kickLeaseRefill as __testKickLeaseRefill, globalLimiterOn as __testGlobalLimiterOn, tryTakeAdmission as __testTryTakeAdmission, gateRelease as __testGateRelease, leaseWant as __testLeaseWant }; // 3021 全局令牌桶单测钩子
export { normalizeOpenAIContent, normalizeOpenAIMessages, neutralizeImageDataMarkers, idleMaxMs };
export { resolveModel as __testResolveModel, normModelKey as __testNormModelKey }; // 模型别名归一化单测钩子
export { matchRecKey as __testMatchRecKey }; // 换钥匙宽限期单测钩子
export { __testResetAdminFails }; // 管理密码内存失败计数单测钩子（并发爆破护栏）
export { __testResetUsageCoalesce, __testFireUsageTrailing, applyDelta as __testApplyDelta, flushUsage as __testFlushUsage }; // 计数写合并单测钩子（KV 每秒 1 写）
export { deltaFrom as __testDeltaFrom, usageDoStub as __testUsageDoStub, USAGE_MIRROR_MS as __testUsageMirrorMs }; // 计数搬 DO 单测钩子
export { suggestedGlobalRpm as __testSuggestedGlobalRpm, RATE_LIMIT_RPM_MEASURED as __testRateLimitRpmMeasured }; // 全局闸建议值单测钩子（实测：桶 40 / 每分钟补 20）
export { sumClassCounts as __testSumClassCounts, CJK_TOKEN_WEIGHT as __testCjkWeight, RATE_LIMIT_HINT_MIN as __testRateLimitHintMin }; // 3021 开闸信号 / CJK 权重单测钩子
export { logTokenEstimateDrift as __testLogTokenEstimateDrift, EST_DRIFT_RATIO as __testEstDriftRatio, EST_DRIFT_MIN_TOKENS as __testEstDriftMinTokens }; // 估算漂移日志阈值单测钩子（P0-6）
export { cbOnCapacityFail as __testCbOnCapacityFail, cbOnSuccess as __testCbOnSuccess, ensureAdmission as __testEnsureAdmission, __testCbSnapshot, __testSetLastCapacityAt, AIMD_RESET_MS as __testAimdResetMs }; // AIMD 降载/恢复单测钩子（审计④）
export { claudeTools as __testClaudeTools, openaiTools as __testOpenaiTools, responsesTools as __testResponsesTools }; // 三协议工具过滤单测钩子（服务端工具不得透给上游）
export { estimateMessagesTokens as __testEstimateMessagesTokens, contextHeaders as __testContextHeaders }; // 上下文观测头单测钩子（钉住"必须比只算正文的 estimateMessagesTokens 大"）
export { rescueTrim as __testRescueTrim, rescueTrimTarget as __testRescueTrimTarget, rescueTrimOn as __testRescueTrimOn, RESCUE_TRIM_SAFETY as __testRescueTrimSafety }; // 救援截断单测钩子（切点/配对/单调性/兜底）
export { isModelDownError as __testIsModelDownError, noteModelFail as __testNoteModelFail, noteModelOk as __testNoteModelOk, modelDown as __testModelDown, capState as __testCapState, MODEL_DOWN as __testModelDownMap }; // 断供快速失败闩单测钩子（4006 别再干等 50 秒）
export { dayKeyCN as __testDayKeyCN, bumpDay as __testBumpDay, recentDays as __testRecentDays, failBucket as __testFailBucket, failAdvice as __testFailAdvice, svcSummary as __testSvcSummary, coloCN as __testColoCN, DAY_KEEP as __testDayKeep }; // 客户自查页：按天用量/失败分类/服务状态摘要单测钩子
async function runGLM(env, options, signal) {
  const model = resolveModel(options.model);
  return await aiRunWithRetry(env, model, buildReq(model, options, false), pickPolicy(options), runOptions(options), signal);
}
async function runObserved(env, ctx, options, signal) {
  const startedAt = Date.now();
  const model = resolveModel(options.model);
  const req = buildReq(model, options, false);
  try {
    let r, lastErr;
    const cap = capState(env, model);
    for (let attempt = 0; attempt <= EMPTY_RESPONSE_RETRIES; attempt++) {
      const result = await aiRunWithRetry(env, model, req, pickPolicy(options), runOptions(options), signal, cap);
      r = normalize(result);
      if (hasNormalizedOutput(r)) break;
      logEmptyStream(req, attempt);
      lastErr = mkErr("empty response");
      if (attempt === EMPTY_RESPONSE_RETRIES) throw lastErr;
      await sleep(backoff(RETRY_NORMAL.base, attempt));
    }
    const usage = { input: r.inputTokens, output: r.outputTokens, cached: r.cachedTokens, isEstimated: !(r.inputTokens || r.outputTokens) };
    writeSentinel(env, ctx, sentinelPoint(env, options, false, startedAt, "ok", "none", null, usage));
    return r;
  } catch (e) {
    writeSentinel(env, ctx, sentinelPoint(env, options, false, startedAt, "error", classifyError(e), null, { input: 0, output: 0, cached: null, isEstimated: true }));
    throw e;
  }
}
function friendlyError(e) {
  const m = String((e && e.message) || e); const low = m.toLowerCase();
  if (low.includes("longer than") || (low.includes("context") && low.includes("length")) || low.includes("too long") || low.includes("5021")) return { status: 400, type: "invalid_request_error", message: "上下文过长，请精简后重试（glm-5.2 上限约 25 万 token）。" };
  // 两类 8007 都是客户端历史里工具数据坏了、glm 校验拒收、【不可重试】，须回 400 否则客户端当 5xx 死循环烧额度（与上面"上下文超顶"分开，那条已先判走）：
  //   "unexpected end of data"=某 tool_calls.arguments / tool 结果 JSON 被截断或过大（B 实证 2026-07-06）；
  //   "...arguments must be valid JSON"=某 assistant tool_call 的 arguments 不是合法 JSON（2026-07-20 133551 真实客诉，原掉到 500 → 客户端死循环烧额度）。
  if (low.includes("unexpected end of data") || low.includes("must be valid json") || low.includes("arguments must be valid")) return { status: 400, type: "invalid_request_error", message: "对话历史有一步的工具调用数据损坏/不完整（不可重试）；请在客户端 /compact 或开新会话后重试。" };
  // 8007 = glm 的 BadRequest 总码：请求本身不合法（历史坏了/参数非法/消息为空等），【一律不可重试】。
  // 上面已把已知变体（工具数据损坏）给了更具体的提示；这里通配兜住所有其余 8007/BadRequest，
  // 回干净 400 而非掉 500 —— 避免任何未知 8007 变体让客户端当 5xx 死循环烧额度（止住打地鼠）。
  if (low.includes("8007") || low.includes("badrequest")) return { status: 400, type: "invalid_request_error", message: "请求被上游拒绝（数据不合法，不可重试）；请重置对话或在客户端 /compact 后重试。" };
  if (low.includes("queue full") || low.includes("queue timeout")) return { status: 429, type: "rate_limit_error", message: "请求过于密集，请稍后重试。" };
  if (low.includes("empty response")) return { status: 503, type: "overloaded_error", message: "服务繁忙（上游空响应），请稍后重试。" };
  if (low.includes("first token timeout") || low.includes("prefill timeout") || low.includes("upstream stalled")) return { status: 503, type: "overloaded_error", message: "服务繁忙（上游响应超时），请稍后重试。" };
  // 3021 = 上游每分钟推理限速（B 项目压测实采真码，2026-07-03）。老代码不认 → 500 硬失败客户端不重试。
  // 须在 isCapacityError 之前判（3021 已归容量类做退避重试），重试耗尽时回 429 让客户端按限速语义优雅退避。
  if (low.includes("3021") || low.includes("per min rate") || low.includes("per-min rate") || (low.includes("rate limit") && low.includes("inference"))) return { status: 429, type: "rate_limit_error", message: "上游繁忙（每分钟推理限速），请稍后重试。" };
  /* 文案 2026-08-02 改（用户确认）。老文案是「当日免费额度已用尽，次日恢复后可用（如需不断供请联系升级）」，
     对现在这批号是【假话】：付费号、当天零用量，客户看了会以为我们在抠额度。
     根因：CF 把「免费额度耗尽」和「断供」复用了同一个码 4006，而这个分支只看码不看文案，
     两种完全不同的情况吐同一句。既然分不出来，就别替 CF 编原因——只说客户能据以行动的事实。 */
  if (low.includes("4006") || low.includes("1027") || low.includes("free allocation") || low.includes("daily free")) return { status: 429, type: "rate_limit_error", message: "这个通道当前调用不了，我们正在处理，可稍后重试或联系客服换通道。" };
  if (isCapacityError(e)) return { status: 503, type: "overloaded_error", message: "服务繁忙，请稍后重试。" };
  // 结构兜底（2026-07-21 B批·外科版）：未被上面任何分支识别的错，若其 glm envelope 里内嵌了
  // 4xx 码或 BadRequest/invalid 类 type，说明请求本身不合法（客户端数据错）、【不可重试】→ 回 400，
  // 而非掉 500 让客户端当 5xx 死循环烧额度。堵住未来任何不含 "8007"/"badrequest" 字样的新 4xx 变体。
  // 用锚定正则抠 JSON 键，不裸匹配数字（避免 F3 那种列号巧合误判）。容量类已在上一行判走，不会误伤。
  const codeMatch = m.match(/"code"\s*:\s*(\d{3})\b/);
  const embeddedCode = codeMatch ? Number(codeMatch[1]) : null;
  const typeMatch = m.match(/"type"\s*:\s*"([^"]+)"/);
  const embeddedType = typeMatch ? typeMatch[1].toLowerCase() : "";
  if (embeddedCode === 429) return { status: 429, type: "rate_limit_error", message: "上游繁忙，请稍后重试。" };
  if ((embeddedCode !== null && embeddedCode >= 400 && embeddedCode <= 499)
      || embeddedType.includes("badrequest") || embeddedType.includes("invalid")
      || embeddedType.includes("unprocessable") || embeddedType.includes("notfound")
      || embeddedType.includes("unsupported")) {
    return { status: 400, type: "invalid_request_error", message: "请求被上游拒绝（数据不合法，不可重试）；请重置对话或在客户端 /compact 后重试。" };
  }
  // 最后一档不再把上游原文回给客户（审计零碎条之二）：原文是排障用的，里面可能带
  // 内部诊断/模型名/账号线索，去密只挡得住长得像密钥的东西。原文已由 [zcode-diag]
  // 在出错现场整段记进日志（describeErr 去密后 4000 字），客户这边只拿一句人话。
  return { status: 500, type: "api_error", message: "调用失败（未识别的上游错误），请稍后重试；持续出现请联系管理员。" };
}
// 早回 200 后、尚未出字时，只对 503 类上游瞬时错做透明重连。
// 429 类不 reprime：queue-timeout 是自身饱和且重连会绕过准入名额；4006/1027 是确定性额度耗尽；3021 仍在限速窗口内。
function isReprimable(e) { return friendlyError(e).status === 503; }
// Anthropic SSE 错误类型白名单；invalid_request_error 不能被折成 api_error，否则客户端会误判是否该重试。
function sseErrType(t) { return (t === "overloaded_error" || t === "rate_limit_error" || t === "invalid_request_error" || t === "authentication_error") ? t : "api_error"; }

function errorText(e) {
  let s = "";
  if (e && typeof e === "object") {
    s = String(e.stack || e.message || e);
    const extra = {};
    for (const k of ["name", "code", "status", "statusCode"]) if (e[k] != null) extra[k] = e[k];
    if (e.cause) extra.cause = String((e.cause && (e.cause.stack || e.cause.message)) || e.cause).slice(0, 1000);
    if (Object.keys(extra).length) s += "\nmeta=" + JSON.stringify(extra);
  } else {
    s = String(e);
  }
  return redactSecrets(s).slice(0, 4000);
}
function redactSecrets(s) {
  return String(s || "")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"',;}]+/ig, "$1[redacted]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]{12,}/ig, "$1[redacted]")
    .replace(/\b(sk|cf|zai|key|token)-[A-Za-z0-9._~+/-]{12,}/ig, "[redacted]");
}
function contentKind(c) {
  if (typeof c === "string") return "string";
  if (Array.isArray(c)) return "array:" + c.map(x => (typeof x === "string" ? "string" : (x && typeof x === "object" ? String(x.type || x.kind || "object") : typeof x))).join(",");
  if (c == null) return "null";
  return typeof c;
}
function summarizeAiRequest(req) {
  const messages = Array.isArray(req && req.messages) ? req.messages : [];
  return {
    model: req && req.model,
    stream: !!(req && req.stream),
    messageCount: messages.length,
    roles: messages.map(m => (m && m.role) || "unknown"),
    contentKinds: messages.map(m => contentKind(m && m.content)),
    hasTools: Array.isArray(req && req.tools) && req.tools.length > 0,
    toolCount: Array.isArray(req && req.tools) ? req.tools.length : 0,
    hasToolChoice: !!(req && req.tool_choice),
    toolRoleCount: messages.filter(m => m && m.role === "tool").length,
    toolCallsByMessage: messages.map(m => Array.isArray(m && m.tool_calls) ? m.tool_calls.length : 0),
    hasResponseFormat: !!(req && req.response_format),
    approxChars: estimateReqChars(req),
  };
}
function logDiagFailure(phase, e, detail) {
  try {
    console.error("[zcode-diag]", JSON.stringify({ phase, error: errorText(e), detail }));
  } catch (_) {
    console.error("[zcode-diag]", phase, errorText(e));
  }
}
/* token 估算校准日志（P0-3）：拿到上游真实 input_tokens 时，和我们的估算比一比。
   过大闸只能用估算（请求还没发出去），估算偏了就会误拦或漏拦，而此前完全没有"偏多少"的观测。
   只在够大(≥2 万 token，小请求比值噪声大且无关闸门)且偏差 ≥EST_DRIFT_RATIO 时打一条，热路径基本零开销。
   ratio>1 = 我们高估(有误拦风险)，<1 = 低估。攒够样本就按中位数回调 CJK_TOKEN_WEIGHT。 */
const EST_DRIFT_MIN_TOKENS = 20000;
// 阈值 0.10：2026-07-27 soak 实测估/真 = 0.89（两档一致），系统性偏差就在 11% 这个量级。
// 原值 0.25 抓不到它 —— 等于埋了个永远不响的探针，所以降到 0.10 才真能收到校准数据。
const EST_DRIFT_RATIO = 0.10;
function logTokenEstimateDrift(model, options, actualInput) {
  if (!(actualInput >= EST_DRIFT_MIN_TOKENS)) return;
  try {
    const est = estimateReqTokens(options);   // 已记忆化：本次请求早算过，这里是查表
    if (!(est > 0)) return;
    const ratio = est / actualInput;
    if (Math.abs(ratio - 1) < EST_DRIFT_RATIO) return;
    console.log("[zcode-diag]", JSON.stringify({ tag: "token_est_drift", model, est, actual: actualInput, ratio: Math.round(ratio * 100) / 100 }));
  } catch (_) {}
}
function logEmptyStream(req, attempt) {
  try {
    console.error("[zcode-diag] empty-stream", { shape: summarizeAiRequest(req), attempt });
  } catch (_) {
    console.error("[zcode-diag] empty-stream", { attempt });
  }
}

/* ===== 上游流式：读取 / 解析 / 预热 =====
   兼容两种上游分片：OpenAI chunk（choices[0].delta）与 Workers AI 文本（{response}）。 */
// 带超时的读取器：超时不丢弃在飞的 read（保留 pending 给下次复用，避免“read 进行中再 read”报错）。
function wrapReader(stream, rawcmp) {
  const rs = stream instanceof ReadableStream ? stream : ((stream && stream.body) || stream);
  const reader = rs.getReader();
  const dec = new TextDecoder();
  let pending = null;
  return {
    async read(ms) {
      // 超时只是没等到，不能丢掉在飞的 read：保留 pending 给下次复用；
      // 同时挂一个吞错 catch，避免 idle-max 提前结束时这条 read 变成游离的 unhandled rejection。
      if (!pending) { pending = reader.read(); pending.catch(() => {}); }
      let timer;
      const to = new Promise((res) => { timer = setTimeout(() => res(TIMEOUT), ms); });
      const v = await Promise.race([pending, to]);
      clearTimeout(timer);
      if (v === TIMEOUT) return TIMEOUT;      // 保留 pending，下次继续等同一个 read
      pending = null;
      if (v.done) { const text = dec.decode(); if (text) rawCmpLog(rawcmp, "upstream", text); return { done: true, text }; }
      const text = dec.decode(v.value, { stream: true });
      rawCmpLog(rawcmp, "upstream", text);
      return { text };
    },
    cancel() { return Promise.resolve().then(() => reader.cancel()).catch(() => {}); },
  };
}
function diagContentEnabled(env) { const v = env && env.DIAG_CONTENT; return v === true || v === 1 || /^(1|true|yes|on)$/i.test(String(v || "")); }
function makeRawCmp(env, options) { return diagContentEnabled(env) && options && options.thinking === true ? { id: rid().slice(0, 8), upstream: 0, relay: 0, max: 20 } : null; }
function rawCmpLog(cmp, side, text) {
  if (!cmp || !text) return;
  const k = side === "upstream" ? "upstream" : "relay";
  if (cmp[k] >= cmp.max) return;
  cmp[k]++;
  try { console.log("[zcode-rawcmp]", JSON.stringify({ id: cmp.id, side, n: cmp[k], text: redactSecrets(String(text)).slice(0, 4000) })); } catch (_) {}
}
function headersForDiag(headers) {
  const out = {};
  try {
    for (const [k, v] of headers.entries()) {
      const key = String(k || "").toLowerCase();
      if (key === "authorization" || key === "x-api-key" || key.includes("token") || key.includes("key")) {
        out[key] = "[redacted]";
      } else {
        out[key] = redactSecrets(v).slice(0, 1000);
      }
    }
  } catch (_) {}
  return out;
}
function diagUpstreamReq(path, body) {
  try {
    if (path === "/v1/chat/completions") {
      const options = { messages: normalizeOpenAIMessages(body.messages), tools: openaiTools(body.tools), maxTokens: body.max_tokens || body.max_completion_tokens, model: body.model, thinking: clientThinkingPref(body), affinity: null };
      return buildReq(resolveModel(options.model), options, !!body.stream);
    }
    if (path === "/v1/messages") {
      const messages = claudeToOpenAI(body);
      const options = { messages, tools: claudeTools(body.tools), maxTokens: body.max_tokens, model: body.model, thinking: clientThinkingPref(body), affinity: null };
      return buildReq(resolveModel(options.model), options, !!body.stream);
    }
    if (path === "/v1/responses") {
      const messages = responsesToOpenAI(body);
      const options = { messages, tools: responsesTools(body.tools), maxTokens: body.max_output_tokens, model: body.model, thinking: clientThinkingPref(body), affinity: null };
      return buildReq(resolveModel(options.model), options, !!body.stream);
    }
  } catch (e) {
    return { diagBuildError: errorText(e) };
  }
  return null;
}
function diagPath(base, key) {
  if (typeof key === "number") return base + "[" + key + "]";
  return base + "." + String(key).replace(/[^A-Za-z0-9_$]/g, "_");
}
function contentKindForDiag(c) {
  if (Array.isArray(c)) return "array";
  if (c === null) return "null";
  return typeof c;
}
function messageSummaryForDiag(messages) {
  if (!Array.isArray(messages)) return { kind: contentKindForDiag(messages), count: 0 };
  return {
    count: messages.length,
    items: messages.map((m, i) => {
      const c = m && m.content;
      const item = { i, role: (m && m.role) || "unknown", keys: m && typeof m === "object" ? Object.keys(m).slice(0, 30) : [], content: contentKindForDiag(c) };
      if (typeof c === "string") item.contentLength = c.length;
      if (Array.isArray(c)) item.parts = c.slice(0, 80).map((p, j) => ({ j, type: p && typeof p === "object" ? p.type : typeof p, keys: p && typeof p === "object" ? Object.keys(p).slice(0, 20) : [] }));
      return item;
    })
  };
}
function scanStringsForDiag(v, path, out, seen) {
  if (out.length >= 200) return;
  if (typeof v === "string") {
    const dataIdx = v.indexOf("data:image");
    const b64 = v.match(/[A-Za-z0-9+/]{200,}={0,2}/);
    if (dataIdx >= 0 || b64) {
      out.push({
        path,
        length: v.length,
        hasDataImage: dataIdx >= 0,
        matchLength: dataIdx >= 0 ? Math.min(v.length - dataIdx, 1000000) : (b64 ? b64[0].length : 0),
        prefix: redactSecrets(v.slice(0, 40)),
        matchPrefix: redactSecrets((dataIdx >= 0 ? v.slice(dataIdx, dataIdx + 40) : (b64 ? b64[0].slice(0, 40) : "")))
      });
    }
    return;
  }
  if (!v || typeof v !== "object") return;
  if (seen.has(v)) return;
  seen.add(v);
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) scanStringsForDiag(v[i], diagPath(path, i), out, seen);
    return;
  }
  for (const k of Object.keys(v)) scanStringsForDiag(v[k], diagPath(path, k), out, seen);
}
function scanObjectForDiag(v) {
  const hits = [];
  scanStringsForDiag(v, "$", hits, new Set());
  const topKeys = v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).slice(0, 80) : [];
  return { topKeys, messages: messageSummaryForDiag(v && v.messages), stringHits: hits.slice(0, 80) };
}
function diagScanPayload(path, body, headers) {
  const upstream = diagUpstreamReq(path, body);
  return { at: new Date().toISOString(), path, headers: headersForDiag(headers), inbound: scanObjectForDiag(body), upstream: scanObjectForDiag(upstream) };
}
function logDiagContentFailure(env, ctx, path, body, headers) {
  if (!diagContentEnabled(env)) return;
  try {
    const payload = diagScanPayload(path, body, headers);
    console.error("[zcode-imgscan]", JSON.stringify(payload));
    if (ctx && ctx.waitUntil && env && env.STORE) ctx.waitUntil(env.STORE.put("diag:lastImgScanFailure", JSON.stringify(payload)).catch(() => {}));
  } catch (e) {
    console.error("[zcode-imgscan]", JSON.stringify({ path, diagError: errorText(e) }));
  }
}
function logDiagContentRequest(env, ctx, path, body, headers) {
  if (!diagContentEnabled(env)) return;
  try {
    const payload = diagScanPayload(path, body, headers);
    if (ctx && ctx.waitUntil && env && env.STORE) ctx.waitUntil(env.STORE.put("diag:lastImgScan", JSON.stringify(payload)).catch(() => {}));
  } catch (_) {}
}
// 有状态 SSE 解析器：feed/flush 返回事件数组 {t:"text"|"reasoning", v}（实时流出）；tool_calls 按 index 累加。
function makeParser() {
  let buf = "";
  const toolMap = new Map();
  let usage = null, finish = null, text = "", reasoning = "", done = false;
  let thinkBuf = "", inThink = false;
  const START = "<think>", END = "</think>";
  const suffixLen = (s, tags) => {
    let n = 0;
    for (const tag of tags) {
      const max = Math.min(tag.length - 1, s.length);
      for (let i = 1; i <= max; i++) if (s.endsWith(tag.slice(0, i)) && i > n) n = i;
    }
    return n;
  };
  const emitText = (v, out) => { if (v) { text += v; out.push({ t: "text", v }); } };
  const emitReasoning = (v, out) => { if (v) { reasoning += v; out.push({ t: "reasoning", v }); } };
  const splitThinkContent = (s, out, final = false) => {
    thinkBuf += s;
    while (thinkBuf) {
      if (inThink) {
        const end = thinkBuf.toLowerCase().indexOf(END);
        if (end >= 0) {
          emitReasoning(thinkBuf.slice(0, end), out);
          thinkBuf = thinkBuf.slice(end + END.length);
          inThink = false;
          continue;
        }
        const keep = final ? 0 : suffixLen(thinkBuf, [END]);
        emitReasoning(thinkBuf.slice(0, thinkBuf.length - keep), out);
        thinkBuf = thinkBuf.slice(thinkBuf.length - keep);
        if (final && thinkBuf) { emitReasoning(thinkBuf, out); thinkBuf = ""; }
        break;
      }
      const low = thinkBuf.toLowerCase();
      const start = low.indexOf(START);
      const strayEnd = low.indexOf(END);
      if (start >= 0 && (strayEnd < 0 || start < strayEnd)) {
        emitText(thinkBuf.slice(0, start), out);
        thinkBuf = thinkBuf.slice(start + START.length);
        inThink = true;
        continue;
      }
      if (strayEnd >= 0) {
        emitText(thinkBuf.slice(0, strayEnd), out);
        thinkBuf = thinkBuf.slice(strayEnd + END.length);
        continue;
      }
      const keep = final ? 0 : suffixLen(thinkBuf, [START, END]);
      emitText(thinkBuf.slice(0, thinkBuf.length - keep), out);
      thinkBuf = thinkBuf.slice(thinkBuf.length - keep);
      if (final && thinkBuf) { emitText(thinkBuf, out); thinkBuf = ""; }
      break;
    }
  };
  const handle = (payload, out) => {
    if (!payload) return;
    if (payload === "[DONE]") { done = true; return; }
    let obj; try { obj = JSON.parse(payload); } catch { return; }
    const choice = obj.choices && obj.choices[0];
    const delta = choice ? (choice.delta || choice.message || {}) : null;
    // 推理（独立字段，先于正文处理；流式 delta.reasoning_content / 非流式 message.reasoning_content）
    let rc = "";
    if (delta) { if (typeof delta.reasoning_content === "string") rc = delta.reasoning_content; else if (typeof delta.reasoning === "string") rc = delta.reasoning; }
    if (!rc && typeof obj.reasoning_content === "string") rc = obj.reasoning_content;
    if (rc) emitReasoning(rc, out);
    // 正文
    let t = "";
    if (delta && typeof delta.content === "string") t = delta.content;
    else if (typeof obj.response === "string") t = obj.response;
    if (t) splitThinkContent(t, out);
    const tcs = (delta && delta.tool_calls) || obj.tool_calls;
    if (Array.isArray(tcs)) {
      for (const tc of tcs) {
        const idx = (tc.index != null) ? tc.index : toolMap.size;
        const cur = toolMap.get(idx) || { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        const fn = tc.function || {};
        if (fn.name) cur.name = fn.name;
        if (typeof fn.arguments === "string") cur.args += fn.arguments;
        toolMap.set(idx, cur);
      }
    }
    if (choice && choice.finish_reason) finish = choice.finish_reason;
    if (obj.usage) usage = obj.usage;
  };
  const drain = (chunk, out) => { for (const line of chunk.split("\n")) { const s = line.trimStart(); if (s.startsWith("data:")) handle(s.slice(5).trim(), out); } };
  return {
    feed(s) { buf += s; const out = []; let i; while ((i = buf.indexOf("\n\n")) >= 0) { drain(buf.slice(0, i), out); buf = buf.slice(i + 2); } return out; },
    flush() { const out = []; if (buf.trim()) drain(buf, out); buf = ""; splitThinkContent("", out, true); return out; },
    tools() { return [...toolMap.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => ({ id: v.id || ("call_" + rid()), name: v.name, arguments: v.args || "" })).filter(t => typeof t.name === "string" && t.name.trim() !== ""); }, // 丢弃空名工具调用（glm 退化会吐无 name 的 tool_call，原样下发→客户端 "tool name is empty" 硬崩）
    hasTools() { return toolMap.size > 0; },
    hasOutput() { return text !== "" || reasoning !== "" || toolMap.size > 0; },
    isDone() { return done; },
    state() { return { usage, finish, text, reasoning }; },
  };
}
function finalize(parser) { const s = parser.state(); return { tools: parser.tools(), usage: s.usage, finish: s.finish, text: s.text, reasoning: s.reasoning }; }
function usageOut(r, fallbackText, estInput) {
  const u = r.usage || {};
  const rawOut = u.completion_tokens || u.output_tokens || 0;
  const rawInp = u.prompt_tokens || u.input_tokens || 0;
  const out = rawOut || Math.ceil((fallbackText || "").length / 4);
  const inp = rawInp || estInput || 0;
  const cd = u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens;
  return { input: inp, output: out, cached: (typeof cd === "number" ? cd : null), isEstimated: !(rawInp || rawOut) };
}

// 预热（三态，绝不自我放弃）：
//   {kind:"content",...}：宽限内拿到首份内容或干净结束 → 回放后正常流式。
//   {kind:"pending",...} ：宽限到点仍无字、但连接正常 → 早回 200，由 startStreaming 心跳保活继续等。
//   {kind:"connecting",..}：连接(env.AI.run) 超 GRACE 仍未拿到流 → 早回 200，由 startStreaming 边心跳边等流，PREFILL_MAX 兜底（治连接裸挂 P1-A）。
//   throw                ：出字前的硬错误（多为容量，已退避重试到上限）→ 上层 503 + Retry-After。
async function primeWithGrace(env, options, rawcmp, gateCtl) {
  const model = resolveModel(options.model);
  const req = buildReq(model, options, true);
  const policy = pickPolicy(options);
  const grace = graceMs(env);
  const cap = capState(env, model);
  let lastErr;
  for (let attempt = 0; attempt <= Math.max(cap.retries, EMPTY_RESPONSE_RETRIES); attempt++) {
    // 连接调温柔（P1-A）：env.AI.run 拿到流前也有界 —— race GRACE。
    //   GRACE 内拿到流 → 原三态读循环（行为不变）；GRACE 内 reject → 容量退避/干净抛（不变）；
    //   GRACE 到点仍没拿到流（连接慢，50s 裸挂根因）→ 返回 connecting：startStreaming 早回200+心跳边等，PREFILL_MAX 兜底。
    const startedAt = Date.now();
    const aiP = env.AI.run(model, req, runOptions(options));
    aiP.catch((e) => logDiagFailure("ai_run_async", e, { mode: "stream", model, request: summarizeAiRequest(req) })); // 超时/早回后 aiP 仍可能 reject → 防游离 rejection
    let gt; const graceTimer = new Promise((res) => { gt = setTimeout(() => res(TIMEOUT), grace); });
    const cr = await Promise.race([aiP.then((s) => ({ stream: s }), (e) => ({ err: e })), graceTimer]);
    clearTimeout(gt);
    if (cr === TIMEOUT) return { kind: "connecting", aiP, startedAt, req, attempt, model, options: runOptions(options), cap };
    if (cr.err !== undefined) {
      const e = cr.err;
      if (isCapacityError(e)) cbOnCapacityFail(env, attempt);
      noteModelFail(env, model, e, attempt);                  // 断供闩记账（只算首发）
      lastErr = e;
      if (!isCapacityError(e) || attempt >= cap.retries) throw e;
      if (gateCtl) gateCtl.release();                       // 容量退避前先放名额，别占着名额睡觉饿死他人
      if (!await sleepCapacityBackoff(env, attempt, cap)) throw e;
      if (gateCtl) await gateCtl.reacquire();               // 退避结束、重连上游前再入场
      continue;
    }
    const wrapped = wrapReader(cr.stream, rawcmp); cbOnSuccess(env); noteModelOk(model); // 拿到流即证明这个模型还调得动 → 清断供闩
    const parser = makeParser();
    try {
      const deadline = Date.now() + grace;
      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { kind: "pending", wrapped, parser, req, attempt, cap };   // 宽限到点仍无字 → 早回 200（不放弃、不重试）
        const v = await wrapped.read(remaining);
        if (v === TIMEOUT) return { kind: "pending", wrapped, parser, req, attempt, cap };     // 同上
        if (v.done) {
          const evs = v.text ? parser.feed(v.text) : [];
          const tail = evs.concat(parser.flush());
          // 整段空回复（无文本无推理无工具）→ 出字前用空回复专用预算重试，避免偶发“空 200”。
          if (!parser.hasOutput()) {
            logEmptyStream(req, attempt);
            if (attempt < EMPTY_RESPONSE_RETRIES) throw RETRY_EMPTY;
            throw mkErr("empty response");
          }
          return { kind: "content", wrapped, parser, firstEvents: tail, ended: true, req, attempt, cap };
        }
        const evs = parser.feed(v.text);
        if (evs.length || parser.hasTools() || parser.isDone()) {
          const ended = parser.isDone();
          if (ended && !parser.hasOutput()) {
            logEmptyStream(req, attempt);
            if (attempt < EMPTY_RESPONSE_RETRIES) throw RETRY_EMPTY;
            throw mkErr("empty response");
          }
          return { kind: "content", wrapped, parser, firstEvents: ended ? evs.concat(parser.flush()) : evs, ended, req, attempt, cap };
        }
        // 只有 role 之类空增量 → 继续等，直到宽限到点。
      }
    } catch (e) {
      await wrapped.cancel();
      if (isCapacityError(e)) cbOnCapacityFail(env, attempt);
      noteModelFail(env, model, e, attempt);                  // 断供闩记账（只算首发）
      const empty = e === RETRY_EMPTY;
      lastErr = empty ? mkErr("empty response") : e;
      // 出字前：容量拒绝 / 空回复可重试；其它错误抛出 → 干净 503 / 友好报错。
      if (empty && attempt < EMPTY_RESPONSE_RETRIES) { await sleep(backoff(policy.base, attempt)); continue; }
      if (isCapacityError(e) && attempt < cap.retries) {
        if (gateCtl) gateCtl.release();                     // 容量退避前放名额
        if (await sleepCapacityBackoff(env, attempt, cap)) { if (gateCtl) await gateCtl.reacquire(); continue; }
      }
      throw lastErr;
    }
  }
  throw lastErr || mkErr("stream failed");
}

// 早回 200 后、尚未出字时的透明重连：重新打开一条上游流，客户端只看到心跳。
function freshConnecting(env, options) {
  if (cbOpen()) throw mkErr("capacity (circuit open)");
  const model = resolveModel(options.model);
  const req = buildReq(model, options, true);
  const aiP = env.AI.run(model, req, runOptions(options));
  aiP.catch((e) => logDiagFailure("ai_run_async", e, { mode: "stream", model, request: summarizeAiRequest(req) }));
  return { kind: "connecting", aiP, startedAt: Date.now(), req, attempt: 0, model, options: runOptions(options), cap: capState(env, model) };
}

// 把解析器事件路由到协议 sink：推理走 reasoning 通路，正文走 text 通路。
function emitEvent(sink, ev) { if (ev.t === "reasoning") sink.reasoning(ev.v); else sink.text(ev.v); }
// 通用流式驱动：宽限内拿到内容就照常 200；宽限到点仍 prefill → 早回 200 + 心跳保活继续等。
// 相位看门狗：出字前给 PREFILL_MAX（宽），出字后给 STREAM_IDLE_MAX（严）；超了发流内错误帧。
async function startStreaming(env, options, ctx, makeSink, estInput, extraHeaders) {
  if (cbOpen()) throw mkErr("capacity (circuit open)"); // 开闸期：流式同样源头快速失败
  let gateHeld = tryTakeAdmission(env);                  // 正常热路径：有名额立即直通，不进队列
  const releaseGate = () => { if (gateHeld) { gateHeld = false; gateRelease(env); } }; // 幂等释放当前名额；释放后可 reacquireGate 重新入场
  const reacquireGate = async (sig) => { if (!gateHeld) { await gateAcquire(env, { queue: true, stream: true, signal: sig }); gateHeld = true; } }; // 退避后重新入场（仍走有界队列+心跳保活）
  const gateCtl = { release: releaseGate, reacquire: reacquireGate }; // 交给 primeWithGrace：容量退避时放名额、重连前再入场，避免占名额睡觉饿死他人
  const sentinelStartedAt = Date.now();
  let sentinelTtftMs = null, sentinelDone = false;
  const markTtft = () => { if (sentinelTtftMs == null) sentinelTtftMs = Date.now() - sentinelStartedAt; };
  const finishSentinel = (status, errorClass, fin) => {
    if (sentinelDone) return;
    sentinelDone = true;
    const u = fin ? usageOut(fin, fin.text, estInput) : { input: estInput || 0, output: 0, cached: null, isEstimated: true };
    writeSentinel(env, ctx, sentinelPoint(env, options, true, sentinelStartedAt, status, errorClass, sentinelTtftMs, u));
  };
  let primed;
  const rawcmp = makeRawCmp(env, options);
  if (gateHeld) {
    try { primed = await primeWithGrace(env, options, rawcmp, gateCtl); }  // 抛出 → 上层 errResp（出字前 503+Retry-After）
    catch (e) { finishSentinel("error", classifyError(e), null); releaseGate(); throw e; } // 预热失败：先释放名额再抛
  }
  const st = { clientGone: false };
  const hb = heartbeatMs(env), prefillMax = prefillMaxMs(env), idleMax = idleMaxMs(env);
  const kaOn = prefillKeepalive(env);
  let queueAbort = null;
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const sink = makeSink((s) => { rawCmpLog(rawcmp, "relay", s); controller.enqueue(enc.encode(s)); });
      let sawContent = false;
      // 出字前的保活：开关开且 sink 支持时发极小真 reasoning 增量（喂活客户端计时器），否则退回普通心跳。
      const beat = () => { if (kaOn && !sawContent && sink.keepalive) sink.keepalive(); else sink.heartbeat(); };
      try {
        sink.open();
        if (progressHint(env) && sink.reasoning && !sawContent && estimateReqChars(options) >= HEAVY_CHARS) {
          try { sink.reasoning(progressHintText(env)); } catch (_) {}   // 大内容一次性"处理中"预告(env 门控)，reasoning 通路、不污染正文
        }
        if (!primed) {
          // 没拿到名额时才早回 200：在有界队列里保活等待，拿到名额后再连接上游。
          queueAbort = new AbortController();
          const gateP = gateAcquire(env, { queue: true, stream: true, signal: queueAbort.signal }).then(() => ({ ok: true }), (e) => ({ err: e }));
          while (true) {
            let tt; const tick = new Promise((res) => { tt = setTimeout(() => res(TIMEOUT), hb); });
            const r = await Promise.race([gateP, tick]);
            clearTimeout(tt);
            if (r && r.ok) gateHeld = true;   // 拿到名额立刻认领，之后任何提前 return 都由 finally 释放
            if (env && env.__TEST_STREAM_GATE_GRANTED_CLIENT_GONE) st.clientGone = true;
            if (st.clientGone) return;
            if (r === TIMEOUT) { beat(); continue; }
            if (r.err !== undefined) throw r.err;
            break;
          }
          primed = await primeWithGrace(env, options, rawcmp, gateCtl);
        }
        let reprimeCount = 0; const reprimeMax = reprimeMaxStream(env);
        reprime: while (true) {
        try {
        if (primed.kind === "connecting") {
          // 连接慢已早回 200：边发心跳边等 env.AI.run 拿到流，PREFILL_MAX 总上限兜底（不再 0 反馈裸挂）。
          while (true) {
            let tt; const tick = new Promise((res) => { tt = setTimeout(() => res(TIMEOUT), hb); });
            const r = await Promise.race([primed.aiP.then((s) => ({ stream: s }), (e) => ({ err: e })), tick]);
            clearTimeout(tt);
            if (st.clientGone) return;
            if (r === TIMEOUT) { if (Date.now() - primed.startedAt >= prefillMax) throw mkErr("prefill timeout"); beat(); continue; }
            if (r.err !== undefined) {
              if (isCapacityError(r.err)) cbOnCapacityFail(env, primed.attempt);
              noteModelFail(env, primed.model || resolveModel(options.model), r.err, primed.attempt); // 断供闩记账（只算首发）
              const cap = primed.cap || capState(env, primed.model || resolveModel(options.model));
              if (isCapacityError(r.err) && primed.attempt < cap.retries) {
                const delay = capDelayMs(env, primed.attempt, cap);
                if (delay < 0) throw r.err;
                releaseGate();                              // 连接态退避期间放名额（已早回200，由心跳保活）
                const until = Date.now() + delay;
                while (Date.now() < until) {
                  await sleep(Math.min(hb, until - Date.now()));
                  if (st.clientGone) return;
                  beat();
                }
                if (Date.now() > cap.deadline) throw r.err;
                await reacquireGate(queueAbort && queueAbort.signal);  // 重连上游前再入场
                const nextAttempt = primed.attempt + 1;
                const nextP = env.AI.run(primed.model || resolveModel(options.model), primed.req, primed.options || runOptions(options));
                nextP.catch((e) => logDiagFailure("ai_run_async", e, { mode: "stream", model: primed.model || resolveModel(options.model), request: summarizeAiRequest(primed.req) }));
                primed = { ...primed, aiP: nextP, startedAt: Date.now(), attempt: nextAttempt, cap };
                continue;
              }
              throw r.err;
            } // 连接最终失败 → 错误帧（计 fail）
            cbOnSuccess(env); noteModelOk(primed.model || resolveModel(options.model)); // 拿到流 → 清断供闩
            primed = { kind: "pending", wrapped: wrapReader(r.stream, rawcmp), parser: makeParser(), req: primed.req, attempt: primed.attempt, cap: primed.cap }; // 拿到流 → 转入正常读循环
            break;
          }
        }
        if (primed.kind === "content") {
          for (const ev of primed.firstEvents) { if (ev.t === "text") { markTtft(); sawContent = true; } emitEvent(sink, ev); }
          if (primed.ended) { const fin = finalize(primed.parser); finishSentinel("ok", "none", fin); sink.finish(fin); ctx.waitUntil(recordUsageSafe(env, true, streamTok(options, fin, estInput))); return; } // 宽限内完整结束也记 success + token
        }
        let silence = 0;
        while (true) {
          const v = await primed.wrapped.read(hb);
          if (st.clientGone) return;
          if (v === TIMEOUT) {
            silence += hb;
            if (silence >= (sawContent ? idleMax : prefillMax)) throw mkErr(sawContent ? "upstream stalled" : "prefill timeout");
            beat();                                   // prefill 期间也心跳，连接不静默（出字前可携带 reasoning 占位）
            continue;
          }
          silence = 0;
          if (v.done) {
            const tail = (v.text ? primed.parser.feed(v.text) : []).concat(primed.parser.flush());
            for (const ev of tail) { if (ev.t === "text") { markTtft(); sawContent = true; } emitEvent(sink, ev); }
            break;
          }
          for (const ev of primed.parser.feed(v.text)) { if (ev.t === "text") { markTtft(); sawContent = true; } emitEvent(sink, ev); }
        }
        const fin = finalize(primed.parser);
        if (!hasFinalOutput(fin)) {
          logEmptyStream(primed.req || buildReq(resolveModel(options.model), options, true), primed.attempt || 0);
          throw mkErr("empty response");
        }
        finishSentinel("ok", "none", fin);
        sink.finish(fin);
        ctx.waitUntil(recordUsageSafe(env, true, streamTok(options, fin, estInput)));
        return;
        } catch (reErr) {
          if (st.clientGone) return;
          if (!sawContent && isReprimable(reErr) && reprimeCount < reprimeMax) {
            reprimeCount++;
            try { console.log("[zcode-diag] stream-reprime " + JSON.stringify({ n: reprimeCount, cls: classifyError(reErr) })); } catch (_) {}
            try { if (primed && primed.wrapped) await primed.wrapped.cancel(); } catch (_) {}
            await sleep(backoff(RETRY_NORMAL.base, reprimeCount));
            if (st.clientGone) return;
            beat();
            primed = freshConnecting(env, options);
            continue reprime;
          }
          throw reErr;
        }
        }
      } catch (e) {
        if (st.clientGone) return;                 // 客户主动断开：不记账、不补错误帧
        const cls = classifyError(e);
        logDiagFailure("stream_fail", e, { cls, attempt: primed && primed.attempt, kind: primed && primed.kind, model: resolveModel(options.model) }); // 客户端可见的最终失败：补诊断(仅真失败时打，热路径零影响)
        try { sink.error(e); } catch {}
        finishSentinel("error", cls, null);
        ctx.waitUntil(recordUsageSafe(env, false, null, cls));    // 早回 200 后的流内错误也记失败（成功率不虚高）；cls 供客户自查页分类
      } finally {
        if (queueAbort) queueAbort.abort();
        if (primed && primed.wrapped) await primed.wrapped.cancel();  // 中止上游（connecting 态可能还没拿到流）
        releaseGate();                              // 流结束 → 释放并发名额
        try { controller.close(); } catch {}
      }
    },
    cancel() { st.clientGone = true; finishSentinel("error", "client_abort", null); if (queueAbort) queueAbort.abort(); if (primed && primed.wrapped) primed.wrapped.cancel(); releaseGate(); }, // 客户端断开 → abort 上游 + 释放名额
  });
  // 三协议的流式都从这里出去 —— 头在响应创建时就定死，跟流内内容无关，一处加即三处都有。
  return new Response(stream, { headers: sh({ [UPSTREAM_MODEL_HEADER]: resolveModel(options.model), ...contextHeaders(env, options), ...extraHeaders }) });
}

/* ===== OpenAI Chat ===== */
async function handleChat(body, env, ctx, affinity, signal, gatePath) {
  let options = { messages: normalizeOpenAIMessages(body.messages), tools: openaiTools(body.tools), maxTokens: body.max_tokens || body.max_completion_tokens, model: body.model, thinking: clientThinkingPref(body), affinity };
  const model = body.model || "glm-5.2";
  let trimHeader = null;
  // gatePath 非空 = 过大闸判了超限。没超限的请求这行是 false，之后的一切与改动前逐字节相同。
  if (gatePath) { const t = rescueOrReject(body, env, ctx, options, gatePath); if (t.resp) return t.resp; options = t.options; trimHeader = t.header; }
  if (body.stream) {
    const includeUsage = !!(body.stream_options && body.stream_options.include_usage);
    const estInput = estimateReqTokens(options);   // 见下方"为什么不是 estimateMessagesTokens"；裁过的话这里已是裁后的量
    return await startStreaming(env, options, ctx, (write) => chatSink(write, model, includeUsage, estInput), estInput, trimHeader);
  }
  const r = await runObserved(env, ctx, options, signal);
  logTokenEstimateDrift(resolveModel(options.model), options, r.inputTokens);   // 非流式拿得到上游真实 input_tokens，顺手校准估算器
  ctx.waitUntil(recordUsageSafe(env, true, tokRec(resolveModel(options.model), r.inputTokens, r.outputTokens, r.cachedTokens)));
  return json(chatResp(r, model), 200, { [UPSTREAM_MODEL_HEADER]: resolveModel(options.model), ...contextHeaders(env, options), ...trimHeader });
}
/* ===== 工具定义消毒（治上游 8007 "'str object' has no attribute 'items'"）=====
   部分客户端/MCP 桥把工具的 JSON Schema 发成【字符串】，glm 上游模板对 parameters 做 .items() 遍历，
   遇字符串直接炸 400（AiError 8007，2026-07-04 哪吒 811558 真实客诉）。进上游前统一整形：
   字符串 → 尝试 JSON.parse；仍不是纯对象 → 兜底空 schema；没名字的工具丢弃。三协议共用。 */
function sanitizeToolParams(p) {
  if (typeof p === "string") { try { p = JSON.parse(p); } catch (_) { p = null; } }
  return (p && typeof p === "object" && !Array.isArray(p)) ? p : { type: "object", properties: {} };
}
function sanitizeTools(flat) {
  if (!Array.isArray(flat) || !flat.length) return undefined;
  let coerced = 0, dropped = 0;
  const out = [];
  for (const t of flat) {
    if (!t || typeof t.name !== "string" || !t.name) { dropped++; continue; }
    const raw = t.parameters;
    const params = neutralizeImageDataMarkers(sanitizeToolParams(raw));
    if (raw != null && params !== raw) coerced++;
    out.push({ type: "function", function: { name: t.name, description: typeof t.description === "string" ? neutralizeImageDataMarkers(t.description) : "", parameters: params } });
  }
  if (coerced || dropped) { try { console.log("[zcode-diag] tools-sanitized " + JSON.stringify({ coerced, dropped, total: flat.length })); } catch (_) {} } // 只记数量，不记 schema 内容
  return out.length ? out : undefined;
}
function openaiTools(t) { if (!Array.isArray(t) || !t.length) return undefined; return sanitizeTools(t.filter(x => x && x.type === "function" && x.function).map(x => ({ name: x.function.name, description: x.function.description, parameters: x.function.parameters }))); }
function normalizeOpenAIContent(content) {
  if (typeof content === "string") return neutralizeImageDataMarkers(content);
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content.map((item) => {
    if (typeof item === "string") return neutralizeImageDataMarkers(item);
    if (!item || typeof item !== "object") return "";
    for (const key of ["text", "input_text", "output_text"]) {
      if (typeof item[key] === "string") return neutralizeImageDataMarkers(item[key]);
    }
    if (typeof item.content === "string") return neutralizeImageDataMarkers(item.content);
    if (String(item.type || "").toLowerCase().includes("image") || item.image_url) return "[图片已省略：本服务为纯文本模型，暂不支持图片]";
    return "";
  }).filter(Boolean).join("\n");
}
function normalizeOpenAIMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message) => {
    if (!message || typeof message !== "object" || typeof message.content === "string") return message;
    return { ...message, content: normalizeOpenAIContent(message.content) };
  });
}
function chatResp(r, model) {
  const message = { role: "assistant", content: r.text || "" };
  if (r.reasoning) message.reasoning_content = r.reasoning;
  if (r.toolCalls.length) { message.tool_calls = r.toolCalls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })); if (!r.text) message.content = null; }
  const usage = { prompt_tokens: r.inputTokens, completion_tokens: r.outputTokens, total_tokens: r.inputTokens + r.outputTokens };
  if (r.cachedTokens != null) usage.prompt_tokens_details = { cached_tokens: r.cachedTokens }; // 透传缓存命中
  return { id: "chatcmpl-" + rid(), object: "chat.completion", created: nowSec(), model, choices: [{ index: 0, message, finish_reason: r.toolCalls.length ? "tool_calls" : "stop", logprobs: null }], usage };
}
// chat 流式 sink：role → 逐 token content → (工具) → finish → (include_usage) → [DONE]。
function chatSink(write, model, includeUsage, estInput) {
  const base = { id: "chatcmpl-" + rid(), object: "chat.completion.chunk", created: nowSec(), model };
  const argChunks = (s) => {
    const out = [];
    const text = String(s || "");
    for (let i = 0; i < text.length; i += 512) out.push(text.slice(i, i + 512));
    return out.length ? out : [""];
  };
  return {
    open() { write(ck(base, { role: "assistant" }, null)); },
    reasoning(t) { write(ck(base, { reasoning_content: t }, null)); }, // 推理走独立字段，不进 content
    text(t) { write(ck(base, { content: t }, null)); },
    heartbeat() { write(ck(base, {}, null)); }, // 真 data 帧：空 delta 保活，不代表真实内容
    keepalive() { write(ck(base, { reasoning_content: " " }, null)); }, // 出字前保活：极小 reasoning 增量，喂活 ai-sdk 空闲计时器（PREFILL_KEEPALIVE 开时用，走推理通路不污染正文）
    finish(r) {
      if (r.tools.length) {
        write(ck(base, { tool_calls: r.tools.map((t, i) => ({ index: i, id: t.id, type: "function", function: { name: t.name, arguments: "" } })) }, null));
        for (let i = 0; i < r.tools.length; i++) {
          for (const part of argChunks(r.tools[i].arguments)) write(ck(base, { tool_calls: [{ index: i, function: { arguments: part } }] }, null));
        }
      }
      write(ck(base, {}, r.tools.length ? "tool_calls" : "stop"));
      if (includeUsage) { const u = usageOut(r, r.text, estInput); const usage = { prompt_tokens: u.input, completion_tokens: u.output, total_tokens: u.input + u.output }; if (u.cached != null) usage.prompt_tokens_details = { cached_tokens: u.cached }; write("data: " + JSON.stringify({ ...base, choices: [], usage }) + "\n\n"); }
      write("data: [DONE]\n\n");
    },
    error(e) { const f = friendlyError(e); write("data: " + JSON.stringify({ error: { message: f.message, type: f.type } }) + "\n\n"); },
  };
}
function ck(base, delta, fin) { return "data: " + JSON.stringify({ ...base, choices: [{ index: 0, delta, logprobs: null, finish_reason: fin }] }) + "\n\n"; }

/* ===== Claude Code ===== */
async function handleClaude(body, env, ctx, affinity, signal, gatePath) {
  const messages = claudeToOpenAI(body); const tools = claudeTools(body.tools);
  let options = { messages, tools, maxTokens: body.max_tokens, model: body.model, thinking: clientThinkingPref(body), affinity };
  const model = body.model || "glm-5.2";
  let trimHeader = null;
  // gatePath 非空 = 过大闸判了超限。没超限的请求这行是 false，之后的一切与改动前逐字节相同。
  if (gatePath) { const t = rescueOrReject(body, env, ctx, options, gatePath); if (t.resp) return t.resp; options = t.options; trimHeader = t.header; }
  if (body.stream) { const estInput = estimateReqTokens(options); return await startStreaming(env, options, ctx, (write) => claudeSink(write, model, estInput), estInput, trimHeader); }   // 见 estimateMessagesTokens 上方注释
  const r = await runObserved(env, ctx, options, signal);
  logTokenEstimateDrift(resolveModel(options.model), options, r.inputTokens);   // 非流式拿得到上游真实 input_tokens，顺手校准估算器
  ctx.waitUntil(recordUsageSafe(env, true, tokRec(resolveModel(options.model), r.inputTokens, r.outputTokens, r.cachedTokens)));
  return json(claudeMsg(r, model), 200, { [UPSTREAM_MODEL_HEADER]: resolveModel(options.model), ...contextHeaders(env, options), ...trimHeader });
}
function claudeToOpenAI(body) {
  // F10 的 Claude 协议双胞胎：messages 传非数组（畸形）→抛 BadRequest→friendlyError 回 400；
  // 否则下面 for..of 会把字符串按字符迭代成空数组 → 被 buildReq 误当空请求注入 "hi" 回驴唇不对马嘴的 200。
  if (body && body.messages != null && !Array.isArray(body.messages)) throw mkErr("BadRequest: messages 必须是数组");
  const messages = []; const system = extractText(body.system); if (system) messages.push({ role: "system", content: system });
  for (const message of body.messages || []) {
    if (typeof message.content === "string") { messages.push({ role: message.role, content: message.content }); continue; }
    if (!Array.isArray(message.content)) continue;
    if (message.role === "assistant") {
      const text = message.content.filter(i => i.type === "text").map(i => i.text).join("\n");
      const tc = message.content.filter(i => i.type === "tool_use").map(i => ({ id: i.id, type: "function", function: { name: i.name, arguments: JSON.stringify(i.input || {}) } }));
      const conv = { role: "assistant", content: text || null }; if (tc.length) conv.tool_calls = tc; messages.push(conv); continue;
    }
    let buf = [];
    for (const item of message.content) {
      if (item.type === "text") buf.push(item.text);
      if (item.type === "image") buf.push("[图片已省略：本服务为纯文本模型，暂不支持图片]"); // F11 的 Claude 协议双胞胎：图片块占位而非丢弃，避免整条消息被剥空
      if (item.type === "tool_result") { if (buf.length) { messages.push({ role: "user", content: buf.join("\n") }); buf = []; } messages.push({ role: "tool", tool_call_id: item.tool_use_id, content: extractText(item.content) }); }
    }
    if (buf.length) messages.push({ role: "user", content: buf.join("\n") });
  }
  return messages;
}
/* Claude 协议里【客户端函数工具】没有 type 字段（或显式写 type:"custom"）；带版本号 type 的是【服务端工具】
   —— web_search_20250305 / bash_20250124 / text_editor_* / computer_* / code_execution_* 这类，
   本该由模型提供方在自己服务端跑，客户端只管声明。我们上游是 CF 托管的 glm-5.2，它没有这些能力
   （2026-07-31 实测钉死，见 docs/40）。
   以前这里不过滤：服务端工具是有名字的，sanitizeTools 只丢没名字的，于是它被整形成"参数为空的普通函数工具"
   透给上游 → 模型回一个 {"type":"tool_use","name":"web_search","input":{}} → 客户端没法执行，卡住或报错。
   OpenAI 路径（openaiTools）和 Responses 路径（responsesTools）本来就按 type 过滤，只有这条漏了。
   丢掉之后模型压根拿不到这个工具，会老实说"我无法联网"——对客户比"假装能搜然后卡死"诚实得多。 */
function claudeTools(t) {
  if (!Array.isArray(t) || !t.length) return undefined;
  // 只按 type 挑：畸形条目（null/非对象）照旧原样交给 sanitizeTools 丢弃并计数，
  // 免得这行日志把"畸形"也算成"服务端工具"，回头查日志被自己误导。
  const kept = t.filter(x => !x || x.type == null || x.type === "custom");
  if (kept.length !== t.length) { try { console.log("[zcode-diag] claude-server-tools-dropped " + JSON.stringify({ dropped: t.length - kept.length, total: t.length })); } catch (_) {} } // 只记数量，不记工具名/schema
  return sanitizeTools(kept.map(x => x && { name: x.name, description: x.description, parameters: x.input_schema }));
}
function claudeMsg(r, model) {
  const content = [];
  if (r.reasoning) content.push({ type: "thinking", thinking: r.reasoning });
  if (r.text) content.push({ type: "text", text: r.text });
  for (const c of r.toolCalls) content.push({ type: "tool_use", id: c.id, name: c.name, input: parseArgs(c.arguments) });
  const usage = { input_tokens: r.inputTokens, output_tokens: r.outputTokens };
  if (r.cachedTokens != null) usage.cache_read_input_tokens = r.cachedTokens; // Anthropic 缓存读字段
  return { id: "msg_" + rid(), type: "message", role: "assistant", model, content, stop_reason: r.toolCalls.length ? "tool_use" : "end_turn", stop_sequence: null, usage };
}
// Claude 流式 sink：message_start →（思考块 thinking_delta）→ text 块 → tool_use 块 → message_delta → message_stop。
// 推理与正文用不同 content block（thinking / text），按出现顺序惰性开块、切换时收旧开新；正文绝不混入推理。
// 注意：message_start.usage.input_tokens 用 estimateTokens 估算（拿不到上游真实数，但比报 0 强）；output_tokens 在 message_delta 给出。
function claudeSink(write, model, estInput) {
  const msg = { id: "msg_" + rid(), type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: estInput || 0, output_tokens: 0 } };
  let idx = 0, cur = null; // cur: null | "thinking" | "text"
  const closeCur = () => { if (cur !== null) { write(sse("content_block_stop", { type: "content_block_stop", index: idx })); idx++; cur = null; } };
  const openBlock = (type) => {
    const cb = type === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" };
    write(sse("content_block_start", { type: "content_block_start", index: idx, content_block: cb }));
    cur = type;
  };
  return {
    open() { write(sse("message_start", { type: "message_start", message: msg })); },
    reasoning(t) {
      if (cur !== "thinking") { closeCur(); openBlock("thinking"); }
      write(sse("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "thinking_delta", thinking: t } }));
    },
    text(t) {
      if (cur !== "text") { closeCur(); openBlock("text"); }
      write(sse("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: t } }));
    },
    heartbeat() { write(sse("ping", { type: "ping" })); }, // Anthropic 官方心跳事件
    finish(r) {
      closeCur();
      for (const tc of r.tools) {
        write(sse("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "tool_use", id: tc.id, name: tc.name, input: {} } }));
        write(sse("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: tc.arguments || "{}" } }));
        write(sse("content_block_stop", { type: "content_block_stop", index: idx }));
        idx++;
      }
      const u = usageOut(r, r.text, estInput);
      const mu = { output_tokens: u.output };
      if (u.cached != null) mu.cache_read_input_tokens = u.cached; // 透传缓存命中
      write(sse("message_delta", { type: "message_delta", delta: { stop_reason: r.tools.length ? "tool_use" : "end_turn", stop_sequence: null }, usage: mu }));
      write(sse("message_stop", { type: "message_stop" }));
    },
    error(e) {
      closeCur();
      const f = friendlyError(e);
      write(sse("error", { type: "error", error: { type: sseErrType(f.type), message: f.message } }));
    },
  };
}

/* ===== Codex Responses ===== */
async function handleResponses(body, env, ctx, affinity, signal, gatePath) {
  const messages = responsesToOpenAI(body); const tools = responsesTools(body.tools);
  let options = { messages, tools, maxTokens: body.max_output_tokens, model: body.model, thinking: clientThinkingPref(body), affinity };
  const model = body.model || "glm-5.2";
  let trimHeader = null;
  // gatePath 非空 = 过大闸判了超限。没超限的请求这行是 false，之后的一切与改动前逐字节相同。
  if (gatePath) { const t = rescueOrReject(body, env, ctx, options, gatePath); if (t.resp) return t.resp; options = t.options; trimHeader = t.header; }
  if (body.stream) { const estInput = estimateReqTokens(options); return await startStreaming(env, options, ctx, (write) => responsesSink(write, model, estInput), estInput, trimHeader); }   // 见 estimateMessagesTokens 上方注释
  const r = await runObserved(env, ctx, options, signal);
  logTokenEstimateDrift(resolveModel(options.model), options, r.inputTokens);   // 非流式拿得到上游真实 input_tokens，顺手校准估算器
  ctx.waitUntil(recordUsageSafe(env, true, tokRec(resolveModel(options.model), r.inputTokens, r.outputTokens, r.cachedTokens)));
  return json(responsesResult(r, model), 200, { [UPSTREAM_MODEL_HEADER]: resolveModel(options.model), ...contextHeaders(env, options), ...trimHeader });
}
function responsesToOpenAI(body) {
  const messages = []; if (body.instructions) messages.push({ role: "system", content: extractText(body.instructions) });
  if (typeof body.input === "string") { messages.push({ role: "user", content: body.input }); return messages; }
  for (const item of body.input || []) {
    if (item.type === "message") messages.push({ role: item.role === "developer" ? "system" : item.role, content: extractText(item.content) });
    if (item.type === "function_call") messages.push({ role: "assistant", content: null, tool_calls: [{ id: item.call_id || item.id, type: "function", function: { name: item.name, arguments: item.arguments || "{}" } }] });
    if (item.type === "function_call_output") messages.push({ role: "tool", tool_call_id: item.call_id, content: extractText(item.output) });
  }
  return messages;
}
function responsesTools(t) { if (!Array.isArray(t) || !t.length) return undefined; return sanitizeTools(t.filter(x => x && x.type === "function").map(x => ({ name: x.name, description: x.description, parameters: x.parameters }))); }
function responsesResult(r, model) {
  const output = [];
  if (r.reasoning) output.push({ id: "rs_" + rid(), type: "reasoning", summary: [{ type: "summary_text", text: r.reasoning }] });
  if (r.text) output.push({ id: "msg_" + rid(), type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: r.text, annotations: [] }] });
  for (const c of r.toolCalls) output.push({ id: "fc_" + rid(), type: "function_call", status: "completed", call_id: c.id, name: c.name, arguments: c.arguments });
  const usage = { input_tokens: r.inputTokens, output_tokens: r.outputTokens, total_tokens: r.inputTokens + r.outputTokens };
  if (r.cachedTokens != null) usage.input_tokens_details = { cached_tokens: r.cachedTokens }; // Responses 缓存字段
  return { id: "resp_" + rid(), object: "response", created_at: nowSec(), status: "completed", model, output, error: null, incomplete_details: null, usage };
}
// Responses 流式 sink：response.created → message item 逐 token → function_call item → response.completed。
function responsesSink(write, model, estInput) {
  let seq = 0;
  const add = (type, data) => write(sse(type, { type, sequence_number: seq++, ...data }));
  const base = { id: "resp_" + rid(), object: "response", created_at: nowSec(), status: "completed", model, output: [], error: null, incomplete_details: null, usage: { input_tokens: estInput || 0, output_tokens: 0, total_tokens: estInput || 0 } };
  const output = [];
  let oi = 0, msgId = null, msgOpen = false, msgText = "";
  let rsId = null, rsOpen = false, rsClosed = false, rsText = ""; // 推理项（reasoning，独立于正文 message 项）
  const closeReasoning = () => {
    if (rsOpen && !rsClosed) {
      add("response.reasoning_summary_text.done", { item_id: rsId, output_index: oi, summary_index: 0, text: rsText });
      add("response.reasoning_summary_part.done", { item_id: rsId, output_index: oi, summary_index: 0, part: { type: "summary_text", text: rsText } });
      const item = { id: rsId, type: "reasoning", summary: [{ type: "summary_text", text: rsText }] };
      add("response.output_item.done", { output_index: oi, item });
      output.push(item); oi++; rsClosed = true;
    }
  };
  return {
    open() { add("response.created", { response: { ...base, status: "in_progress", output: [] } }); },
    reasoning(t) {
      if (!rsOpen) {
        rsId = "rs_" + rid(); rsOpen = true;
        add("response.output_item.added", { output_index: oi, item: { id: rsId, type: "reasoning", summary: [] } });
        add("response.reasoning_summary_part.added", { item_id: rsId, output_index: oi, summary_index: 0, part: { type: "summary_text", text: "" } });
      }
      rsText += t;
      add("response.reasoning_summary_text.delta", { item_id: rsId, output_index: oi, summary_index: 0, delta: t });
    },
    text(t) {
      if (!msgOpen) {
        closeReasoning(); // 推理项必须在正文 message 项之前收尾
        msgId = "msg_" + rid(); msgOpen = true;
        add("response.output_item.added", { output_index: oi, item: { id: msgId, type: "message", status: "in_progress", role: "assistant", content: [] } });
        add("response.content_part.added", { item_id: msgId, output_index: oi, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      }
      msgText += t;
      add("response.output_text.delta", { item_id: msgId, output_index: oi, content_index: 0, delta: t });
    },
    heartbeat() { write(": ping\n\n"); },
    finish(r) {
      closeReasoning(); // 只有推理、没有正文时也要把推理项收尾
      if (msgOpen) {
        add("response.output_text.done", { item_id: msgId, output_index: oi, content_index: 0, text: msgText });
        const part = { type: "output_text", text: msgText, annotations: [] };
        add("response.content_part.done", { item_id: msgId, output_index: oi, content_index: 0, part });
        const item = { id: msgId, type: "message", status: "completed", role: "assistant", content: [part] };
        add("response.output_item.done", { output_index: oi, item });
        output.push(item); oi++;
      }
      for (const tc of r.tools) {
        const fcId = "fc_" + rid();
        add("response.output_item.added", { output_index: oi, item: { id: fcId, type: "function_call", status: "in_progress", call_id: tc.id, name: tc.name, arguments: "" } });
        add("response.function_call_arguments.delta", { item_id: fcId, output_index: oi, delta: tc.arguments });
        add("response.function_call_arguments.done", { item_id: fcId, output_index: oi, arguments: tc.arguments });
        const item = { id: fcId, type: "function_call", status: "completed", call_id: tc.id, name: tc.name, arguments: tc.arguments };
        add("response.output_item.done", { output_index: oi, item });
        output.push(item); oi++;
      }
      const u = usageOut(r, msgText, estInput);
      const usage = { input_tokens: u.input, output_tokens: u.output, total_tokens: u.input + u.output };
      if (u.cached != null) usage.input_tokens_details = { cached_tokens: u.cached }; // 透传缓存命中
      add("response.completed", { response: { ...base, output, usage } });
    },
    error(e) { const f = friendlyError(e); add("response.failed", { response: { ...base, status: "failed", error: { code: f.type, message: f.message } } }); },
  };
}

/* ===== Sentinel L0 / relay health ===== */
function sentinelCustomer(env) { return String((env && env.SENTINEL_CUSTOMER) || "unknown").slice(0, 96); }
function isolateId() { if (!ISOLATE_ID) ISOLATE_ID = crypto.randomUUID(); return ISOLATE_ID; }
function classifyError(e) {
  const low = String((e && e.message) || e || "").toLowerCase();
  let cls = "unknown";
  if (low.includes("circuit open")) cls = "circuit_open";
  else if (low.includes("gate full") || low.includes("queue full") || low.includes("queue timeout")) cls = "gate_full";
  else if (low.includes("3021") || low.includes("per min rate") || low.includes("per-min rate") || (low.includes("rate limit") && low.includes("inference"))) cls = "rate_limited_3021"; // 每分钟推理限速：单列一类，供"该号是否该开 GLOBAL_RPM_LIMIT"判断（重试仍走容量通道，见 isCapacityError）
  else if (low.includes("3040") || low.includes("capacity") || low.includes("429") || low.includes("overload") || low.includes("internal server error")) cls = "capacity_3040"; // 任意 glm "Internal server error" 均归容量类观测
  else if (low.includes("5021") || low.includes("context") || low.includes("too long") || low.includes("longer than")) cls = "context_5021";
  else if (low.includes("prefill timeout") || low.includes("first token timeout")) cls = "prefill_timeout";
  else if (low.includes("3046") || low.includes("request timeout")) cls = "upstream_stalled"; // 上游请求超时（真实码 3046）；重试走容量通道，观测归 stalled
  else if (low.includes("upstream stalled")) cls = "upstream_stalled";
  else if (low.includes("connect") || low.includes("connection")) cls = "connect_stall";
  else if (low.includes("auth") || low.includes("unauthorized") || low.includes("forbidden")) cls = "auth";
  return SENTINEL_ERROR_CLASSES.has(cls) ? cls : "unknown";
}
function sentinelPoint(env, options, isStream, startedAt, status, errorClass, ttftMs, usage) {
  const u = usage || {};
  const customer = sentinelCustomer(env);
  const cached = typeof u.cached === "number" ? (u.cached > 0 ? "1" : "0") : "unknown";
  return {
    indexes: [customer],
    blobs: [
      customer,
      status === "ok" ? "ok" : "error",
      SENTINEL_ERROR_CLASSES.has(errorClass) ? errorClass : "unknown",
      resolveModel(options && options.model),
      isStream ? "1" : "0",
      cached,
      u.isEstimated ? "1" : "0",
      isolateId(),
    ],
    doubles: [
      typeof ttftMs === "number" ? ttftMs : -1,
      Math.max(0, Date.now() - startedAt),
      Number(u.input || 0),
      Number(u.output || 0),
    ],
  };
}
function writeSentinel(env, ctx, point) {
  try {
    if (env && env.SENTINEL_AE && typeof env.SENTINEL_AE.writeDataPoint === "function") env.SENTINEL_AE.writeDataPoint(point);
  } catch (_) {}
  try {
    if (ctx && env && env.SENTINEL_ROLLUP) ctx.waitUntil(writeSentinelRollup(env, point));
  } catch (_) {}
}
async function writeSentinelRollup(env, point) {
  const id = env.SENTINEL_ROLLUP.idFromName("relay-rollup");
  const stub = env.SENTINEL_ROLLUP.get(id);
  await stub.fetch("https://sentinel-rollup/event", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(point) });
}
async function handleSentinelHealth(env) {
  if (!env || !env.SENTINEL_ROLLUP) return json({ ok: true, configured: false, schemaVersion: SENTINEL_SCHEMA_VERSION, reason: "missing_rollup_do" });
  const id = env.SENTINEL_ROLLUP.idFromName("relay-rollup");
  const stub = env.SENTINEL_ROLLUP.get(id);
  const r = await stub.fetch("https://sentinel-rollup/health");
  const data = await r.json();
  data.customer = sentinelCustomer(env);
  // 建议值兜底：DO 还没升上来的号（DO 是独立部署节奏）也得看得到该开多少，不能只有"该开闸"三个字
  if (!(Number(data.suggestGlobalRpmValue) > 0)) data.suggestGlobalRpmValue = suggestedGlobalRpm(env);
  data.globalRpmLimit = globalRpmLimit(env);        // 现在实际开着多少（0 = 闸关），跟建议值摆一起才看得出差多远
  return json(data, r.status);
}
async function querySentinelWindow(account, token, dataset, fromExpr, toExpr) {
  const where = "timestamp >= " + fromExpr + " AND timestamp < " + toExpr;
  const summarySql = `
SELECT
  SUM(_sample_interval) AS volume,
  SUM(if(blob2 = 'ok', _sample_interval, 0)) AS okWeighted,
  SUM(if(blob2 != 'ok', _sample_interval, 0)) AS errorTotal,
  SUM(if(blob7 = '1', _sample_interval, 0)) AS estimatedWeighted
FROM ${dataset}
WHERE ${where}
FORMAT JSON`;
  const ttftSql = `
SELECT
  quantileExactWeighted(0.50)(double1, _sample_interval) AS ttftP50,
  quantileExactWeighted(0.95)(double1, _sample_interval) AS ttftP95,
  SUM(_sample_interval) AS ttftVolume
FROM ${dataset}
WHERE ${where} AND double1 >= 0
FORMAT JSON`;
  const classSql = `
SELECT blob3 AS errorClass, SUM(_sample_interval) AS estCount
FROM ${dataset}
WHERE ${where} AND blob2 != 'ok'
GROUP BY blob3
ORDER BY estCount DESC
FORMAT JSON`;
  const summaryRows = await aeSql(account, token, summarySql);
  const ttftRows = await aeSql(account, token, ttftSql);
  const classRows = await aeSql(account, token, classSql);
  const s = summaryRows[0] || {};
  const t = ttftRows[0] || {};
  const volume = Number(s.volume || 0);
  const byClass = {};
  for (const r of classRows) byClass[r.errorClass || "unknown"] = Number(r.estCount || 0);
  return {
    successRate: ratioOrNull(s.okWeighted, volume),
    errCount: { total: Number(s.errorTotal || 0), byClass },
    ttftP50: Number(t.ttftVolume || 0) > 0 ? numberOrNull(t.ttftP50) : null,
    ttftP95: Number(t.ttftVolume || 0) > 0 ? numberOrNull(t.ttftP95) : null,
    volume,
    estimatedRatio: ratioOrNull(s.estimatedWeighted, volume),
  };
}
async function aeSql(account, token, sql) {
  const r = await fetch("https://api.cloudflare.com/client/v4/accounts/" + account + "/analytics_engine/sql", {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "text/plain" },
    body: sql,
  });
  const text = await r.text();
  if (!r.ok) throw new Error("AE SQL failed: " + r.status + " " + text.slice(0, 120));
  return parseAeRows(text);
}
function parseAeRows(text) {
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j)) return j;
    if (Array.isArray(j.data)) return j.data;
    if (j && j.meta && Array.isArray(j.data)) return j.data;
  } catch (_) {}
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch (_) { return {}; }
  }).filter((x) => Object.keys(x).length);
}
function numberOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function ratioOrNull(numerator, denominator) {
  const d = Number(denominator);
  if (!Number.isFinite(d) || d <= 0) return null;
  const n = Number(numerator || 0);
  return Number.isFinite(n) ? n / d : null;
}

/* ===== 通用 ===== */
function hasNormalizedOutput(r) {
  return !!(r && ((typeof r.text === "string" && r.text !== "") || (typeof r.reasoning === "string" && r.reasoning !== "") || (Array.isArray(r.toolCalls) && r.toolCalls.length > 0)));
}
function hasFinalOutput(r) {
  return !!(r && ((typeof r.text === "string" && r.text !== "") || (typeof r.reasoning === "string" && r.reasoning !== "") || (Array.isArray(r.tools) && r.tools.length > 0)));
}
function normalize(result) {
  const message = (result && result.choices && result.choices[0] && result.choices[0].message) || {};
  let text = message.content || (result && result.response) || "";
  if (typeof text === "string") text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trimStart();
  // 推理走独立字段（与 content 分离）；保留 <think> 剥离仅作兜底，正常情况下 content 已干净。
  let reasoning = message.reasoning_content || message.reasoning || (result && result.reasoning_content) || "";
  if (typeof reasoning !== "string") reasoning = "";
  const raw = message.tool_calls || (result && result.tool_calls) || [];
  const toolCalls = raw.map(call => { const fn = call.function || call; return { id: call.id || ("call_" + rid()), name: fn.name, arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {}) }; }).filter(t => typeof t.name === "string" && t.name.trim() !== ""); // 同 tools()：丢弃空名工具调用，别让无名 tool_call 打崩客户端
  const usage = (result && result.usage) || {};
  const cd = usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens;
  return { text, reasoning, toolCalls, inputTokens: usage.prompt_tokens || usage.input_tokens || 0, outputTokens: usage.completion_tokens || usage.output_tokens || 0, cachedTokens: (typeof cd === "number" ? cd : null) };
}
function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content.map(i => (typeof i === "string" ? i : (i.text || i.input_text || i.output_text || i.content || ""))).filter(Boolean).join("\n");
}
function parseArgs(v) { if (typeof v !== "string") return v || {}; try { return JSON.parse(v); } catch { return { value: v }; } }
// token 粗估：CJK 表意/假名/谚文按 CJK_TOKEN_WEIGHT 折算，其余字符约 1/4 token。比纯 len/4 对中文准很多。
function estimateTokens(s) {
  let cjk = 0, other = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF) || (c >= 0x3040 && c <= 0x30FF) || (c >= 0xAC00 && c <= 0xD7A3) || (c >= 0xF900 && c <= 0xFAFF) || (c >= 0x20000 && c <= 0x2FA1F)) cjk++;
    else other++;
  }
  return Math.ceil(cjk * CJK_TOKEN_WEIGHT + other / 4);
}
/* 估算一组（已转成 OpenAI 格式的）消息的输入 token —— 【只算正文】：不算 tool_calls、不算 tools 定义。
   2026-08-01 起【已退出热路径】：三条流式路径原本拿它当 estInput，而 estInput 会经 usageOut 在
   【上游没回 usage 时】当回退值报给客户端、并进 recordUsage 记账 —— 是客户能看见的账单口径。
   Claude Code 那种"3 万 token 工具定义 + 小正文"的请求，它报出的 input_tokens 只有个位数
   （实测 32875 报成 2），agent 循环那种满是 tool_calls 的也少报八成。现已统一改成 estimateReqTokens(options)。
   函数本身留着不删：它是两条防倒退用例的"改前"参照物 —— test/stream-est-input.test.mjs（钉热路径）
   与 test/context-headers.test.mjs（钉三个观测头），都断言"现在的数必须远大于它"。
   谁要是把热路径换回来，那两条测立刻红。 */
function estimateMessagesTokens(messages) {
  let n = 0;
  for (const m of messages || []) {
    if (typeof m.content === "string") n += estimateTokens(m.content);
    else if (Array.isArray(m.content)) for (const c of m.content) { if (typeof c === "string") n += estimateTokens(c); else if (c && typeof c.text === "string") n += estimateTokens(c.text); }
  }
  return n;
}
async function sha256(s) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join(""); }
// 定长 token 的常量时间比较，抗时序侧信道（管理密码 / 密钥哈希）。
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0;
}
function mintKey() { const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"; const a = new Uint32Array(48); crypto.getRandomValues(a); let s = "sk-"; for (let i = 0; i < 48; i++) s += c[a[i] % 62]; return s; }
function toInt(v, dflt) { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : dflt; }
function rid() { return crypto.randomUUID().replaceAll("-", ""); }
function nowSec() { return Math.floor(Date.now() / 1000); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sse(event, data) { return "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n"; }
function json(data, status = 200, extra) { return Response.json(data, { status, headers: { ...cors(), ...(extra || {}) } }); }
// 错误响应：503/429 带 Retry-After，触发客户端自动退避重试。
function errResp(f) {
  const headers = cors();
  if (f.status === 503 || f.status === 429) headers["Retry-After"] = cbOpen() ? "5" : "2"; // 开闸期让客户端等更久，拉开重试
  if (f.reason) headers[DENY_REASON_HEADER] = f.reason;
  return Response.json({ error: { message: f.message, type: f.type } }, { status: f.status, headers });
}
function html(s) { return new Response(s, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...cors() } }); }
function cors() { return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, x-admin-token, anthropic-version", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Expose-Headers": [DENY_REASON_HEADER, UPSTREAM_MODEL_HEADER, CONTEXT_TOKENS_HEADER, CONTEXT_LIMIT_HEADER, CONTEXT_PCT_HEADER, CONTEXT_TRIMMED_HEADER].join(", ") }; }
function sh(extra) { return { ...cors(), ...(extra || {}), "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" }; }
/* 三个上下文观测头（来历见文件头 CONTEXT_*_HEADER 那段注释）。三协议 × 流式/非流式六种组合都要带。
   一律用 estimateReqTokens(options)：options 是三协议收敛之后、真正要发给上游的那一份，
   正文 + tool_calls + tools 定义全算上；estimateMessagesTokens 只算正文，不许拿来填这里。
   开销说明（别照抄"零开销"）：过大闸算的是 body，这里算的是 options，
   REQ_TOKENS_MEMO 是 WeakMap 按对象做 key，两者不共用 → 这里是实打实多走一遍整棵消息树，
   量级与 pickPolicy 已有的 estimateReqChars(options) 相当，可接受。 */
function contextHeaders(env, options) {
  const est = estimateReqTokens(options);
  const limit = oversizeTokenLimit(env);
  return {
    [CONTEXT_TOKENS_HEADER]: String(est),
    [CONTEXT_LIMIT_HEADER]: String(limit),
    [CONTEXT_PCT_HEADER]: String(limit > 0 ? Math.round((est * 100) / limit) : 0), // 闸关(limit=0)没有分母，回 0，别让它变成 Infinity/NaN
  };
}

/* ===== 客户自查页（Aurora 风格）===== */
const USAGE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>用量查询</title><style>
:root{--bg:#06070d;--ink:#eaf0ff;--mut:#8b93ad;--line:rgba(255,255,255,.08);--ok:#34d399;--bad:#fb7185;--g1:#7c5cff;--g2:#22d3ee;--g3:#f97316;--glass:rgba(255,255,255,.04)}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--ink);font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.bg{position:fixed;inset:0;z-index:-1;background:radial-gradient(40% 40% at 15% 20%,var(--g1),transparent 60%),radial-gradient(35% 35% at 85% 15%,var(--g2),transparent 60%),radial-gradient(45% 45% at 75% 90%,var(--g3),transparent 60%);opacity:.5}
.card{width:100%;max-width:480px;background:var(--glass);border:1px solid var(--line);border-radius:22px;padding:28px;backdrop-filter:blur(22px) saturate(160%);-webkit-backdrop-filter:blur(22px) saturate(160%);box-shadow:0 30px 80px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.06)}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:22px}
.logo{width:42px;height:42px;border-radius:12px;background:linear-gradient(110deg,var(--g2),var(--g1));display:flex;align-items:center;justify-content:center;font-weight:800;color:#0b0b12;box-shadow:0 8px 24px rgba(124,92,255,.35)}
.bt{font-size:17px;font-weight:700}.bs{font-size:12px;color:var(--mut);margin-top:2px}
/* 域名：45 个号这页长得一模一样，客户手上可能有不止一个，不写域名没法辨认自己在看哪个 */
.host{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--mut);margin-top:5px;letter-spacing:.02em;word-break:break-all}
.form{display:flex;gap:10px}
#key{flex:1;height:46px;border-radius:12px;border:1px solid var(--line);background:rgba(255,255,255,.04);color:var(--ink);padding:0 14px;font-size:14px;font-family:ui-monospace,monospace;outline:none}
#key:focus{border-color:rgba(124,92,255,.6);box-shadow:0 0 0 4px rgba(124,92,255,.15)}
#go{height:46px;padding:0 22px;border:0;border-radius:12px;background:linear-gradient(110deg,var(--g2),var(--g1));color:#0b0b12;font-weight:700;cursor:pointer;box-shadow:0 8px 22px rgba(124,92,255,.3)}
#go:disabled{opacity:.6;cursor:default}
.err{display:none;margin-top:14px;padding:11px 14px;border-radius:12px;background:rgba(251,113,133,.1);border:1px solid rgba(251,113,133,.3);color:#fda4af;font-size:13px}
.result{margin-top:20px}
.status{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--mut);margin-bottom:14px}
.dot{width:9px;height:9px;border-radius:50%;background:var(--mut)}.dot.ok{background:var(--ok);box-shadow:0 0 8px var(--ok)}.dot.bad{background:var(--bad);box-shadow:0 0 8px var(--bad)}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.kpi{background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:16px;padding:14px}
.kl{font-size:12px;color:var(--mut)}.kv{font-size:23px;font-weight:800;margin-top:6px;font-variant-numeric:tabular-nums}.ks{font-size:11px;color:var(--mut);margin-top:3px}
.bar{height:8px;border-radius:999px;background:rgba(255,255,255,.06);overflow:hidden;margin-top:14px}.bar i{display:block;height:100%;background:linear-gradient(110deg,var(--g2),var(--g1));width:0;transition:width .6s}
.dot.busy{background:var(--g3);box-shadow:0 0 8px var(--g3)}
.notice{display:none;margin-top:14px;padding:11px 14px;border-radius:12px;background:rgba(249,115,22,.1);border:1px solid rgba(249,115,22,.3);color:#fdba74;font-size:12px;line-height:1.6}
.box{grid-column:1/-1;background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:16px;padding:14px}
.tokv{font-size:26px;font-weight:800;margin-top:6px;font-variant-numeric:tabular-nums}
.tokd{font-size:11px;color:var(--mut);margin-top:5px;line-height:1.7}
.spark{display:flex;align-items:flex-end;gap:6px;height:54px;margin-top:12px}
.spark span{flex:1;border-radius:4px 4px 0 0;background:linear-gradient(0deg,rgba(34,211,238,.35),var(--g2));min-height:3px;transition:height .5s}
.spark span.z{background:rgba(255,255,255,.07)}
.sparkx{display:flex;justify-content:space-between;font-size:10px;color:var(--mut);margin-top:6px;font-variant-numeric:tabular-nums}
.fl{font-size:12px;color:var(--mut);margin-top:9px;line-height:1.7}
.fl b{color:var(--ink);font-weight:700}
.foot{font-size:11px;color:var(--mut);margin-top:12px;text-align:center}
@media(max-width:430px){.kpis{grid-template-columns:1fr}}
</style></head><body><div class="bg"></div>
<main class="card">
<div class="brand"><div class="logo">A</div><div><div class="bt">API 用量查询</div><div class="bs">输入你的密钥，查看有效期与额度</div><div id="host" class="host"></div></div></div>
<div class="form"><input id="key" type="password" placeholder="sk-..." autocomplete="off" spellcheck="false"/><button id="go">查询</button></div>
<div id="err" class="err"></div>
<div id="notice" class="notice"></div>
<div id="result" class="result" style="display:none">
<div class="status"><span id="dot" class="dot"></span><span id="stext"></span></div>
<div class="kpis">
<div class="kpi"><div class="kl">有效期</div><div id="kExp" class="kv">—</div><div id="kExp2" class="ks"></div></div>
<div class="kpi"><div class="kl">剩余次数</div><div id="kLeft" class="kv">—</div><div id="kLeft2" class="ks"></div></div>
<div class="kpi"><div class="kl">成功率</div><div id="kRate" class="kv">—</div><div id="kRate2" class="ks"></div></div>
<div class="box"><div class="kl">累计用量（token）</div><div id="tokV" class="tokv">—</div><div id="tokD" class="tokd"></div></div>
<div class="box"><div class="kl">最近 7 天成功调用</div><div id="spark" class="spark"></div><div id="sparkx" class="sparkx"></div><div id="sparkn" class="tokd" style="display:none"></div></div>
<div id="fbox" class="box" style="display:none"><div class="kl">最近失败</div><div id="fl" class="fl"></div></div>
</div>
<div class="bar"><i id="barfill"></i></div>
<div id="foot" class="foot"></div>
</div>
</main>
<script>
var keyEl=document.getElementById("key"),goEl=document.getElementById("go"),errEl=document.getElementById("err"),resEl=document.getElementById("result"),notEl=document.getElementById("notice");
function setT(id,t){document.getElementById(id).textContent=t;}
function fmtD(e){if(!e)return "永久";var d=new Date(e*1000);return d.getFullYear()+"-"+("0"+(d.getMonth()+1)).slice(-2)+"-"+("0"+d.getDate()).slice(-2);}
function fmtDT(e){if(!e)return "";var d=new Date(e*1000);return fmtD(e)+" "+("0"+d.getHours()).slice(-2)+":"+("0"+d.getMinutes()).slice(-2);}
/* 大数字说人话：一万以下给千分位，一万以上给"万/亿"——客户看 12,400,000 要数零，看"1240 万"一眼就懂 */
function fmtN(n){n=n||0;if(n<10000)return String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g,",");if(n<100000000)return (Math.round(n/1000)/10)+" 万";return (Math.round(n/1000000)/100)+" 亿";}
function fmtAgo(sec){if(!sec)return "";var s=Math.max(0,Math.floor(Date.now()/1000)-sec);if(s<60)return "刚刚";if(s<3600)return Math.floor(s/60)+" 分钟前";if(s<86400)return Math.floor(s/3600)+" 小时前";return Math.floor(s/86400)+" 天前";}
function xspan(t){var e=document.createElement("span");e.textContent=t;return e;}
/* 状态行：有实测就摆实测，没实测就只说"运行中"。绝不在没验过的时候写"服务正常"——
   那句话客户是当承诺看的，我们没验过就不能说。 */
function renderSvc(d){
var dot=document.getElementById("dot"),st=d.svc||{state:"unknown"},tail=d.label?(" · "+d.label):"";
if(!d.enabled){dot.className="dot bad";setT("stext","已停用"+tail);return;}
if(d.expired){dot.className="dot bad";setT("stext","已到期"+tail);return;}
if(st.state==="down"){dot.className="dot bad";setT("stext","服务异常，我们已收到告警"+tail);return;}
if(st.state==="busy"){dot.className="dot busy";setT("stext","服务正常 · 上游拥挤，可能偶发变慢"+tail);return;}
if(st.state==="ok"){var sec=st.latencyMs?(Math.round(st.latencyMs/100)/10+" 秒"):"";
dot.className="dot ok";setT("stext","服务正常 · "+fmtAgo(st.checkedAt)+(sec?("实测 "+sec):"自检通过")+(st.place?(" · "+st.place):"")+tail);return;}
dot.className="dot";setT("stext","服务运行中"+tail);
}
function renderTok(d){
var tk=d.tok||{},tin=0,tout=0,tc=0;
for(var m in tk){if(!Object.prototype.hasOwnProperty.call(tk,m))continue;tin+=tk[m].in||0;tout+=tk[m].out||0;tc+=tk[m].cached||0;}
var all=tin+tout;   // 缓存那部分本来就算在输入里，不能再加一遍，否则数字凭空翻倍
setT("tokV",all?("约 "+fmtN(all)):"—");
setT("tokD",all?("输入 "+fmtN(tin)+" / 输出 "+fmtN(tout)+(tc?("　·　其中命中缓存 "+fmtN(tc)+"（重复的上下文不用重算，更快）"):"")):"还没有用量记录");
}
function renderSpark(d){
var days=d.days||[],sp=document.getElementById("spark"),xs=document.getElementById("sparkx"),note=document.getElementById("sparkn"),mx=0,sum=0,i;
sp.innerHTML="";xs.innerHTML="";
for(i=0;i<days.length;i++){if(days[i].calls>mx)mx=days[i].calls;sum+=days[i].calls;}
for(i=0;i<days.length;i++){var x=days[i],s=document.createElement("span");
s.style.height=Math.max(3,mx?Math.round(x.calls/mx*100):0)+"%";
if(!x.calls)s.className="z";
// 柱子只数成功的（失败另有"最近失败"块），所以文案一律带"成功"二字，别让客户以为是全部尝试次数
s.title=x.d.slice(5)+"：成功 "+x.calls+" 次"+((x.in+x.out)?("，"+fmtN(x.in+x.out)+" token"):"");
sp.appendChild(s);}
var td=days.length?days[days.length-1]:null;
xs.appendChild(xspan(days.length?days[0].d.slice(5):""));
xs.appendChild(xspan(td?("今天成功 "+td.calls+" 次"+((td.in+td.out)?(" · "+fmtN(td.in+td.out)+" token"):"")):""));
/* 按天统计是后加的，老客户的历史调用没进这里。柱子全空、却有历史次数时必须说清楚，
   不然客户看到"7 天 0 次"和"已用 73 次"并排，只会以为我们数字算错了。 */
if(!sum&&d.usedCalls){note.style.display="";note.textContent="按天统计刚上线，只统计从现在起的调用；此前的 "+d.usedCalls+" 次已计入上面的累计用量。";}
else{note.style.display="none";note.textContent="";}
}
/* 失败只报"你能自己处理"的部分：分类 + 一句怎么办。没失败就整块不显示，不制造焦虑。 */
function renderFails(d){
var box=document.getElementById("fbox"),lines=[],i;
if(d.fail&&d.fail.lastAt){
lines.push("<b>"+d.fail.last+"</b>（"+fmtAgo(d.fail.lastAt)+"）"+(d.fail.advice?("——"+d.fail.advice):""));
var by=d.fail.by||[],seg=[];for(i=0;i<by.length;i++)seg.push(by[i].name+" "+by[i].n+" 次");
if(seg.length)lines.push("累计："+seg.join(" · "));}
/* 这段话客户会当"你们是不是给我缩水了"来读，所以必须先说清楚 20 万是模型那 26 万里留出来的余量，
   不是我们自己压的额度。别改成"单次上限 20 万"那种只报数字的写法。 */
if(d.blocked&&d.blocked.count)lines.push("<b>对话太长，有 "+d.blocked.count+" 次没发出去</b>（最近一次约 "+fmtN(d.blocked.lastTokens)+" token。模型一轮最多只装得下 "+fmtN(d.blocked.ctx)+" token，回复和工具调用都要从这一份里扣，所以发出去的部分留在 "+fmtN(d.blocked.limit)+" 以内，免得话说到一半被截断）——新开一个会话接着问就行");
if(!lines.length){box.style.display="none";return;}
box.style.display="";document.getElementById("fl").innerHTML=lines.join("<br/>");
}
function q(){var k=keyEl.value.trim();if(!k){errEl.style.display="block";errEl.textContent="请输入密钥";return;}
goEl.disabled=true;errEl.style.display="none";resEl.style.display="none";notEl.style.display="none";
fetch("/usage",{method:"POST",headers:{authorization:"Bearer "+k}}).then(function(r){return r.json();}).then(function(d){
goEl.disabled=false;
if(!d.ok){errEl.style.display="block";errEl.textContent=(d.error&&d.error.message)||"查询失败";return;}
resEl.style.display="block";
// 用宽限期里的旧密钥：这条以前接口就返回了、页面却没显示，等于让客户到失效那一刻才知道
if(d.usingOldKey){notEl.style.display="block";notEl.textContent=(d.notice||"你用的是已被替换的旧密钥")+(d.oldKeyExpiresAt?("（旧密钥 "+fmtDT(d.oldKeyExpiresAt)+" 失效）"):"");}
renderSvc(d);
if(d.expiresAt==null){setT("kExp","永久");setT("kExp2","长期有效");}
else{var days=Math.max(0,Math.ceil((d.expiresAt-Date.now()/1000)/86400));setT("kExp",d.expired?"已到期":(days+" 天"));setT("kExp2","到期 "+fmtD(d.expiresAt));}
if(d.maxCalls<0){setT("kLeft","不限");setT("kLeft2","已用 "+d.usedCalls+" 次");}
else{setT("kLeft",String(d.remaining));setT("kLeft2","已用 "+d.usedCalls+" / "+d.maxCalls);}
var tt=d.successCalls+d.failCalls;setT("kRate",tt?(Math.round(d.successCalls/tt*1000)/10+"%"):"—");setT("kRate2",tt?("成功 "+d.successCalls+" · 失败 "+d.failCalls):"暂无调用");
renderTok(d);renderSpark(d);renderFails(d);
// 三种情况分开说：有记录 / 有历史调用但这项刚上线（别冤枉客户"没配好"）/ 真的一次没调过
setT("foot",d.lastCallAt?("最近一次调用："+fmtAgo(d.lastCallAt)):(d.usedCalls?"最近一次调用时间从现在起开始记录":"还没有调用记录——如果你已经配好了，说明请求没打到这里"));
var pct=d.maxCalls<0?0:Math.min(100,Math.round(d.usedCalls/Math.max(1,d.maxCalls)*100));
document.getElementById("barfill").style.width=pct+"%";
}).catch(function(){goEl.disabled=false;errEl.style.display="block";errEl.textContent="网络错误，请重试";});}
// 域名从浏览器地址栏取，不经服务端 —— 45 份副本共用同一份模板，取地址栏天然每号都对
document.getElementById("host").textContent=(typeof location!=="undefined"&&location.host)||"";
goEl.addEventListener("click",q);keyEl.addEventListener("keydown",function(e){if(e.key==="Enter")q();});
</script></body></html>`;
