// 舞台脚本合集：只做「启动/测试」两件事，不引入任何构建步骤。
//
// 独立进程是刻意的：它不跟着 DSH 死，DSH 重启也不用重新加载舞台。
// 详见 docs/research/live2d-jev-two-paths.md 与 agent-diva 的 Mirror 研究包。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRY = join(HERE, 'server.mjs')

const command = process.argv[2] ?? 'start'

if (command === 'start') {
  // 直接把输出接到终端：令牌要让人看得见、能复制。
  const child = spawn(process.execPath, [ENTRY], { stdio: 'inherit' })
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal))
  }
  child.on('exit', (code) => process.exit(code ?? 0))
} else if (command === 'check') {
  const port = process.env.STAGE_PORT ?? 5462
  const token = process.env.STAGE_TOKEN ?? ''
  const url = `http://127.0.0.1:${port}/api/ping${token === '' ? '' : `?token=${encodeURIComponent(token)}`}`
  try {
    const response = await fetch(url)
    const body = await response.json().catch(() => null)
    console.log(response.ok ? `舞台在跑：${JSON.stringify(body)}` : `舞台拒绝了这个请求：HTTP ${response.status} ${body?.code ?? ''}`)
    process.exit(response.ok ? 0 : 1)
  } catch (error) {
    console.error(`舞台没有响应：${error?.message ?? error}`)
    process.exit(1)
  }
} else {
  console.error(`用法：node stage-app/cli.mjs [start|check]`)
  process.exit(2)
}
