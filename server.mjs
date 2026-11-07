// 角色舞台：一个完全独立的进程。
//
// 它不依赖 DSH、不嵌在宿主的设置面板里，也不经过宿主的鉴权。理由来自 agent-diva 的研究包
// （docs/research/diva-workbench-pen-mirror-neurolink-2026-08）：
//
//   Mirror 是 DIVA 的可替换呈现与具身前端。它消费语义状态，产生受限输入，
//   默认不获得通用外部执行权。
//   VRM/Live2D 渲染、模型和动画资产应当逐步迁出 Core，通过稳定合同运行，
//   而不是成为 Core 或主 GUI 无法移除的编译耦合。
//
// 所以这里自己拥有：页面、渲染层、编译器、引擎、模型、指令箱、认证。
// 外面（DSH 或别的什么）只需要会发语义动作、会读状态就够了。
//
// 安全按研究包的「安全最低线」做，不因为「本机」就免检：
//   - 默认只监听 loopback；
//   - loopback 也要令牌：启动时生成，打印在终端，页面用带令牌的地址打开；
//   - 有全局 Kill Switch（POST /api/kill）；
//   - 每段表演记审计（谁、什么时候、演了什么）。
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createQueue } from './src/perform-queue.mjs'
import { safeJoin } from './src/safe-join.mjs'
import { createModelStore } from './src/model-store.mjs'
import { buildCapabilities, renderCapabilitiesText } from './src/capabilities.mjs'
import { compilePlan } from './stage/performance-compiler.mjs'
import { buildCatalog } from './stage/model-assets.mjs'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const PORT = Number(process.env.STAGE_PORT ?? 5462)
const HOST = process.env.STAGE_HOST ?? '127.0.0.1'
/** 模型放哪：默认跟着 DSH 的角色目录走，也可以自己指。 */
const MODELS = resolve(process.env.STAGE_MODELS ?? join(ROOT, '..', '.artifacts', 'dsh-home', 'live2d', 'models'))
const KNOWLEDGE = join(ROOT, 'data', 'knowledge')
const PERFORMANCES = join(ROOT, 'data', 'performances')
const PROFILES = process.env.STAGE_PROFILES ?? join(ROOT, '..', '.artifacts', 'stage-profiles')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.moc3': 'application/octet-stream',
  '.wav': 'audio/wav',
}

const queue = createQueue({ depth: Number(process.env.STAGE_DEPTH ?? 8) })
const store = createModelStore({
  root: MODELS,
  demoDir: join(ROOT, 'demo'),
  cacheDir: PROFILES,
  knowledgeDir: KNOWLEDGE,
  logger: console,
})

/** 会话令牌：启动时生成一次，进程活着就有效。 */
const TOKEN = process.env.STAGE_TOKEN ?? randomBytes(18).toString('base64url')
/** 全局 Kill Switch：按下之后拒绝一切新表演，直到进程重启。 */
let killed = false
/** 审计：每段表演一行，够追溯「谁在什么时候让它演了什么」。 */
const audit = []

const send = (res, status, value) => {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}
const fail = (res, status, code, error) => send(res, status, { ok: false, code, error })

/** 令牌比较要抗时序：长度不同直接算失败，别用 === 比秘密。 */
function tokenMatches(supplied) {
  if (typeof supplied !== 'string' || supplied === '') return false
  const a = Buffer.from(supplied)
  const b = Buffer.from(TOKEN)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** 三道校验：只认本机 Host、只认本机/同源、令牌必须对。 */
function rejected(req, res, url) {
  if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(String(req.headers.host ?? '').toLowerCase())) {
    fail(res, 403, 'HOST_REJECTED', '只接受本机访问')
    return true
  }
  // 令牌可以走查询串（首次打开页面）或请求头（后续调用）。
  const supplied = req.headers['x-stage-token'] ?? url.searchParams.get('token')
  if (!tokenMatches(typeof supplied === 'string' ? supplied : '')) {
    fail(res, 403, 'TOKEN_REQUIRED', '缺少或错误的舞台令牌')
    return true
  }
  return false
}

