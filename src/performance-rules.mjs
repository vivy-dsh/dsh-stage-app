/**
 * 每模型的表演规则：**谁能动、谁和谁互斥、哪些通道交给手势系统**。
 *
 * 纯函数、无 I/O。判定口径来自 Soullink `scripts/conversation-service.mjs`（Apache-2.0）：
 * 同一套规则要同时供给三处，不能再各抄一份——
 *   1. 运行时（表演层消费 `performanceRules`）
 *   2. `tools/jev-gear-audit.mjs`（诊断：档位落点、危害清单）
 *   3. `tools/derive-performance-rules.mjs`（从真实模型资产派生声明）
 *
 * 规则分两半，这是刻意的：
 * - **derived（工具拥有、可重算）**：池子划分、手势关节、危害清单、档位健康度。
 * - **declared（人拥有、工具不碰）**：互斥组、外观排除、档位覆写。这些是判断，不是推导。
 */

/** 已知手部/道具开关（Soullink 的 LilyaBee 名单，仅作参考，不假设别的模型也有）。 */
export const HAND_ACTION_IDS = Object.freeze([
  'Param68', 'Param69', 'Param70', 'Param72', 'Param71', 'Param73',
  'Param74', 'Param75', 'Param76', 'Param77', 'Param108',
])

export const HAND_SWITCH_IDS = Object.freeze([...HAND_ACTION_IDS, 'Param86', 'Param87'])

/** 保护性外观（会毁掉呈现的通道）。 */
export const APPEARANCE_IDS = Object.freeze(['Param96', 'Param97', 'Param98'])

/** 口型开合归音频包络，不归判断层。 */
export const MOUTH_LIPSYNC_ID = 'ParamMouthOpenY'

/** 这些前缀的"角度"通道由模型自带参数，不进候选池。 */
export const PROTECTED_ANGLE_PREFIX = 'Param_Angle_'

const CONTINUOUS_BINARY_PATTERN = /(?:^|[ _-])(eye(?:[lr])?(?:open|smile)|eyeball|mouth|brow|cheek|breath|jaw|pucker|funnel|gaze|angle|bodyangle)(?:$|[ _-])/iu
const CONTINUOUS_ID_PATTERN = /^param(?:eye[lr]?(?:open|smile)|eyeball|mouth|jaw|brow|cheek|breath|angle|bodyangle)/iu
const PROTECTED_APPEARANCE_PATTERN = /(?:watermark|copyright|hidden|hide|invisible|disappear|水印|隐藏|消失|版权)/iu
const HAND_SEMANTIC_PATTERN = /(?:hand|arm|gesture|wave|waving|sign|prop|accessory|挥手|招手|手|手臂|比心|猫手|祈祷|鞭子|碗|糖|歌|游戏|内裤|猫)/iu

/** 走编辑器分组分隔线的通道（不是视觉参数）。 */
const EDITOR_ONLY_PATTERN = /^Divider\d+$/u
/** 待机动画触发开关。 */
const IDLE_TRIGGER_PATTERN = /^IDLE$/u
/** 动画触发器：量程不是 0..1 时逃得过"二值开关"判定，必须单独处理。 */
const ANIMATION_TRIGGER_PATTERN = /^(?:Ani\d+|Ani[A-Za-z]+)$/u
/** 外观类（服装 / 眼镜 / 尾巴 / 鞋子 / 大小变）。 */
const APPEARANCE_NAME_PATTERN = /眼镜|裙子|鞋子|尾巴|长短|胸口衣服|大钢盆|服装|衣服/u

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

/** 严格二值动作开关：量程 0..1，且 id/name 不像连续通道。 */
export function isDiscreteActionParameter(parameter) {
  if (parameter.min !== 0 || parameter.max !== 1) return false
  return !CONTINUOUS_ID_PATTERN.test(parameter.id) &&
    !CONTINUOUS_BINARY_PATTERN.test(`${parameter.id} ${parameter.name ?? ''}`)
}

export function isProtectedAppearanceParameter(parameter) {
  return APPEARANCE_IDS.includes(parameter.id) ||
    PROTECTED_APPEARANCE_PATTERN.test(`${parameter.id} ${parameter.name ?? ''}`)
}

