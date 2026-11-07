// 给模型看的能力说明。
//
// 为什么要单独一份：模型不知道这个模型有哪些参数、哪些表情、手势叫什么。
// 让它「先读能力、再编排」，比把 509 个参数硬塞进提示词便宜得多，也不容易编出不存在的通道。
//
// 为什么从编译器渲染而不是手写：动作清单手写两份就会漂——这个项目已经因为
// 「每个工具各抄一份规则」漏报过两次（见 research §6.2）。这里只做「渲染」，
// 规格表与硬规矩全部来自 performance-compiler.mjs。

import { ACTION_SPEC, ACTION_COMMON_FIELDS } from '../stage/performance-compiler.mjs'

/** 硬规矩：写进说明里，让模型一开始就知道什么会被拒。 */
export const HARD_RULES = Object.freeze([
  '每个计划是一条 {version:1, actions:[…]}，1..24 个动作，总长不超过 60 秒。',
  'pose / trajectory / recorded 只能写「语义输入」里的参数，且不能写 ParamBreath。',
  '物理输出通道一律不可写（作者物理在用）。',
  '两个动作同时控制同一个参数超过 15 毫秒会被拒绝；唯一例外是一侧是 expression 且 layer 为 overlay。',
  'gesture 的时长不够会自动延长以保留作者的进入/退出动作，并给出警告。',
  '参数值超出模型范围会被夹取并警告，不会报错。',
])

/** 优先拿一个「真表情」当示例，而不是换装开关。 */
const EXAMPLE_EXPRESSION_PREFERENCE = ['脸红', '＞＜', '流泪', '屑屑眼', '流冷汗', '兔牙', '黑脸']

function pickFacialExpression(expressions) {
  for (const name of EXAMPLE_EXPRESSION_PREFERENCE) {
    if (expressions.includes(name)) return name
  }
  return null
}

const rangeText = (field) => field.values ? field.values.join(' | ') : field.range ?? field.note ?? ''

/** 把能力整理成一个可直接给模型看的结构。 */
export function buildCapabilities(profile) {
  if (!profile || typeof profile !== 'object') throw new Error('缺少模型档案，无法生成能力说明')
  const semanticIds = Array.isArray(profile.semanticIds) ? profile.semanticIds : []
  const expressions = Array.isArray(profile.expressions) ? profile.expressions : []
  const gestures = profile.gestures && typeof profile.gestures === 'object' ? profile.gestures : {}
  const gestureJoints = profile.gestureJoints && typeof profile.gestureJoints === 'object' ? profile.gestureJoints : {}
  const catalog = profile.controlCatalog && typeof profile.controlCatalog === 'object' ? profile.controlCatalog : {}

  /** 语义输入连同范围一起给：模型据此能给出像样的数值。 */
  const semantic = semanticIds.map((id) => {
    const entry = catalog[id]
    return {
      id,
      ...entry && typeof entry.min === 'number' ? { min: entry.min, max: entry.max, default: entry.default } : {},
    }
  })

  return {
    version: 1,
    model: profile.model ?? null,
    actions: ACTION_SPEC.map((spec) => ({
      kind: spec.kind,
      summary: spec.summary,
      fields: spec.fields.map((field) => ({
        name: field.name,
        ...field.required === true ? { required: true } : {},
        ...rangeText(field) === '' ? {} : { values: rangeText(field) },
        ...field.from === undefined ? {} : { from: field.from },
      })),
    })),
    common: ACTION_COMMON_FIELDS.map((field) => ({ name: field.name, range: rangeText(field) })),
    rules: [...HARD_RULES],
    semanticIds: semantic,
    expressions,
    gestures: Object.entries(gestures).map(([name, gesture]) => ({
      name,
      label: gesture?.label ?? name,
      ...Array.isArray(Object.keys(gestureJoints[name] ?? {})) && Object.keys(gestureJoints[name] ?? {}).length > 0
        ? { joints: Object.keys(gestureJoints[name]) }
        : {},
    })),
    example: {
      version: 1,
      intent: '被夸了，有点不好意思又开心',
      actions: [
        { kind: 'look', direction: 'down', at: 0, duration: 1.4, strength: 0.6 },
        // 例子里要挑一个**真表情**：这个模型的 23 个「表情」里有一半是换装/道具开关，
        // 拿列表第一个当例子会教坏模型（第一个恰好是「体型1」）。
        ...(pickFacialExpression(expressions) === null ? [] : [
          { kind: 'expression', name: pickFacialExpression(expressions), layer: 'overlay', at: 0.2, duration: 2.4, strength: 0.8 },
        ]),
        { kind: 'tilt', direction: 'left', at: 0.6, duration: 1.8, strength: 0.5 },
      ],
    },
  }
}

/**
 * 渲染成紧凑文本（模型的 token 是有限的，别把它撑爆）。
 * 目标 < 4 KB；测试里有体积断言。
 */
export function renderCapabilitiesText(capabilities) {
  const lines = []
  lines.push(`模型：${capabilities.model ?? '当前角色'}｜计划形状 {version:1, intent?, summary?, actions:[…]}`)
  lines.push('')
  lines.push('## 动作')
  for (const action of capabilities.actions) {
    const fields = action.fields
      .map((field) => {
        const extra = field.from ? `，取 ${field.from} 里的名字` : field.values ? `，${field.values}` : ''
        return `${field.name}${field.required ? '*' : ''}${extra}`
      })
      .join('；')
    lines.push(`- ${action.kind}：${action.summary}${fields === '' ? '' : `（${fields}）`}`)
  }
  lines.push(`- 通用字段：${capabilities.common.map((field) => `${field.name} ${field.range}`).join('；')}`)
  lines.push('')
  lines.push('## 规矩（违反会被拒绝）')
  for (const rule of capabilities.rules) lines.push(`- ${rule}`)
  lines.push('')
  lines.push(`## 可写语义输入（${capabilities.semanticIds.length} 个，pose/trajectory/recorded 只能用这些）`)
  // 紧凑写：范围是模型给数值时的依据，默认值它用不上，省下的是 token。
  lines.push(capabilities.semanticIds
    .map((item) => item.min === undefined ? item.id : `${item.id}[${item.min}..${item.max}]`)
    .join('、'))
  lines.push('')
  lines.push(`## 表情（expression.name 只能用这些，${capabilities.expressions.length} 个）`)
  lines.push(capabilities.expressions.join('、'))
  lines.push('')
  lines.push(`## 手势（gesture.name 只能用这些，${capabilities.gestures.length} 个）`)
  for (const gesture of capabilities.gestures) {
    lines.push(`- ${gesture.name}（${gesture.label}）${gesture.joints ? `｜关节：${gesture.joints.join('、')}` : ''}`)
  }
  lines.push('')
  lines.push('## 最小示例')
  lines.push(JSON.stringify(capabilities.example))
  return lines.join('\n')
}
