// 验证「点一下角色会有反应」——用真实浏览器，不靠肉眼，也不靠截图工具的步骤语法。
//
// 做法：起一个无头 Chrome，通过 CDP 打开舞台页，读包围盒，真的点一下角色的头，
// 然后读回引擎状态。凭据是数字（轨迹条数、是否在演、参数写入），不是「看起来像」。
//
//   node stage-app/tools/tap-check.mjs
//   node stage-app/tools/tap-check.mjs --url 'http://127.0.0.1:5462/?token=...'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? null : args[index + 1] ?? null
}

const BASE = process.env.STAGE_BASE_URL ?? 'http://127.0.0.1:5462'
const PORT = Number(process.env.CDP_PORT ?? 9333)

async function resolveUrl() {
  const given = option('--url')
  if (given !== null) return given
  const { readFile } = await import('node:fs/promises')
  const home = process.env.DSH_HOME ?? join(process.cwd(), '.artifacts', 'dsh-home')
  const token = (await readFile(join(home, 'live2d', 'stage-token'), 'utf8')).trim()
  return `${BASE}/?token=${encodeURIComponent(token)}`
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** 等 CDP 端口起来：它不会立刻可连。 */
async function waitForDevtools(deadlineMs = 15_000) {
  const until = Date.now() + deadlineMs
  while (Date.now() < until) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (response.ok) return await response.json()
    } catch { /* 还没起来 */ }
    await sleep(200)
  }
  throw new Error(`Chrome 的调试端口 ${PORT} 一直没起来`)
}

/** 极简 CDP 客户端：够用就行，不引依赖。 */
function connect(wsUrl) {
  const socket = new WebSocket(wsUrl)
  let nextId = 1
  const pending = new Map()
  const listeners = new Set()

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true })
  })

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(typeof event.data === 'string' ? event.data : '')
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(`${message.error.message}${message.error.data ? `: ${message.error.data}` : ''}`))
      else resolve(message.result)
      return
    }
    for (const listener of listeners) listener(message)
  })

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })

  return {
    ready,
    send,
    on: (fn) => listeners.add(fn),
    close: () => socket.close(),
  }
}

