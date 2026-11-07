// 模型档案（profile）构建：把模型目录里的作者文件整理成舞台可用的只读目录。
//
// 这是鲸语 `model_profile.py` 的移植版，差别只有两处：
//   1. 鲸语写死「大肥鱼」单个模型；这里接受任意模型目录。
//   2. 模型专属知识（语义参数集、手势、关节绑定）从 data/knowledge/*.json 读，
//      没有对应知识就用通用推导。于是「作者手工调过的那个模型」和「用户自己导入的模型」
//      走同一条代码路径，只是知识密度不同。
//
// 只读：不修改模型的任何文件，只产出 profile 对象。
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Cubism 标准语义参数：即使没有专属知识，这些 id 也直接可用。 */
export const STANDARD_PRIMARY = [
  'ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
  'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ',
  'ParamEyeBallX', 'ParamEyeBallY', 'ParamEyeLOpen', 'ParamEyeROpen',
  'ParamBrowLY', 'ParamBrowRY', 'ParamMouthForm', 'ParamMouthOpenY', 'ParamBreath',
]

/** 作者物理输出参数：舞台永远不写，交给模型自带的物理。 */
export function physicsOutputIds(physics) {
  const out = new Set()
  for (const setting of physics?.PhysicsSettings ?? []) {
    for (const output of setting.Output ?? []) {
      const id = output?.Destination?.Id
      if (typeof id === 'string') out.add(id)
    }
  }
  return out
}

export function physicsInputIds(physics) {
  const out = new Set()
  for (const setting of physics?.PhysicsSettings ?? []) {
    for (const input of setting.Input ?? []) {
      const id = input?.Source?.Id
      if (typeof id === 'string') out.add(id)
    }
  }
  return out
}

/** 原生手势参数：由作者动作曲线驱动，不是语义输入。 */
export function gestureParameterIds(motions, gestures) {
  const ids = new Set()
  const groups = new Set()
  for (const gesture of Object.values(gestures ?? {})) {
    for (const group of [gesture.enter, gesture.exit]) if (typeof group === 'string') groups.add(group)
  }
  for (const group of groups) {
    for (const curve of motions?.[group]?.Curves ?? []) {
      if (curve?.Target === 'Parameter' && typeof curve.Id === 'string') ids.add(curve.Id)
    }
  }
  return ids
}

/** 作者表情占用的参数。 */
export function expressionParameterIds(expressions) {
  const ids = new Set()
  for (const expression of Object.values(expressions ?? {})) {
    for (const parameter of expression?.Parameters ?? []) {
      if (typeof parameter?.Id === 'string') ids.add(parameter.Id)
    }
  }
  return ids
}

/**
 * 给每个参数标上归属，舞台据此决定谁可以写。
 *   author-physics     作者物理输出，永不写
 *   semantic           语义输入，舞台的主力
 *   native-gesture     手势关节，只能由手势动作驱动
 *   author-expression  作者表情占用
 *   unmapped           其余（私有效果），需人工校准后才碰
 */
export function buildControlCatalog({ coreInventory, knowledge, physics, expressions, motions }) {
  const primary = new Set(knowledge?.primary ?? STANDARD_PRIMARY)
  const outputs = physicsOutputIds(physics)
  const gestures = gestureParameterIds(motions, knowledge?.gestures)
  const exprs = expressionParameterIds(expressions)
  const catalog = {}
  for (const parameter of coreInventory?.parameters ?? []) {
    const id = parameter.id
    const owner = outputs.has(id) ? 'author-physics'
      : primary.has(id) ? 'semantic'
        : gestures.has(id) ? 'native-gesture'
          : exprs.has(id) ? 'author-expression'
            : 'unmapped'
    catalog[id] = { owner, min: parameter.min, max: parameter.max, default: parameter.default }
  }
  return catalog
}

/** 语义参数的可写范围：物理输出与呼吸一律排除，呼吸由待机自己管。 */
export function semanticWritableRange(catalog, { exclude = [] } = {}) {
  const skip = new Set(exclude)
  const values = {}
  for (const [id, entry] of Object.entries(catalog)) {
    if (entry.owner !== 'semantic' || skip.has(id)) continue
    values[id] = [entry.min, entry.max]
  }
  return values
}

function countOwner(catalog, owner) {
  let n = 0
  for (const entry of Object.values(catalog)) if (entry.owner === owner) n += 1
  return n
}

function displayNames(cdi3) {
  const names = {}
  for (const item of cdi3?.Parameters ?? []) {
    if (typeof item?.Id === 'string' && typeof item?.Name === 'string') names[item.Id] = item.Name
  }
  return names
}

/**
 * 组装 profile。所有入参都是已解析的 JSON；缺哪个就少哪块能力，不抛异常。
 * @param {object} input
 * @param {object} input.coreInventory 参数总清单（id/min/max/default）
 * @param {object} [input.knowledge] 模型专属知识（primary/gestures/gestureJoints/model/credit）
 * @param {object} [input.cdi3] 参数显示名
 * @param {object} [input.physics] physics3.json
 * @param {object} [input.expressions] { 名称: exp3.json }
 * @param {object} [input.motions] { 名称: motion3.json }
 * @param {object} [input.vts] vtube.json（可选的 VTS 映射）
 * @param {string} [input.modelPath] 浏览器加载模型用的 URL
 */