/** 取当前模型：优先用查询串，其次配置里选的，最后自动挑。 */
async function currentModel(name) {
  const resolved = await store.resolve(name ?? '')
  if (!resolved.name) throw new Error('还没有可用的角色模型')
  return resolved
}

const readJsonBody = async (req, limit = 512 * 1024) => {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) return null
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

async function listPerformances() {
  let names
  try { names = await readdir(PERFORMANCES) } catch { return [] }
  const items = []
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue
    try {
      const json = JSON.parse(await readFile(join(PERFORMANCES, name), 'utf8'))
      items.push({ name: name.replace(/\.json$/i, ''), intent: json.intent ?? null, actions: Array.isArray(json.actions) ? json.actions.length : 0 })
    } catch { /* 坏文件跳过，不该让整个库读不出来 */ }
  }
  return items
}

/** 编译一段语义计划：这是 Mirror 的「动作映射」，外面只说想表达什么。 */
async function compileFor(plan, modelName) {
  const resolved = await currentModel(modelName)
  const loaded = await store.catalog(resolved.name)
  if (loaded === null) throw new Error(`模型 ${resolved.name} 没有语义档案（缺 core-inventory.json）`)
  const catalog = buildCatalog({ profile: loaded.profile, expressions: loaded.expressions, motions: loaded.motions })
  const compiled = compilePlan(plan, catalog)
  return { compiled, profile: loaded.profile }
}

