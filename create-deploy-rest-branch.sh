#!/bin/bash
# 创建 deploy-rest 分支（模式 B：REST API 多账号）
# 用法：在仓库根目录运行 bash create-deploy-rest-branch.sh

set -e

BRANCH_NAME="deploy-rest"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

echo "当前分支：$CURRENT_BRANCH"
echo "准备创建 $BRANCH_NAME 分支（模式 B：REST API 多账号）..."

# 确保在 main/master 分支
if [ "$CURRENT_BRANCH" != "main" ] && [ "$CURRENT_BRANCH" != "master" ]; then
  echo "警告：当前不在 main/master 分支，建议先切换到主分支再运行此脚本"
  read -p "继续？(y/N) " -n 1 -r
  echo
  [[ ! $REPLY =~ ^[Yy]$ ]] && exit 1
fi

# 创建并切换到新分支
git checkout -b "$BRANCH_NAME"
echo "✓ 已创建并切换到 $BRANCH_NAME 分支"

# 备份模式 A 的 wrangler.toml
cp wrangler.toml wrangler.binding.toml.bak

# 用模式 B 配置覆盖 wrangler.toml
cat > wrangler.toml << 'TOML_EOF'
# cf-ai-gw — 模式 B：REST API（多账号 failover）
# 此分支由 create-deploy-rest-branch.sh 自动创建
# 调用路径：Worker → 公网 HTTPS → api.cloudflare.com

name = "cf-ai-gw"
main = "_worker.js"
compatibility_date = "2025-08-01"

# 注意：模式 B 不需要 [ai] binding，通过 REST API 调用，需在面板配置账号 Token

# === KV 命名空间绑定 ===
[[kv_namespaces]]
binding = "KV"
id = "YOUR_KV_NAMESPACE_ID"

# === 环境变量 ===
[vars]
ADMIN_PASSWORD = "YOUR_ADMIN_PASSWORD"
TOML_EOF

echo "✓ wrangler.toml 已切换为模式 B 配置"

# 提交变更
git add wrangler.toml
git commit -m "chore: switch to REST API mode (deploy-rest branch)

- main = _worker.js (REST API 多账号)
- 移除 [ai] binding（通过公网 HTTPS 调用）
- 保留 KV binding 和环境变量"

echo "✓ 已提交变更"

echo ""
echo "=========================================="
echo "  $BRANCH_NAME 分支创建完成！"
echo "=========================================="
echo ""
echo "下一步：推送到 GitHub"
echo "  git push origin $BRANCH_NAME"
echo ""
echo "一键部署按钮（模式 B）："
echo "  https://deploy.workers.cloudflare.com/?url=https://github.com/\$(git remote get-url origin | sed 's|.*github.com[:/]||;s|.git||')/tree/$BRANCH_NAME"
echo ""
echo "切回主分支：git checkout $CURRENT_BRANCH"
