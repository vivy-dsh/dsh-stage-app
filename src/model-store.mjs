// 模型仓库：一个子目录 = 一个模型，可以挂多个根。
//
//   根 1  $DSH_HOME/live2d/models/<名字>/   人工导入（用户自己的模型落这里）
//   根 2  <插件>/demo/<名字>/               随插件分发的示例模型
//
// 同名时人工导入的优先，示例模型永远可以让位。这里只做「发现 + 建档案 + 缓存」，
// 不改模型文件本身；没有 core-inventory.json 的模型照样可渲染，只是没有语义档案。
import { readdir, stat, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildProfile, renderReady, scanModelDir, readJsonIfPresent } from './profile.mjs'

/** 读 data/knowledge/*.json：模型专属知识，按 match 里的子串命中。 */
export async function loadKnowledge(dir) {
  let names
  try { names = await readdir(dir) } catch { return [] }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const json = await readJsonIfPresent(join(dir, name))
    if (json) out.push({ file: name, ...json })
  }
  return out
}

/** 读知识里声明的参数清单（路径相对知识文件所在目录）。 */
async function loadDeclaredInventory(knowledge, knowledgeDir) {
  const reference = knowledge?.inventory
  if (typeof reference !== 'string' || reference === '') return null
  return readJsonIfPresent(join(knowledgeDir, reference))
}

/** 用模型目录名 / model3 文件名去命中专属知识。 */
export function matchKnowledge(knowledgeList, haystack) {
  const text = String(haystack ?? '')
  for (const knowledge of knowledgeList) {
    const needles = Array.isArray(knowledge.match) ? knowledge.match : []
    if (needles.some(needle => typeof needle === 'string' && needle && text.includes(needle))) return knowledge
  }
  return null
}

async function dirSignature(dir) {
  const parts = []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile()) continue
      const info = await stat(join(dir, entry.name)).catch(() => null)
      parts.push(`${entry.name}:${info?.size ?? 0}:${Math.round(info?.mtimeMs ?? 0)}`)
    }
  } catch { return 'unreadable' }
  return parts.join('|')
}

/**
 * @param {object} options
 * @param {string|Array<{dir: string, source?: string}>} options.root 用户模型根（或完整根列表）
 * @param {string} [options.demoDir] 示例模型根
 * @param {string} options.cacheDir 档案缓存目录（$DSH_HOME/live2d/profiles）
 * @param {string} options.knowledgeDir 模型专属知识目录
 * @param {(msg: string) => void} [options.logger]
 */