const server = createServer(async (req, res) => {
  let url
  try {
    url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${HOST}:${PORT}`}`)
  } catch {
    return fail(res, 400, 'BAD_URL', '请求地址不合法')
  }
  const path = decodeURIComponent(url.pathname)

  try {
    // ---- 页面：不带令牌就把令牌写进地址栏，省得人手动拼 ----
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      const html = await readFile(join(ROOT, 'index.html'), 'utf8')
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' })
      // 页面自己不知道令牌，由服务端注入，避免把它写在静态文件里。
      return res.end(html.replace('__STAGE_TOKEN__', TOKEN))
    }

    if (path.startsWith('/api/')) {
      if (rejected(req, res, url)) return

      if (path === '/api/ping') {
        return send(res, 200, { ok: true, killed, queue: queue.state() })
      }

      if (path === '/api/capabilities') {
        const resolved = await currentModel(url.searchParams.get('name'))
        if (resolved.profile === null || resolved.profile?.error) {
          return fail(res, 409, 'NO_PROFILE', resolved.profile?.error ?? '这个模型没有语义档案')
        }
        const capabilities = buildCapabilities(resolved.profile)
        // 连文字一起给：编排的规矩属于 Mirror，宿主不该自己再写一份。
        return send(res, 200, { ok: true, capabilities, text: renderCapabilitiesText(capabilities) })
      }

      // 页面该加载哪个 model3：由服务端给，页面不猜（目录名与资源名经常不一致）。
      if (path === '/api/model') {
        const resolved = await currentModel(url.searchParams.get('name'))
        return send(res, 200, { ok: true, name: resolved.name, modelPath: resolved.entry?.modelPath ?? null, ready: resolved.entry?.ready ?? false })
      }

      if (path === '/api/profile') {
        const resolved = await currentModel(url.searchParams.get('name'))
        if (resolved.profile === null) return fail(res, 409, 'NO_PROFILE', '这个模型没有语义档案')
        if (resolved.profile?.error) return fail(res, 409, 'PROFILE_UNAVAILABLE', resolved.profile.error)
        return send(res, 200, { ok: true, profile: resolved.profile })
      }

      /**
       * 真实可用的名字清单。编排时必须照着这里写，不能凭印象。
       *
       * 表情里有相当一部分其实是服装/道具开关（`体型1`、`单片眼镜`…），
       * 当成情绪用就是错的——所以这里直接分成两类，别让调用方自己猜。
       */
      if (path === '/api/catalog') {
        const resolved = await currentModel(url.searchParams.get('name'))
        if (resolved.profile === null || resolved.profile?.error) {
          return fail(res, 409, 'NO_PROFILE', resolved.profile?.error ?? '这个模型没有语义档案')
        }
        const profile = resolved.profile
        // expressions / motions 是名字数组（不是对象）；gestures 是对象。
        // 早先这里一律 Object.keys()，数组就变成了 0..N 的下标——真数据才暴露。
        const names = (value) => Array.isArray(value) ? value.slice() : Object.keys(value ?? {})
        const expressionNames = names(profile.expressions)
        // 这些名字看着像表情，其实是切换服装/道具/手的开关：拿来做情绪会「穿帮」。
        const costumeHint = /^(体型|服装|道具|单片|眼镜|帽子|尾巴|耳朵|脱鞋|裙子|胸口衣服|竖食指)/
        return send(res, 200, {
          ok: true,
          model: resolved.name,
          expressions: {
            emotion: expressionNames.filter(name => !costumeHint.test(name)),
            costume: expressionNames.filter(name => costumeHint.test(name)),
          },
          motions: names(profile.motions),
          gestures: names(profile.gestures),
          semantic: profile.semanticIds ?? [],
          counts: profile.counts ?? null,
        })
      }

      if (path === '/api/library') {
        return send(res, 200, { ok: true, performances: await listPerformances() })
      }

      // 语义动作 → 编译 → 入队。这是外面唯一需要的写接口。
      if (path === '/api/perform' && req.method === 'POST') {
        if (killed) return fail(res, 409, 'KILLED', '已按下 Kill Switch，重启舞台后才能再演')
        const body = await readJsonBody(req)
        if (body === null) return fail(res, 400, 'BAD_JSON', '请求体必须是 JSON')
        const plan = body.plan
        if (!plan || typeof plan !== 'object') return fail(res, 400, 'NO_PLAN', '缺少 plan')
        const state = queue.state()
        if (state.lastSeenMs === null) return fail(res, 409, 'NO_STAGE', '还没有打开舞台页面，演不了')
        try {
          const { compiled } = await compileFor(plan, body.model)
          const { jobId, deduplicated } = queue.enqueue({
            plan,
            compiled,
            requestId: typeof body.requestId === 'string' && body.requestId !== '' ? body.requestId : null,
          })
          audit.push({ at: new Date().toISOString(), jobId, intent: plan.intent ?? null, actions: plan.actions?.length ?? 0, from: req.headers['user-agent'] ?? 'unknown' })
          if (audit.length > 200) audit.shift()
          return send(res, 200, { ok: true, jobId, deduplicated, duration: compiled.duration, tracks: compiled.tracks.length, warnings: compiled.warnings })
        } catch (error) {
          return fail(res, 400, 'REJECTED', error?.message ?? String(error))
        }
      }

      // 只校验不演：编排的时候先用它试一下。
      if (path === '/api/compile' && req.method === 'POST') {
        const body = await readJsonBody(req)
        if (body === null || !body.plan) return fail(res, 400, 'NO_PLAN', '缺少 plan')
        try {
          const { compiled } = await compileFor(body.plan, body.model)
          return send(res, 200, { ok: true, duration: compiled.duration, tracks: compiled.tracks.length, steps: compiled.steps.map(s => s.kind), warnings: compiled.warnings })
        } catch (error) {
          return fail(res, 400, 'REJECTED', error?.message ?? String(error))
        }
      }

      if (path === '/api/state') return send(res, 200, { ok: true, killed, ...queue.state() })

      if (path === '/api/stop' && req.method === 'POST') {
        queue.requestStop()
        return send(res, 200, { ok: true, requested: true })
      }

      // Kill Switch：停掉正在演的，并且拒绝后续一切表演。
      if (path === '/api/kill' && req.method === 'POST') {
        killed = true
        queue.requestStop()
        return send(res, 200, { ok: true, killed: true })
      }

      if (path === '/api/audit') return send(res, 200, { ok: true, audit: [...audit].reverse() })

      // 舞台页面长轮询来这里取活：它是同一个源、同一个令牌，不走宿主。
      if (path === '/api/pending') {
        if (killed) return send(res, 200, { ok: true, type: 'stop' })
        const waitRaw = Number(url.searchParams.get('wait') ?? 0)
        const waitMs = Number.isFinite(waitRaw) ? Math.min(Math.max(waitRaw, 0), 60_000) : 0
        if (waitMs > 0) {
          req.socket?.setTimeout?.(0)
          res.socket?.setTimeout?.(0)
        }
        let gone = false
        const onClose = () => { gone = true }
        req.on('close', onClose)
        const payload = await queue.claim({ waitMs, visibility: url.searchParams.get('vis') })
        req.off?.('close', onClose)
        if (gone || res.writableEnded === true || res.destroyed === true) return
        return send(res, 200, { ok: true, ...payload })
      }

      if (path === '/api/receipt' && req.method === 'POST') {
        const body = await readJsonBody(req)
        if (body === null) return fail(res, 400, 'BAD_JSON', '请求体必须是 JSON')
        try {
          const result = queue.receipt(body.jobId, { status: body.status, progress: body.progress, error: body.error ?? null })
          return send(res, 200, { ok: true, job: result, stopRequested: result.stopRequested === true })
        } catch (error) {
          return fail(res, 400, 'BAD_RECEIPT', error?.message ?? String(error))
        }
      }

      return fail(res, 404, 'NOT_FOUND', '未知接口')
    }

    // ---- 静态：舞台脚本、厂商库、模型资产 ----
    const target = resolveStatic(path)
    if (target === null) return fail(res, 404, 'NOT_FOUND', '未知路径')
    return await serveFile(req, res, target)
  } catch (error) {
    console.error(`[stage] ${req.method} ${path} 失败：`, error)
    if (!res.headersSent) return fail(res, 500, 'INTERNAL', error?.message ?? String(error))
  }
})

