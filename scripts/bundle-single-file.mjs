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
	// tokens.ts 必须在 blocks.ts 之前：blocks.ts 的 Tokens 块用它的 `fmtTps`。
	// （函数声明会提升，但把它放在依赖方之前更符合阅读顺序，
	//  也避免将来有人在这里加顶层 `const` 时踩到 TDZ。）
	{ file: "tokens.ts", banner: "LLM token 吞吐（TPS）估算与每秒桶计量" },
	{ file: "blocks.ts", banner: "指标块构造：历史 + 快照 → MetricBlock[]" },
	{ file: "index.ts", banner: "pi 扩展主体" },
];

/**
 * 需要重命名的符号：避免不同模块里的同名声明在拼接后冲突。
 *
 * 目前**不需要任何重命名** —— index.ts 不再自带 `renderPanel`
 * （已改为从 chart-panel.ts 导入），两个模块之间没有重名。
 * 保留这个数组是因为它是防重名的机制：将来再出现同名符号时在这里加一条。
 */
const RENAMES = [];

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
 *   PI_SYSMON_CHART_HEIGHT=4     每张图的绘图行数（不含边框 4 行）
 *   PI_SYSMON_LABEL=title        读数位置：title（默认，边框标题栏）/ box（右上角浮框）/ both / none
 *   PI_SYSMON_DISKS=1            额外加一块磁盘 I/O 图
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
	out = out.replace(
		/^export (interface|type|function|const|let|class|enum|async)\b/gm,
		"$1",
	);
	// export { ... } 形式的再导出（本项目没有，防御性删除）
	out = out.replace(/^export \{[\s\S]*?\};[ \t]*$/gm, "");
	out = out.replace(/@@KEEP_DEFAULT@@/g, "export default");
	return out.trim();
}

/**
 * 收集某个源文件从本地模块导入的**运行期符号名**（不含纯类型）。
 *
 * 单文件形态是把所有模块拼成一个作用域，所以“导入”在产物里表现为
 * “名字被直接引用”。一旦某个被导入的符号在产物里**没有定义**，
 * 运行期就是 `ReferenceError: xxx is not defined` —— 而这类错误
 * 在开发期极难发现：代码能 typecheck、单元测试能过
 * （测试直接 import 源文件，根本不走打包），只在 pi 真的加载扩展时才爆。
 * 这个自检就是为了堵这类事故。
 */
function collectLocalImports(src) {
	const names = new Set();
	// 用 `[^{}]*` 而不是 `[\s\S]*?`：后者会**跨过**多条 import 语句
	// （因为它可以吃下 `}` 与后续的 `import`），从而把外部包的符号误判成本地导入。
	// import 的说明符列表里不可能出现嵌套花括号，所以 `[^{}]*` 既够用又不会越界。
	const re = /import\s+(?:type\s+)?\{([^{}]*)\}\s*from\s*"\.\/[^"]+";/g;
	let m;
	while ((m = re.exec(src)) !== null) {
		const isTypeOnlyImport = /^\s*import\s+type\b/.test(m[0]);
		for (const raw of (m[1] ?? "").split(",")) {
			const t = raw.trim();
			if (!t) continue;
			// 跳过内联 `type X`：类型不产生运行期代码
			if (/^type\s/.test(t) || isTypeOnlyImport) continue;
			// `A as B` → 取原名 A
			const name = t.replace(/\s+as\s+.*$/, "").trim();
			if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
		}
	}
	return names;
}

/** 产物里该符号是否有定义（函数/常量/类/枚举，含 export 前缀） */
function isDefinedIn(out, name) {
	const esc = name.replace(/[$]/g, "\\$");
	const re = new RegExp(
		`^(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|const|let|var|class|enum)\\s+${esc}\\b`,
		"m",
	);
	if (re.test(out)) return true;
	// `export { x }` / `export default function(){}` 等形态（防御性）
	if (new RegExp(`^export\\s*\\{[^}]*\\b${esc}\\b`, "m").test(out)) return true;
	return false;
}

/**
 * 收集某个源文件**顶层声明的类型名**（interface / type / class / enum）。
 *
 * 单文件形态把所有模块拼进一个作用域，所以两个模块各自声明同名类型就会变成
 * `ParseError: Identifier 'X' has already been declared` → **扩展加载失败、pi 报错**。
 * 典型场景：A 模块定义了 `type LabelMode` 并导出，B 模块为了省事又抄了一遗。
 * 与“符号缺失”一样，这类错 typecheck 和单测都拦不住（它们只看源码/不走打包）。
 *
 * 关键：**不能要求带 `export`**。`index.ts` 的 `type LabelMode = ...` 就没写 export，
 * 而它正是真实踩到的那个重名（我第一版正则只认 `export type`，注入重名后自检仍然通过）。
 */
function collectTypeDecls(src) {
	const names = [];
	// 行首（允许缩进外的 export）才算顶层声明，避开函数体内的局部 type
	const re =
		/^(?:export\s+)?(?:declare\s+)?(?:interface|type|class|enum)\s+([A-Za-z_$][\w$]*)/gm;
	let m;
	while ((m = re.exec(src)) !== null) if (m[1]) names.push(m[1]);
	return names;
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
		chunks.push(
			`// ══════════════════════════ ${mod.banner} ══════════════════════════\n\n${code}`,
		);
	}

	const out = `${HEADER}\n${chunks.join("\n\n")}\n`;

	// 自检 1：不允许残留本地相对 import
	const localImport = /from\s+"\.\.?\//;
	if (localImport.test(out)) {
		console.error("✗ 打包结果里仍存在本地相对 import，单文件版会加载失败：");
		for (const line of out.split("\n"))
			if (localImport.test(line)) console.error(`    ${line}`);
		process.exit(1);
	}

	// 自检 2：每个从本地模块导入的运行期符号都必须在产物里有定义。
	// 这是「buildBlocks 忘了加进 MODULES / RENAMES 改名改出空指针」这类
	// 只在 pi 真实加载时才爆的 ReferenceError 的唯一防线。
	const missing = [];
	for (const mod of MODULES) {
		const src = readFileSync(join(SRC, mod.file), "utf8");
		for (const name of collectLocalImports(src)) {
			if (!isDefinedIn(out, name)) missing.push(`${name}（被 ${mod.file} 导入）`);
		}
	}
	if (missing.length > 0) {
		console.error(
			"✗ 打包结果里以下符号被引用但没有定义（运行期会 ReferenceError）：",
		);
		for (const m of missing) console.error(`    ${m}`);
		console.error("  → 若是新模块，请加进 MODULES；若是重名，请加进 RENAMES。");
		process.exit(1);
	}

	// 自检 3：同一个类型/接口/类名不得在多个模块里重复声明。
	// 单文件形态把它们拼进同一个作用域，重名会直接是
	// `ParseError: Identifier 'X' has already been declared`（扩展加载失败）。
	const seen = new Map();
	const dups = [];
	for (const mod of MODULES) {
		const src = readFileSync(join(SRC, mod.file), "utf8");
		for (const name of collectTypeDecls(src)) {
			const prev = seen.get(name);
			if (prev) dups.push(`"${name}" 同时在 ${prev} 与 ${mod.file} 里声明`);
			else seen.set(name, mod.file);
		}
	}
	if (dups.length > 0) {
		console.error("✗ 以下类型名被重复声明（单文件形态会 ParseError）：");
		for (const d of dups) console.error(`    ${d}`);
		console.error("  → 保留一处作为唯一来源，另一处改为 import type。");
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
