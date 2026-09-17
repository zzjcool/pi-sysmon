#!/usr/bin/env node
/**
 * 把多文件扩展打包成**单文件**版本（dist/pi-sysmon.ts）。
 *
 * 为什么需要单文件？
 *   pi 的自动发现会把 <configDir>/extensions/ 下的**每个 .ts 文件**都当作扩展加载。
 *   所以：
 *     · 多文件版必须放在子目录里（extensions/pi-sysmon/index.ts + 伴生文件）
 *     · 平铺多个 .ts 会让 pi 把 braille.ts 也当扩展，报
 *       "Extension does not export a valid factory function" 而**启动失败**
 *   单文件版没有这个约束：直接放到 extensions/pi-sysmon.ts 即可。
 *
 * 本脚本只做「拼接 + 去重 import + 重命名冲突」，不引入任何依赖。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const OUT_DIR = join(ROOT, "dist");
const OUT_FILE = join(OUT_DIR, "pi-sysmon.ts");

/** 拼接顺序很重要：被依赖的模块放前面。 */
const MODULES = [
	{ file: "metrics.ts", banner: "指标采集：读 /proc 计算 CPU/内存/网络/磁盘" },
	{ file: "braille.ts", banner: "braille 2x4 子像素折线图渲染" },
	{ file: "chart-panel.ts", banner: "带坐标轴 / 刻度 / 时间标签的图表面板" },
	{ file: "index.ts", banner: "pi 扩展主体" },
];

/** 需要重命名的符号：避免不同模块里的同名声明在拼接后冲突。 */
const RENAMES = [
	// chart-panel 与 index 都定义了 renderPanel；把 chart-panel 的那个改名
	{ in: "chart-panel.ts", from: /\brenderPanel\b/g, to: "renderChartPanel" },
];

const HEADER = `/**
 * pi-sysmon —— 在 pi 里显示 bottom 风格的 braille 折线图（CPU / 内存 / 网络）。
 *
 * ⚠️ 本文件由 scripts/bundle-single-file.mjs 自动生成，请勿直接编辑。
 *    要改代码请改 src/ 下的源文件，然后运行 \`npm run build:single\`。
 *
 * 安装（单文件形态）：
 *   把本文件复制为 <configDir>/extensions/pi-sysmon.ts
 *   即 ~/.pi/agent/extensions/pi-sysmon.ts（默认 configDir）
 *
 * 命令：
 *   /sysmon            开 / 关（默认开启，状态持久化到 <configDir>/pi-sysmon.json）
 *   /sysmon chart      图表模式（默认）
 *   /sysmon line       一行文字模式
 *   /sysmon footer     用图表替换整个底部
 *   /sysmon on|off     显式开 / 关
 *
 * 环境变量：
 *   PI_SYSMON_INTERVAL=1000      采样间隔毫秒（下限 500）
 *   PI_SYSMON_POINTS=400         历史点数（默认按终端宽度自适应）
 *   PI_SYSMON_CHART_HEIGHT=3     每张图的高度（1..6）
 *   PI_SYSMON_MODE=chart         初始模式
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os, { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
`;

/** 去掉 import 行与 `export` 关键字；`export default` 保留（扩展入口需要）。 */
function stripModuleSyntax(src) {
	let out = src;
	// 删除所有 import 声明（含跨行的 `import type {\n...\n} from "..."`）
	out = out.replace(/^import[\s\S]*?from\s+"[^"]+";[ \t]*$/gm, "");
	// export default 需要保留
	out = out.replace(/^export default\b/gm, "@@KEEP_DEFAULT@@");
	// 其余 export 前缀去掉（拼接后同处一个模块作用域）
	out = out.replace(/^export (interface|type|function|const|let|class|enum|async)\b/gm, "$1");
	// export { ... } 形式的再导出（本项目没有，防御性删除）
	out = out.replace(/^export \{[\s\S]*?\};[ \t]*$/gm, "");
	out = out.replace(/@@KEEP_DEFAULT@@/g, "export default");
	return out.trim();
}

function main() {
	const chunks = [];
	for (const mod of MODULES) {
		const path = join(SRC, mod.file);
		if (!existsSync(path)) {
			console.error(`✗ 缺少源文件: ${path}`);
			process.exit(1);
		}
		let code = stripModuleSyntax(readFileSync(path, "utf8"));
		for (const r of RENAMES) {
			if (r.in === mod.file) code = code.replace(r.from, r.to);
		}
		chunks.push(`// ══════════════════════════ ${mod.banner} ══════════════════════════\n\n${code}`);
	}

	const out = `${HEADER}\n${chunks.join("\n\n")}\n`;

	// 自检：不允许残留本地相对 import
	const localImport = /from\s+"\.\.?\//;
	if (localImport.test(out)) {
		console.error("✗ 打包结果里仍存在本地相对 import，单文件版会加载失败：");
		for (const line of out.split("\n")) if (localImport.test(line)) console.error(`    ${line}`);
		process.exit(1);
	}

	mkdirSync(OUT_DIR, { recursive: true });
	writeFileSync(OUT_FILE, out, "utf8");

	const lines = out.split("\n").length;
	const bytes = Buffer.byteLength(out, "utf8");
	console.log(`✓ 已生成 ${OUT_FILE}`);
	console.log(`  行数 ${lines} / 大小 ${(bytes / 1024).toFixed(1)} KB`);
	console.log("  本地相对 import: 0（自包含）");
}

main();