/** 手部/道具开关：二值开关，且 id 在已知名单里或名字带手部语义。 */
export function isHandActionParameter(parameter) {
  return isDiscreteActionParameter(parameter) &&
    (HAND_SWITCH_IDS.includes(parameter.id) || HAND_SEMANTIC_PATTERN.test(`${parameter.id} ${parameter.name ?? ''}`))
}

/**
 * 语义档位：neutral 取参数真实 default（不是量程中点），其余按"到该侧端点的距离"取比例。
 * 直觉：default 压在端点的通道只有单侧可动，ratio 直接跳过不存在的一侧。
 */
export function semanticGears(parameter, ladder = GEAR_LADDER) {
  const neutral = clamp(parameter.default, parameter.min, parameter.max)
  const options = { neutral }
  for (const [key, ratio] of ladder) {
    const distance = ratio < 0 ? neutral - parameter.min : parameter.max - neutral
    if (distance <= 1e-9) continue
    const value = clamp(neutral + distance * ratio, parameter.min, parameter.max)
    if (!Object.values(options).some((existing) => Math.abs(existing - value) <= 1e-9)) options[key] = value
  }
  return options
}

/** 现行档位：35 / 65 / 90 %。 */
export const GEAR_LADDER = Object.freeze([
  ['smallNegative', -0.35], ['mediumNegative', -0.65], ['largeNegative', -0.9],
  ['smallPositive', 0.35], ['mediumPositive', 0.65], ['largePositive', 0.9],
])

/** 旧档位：20 / 50 / 80 %，只用于对照"small 档在量程上占多少"。 */
export const LEGACY_GEAR_LADDER = Object.freeze([
  ['smallNegative', -0.2], ['mediumNegative', -0.5], ['largeNegative', -0.8],
  ['smallPositive', 0.2], ['mediumPositive', 0.5], ['largePositive', 0.8],
])

/** 一个通道的档位形态。 */
export function gearShape(parameter, ladder = GEAR_LADDER) {
  const options = semanticGears(parameter, ladder)
  const values = Object.entries(options).filter(([key]) => key !== 'neutral')
  const negative = values.filter(([key]) => key.endsWith('Negative')).length
  const positive = values.filter(([key]) => key.endsWith('Positive')).length
  const span = parameter.max - parameter.min
  const smallKey = negative ? 'smallNegative' : 'smallPositive'
  const small = options[smallKey] === undefined ? 0 : Math.abs(options[smallKey] - options.neutral)
  return {
    options,
    sides: negative && positive ? 'both' : negative ? 'negativeOnly' : positive ? 'positiveOnly' : 'none',
    gearCount: values.length,
    smallPctOfSpan: span > 0 ? +(small / span * 100).toFixed(2) : 0,
  }
}

/**
 * 池子划分：哪些通道归谁。
 * @param {Array} parameters 参数（需含 id/min/max/default，name 可选）
 * @param {{physicsIds?: Set<string>|Iterable<string>, knowledge?: object|null}} options
 */
export function selectPools(parameters, { physicsIds = new Set(), knowledge = null } = {}) {
  const physics = new Set(physicsIds)
  const joints = new Set(gestureJointIds(knowledge))
  // 模型知识里手挑的语义参数一律算连续通道。
  // 为什么需要这一条：Soullink 的连续通道正则要求 id/name 里有词分隔符，
  // `MouthSmile_L` / `BrowInnerUp` / `CheeckPuff` / `JawOpen` / `TongueOut` /
  // `Mouthpucker` / `MouthFunnel` / `LEyeSquint` / `REyeSquint` 这类名字命中不了，
  // 于是量程 0..1 的它们被判成"严格二值开关"——微笑会直接蹦成满格，眯眼会变成闭眼。
  const forcedContinuous = new Set(knowledge?.primary ?? [])
  const handIds = new Set(parameters
    .filter((parameter) => !physics.has(parameter.id) && isHandActionParameter(parameter))
    .map((parameter) => parameter.id))

  const attribution = new Map()
  const eligible = []
  for (const parameter of parameters) {
    let kind
    if (physics.has(parameter.id)) kind = 'physics-output'
    else if (isProtectedAppearanceParameter(parameter)) kind = 'protected-appearance'
    else if (handIds.has(parameter.id)) kind = 'hand-switch'
    else if (parameter.id === MOUTH_LIPSYNC_ID) kind = 'mouth-lipsync'
    else if (parameter.id.startsWith(PROTECTED_ANGLE_PREFIX)) kind = 'protected-angle'
    else {
      kind = !forcedContinuous.has(parameter.id) && isDiscreteActionParameter(parameter)
        ? 'eligible-switch'
        : 'eligible-continuous'
      eligible.push(parameter)
    }
    attribution.set(parameter.id, kind)
  }

  const isSwitch = (parameter) => !forcedContinuous.has(parameter.id) && isDiscreteActionParameter(parameter)
  return {
    eligible,
    switches: eligible.filter(isSwitch),
    continuous: eligible.filter((parameter) => !isSwitch(parameter)),
    forcedContinuous,
    handIds,
    jointIds: [...joints],
    attribution,
    counts: countBy([...attribution.values()]),
  }
}

