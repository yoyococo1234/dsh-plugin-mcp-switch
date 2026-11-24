/**
 * 宿主内置包 `@deepseek-ai/dsh-mcp-client` 的稳健加载器。
 *
 * ## 为什么需要它
 * 该包打在 dsh 安装目录的 `app.asar` 里，profile 安装的插件用裸包名 import 在开机
 * 加载时会失败，所以必须按绝对路径动态导入（Electron 的 fs/loader 认 asar）。
 *
 * ## 旧做法的问题
 * 2026-10-23 的本地补丁把「根目录 + 入口文件」都写死了：
 *   `<resourcesPath>/app.asar/dsh/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js`
 * 下面任一情况变化就会 `failed to import`，而且因为写在顶层 await，**整个插件加载失败**
 * （UI、工具、状态全没了，不只是 MCP 不可用）：
 *   - 安装路径不是默认的用户目录（换盘、绿色版、系统级安装）
 *   - 宿主改成解包布局 `resources/app/dsh/node_modules`
 *   - 包入口不再是 `lib/index.js`（`exports` / `main` 变了）
 *   - 包被改名或挪到别的 `node_modules`
 *
 * ## 现在的解析顺序（每步都真 import 一次，用结果说话，不靠 existsSync 猜）
 *   1. 裸说明符 —— 宿主拦截解析器命中时拿到的就是宿主共享实例（最理想）
 *   2. 环境变量 `DSH_APP_MODULES` 显式指定（排障用）
 *   3. 候选根目录 × 候选入口：
 *        `<resourcesPath>/app.asar/dsh/node_modules`
 *        `<resourcesPath>/app/dsh/node_modules`
 *        `<execPath 目录>/resources/app.asar/dsh/node_modules`
 *        `<execPath 目录>/resources/app/dsh/node_modules`
 *        `%LOCALAPPDATA%/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules`
 *        `@deepseek-ai/dsh` 自身旁的 `node_modules`（npm CLI 布局）
 *      入口优先按该包 `package.json` 的 `exports["."]` / `module` / `main` 解析，
 *      再退回 `lib/index.js`、`index.js`、`dist/index.js`、`*.mjs`。
 *   4. 全部失败**不抛异常**：返回 `{ ok:false, module:undefined, error, tried }`，
 *      插件照常加载，只在真正连 MCP 时明确报「MCP 桥不可用」并给出尝试清单。
 *
 * ## 形状校验
 * `@deepseek-ai/dsh-mcp-client` 导出 `{ Config, apply, createMcpToolDefinition, inject, name }`
 * （0.2.1-rc.5 实测，`apply` 是 async 函数）。`apply` 不是函数就说明拿错了模块，
 * 记为 shape-mismatch 继续试下一个候选，而不是把错的东西交给 `ctx.plugin`。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 目标包名。 */
export const PKG = '@deepseek-ai/dsh-mcp-client'

/** 包 package.json 读不出来时的兜底入口候选（按可能性排序）。 */
const DEFAULT_ENTRIES = ['lib/index.js', 'index.js', 'dist/index.js', 'lib/index.mjs', 'index.mjs']

function readJson(path) {
  try {
    // 去掉可能的 UTF-8 BOM：带 BOM 的 JSON 会让 JSON.parse 直接失败
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return undefined
  }
}

