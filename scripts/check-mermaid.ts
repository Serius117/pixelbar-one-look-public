// scripts/check-mermaid.ts
// 用途：验证 docs/*.md（或传入的任意 .md / 目录）中全部 mermaid 代码块语法可解析。
//       AGENTS.md 图表规范（一律 mermaid，禁 ASCII 画图）的质量门。
// 用法：node scripts/check-mermaid.ts [file.md | dir ...]；无参数默认扫 docs/ 全部 .md
// 输出：每块 ok/error + 汇总；退出码 0=全过 1=有失败（可挂 CI）
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'

// mermaid 解析需要 DOM 环境（jsdom 模拟；Node 24 自带 navigator 不覆盖）
const dom = new JSDOM('<!DOCTYPE html><body></body>')
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  DOMParser: dom.window.DOMParser,
  XMLSerializer: dom.window.XMLSerializer,
  SVGElement: dom.window.SVGElement,
})

const mermaid = (await import('mermaid')).default

function resolveTargets(args: string[]): string[] {
  if (args.length === 0) {
    // 默认扫根目录 *.md（AGENTS/DECISIONS/DEVLOG/README/TASKS）+ docs/*.md
    return [
      ...readdirSync('.').filter((f) => f.endsWith('.md')).map((f) => f),
      ...readdirSync('docs').filter((f) => f.endsWith('.md')).map((f) => join('docs', f)),
    ]
  }
  const out: string[] = []
  for (const a of args) {
    if (statSync(a).isDirectory()) {
      out.push(...readdirSync(a).filter((f) => f.endsWith('.md')).map((f) => join(a, f)))
    } else {
      out.push(a)
    }
  }
  return out
}

interface BlockResult {
  file: string
  index: number
  ok: boolean
  firstLine: string
  error?: string
}

const results: BlockResult[] = []
for (const file of resolveTargets(process.argv.slice(2))) {
  const text = readFileSync(file, 'utf8')
  const blocks = [...text.matchAll(/```mermaid\r?\n([\s\S]*?)```/g)]
  // 盲区防护（2026-11-17 实证）：未闭合的 ```mermaid 块不匹配上面的正则，会被静默跳过
  // —— 实测详细设计.md §10.8 图因此漏检（图未渲染）。这里强制对账：开栏数 = 匹配块数。
  const opens = [...text.matchAll(/```mermaid\r?\n/g)].length
  if (opens !== blocks.length) {
    results.push({
      file,
      index: blocks.length + 1,
      ok: false,
      firstLine: '```mermaid',
      error: `UNCLOSED MERMAID BLOCK: ${opens} opened, ${blocks.length} closed`,
    })
  }
  for (const [i, m] of blocks.entries()) {
    const code = m[1].replace(/\r\n/g, '\n')
    const firstLine = code.trim().split('\n')[0] ?? ''
    try {
      await mermaid.parse(code)
      results.push({ file, index: i + 1, ok: true, firstLine })
    } catch (err) {
      results.push({ file, index: i + 1, ok: false, firstLine, error: String(err) })
    }
  }
}

console.log(JSON.stringify(results, null, 2))
const failed = results.filter((r) => !r.ok)
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} blocks OK`)
process.exit(failed.length ? 1 : 0)