const main = async () => {
  const url = await resolveUrl()
  const profile = await mkdtemp(join(tmpdir(), 'stage-cdp-'))

  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    // 不能用 --disable-gpu：那会让 WebGL 直接不可用，PIXI 起不来。
    // 无头环境靠 SwiftShader 软件渲染就够，慢一点但真实。
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--window-size=720,900',
    'about:blank',
  ], { stdio: 'ignore' })

  const cleanup = async () => {
    try { chrome.kill('SIGKILL') } catch { /* 已经退了 */ }
    await rm(profile, { recursive: true, force: true }).catch(() => {})
  }

  try {
    await waitForDevtools()
    // 新开一个 target 直接指向舞台页
    const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json()
    const cdp = connect(created.webSocketDebuggerUrl)
    await cdp.ready

    const logs = []
    const trouble = []
    cdp.on((message) => {
      if (message.method === 'Runtime.consoleAPICalled') {
        const text = (message.params.args ?? []).map(a => a.value ?? a.description ?? '').join(' ')
        if (text.includes('[stage]')) logs.push(text)
        if (message.params.type === 'error') trouble.push(text)
      }
      if (message.method === 'Runtime.exceptionThrown') {
        trouble.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? '未名异常')
      }
    })

    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')

    // 先等导航真的落到舞台页上。刚 /json/new 出来的 target 可能还在 about:blank，
    // 这时候 evaluate 打的是空页面，会一直看不到任何东西。
    for (let i = 0; i < 200; i += 1) {
      const out = await cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })
      const href = out.result?.value ?? ''
      if (href.startsWith('http')) break
      await sleep(100)
      if (i === 199) throw new Error('页面一直没有导航到舞台地址')
    }

    // 等舞台挂载完成。软件渲染下 PIXI + Cubism 初始化要十秒以上，
    // 所以这里用宽松间隔轮询，不要紧贴着打（紧打会一直落在旧上下文里读到 null）。
    let debug = null
    for (let i = 0; i < 60; i += 1) {
      await sleep(1000)
      const out = await cdp.send('Runtime.evaluate', {
        expression: 'typeof window.__stageDebug === "function" ? JSON.stringify(window.__stageDebug()) : null',
        returnByValue: true,
      })
      if (out.exceptionDetails !== undefined) {
        // 钩子自身抛异常和「还没准备好」是两件事，必须分开报，否则会一直干等。
        throw new Error(`__stageDebug() 抛异常：${out.exceptionDetails.exception?.description ?? out.exceptionDetails.text}`)
      }
      if (typeof out.result?.value === 'string' && out.result.value !== 'null') {
        debug = JSON.parse(out.result.value)
        break
      }
    }
    if (debug === null) {
      const where = (await cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })).result?.value
      const status = (await cdp.send('Runtime.evaluate', {
        expression: "document.getElementById('status')?.textContent ?? '(没有状态条)'", returnByValue: true,
      })).result?.value
      throw new Error(`舞台没有挂载起来（地址 ${where}，状态条：${status}）${trouble.length === 0 ? '' : `\n页面报错：\n  ${trouble.join('\n  ')}`}`)
    }

    const { bounds } = debug
    console.log(`包围盒：x=${Math.round(bounds.x)} y=${Math.round(bounds.y)} w=${Math.round(bounds.width)} h=${Math.round(bounds.height)}`)

    const before = debug.engine ?? null

    const tap = async (x, y, label, waitMs = 1200) => {
      console.log(`\n点「${label}」：(${Math.round(x)}, ${Math.round(y)})`)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: 'mouse' })
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, pointerType: 'mouse' })
        await sleep(30)
      }
      await sleep(waitMs)
    }

    /** 等上一段演完，否则「正在演」会把下一次点击正当挡回去。 */
    const settle = async () => {
      for (let i = 0; i < 60; i += 1) {
        const out = await cdp.send('Runtime.evaluate', { expression: 'window.__stageDebug().performing', returnByValue: true })
        if (out.result?.value === false) return
        await sleep(250)
      }
    }

    await tap(bounds.x + bounds.width / 2, bounds.y + bounds.height * 0.18, '头部')
    await settle()
    await tap(bounds.x + bounds.width / 2, bounds.y + bounds.height * 0.72, '身体')
    await settle()

    // 拖动一大段再松手：不该被当成点击
    console.log('\n拖动一段（不该触发反应）')
    const dragX = bounds.x + bounds.width / 2
    const dragY = bounds.y + bounds.height * 0.18
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dragX, y: dragY, button: 'left', clickCount: 1, pointerType: 'mouse' })
    for (const step of [30, 60, 90, 120]) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragX + step, y: dragY, button: 'left', buttons: 1, pointerType: 'mouse' })
      await sleep(30)
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragX + 120, y: dragY, button: 'left', clickCount: 1, pointerType: 'mouse' })
    await sleep(600)
    const afterDrag = JSON.parse((await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__stageDebug().interaction)', returnByValue: true,
    })).result.value)
    console.log('拖动后的交互记录：', JSON.stringify(afterDrag))
    // 拖动本身还有没有用？视图位置应该真的动了。
    const viewAfter = JSON.parse((await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__stageDebug().view)', returnByValue: true,
    })).result.value)
    console.log('拖动后视图：', JSON.stringify({ zoom: viewAfter.zoom, panX: viewAfter.panX, panY: viewAfter.panY }))
    // 视角字段是 zoom/panX/panY（不是 x/y/scale），拖 120px 应该体现在 panX 上。
    const viewMoved = viewAfter.panX !== debug.view.panX
    console.log('视图是否真的移动了：', viewMoved ? '是' : '否（拖动失效）')
    if (!viewMoved) process.exitCode = 1

    await sleep(700)
    const after = JSON.parse((await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__stageDebug())', returnByValue: true,
    })).result.value)

    const probe = (await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify(window.__tapProbe ?? [])', returnByValue: true })).result?.value
    console.log('\n--- 画布收到的事件 ---')
    console.log(probe)

    console.log('\n--- 控制台 ---')
    for (const line of logs) console.log(line)
    console.log('\n--- 结果 ---')
    console.log('点前：performing =', before?.playing ?? '（引擎还没建）')
    console.log('点后：performing =', after.performing, '| writeCount =', after.engine?.writeCount ?? 0, '| frames =', after.engine?.frames ?? 0)
    const reacted = logs.some(line => line.includes('反应已起手'))
    const hit = logs.some(line => line.includes('点中 head'))
    console.log(`\n命中头部：${hit ? '是' : '否'}　反应起手：${reacted ? '是' : '否'}`)
    if (!hit || !reacted) process.exitCode = 1
    cdp.close()
  } finally {
    await cleanup()
  }
}

main().catch((error) => {
  console.error('验证失败：', error?.message ?? error)
  process.exit(1)
})
