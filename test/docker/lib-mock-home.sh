#!/usr/bin/env bash
# 写一个隔离的 pi agent dir，指向容器内的 mock LLM。
#
# 抽成公共库的原因：inside-mock-tui.sh（交互看效果）与 verify-tui-visual.sh（回归断言）
# 需要**完全一致**的 provider 配置。这份配置里的 compat 字段一旦随 pi 版本变化，
# 两处各写一份就会漏改 —— 症状是「mock 有回复但 ⌀/t/s 不出现」，很难查。
#
# 用法：. "$(dirname "$0")/lib-mock-home.sh"
#       write_mock_home <dir> <port> <plugin_root>
set -euo pipefail

write_mock_home() {
	local dir="$1" port="$2" plugin_root="$3"

	# 护栏：dir 可被 env 覆盖，rm -rf 必须先规范化再白名单校验。
	# 精确字符串比较挡不住 /root/、/root/.、//、/plugin/ 这些等价写法（reviewer 实测）。
	local canon
	canon="$(realpath -m "$dir")"
	case "$canon" in
	/ | /root | /plugin | /tmp | "$(realpath -m "${HOME:-/root}")" | "$(realpath -m "$plugin_root")")
		echo "FAIL: 拒绝写/删危险路径 dir='$dir' (canon='$canon')" >&2
		return 1
		;;
	esac
	# 只允许落在 /tmp/ 下：本库唯一的用途是造一次性临时 home。
	case "$canon" in
	/tmp/?*) ;;
	*)
		echo "FAIL: mock home 必须位于 /tmp 下，实际 '$canon'" >&2
		return 1
		;;
	esac

	rm -rf "$canon"
	mkdir -p "$canon"

	cat >"$canon/settings.json" <<EOF
{
  "defaultProvider": "mock",
  "defaultModel": "flash",
  "defaultThinkingLevel": "off",
  "defaultProjectTrust": "always",
  "packages": ["$plugin_root"]
}
EOF

	cat >"$canon/models.json" <<EOF
{
  "\$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": {
    "mock": {
      "baseUrl": "http://127.0.0.1:$port/v1",
      "api": "openai-completions",
      "apiKey": "mock",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "supportsUsageInStreaming": true,
        "supportsFinishReason": true
      },
      "models": [
        {
          "id": "flash",
          "name": "Mock Flash",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 32000,
          "maxTokens": 2048,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
EOF
}

# 取一个空闲端口（随机端口：固定端口会被上一次残留进程污染，静默串台）。
free_port() {
	node -e '
const net = require("node:net");
const s = net.createServer();
s.listen(0, "127.0.0.1", () => {
  const { port } = s.address();
  s.close(() => { process.stdout.write(String(port)); });
});
'
}