/** 从包 `package.json` 推导入口候选，再补兜底项；结果去重并去掉开头的 `./`。 */
function entryCandidates(pkgDir) {
  const out = []
  const push = (value) => {
    if (typeof value === 'string' && value !== '' && !out.includes(value)) out.push(value)
  }
  const pkg = readJson(join(pkgDir, 'package.json'))
  if (pkg) {
    const exp = pkg.exports
    if (typeof exp === 'string') push(exp)
    else if (exp && typeof exp === 'object') {
      const dot = exp['.'] ?? exp
      if (typeof dot === 'string') push(dot)
      else if (dot && typeof dot === 'object') {
        for (const key of ['import', 'node', 'default', 'require']) push(dot[key])
      }
    }
    push(pkg.module)
    push(pkg.main)
  }
  for (const entry of DEFAULT_ENTRIES) push(entry)
  // 去掉开头的 `./` 之后再按「最终相对路径」去重，避免 `./lib/index.js` 与 `lib/index.js` 重复尝试
  const seen = new Set()
  const unique = []
  for (const entry of out) {
    const normalized = entry.replace(/^\.\//, '')
    if (normalized === '' || seen.has(normalized)) continue
    seen.add(normalized)
    unique.push(normalized)
  }
  return unique
}

/** 候选 `node_modules` 根目录，按可靠性排序。 */
function candidateRoots() {
  const roots = []
  const push = (value) => {
    if (typeof value === 'string' && value !== '' && !roots.includes(value)) roots.push(value)
  }

  if (process.env.DSH_APP_MODULES) push(process.env.DSH_APP_MODULES)

  const resources = process.resourcesPath
  if (resources) {
    push(join(resources, 'app.asar', 'dsh', 'node_modules'))
    push(join(resources, 'app', 'dsh', 'node_modules'))
  }

  try {
    const exeDir = dirname(process.execPath)
    push(join(exeDir, 'resources', 'app.asar', 'dsh', 'node_modules'))
    push(join(exeDir, 'resources', 'app', 'dsh', 'node_modules'))
  } catch {
    /* process.execPath 不可用时跳过 */
  }

  push(join(homedir(), 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar', 'dsh', 'node_modules'))

  // npm CLI / 全局布局：@deepseek-ai/dsh 与 dsh-mcp-client 在同一个 node_modules 下
  try {
    const resolved = import.meta.resolve('@deepseek-ai/dsh/package.json')
    if (resolved.startsWith('file:')) {
      const dshDir = dirname(fileURLToPath(resolved))
      push(join(dshDir, 'node_modules'))
      push(join(dshDir, '..', '..'))
    }
  } catch {
    /* 裸说明符不可解析时跳过 */
  }

  return roots
}

/** 判断 import 到的命名空间是不是真的 mcp-client 插件模块。 */
function looksLikeBridge(mod) {
  return mod !== null && typeof mod === 'object' && typeof mod.apply === 'function'
}

/**
 * 解析并导入宿主内置的 `@deepseek-ai/dsh-mcp-client`。
 * @returns {Promise<{ok: boolean, module: object | undefined, source: string, error?: string, tried: Array<{target: string, error: string}>}>}
 */
export async function resolveHostMcpClient() {
  const tried = []

  // 1) 裸说明符：宿主拦截解析器命中时，拿到的就是宿主共享实例。
  try {
    const mod = await import(PKG)
    if (looksLikeBridge(mod)) {
      return { ok: true, module: mod, source: `${PKG}（裸说明符 / 宿主拦截解析）`, tried }
    }
    tried.push({ target: PKG, error: 'shape-mismatch（apply 不是函数）' })
  } catch (error) {
    tried.push({ target: PKG, error: error?.message || String(error) })
  }

  // 2) 环境变量覆盖 + 3) 候选根目录 × 候选入口
  for (const root of candidateRoots()) {
    // `join` 在 Windows 上会自动用反斜杠，所以这里按包名分段拼接即可
    const dir = join(root, ...PKG.split('/'))
    for (const entry of entryCandidates(dir)) {
      const file = join(dir, entry)
      try {
        const mod = await import(pathToFileURL(file).href)
        if (looksLikeBridge(mod)) return { ok: true, module: mod, source: file, tried }
        tried.push({ target: file, error: 'shape-mismatch（apply 不是函数）' })
      } catch (error) {
        tried.push({ target: file, error: error?.message || String(error) })
      }
    }
  }

  const head = tried
    .slice(0, 6)
    .map((t) => `  · ${t.target} → ${t.error}`)
    .join('\n')
  return {
    ok: false,
    module: undefined,
    source: '',
    tried,
    error:
      `找不到可用的 ${PKG}（共尝试 ${tried.length} 处）：\n${head}` +
      `\n可设环境变量 DSH_APP_MODULES 指向宿主的 dsh\\node_modules 后重启 DSH 再试。`,
  }
}