function countBy(values) {
  const counts = {}
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return counts
}

/** 从模型知识里取手势关节 id（去重、保序）。 */
export function gestureJointIds(knowledge) {
  const joints = knowledge?.gestureJoints ?? {}
  const seen = new Set()
  for (const mapping of Object.values(joints)) {
    if (!mapping || typeof mapping !== 'object') continue
    for (const id of Object.values(mapping)) if (typeof id === 'string' && id) seen.add(id)
  }
  return [...seen]
}

/** 从模型知识里取"手势名 → 开关 id"。 */
export function gestureSwitches(knowledge) {
  const gestures = knowledge?.gestures ?? {}
  const result = {}
  for (const [name, mapping] of Object.entries(gestures)) {
    const id = mapping?.switch
    if (typeof id === 'string' && id) result[name] = id
  }
  return result
}

/**
 * 派生"工具拥有"的那一半：机械可算的部分 + 需要人看一眼的危害清单。
 * 不产出互斥组与外观排除（那些是判断，写在 declared 里）。
 */
export function derivePerformanceRules({ parameters, physicsIds, knowledge = null, modelName = null }) {
  const pools = selectPools(parameters, { physicsIds, knowledge })
  const byId = new Map(parameters.map((parameter) => [parameter.id, parameter]))

  const continuousShapes = pools.continuous.map((parameter) => ({
    parameter,
    shape: gearShape(parameter),
    legacy: gearShape(parameter, LEGACY_GEAR_LADDER),
  }))
  const smallPcts = continuousShapes.map(({ shape }) => shape.smallPctOfSpan)
  const legacySmallPcts = continuousShapes.map(({ legacy }) => legacy.smallPctOfSpan)

  // 危害：不该进候选池、或进了会出事的通道
  const hazards = []
  const note = (id, reason) => {
    const parameter = byId.get(id)
    if (parameter) hazards.push({ id, name: parameter.name ?? id, reason })
  }
  for (const parameter of pools.eligible) {
    if (IDLE_TRIGGER_PATTERN.test(parameter.id)) note(parameter.id, '待机动画触发开关，接管会与待机系统抢控制权')
    else if (EDITOR_ONLY_PATTERN.test(parameter.id)) note(parameter.id, '编辑器分组分隔线，不是视觉参数')
  }
  for (const id of knowledge?.experimentalInputs?.ids ?? []) note(id, '作者配置存在但实测无可见变化，接管是白费注意力')

  // 非 0..1 量程的动画触发器：逃得过二值开关判定，会被当成连续通道给出分数值
  const animationTriggers = pools.eligible
    .filter((parameter) => ANIMATION_TRIGGER_PATTERN.test(parameter.id))
    .map((parameter) => ({
      id: parameter.id,
      name: parameter.name ?? parameter.id,
      min: parameter.min,
      max: parameter.max,
      default: parameter.default,
      reason: parameter.min === 0 && parameter.max === 1
        ? '动画触发开关（量程 0..1）'
        : '动画触发器量程不是 0..1，会被当成连续通道给出分数值；只允许端点',
    }))

  // 每参数独立问 o_{id}，没有互斥组的通道会被同屏点亮 —— 列出家族供人组队
  const families = exclusiveFamilyCandidates(pools.switches)

  // 外观类候选：名字像服装/眼镜/尾巴的开关。工具只报候选，是否排除由 declared 决定。
  const appearanceCandidates = pools.switches
    .filter((parameter) => APPEARANCE_NAME_PATTERN.test(`${parameter.name ?? ''} ${parameter.id}`))
    .map((parameter) => ({ id: parameter.id, name: parameter.name ?? parameter.id, default: parameter.default }))

  // default=1 的开关：off/on 语义与常规相反的嫌疑，需要人确认
  const defaultOnSwitches = pools.switches
    .filter((parameter) => parameter.default === 1)
    .map((parameter) => ({ id: parameter.id, name: parameter.name ?? parameter.id }))

  return {
    schemaVersion: 1,
    model: modelName,
    pools: {
      parameters: parameters.length,
      physicsOutput: pools.counts['physics-output'] ?? 0,
      handSwitch: pools.counts['hand-switch'] ?? 0,
      mouthLipsync: pools.counts['mouth-lipsync'] ?? 0,
      protectedAngle: pools.counts['protected-angle'] ?? 0,
      protectedAppearance: pools.counts['protected-appearance'] ?? 0,
      eligibleSwitch: pools.switches.length,
      eligibleContinuous: pools.continuous.length,
    },
    soullinkDetectedHandSwitches: [...pools.handIds],
    /**
     * 作者物理的输出通道。编译器靠它拒绝「直接驱动物理输出」的计划，
     * 舞台也靠它判断一段表演能不能接受——不落这份名单，前端就得自己再拉一遍 216K 的 physics3。
     */
    physicsOutputIds: [...physicsIds].sort(),
    /** 被通用正则误判成二值开关、由模型知识纠回来的通道。 */
    forcedContinuous: pools.continuous
      .filter((parameter) => pools.forcedContinuous.has(parameter.id) && isDiscreteActionParameter(parameter))
      .map((parameter) => ({ id: parameter.id, name: parameter.name ?? parameter.id })),
    poolIds: {
      eligibleSwitch: pools.switches.map((parameter) => parameter.id),
      eligibleContinuous: pools.continuous.map((parameter) => parameter.id),
    },
    gestureJoints: pools.jointIds.map((id) => {
      const parameter = byId.get(id)
      return parameter
        ? { id, name: parameter.name ?? id, min: parameter.min, max: parameter.max, default: parameter.default, pool: pools.attribution.get(id) }
        : { id, pool: 'absent' }
    }),
    gestureSwitches: gestureSwitches(knowledge),
    experimentalInputs: (knowledge?.experimentalInputs?.ids ?? []).map((id) => ({ id, name: byId.get(id)?.name ?? id })),
    animationTriggers,
    hazards,
    families,
    appearanceCandidates,
    defaultOnSwitches,
    oneSided: continuousShapes
      .filter(({ shape }) => shape.sides !== 'both')
      .map(({ parameter, shape }) => ({ id: parameter.id, name: parameter.name ?? parameter.id, min: parameter.min, max: parameter.max, default: parameter.default, sides: shape.sides })),
    gearHealth: {
      continuous: continuousShapes.length,
      bothSides: continuousShapes.filter(({ shape }) => shape.sides === 'both').length,
      oneSided: continuousShapes.filter(({ shape }) => shape.sides !== 'both').length,
      noGear: continuousShapes.filter(({ shape }) => shape.sides === 'none').length,
      minSmallPctOfSpan: smallPcts.length ? Math.min(...smallPcts) : 0,
      maxSmallPctOfSpan: smallPcts.length ? Math.max(...smallPcts) : 0,
      minSmallPctOfSpanLegacyLadder: legacySmallPcts.length ? Math.min(...legacySmallPcts) : 0,
      maxSmallPctOfSpanLegacyLadder: legacySmallPcts.length ? Math.max(...legacySmallPcts) : 0,
    },
  }
}