export function buildProfile(input) {
  const {
    coreInventory, knowledge = null, cdi3 = null, physics = null,
    expressions = {}, motions = {}, vts = null, modelPath = null,
  } = input ?? {}
  if (!coreInventory || !Array.isArray(coreInventory.parameters)) {
    throw new Error('core-inventory 缺少 parameters，无法建立档案')
  }

  const names = displayNames(cdi3)
  const parameters = coreInventory.parameters.map(p => (names[p.id] ? { ...p, name: names[p.id] } : { ...p }))
  const byId = new Map(parameters.map(p => [p.id, p]))
  const catalog = buildControlCatalog({ coreInventory, knowledge, physics, expressions, motions })

  const primary = (knowledge?.primary ?? STANDARD_PRIMARY).filter(id => byId.has(id))
  const expressionsNames = Object.keys(expressions)
  const gestureIds = new Set(Object.keys(knowledge?.gestures ?? {}))
  const idleName = knowledge?.idleMotion ?? (motions.IDLE ? 'IDLE' : Object.keys(motions)[0] ?? null)

  return {
    schemaVersion: 1,
    model: knowledge?.model ?? coreInventory.name ?? 'unknown',
    credit: knowledge?.credit ?? null,
    modelPath,
    counts: {
      parameters: coreInventory.parameterCount ?? parameters.length,
      parts: coreInventory.partCount ?? null,
      drawables: coreInventory.drawableCount ?? null,
      physics: physics?.PhysicsSettings?.length ?? 0,
      motions: Object.keys(motions).length,
      expressions: expressionsNames.length,
      semantic: primary.length,
      unmapped: countOwner(catalog, 'unmapped'),
    },
    canvas: coreInventory.canvas ?? null,
    coreVersion: coreInventory.coreVersion ?? null,
    // 语义输入：舞台唯一可以自由写的参数。
    semanticIds: primary,
    parameters: primary.map(id => byId.get(id)),
    writableRange: semanticWritableRange(catalog, { exclude: ['ParamBreath'] }),
    // 作者资产：只能整段触发，不能逐帧摆。
    expressions: expressionsNames,
    motions: Object.keys(motions),
    gestures: knowledge?.gestures ?? {},
    gestureJoints: knowledge?.gestureJoints ?? {},
    idleMotion: idleName,
    // 所有权：谁都不能越界。
    controlCatalog: catalog,
    physicsInputIds: [...physicsInputIds(physics)].sort(),
    physicsOutputIds: [...physicsOutputIds(physics)].sort(),
    vtsMappings: vts?.ParameterSettings ?? null,
  }
}

const SIDECAR = {
  cdi3: /\.cdi3\.json$/i,
  physics: /\.physics3\.json$/i,
  vtube: /\.vtube\.json$/i,
  model3: /\.model3\.json$/i,
  coreInventory: /^core-inventory\.json$/i,
}

async function readJsonIfPresent(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return null }
}

/** 一侧目录里的 exp3 / motion3，按文件名（去后缀）索引。 */
async function readJsonDir(dir) {
  const out = {}
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(exp3|motion3)\.json$/i.test(entry.name)) continue
    const json = await readJsonIfPresent(join(dir, entry.name))
    if (json) out[entry.name.replace(/\.(?:exp3|motion3)\.json$/i, '')] = json
  }
  return out
}

/**
 * 扫描一个模型目录，读出 profile 需要的全部素材。
 * 缺 core-inventory 时用 model3.json 的参数引用尽力兜底（数量会不全）。
 */
export async function scanModelDir(dir, { knowledge = null } = {}) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch {
    throw new Error(`模型目录不存在或不可读：${dir}`)
  }
  const files = entries.filter(e => e.isFile()).map(e => e.name)
  const pick = pattern => files.find(name => pattern.test(name)) ?? null
  const cdi3File = pick(SIDECAR.cdi3)
  const physicsFile = pick(SIDECAR.physics)
  const vtubeFile = pick(SIDECAR.vtube)
  const model3File = pick(SIDECAR.model3)
  const inventoryFile = pick(SIDECAR.coreInventory)
  const moc3File = files.find(name => /\.moc3$/i.test(name)) ?? null

  const [coreInventory, cdi3, physics, vts, model3] = await Promise.all([
    inventoryFile ? readJsonIfPresent(join(dir, inventoryFile)) : null,
    cdi3File ? readJsonIfPresent(join(dir, cdi3File)) : null,
    physicsFile ? readJsonIfPresent(join(dir, physicsFile)) : null,
    vtubeFile ? readJsonIfPresent(join(dir, vtubeFile)) : null,
    model3File ? readJsonIfPresent(join(dir, model3File)) : null,
  ])
  const [expressions, motions] = await Promise.all([
    readJsonDir(join(dir, 'Exp3')),
    readJsonDir(join(dir, 'Animation')),
  ])

  return { dir, files, coreInventory, cdi3, physics, vts, model3, moc3File, model3File, expressions, motions }
}

/** 目录里有没有能真正渲染的东西（.moc3 + model3.json）。 */
export function renderReady(scan) {
  return Boolean(scan?.moc3File && scan?.model3File)
}

export { readJsonIfPresent }
