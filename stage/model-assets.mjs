/**
 * 编译一段表演需要的模型资料。
 *
 * 绝大部分**不用自己扫**：宿主的 `buildProfile` 已经把 `controlCatalog`（全参数
 * min/max/default）、`semanticIds`（可写语义输入）、`gestures`、`gestureJoints`、
 * `physicsOutputIds` 都算好放在 `/api/profile` 里了。这里只补两样它不带的**内容**：
 * `motion3` 与 `exp3` —— 而且只取这一份计划真正用到的那几个名字。
 *
 * 为什么不重算：中文字典（哪个参数是语义输入、哪个关节属于哪个手势）只能是模型知识，
 * 而知识只有宿主那一份。浏览器再推导一遍，就会出现「面板里能演、测试里不能演」的分叉。
 */

// 与 stage.mjs 同一个挂载前缀约定：独立运行时是空串。
const PREFIX = (typeof window !== 'undefined' && window.__STAGE_BASE__) ?? ''
const MODELS = `${PREFIX}/models`

/**
 * 纯组装：把 profile 与资产内容拼成编译器要的 catalog。
 * 测试可以直接喂 Node 读到的文件，不必起 HTTP。
 */
export function buildCatalog({ profile, expressions = {}, motions = {} }) {
  const params = new Map()
  for (const [id, entry] of Object.entries(profile?.controlCatalog ?? {})) {
    if (typeof entry?.min !== 'number' || typeof entry?.max !== 'number' || typeof entry?.default !== 'number') continue
    params.set(id, { min: entry.min, max: entry.max, default: entry.default })
  }
  return {
    params,
    primary: profile?.semanticIds ?? [],
    expressions,
    motions,
    gestures: profile?.gestures ?? {},
    gestureJoints: profile?.gestureJoints ?? {},
    physicsOutputs: new Set(profile?.physicsOutputIds ?? []),
  }
}

/**
 * 这份计划要用到哪些表情与原生动作。
 *
 * 只手势需要 motion3（进入/退出），只有 expression 需要 exp3。
 * 一个 20 秒的计划通常只碰 1~6 个名字，没必要把 8 个动作 23 个表情全拉一遍。
 */
export function requiredAssets(plan, gestures = {}) {
  const expressions = new Set()
  const motions = new Set()
  for (const action of plan?.actions ?? []) {
    if (!action || typeof action !== 'object') continue
    if (action.kind === 'expression' && typeof action.name === 'string') expressions.add(action.name)
    if (action.kind === 'gesture') {
      // 双手组合（hand_on_chest + point）要两套进入/退出动作。
      for (const name of [action.name, action.pair]) {
        const gesture = gestures[name]
        if (!gesture) continue
        if (typeof gesture.enter === 'string') motions.add(gesture.enter)
        if (typeof gesture.exit === 'string') motions.add(gesture.exit)
      }
    }
  }
  return { expressions: [...expressions].sort(), motions: [...motions].sort() }
}

const enc = (name) => encodeURIComponent(name)

/**
 * 按计划拉取所需资产，返回编译用的 catalog。
 *
 * @param {object} options
 * @param {object} options.plan               动作计划（用来决定拉什么）
 * @param {string} options.modelKey          `/models/<模型名>` 里的那一段（模型目录名）
 * @param {string} [options.profileUrl]
 * @param {Function} [options.fetchImpl]      便于测试注入
 * @param {AbortSignal} [options.signal]
 */
export async function loadCatalog({
  plan, modelKey, profileUrl = `${PREFIX}/api/profile`, fetchImpl = fetch, signal = null,
}) {
  const getJson = async (url, what) => {
    const response = await fetchImpl(url, { signal })
    if (!response.ok) throw new Error(`${what}取不到（HTTP ${response.status}）：${url}`)
    return response.json()
  }

  const payload = await getJson(profileUrl, '模型档案')
  // 宿主的 /api/profile 是信封形状 `{ ok, profile }`；测试注入的可能是裸档案，两种都接。
  const profile = payload?.profile ?? payload
  if (!profile || typeof profile !== 'object') throw new Error('模型档案是空的，无法编译表演')
  if (!modelKey) {
    // 退路：档案里的 modelPath 末段就是模型目录名。
    modelKey = String(profile?.modelPath ?? '').split(/[\\/]/).filter(Boolean).pop() ?? ''
  }
  if (!modelKey) throw new Error('不知道模型目录名，无法定位 motion3 / exp3')

  const need = requiredAssets(plan, profile?.gestures ?? {})
  const base = `${MODELS}/${enc(modelKey)}`

  const [expressions, motions] = await Promise.all([
    Promise.all(need.expressions.map(async (name) => [name, await getJson(`${base}/Exp3/${enc(name)}.exp3.json`, `表情「${name}」`)])),
    Promise.all(need.motions.map(async (name) => [name, await getJson(`${base}/Animation/${enc(name)}.motion3.json`, `动作「${name}」`)])),
  ])

  return buildCatalog({ profile, expressions: Object.fromEntries(expressions), motions: Object.fromEntries(motions) })
}

/** `data/performances/<name>.json` 的地址（名字不带后缀）。 */
export function performanceUrl(name) {
  return `${PREFIX}/data/performances/${enc(name)}.json`
}