/** 能被整体当作一族去登记互斥的开关家族（≥2 个成员才算）。 */
export function exclusiveFamilyCandidates(switches) {
  const families = [
    ['face-effect', /^key\d+$/u, '表情/脸部特效开关', 'single'],
    ['gesture', /^Movement\d+$/u, '手部姿态开关', 'single'],
    ['sweat', /^SweatBurst\d+$/u, '冒汗特效开关', 'single'],
    ['face-animation', /^(?:F\dAnikey|SWITCHA)$/u, '脸部动画开关', 'single'],
    ['cry', /^(?:R|L)CryKey$/u, '落泪开关（同一件事的两个通道）', 'single'],
    ['costume', /^Clothes\d+$/u, '服装/外观切换', 'independent'],
  ]
  const result = []
  for (const [id, pattern, label, mode] of families) {
    const members = switches.filter((parameter) => pattern.test(parameter.id)).map((parameter) => parameter.id)
    if (members.length >= 2) result.push({ id, label, mode, members })
  }
  return result
}

/**
 * 校验规则：抓"改了数据没改规则"和"规则里写了不存在的通道"。
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validatePerformanceRules(rules, { parameters }) {
  const errors = []
  const warnings = []
  const ids = new Set(parameters.map((parameter) => parameter.id))
  const checkIds = (list, where) => {
    for (const id of list ?? []) if (!ids.has(id)) errors.push(`${where} 引用了不存在的通道：${id}`)
  }

  const pools = rules?.derived?.pools
  if (!pools) { errors.push('缺 derived.pools'); return { errors, warnings } }

  const declared = rules.declared ?? {}
  const excluded = new Set(Object.values(declared.excluded ?? {}).flat().map((entry) => entry.id ?? entry))
  // derived.poolIds 是"只按 Soullink 规则算出来的池子"，即**未减掉 declared 排除项**的原始池。
  // 有效池 = 原始池 − 排除名单；下面所有不变量都针对有效池。
  const eligibleContinuous = new Set((rules.derived.poolIds?.eligibleContinuous ?? [])
    .filter((id) => !excluded.has(id)))
  const gestureJoints = (rules.derived.gestureJoints ?? []).map((entry) => entry.id)

  // 1. 手势关节必须被摘出候选池
  for (const id of gestureJoints) {
    if (eligibleContinuous.has(id)) errors.push(`手势关节仍在候选池里：${id}（应在 declared.excluded 里）`)
  }
  // 1b. 模型知识里手挑的语义参数不能被判成二值开关
  const eligibleSwitch = new Set((rules.derived.poolIds?.eligibleSwitch ?? [])
    .filter((id) => !excluded.has(id)))
  for (const id of rules.derived.forcedContinuous ?? []) {
    if (eligibleSwitch.has(id.id)) errors.push(`语义参数被当成二值开关：${id.id}（${id.name}）`)
  }
  // 2. 手势开关必须在排除名单里
  for (const [name, id] of Object.entries(rules.derived.gestureSwitches ?? {})) {
    checkIds([id], `gestureSwitches.${name}`)
    if (!excluded.has(id)) errors.push(`手势开关没有被排除出候选池：${name} → ${id}`)
  }
  // 3. 危害通道必须被排除
  for (const hazard of rules.derived.hazards ?? []) {
    if (!excluded.has(hazard.id)) errors.push(`危害通道没有被排除：${hazard.id}（${hazard.reason}）`)
  }
  // 4. 二值动作类动画触发器必须被排除或显式覆写
  const overrides = declared.gearOverrides ?? {}
  for (const trigger of rules.derived.animationTriggers ?? []) {
    if (trigger.min === 0 && trigger.max === 1) {
      if (!excluded.has(trigger.id)) warnings.push(`量程 0..1 的动画触发器仍在候选池：${trigger.id}（${trigger.name}）`)
    } else if (!excluded.has(trigger.id) && overrides[trigger.id] === undefined) {
      errors.push(`量程非 0..1 的动画触发器既没排除也没覆写：${trigger.id}`)
    }
  }
  // 5. 互斥组
  const seen = new Map()
  for (const group of declared.exclusiveGroups ?? []) {
    if (!Array.isArray(group.members) || group.members.length < 2) errors.push(`互斥组 ${group.id} 成员不足 2 个`)
    checkIds(group.members, `exclusiveGroups.${group.id}`)
    for (const id of group.members ?? []) {
      if (group.mode === 'single' && seen.has(id)) errors.push(`通道同时属于两个单选组：${id}（${seen.get(id)} 与 ${group.id}）`)
      if (group.mode === 'single') seen.set(id, group.id)
    }
  }
  // 6. 排除名单
  for (const [bucket, list] of Object.entries(declared.excluded ?? {})) {
    checkIds(list.map((entry) => entry.id ?? entry), `excluded.${bucket}`)
  }
  // 7. 档位覆写目标必须存在
  checkIds(Object.keys(overrides), 'gearOverrides')
  // 9. 档位可读性底线
  const health = rules.derived.gearHealth ?? {}
  if (health.noGear > 0) warnings.push(`有 ${health.noGear} 个连续通道完全没有档位`)
  if (health.minSmallPctOfSpan === 0 && health.continuous > 0) errors.push('存在 small 档位移为 0 的连续通道')

  return { errors, warnings }
}