/** 路径 → 磁盘位置。所有分支都必须落在白名单根里。 */
function resolveStatic(path) {
  if (path.startsWith('/stage/')) return safeJoin(join(ROOT, 'stage'), path.slice('/stage/'.length))
  if (path.startsWith('/vendor/')) return safeJoin(join(ROOT, 'vendor'), path.slice('/vendor/'.length))
  if (path.startsWith('/models/')) return safeJoin(MODELS, path.slice('/models/'.length))
  return null
}

async function serveFile(req, res, path) {
  const info = await stat(path).catch(() => null)
  if (!info || !info.isFile()) return fail(res, 404, 'FILE_NOT_FOUND', '文件不存在')
  // 模型素材按目录签名变化，页面侧用 no-cache 复核、命中则复用。
  res.writeHead(200, {
    'content-type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
    'content-length': String(info.size),
    'cache-control': 'no-cache',
  })
  createReadStream(path).pipe(res)
}

/**
 * 令牌落盘：让本机的自动化（工具桥）能拿到凭证，而不用人手动贴。
 *
 * 这是有意的取舍——研究包要求 loopback 也要认证，而「认证」不能在自动化和
 * 「谁都能连」之间二选一。落一份 0600 的文件，比开放无认证端口安全得多；
 * 代价是同用户下的其它进程能读到它，这一点在这里写明，不假装不存在。
 */
async function persistToken() {
  // 与工具桥同一个约定：$DSH_HOME/live2d/stage-token。两边各写一份就迟早对不上。
  const home = process.env.DSH_HOME ?? join(ROOT, '..', '.artifacts', 'dsh-home')
  const dir = join(home, 'live2d')
  try {
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'stage-token')
    await writeFile(file, `${TOKEN}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(file, 0o600).catch(() => {})
    return file
  } catch (error) {
    console.warn(`[stage] 令牌没能落盘（工具桥将无法自动连接）：${error?.message ?? error}`)
    return null
  }
}

server.listen(PORT, HOST, async () => {
  const tokenFile = await persistToken()
  console.log(`\n角色舞台已启动：http://${HOST}:${PORT}/?token=${TOKEN}\n`)
  console.log(`  模型目录：${MODELS}`)
  console.log(`  只监听 ${HOST}；上面那条带令牌的地址就是全部凭证。`)
  console.log(`  工具桥令牌：${tokenFile ?? '（未能落盘）'}`)
  console.log(`  停止：Ctrl-C　Kill Switch：POST /api/kill\n`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n舞台正在关闭…')
    queue.dispose()
    server.close(() => process.exit(0))
  })
}