export function createModelStore({ root, demoDir = null, cacheDir, knowledgeDir, logger = null, basePath = '' }) {
  const roots = []
  if (Array.isArray(root)) for (const item of root) roots.push({ dir: item.dir, source: item.source ?? 'user' })
  else if (typeof root === 'string') roots.push({ dir: root, source: 'user' })
  if (demoDir) roots.push({ dir: demoDir, source: 'demo' })

  let knowledgeCache = null
  async function knowledge() {
    if (knowledgeCache === null) knowledgeCache = await loadKnowledge(knowledgeDir)
    return knowledgeCache
  }

  /** 所有根下发现的模型；同名时靠前的根优先。 */
  async function discover() {
    const found = new Map()
    for (const root of roots) {
      let entries
      try { entries = await readdir(root.dir, { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        if (found.has(entry.name)) continue
        const dir = join(root.dir, entry.name)
        const scan = await scanModelDir(dir).catch(() => null)
        if (scan === null) continue
        found.set(entry.name, {
          name: entry.name,
          dir,
          source: root.source,
          ready: renderReady(scan),
          files: scan.files.length,
          hasInventory: Boolean(scan.coreInventory),
          model3File: scan.model3File,
          expressions: Object.keys(scan.expressions).length,
          motions: Object.keys(scan.motions).length,
          knowledge: matchKnowledge(await knowledge(), `${entry.name} ${scan.model3File ?? ''}`)?.file ?? null,
        })
      }
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  async function list() {
    return (await discover()).map(({ dir, model3File, ...rest }) => rest)
  }

  /** 定位一个模型：目录 + model3 文件名。 */
  async function locate(name) {
    const all = await discover()
    const hit = all.find(model => model.name === name)
    return hit ?? null
  }

  /**
   * 建（或读缓存）档案。没有 core-inventory.json 的模型返回 null，
   * 不是错误——它照样能渲染，只是没有语义参数档案。
   */
  /**
   * 真正扫描并建档。profile() 与 catalog() 共用这一份，避免两套扫描逻辑各说各话。
   * @returns `{ built, scan }`；没有清单时 `built` 为 null。
   */
  async function buildFor(name) {
    const entry = await locate(name)
    if (entry === null) throw new Error(`模型 ${name} 不存在`)
    const dir = entry.dir
    const scan = await scanModelDir(dir)
    const matched = matchKnowledge(await knowledge(), `${name} ${scan.model3File ?? ''}`)
    // 模型目录里没有清单时，退回知识里声明的那份（鲸语的 core-inventory 随插件分发，
    // 不该要求用户把它复制进模型目录）。
    const inventory = scan.coreInventory ?? await loadDeclaredInventory(matched, knowledgeDir)
    if (!inventory) return { built: null, scan, entry }
    const built = buildProfile({
      coreInventory: inventory,
      knowledge: matched,
      cdi3: scan.cdi3,
      physics: scan.physics,
      expressions: scan.expressions,
      motions: scan.motions,
      vts: scan.vts,
      modelPath: `/dsh-live2d/models/${encodeURIComponent(name)}/${encodeURIComponent(scan.model3File)}`,
    })
    built.ready = renderReady(scan)
    built.modelDirName = name
    built.source = entry.source
    built.signature = await dirSignature(dir)
    return { built, scan, entry, dir }
  }

  async function profile(name) {
    const { built, dir } = await buildFor(name)
    if (built === null) return null
    await mkdir(cacheDir, { recursive: true, mode: 0o700 })
    await writeFile(join(cacheDir, `${name}.json`), JSON.stringify({ signature: built.signature, profile: built }), 'utf8')
      .catch(error => logger?.warn?.(`[live2d] 档案缓存写入失败：${error.message}`))
    void dir
    return built
  }

  /**
   * 编译一段表演需要的东西：档案 + motion3/exp3 的**内容**。
   *
   * 档案里只有名字（体积考虑，档案会被缓存到磁盘），而编译器要内容才能还原手势的
   * 进入/退出曲线和表情参数。所以这里直接给 scan 的原始资产，不写缓存。
   */
  async function catalog(name) {
    const { built, scan } = await buildFor(name)
    if (built === null) return null
    return {
      profile: built,
      expressions: scan.expressions ?? {},
      motions: scan.motions ?? {},
      modelDirName: name,
    }
  }

  /** 缓存命中就直接用，签名变了重建。 */
  async function profileCached(name) {
    const entry = await locate(name)
    if (entry === null) return null
    const signature = await dirSignature(entry.dir)
    try {
      const cached = JSON.parse(await readFile(join(cacheDir, `${name}.json`), 'utf8'))
      if (cached?.signature === signature && cached?.profile) return cached.profile
    } catch { /* 没有缓存或读不动，重建 */ }
    return profile(name)
  }

  /** 当前选中的模型：配置里指定 → 第一个可渲染的 → 第一个。 */
  async function resolve(configured) {
    const all = await discover()
    const models = all.map(({ dir, model3File, ...rest }) => rest)
    if (all.length === 0) return { models, name: null, entry: null, profile: null }
    // 用户自己导入的永远优先于随插件分发的示例模型；同类里再按可渲染、名字排。
    const ranked = [...all].sort((a, b) => {
      if (a.source !== b.source) return a.source === 'user' ? -1 : 1
      if (a.ready !== b.ready) return a.ready ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    const readyOnes = ranked.filter(model => model.ready)
    // 注意：不能写成 `(configured && find(...)) ?? readyOnes[0]`——
    // 空字符串配置会让 ?? 直接返回 ''，模型就变成 undefined。
    const wanted = typeof configured === 'string' && configured !== ''
      ? all.find(model => model.name === configured)
      : undefined
    const chosen = wanted ?? readyOnes[0] ?? all[0]
    return {
      models,
      name: chosen.name,
      entry: {
        name: chosen.name,
        source: chosen.source,
        ready: chosen.ready,
        modelPath: `${basePath}/models/${encodeURIComponent(chosen.name)}/${encodeURIComponent(chosen.model3File)}`,
      },
      profile: await profileCached(chosen.name).catch(error => ({ error: error.message })),
    }
  }

  return { list, discover, locate, profile, profileCached, catalog, resolve, roots }
}
