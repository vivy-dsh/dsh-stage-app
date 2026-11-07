/**
 * 语义动作 → 有界、带缓动的参数轨迹。
 *
 * 移植自鲸语 `compiler.py`（294 行，语义逐条对齐）。它只做一件事：
 * 把「点头两次 / 歪头 / 拿起狗尾草 / 表情：加载」这种**语义**动作，
 * 展开成每个参数的 `[[局部时间, 数值], …]` 折线。**它从不解析自然语言**，
 * 也不联网——计划从哪来（作者手写、默认模型、JEV）它不关心。
 *
 * 为什么放在 stage/ 而不是 src/：
 *   这份代码必须同时被**浏览器**和 **node --test** 使用；stage/ 是磁盘直出的目录，
 *   刷新即生效；src/ 要重建客户端 bundle。纯函数放在能被两边都 import 的地方。
 *
 * 三条硬规矩（对应 compiler.py 的 add()）：
 *   1. 物理输出通道永远不可直接驱动 —— 作者的那套物理是模型手感的一半；
 *   2. pose / trajectory / recorded 只能写 `primary` 里的语义输入，且不能碰 `ParamBreath`；
 *   3. 同一参数被两个动作在 15 毫秒以上的区间同时控制 → 拒绝（除非明确的 expression overlay）。
 */

import { bindArmTracks } from './arm-binding.mjs'

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

/**
 * 12 种语义动作的规格表。
 *
 * 存在的理由是**不出现两份真相**：能力说明（给模型看的）由它渲染，
 * 而不是在 capabilities 里另抄一遍动作清单——这个项目已经因为「每个工具各抄一份规则」
 * 漏报过两次（research §6.2）。测试里有一条交叉检查：表里列的 kind 编译器都认，
 * 编译器认的 kind 都在表里。
 */
export const ACTION_SPEC = Object.freeze([
  { kind: 'look', summary: '转眼球并带动头与身体', fields: [
    { name: 'direction', values: ['left', 'right', 'up', 'down', 'center'], required: true },
    { name: 'strength', range: '0..1' },
  ] },
  { kind: 'nod', summary: '点头，可重复', fields: [
    { name: 'count', range: '1..4 整数' },
    { name: 'strength', range: '0..1' },
  ] },
  { kind: 'shake_head', summary: '摇头，可重复', fields: [
    { name: 'count', range: '1..4 整数' },
    { name: 'strength', range: '0..1' },
  ] },
  { kind: 'tilt', summary: '歪头', fields: [
    { name: 'direction', values: ['left', 'right'], required: true },
    { name: 'strength', range: '0..1' },
  ] },
  { kind: 'smile', summary: '微笑（嘴形 + 眼睛）', fields: [{ name: 'strength', range: '0..1' }] },
  { kind: 'blink', summary: '眨眼', fields: [
    { name: 'side', values: ['both', 'left', 'right'] },
    { name: 'count', range: '1..4 整数' },
  ] },
  { kind: 'expression', summary: '作者表情（exp3），可叠在动作上', fields: [
    { name: 'name', from: 'expressions', required: true },
    { name: 'layer', values: ['exclusive', 'overlay'] },
    { name: 'strength', range: '0..1' },
  ] },
  { kind: 'gesture', summary: '作者原生手势（含进入/退出动作）', fields: [
    { name: 'name', from: 'gestures', required: true },
    { name: 'pair', values: ['point'], note: '仅 hand_on_chest 可配 point' },
    { name: 'accents', note: '关节片段 [{at, duration, values}]，values 用关节名' },
    { name: 'armBinding', values: ['guided', 'off'] },
  ] },
  { kind: 'talk', summary: '说话口型（无音频时的假口型）', fields: [
    { name: 'strength', range: '0..1' },
  ] },
  { kind: 'pose', summary: '摆一个姿态（两端淡入淡出）', fields: [
    { name: 'values', note: '语义参数 → 数值，1..12 个' },
    { name: 'label', note: '给人看的说明' },
  ] },
  { kind: 'trajectory', summary: '连续轨迹（关键帧插值）', fields: [
    { name: 'frames', note: '[{time, values}]，2..60 帧，间隔 ≥0.08s，位于 0.15..duration-0.15' },
    { name: 'label', note: '给人看的说明' },
  ] },
  { kind: 'recorded', summary: '社区手调录制（逐帧采样）', fields: [
    { name: 'frames', note: '[{t, v}]，时间必须递增' },
  ] },
])

/** 通用字段（每个动作都能给）。 */
export const ACTION_COMMON_FIELDS = Object.freeze([
  { name: 'at', range: '0..59 秒', note: '相对这段表演开始的时间' },
  { name: 'duration', range: '0.2..20 秒（expression/recorded 可到 59）' },
  { name: 'strength', range: '0..1' },
])

/** 计划不合法。调用方要么拒绝，要么降级——不要静默地「差不多照做」。 */
export class CompileError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CompileError'
    this.code = 'PLAN_REJECTED'
  }
}

/** 有限数字 + 范围检查（对应 compiler.py 的 number()）。 */
function finite(value, name, low, high) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new CompileError(`${name} 必须是有限数字`)
  if (value < low || value > high) throw new CompileError(`${name} 超出范围 ${low}..${high}`)
  return value
}

const cubic = (a, b, c, d, t) => (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d

/**
 * 采样 motion3 的 Segments。
 *
 * 格式是「起点 [t0,v0] + 一串段」，每段以 kind 开头：
 *   0 线性（后面跟 end），1 贝塞尔（c1, c2, end），2 阶梯（保持前值），3 反向阶梯（立刻到终值）。
 * 与 compiler.py 完全一致，包括 18 次二分。
 */
export function sampleMotion(segments, t) {
  let prev = [segments[0], segments[1]]
  let i = 2
  while (i < segments.length) {
    const kind = Math.trunc(segments[i])
    i += 1
    let c1 = null
    let c2 = null
    let end
    if (kind === 1) {
      c1 = [segments[i], segments[i + 1]]
      c2 = [segments[i + 2], segments[i + 3]]
      end = [segments[i + 4], segments[i + 5]]
      i += 6
    } else {
      end = [segments[i], segments[i + 1]]
      i += 2
    }
    if (t <= end[0]) {
      if (kind === 0) return prev[1] + (end[1] - prev[1]) * clamp((t - prev[0]) / Math.max(1e-8, end[0] - prev[0]), 0, 1)
      if (kind === 2) return prev[1]
      if (kind === 3) return end[1]
      let lo = 0
      let hi = 1
      for (let k = 0; k < 18; k += 1) {
        const u = (lo + hi) / 2
        if (cubic(prev[0], c1[0], c2[0], end[0], u) < t) lo = u
        else hi = u
      }
      return cubic(prev[1], c1[1], c2[1], end[1], (lo + hi) / 2)
    }
    prev = end
  }
  return prev[1]
}

const curvesOf = (motion, target = 'Parameter') => (motion?.Curves ?? []).filter((curve) => curve.Target === target)
const curveOf = (motion, pid) => curvesOf(motion).find((curve) => curve.Id === pid) ?? null

/** 两个 motion3 合成一段（只用于 hand_on_chest + point 的双手联动）。 */
function combineMotions(a, b) {
  const merged = { ...a, Curves: a.Curves.map((curve) => ({ ...curve })) }
  const ids = new Set(merged.Curves.map((curve) => curve.Id))
  for (const curve of b.Curves) {
    if (ids.has(curve.Id)) {
      if (curve.Id !== 'Param56' && curve.Id !== 'Param57') throw new CompileError('双手原生动作存在未处理的共享通道')
    } else {
      merged.Curves.push({ ...curve })
    }
  }
  merged.Meta = { ...merged.Meta, Duration: Math.max(a.Meta.Duration, b.Meta.Duration) }
  return merged
}

/**
 * 编译一段动作计划。
 *
 * @param {object} plan            `{version:1, intent, summary, actions:[…]}`
 * @param {object} catalog
 * @param {Map<string,{min:number,max:number,default:number}>|Record} catalog.params
 * @param {string[]} catalog.primary            可写语义输入
 * @param {Record<string,{Parameters:Array}>} catalog.expressions  exp3 内容，按名字
 * @param {Record<string,{Meta:{Duration:number},Curves:Array}>} catalog.motions  motion3 内容，按名字
 * @param {Record<string,{label:string,enter:string,exit:string,switch?:string}>} catalog.gestures
 * @param {Record<string,Record<string,string>>} catalog.gestureJoints
 * @param {Set<string>|string[]} catalog.physicsOutputs
 */
export function compilePlan(plan, catalog) {
  const params = catalog.params instanceof Map ? catalog.params : new Map(Object.entries(catalog.params))
  const primary = new Set(catalog.primary)
  const physicsOutputs = catalog.physicsOutputs instanceof Set ? catalog.physicsOutputs : new Set(catalog.physicsOutputs)
  const expressions = catalog.expressions ?? {}
  const motions = catalog.motions ?? {}
  const gestures = catalog.gestures ?? {}
  const gestureJoints = catalog.gestureJoints ?? {}
  const allJointIds = new Set(Object.values(gestureJoints).flatMap((joints) => Object.values(joints)))

  if (!plan || typeof plan !== 'object' || !Number.isInteger(plan.version) || plan.version !== 1) {
    throw new CompileError('动作计划需要 version: 1')
  }
  const actions = plan.actions
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 24) {
    throw new CompileError('actions 必须包含 1..24 个动作')
  }
  if (String(plan.intent ?? '').length > 2000 || String(plan.summary ?? '').length > 1000) {
    throw new CompileError('动作说明过长')
  }

  const tracks = []
  const steps = []
  const warnings = []
  const kinds = actions.map((action) => action?.kind)

  const requireParam = (pid) => {
    const parameter = params.get(pid)
    if (!parameter) throw new CompileError(`模型没有参数 ${pid}`)
    return parameter
  }

  const add = (pid, start, duration, points, index, label, expression) => {
    const parameter = requireParam(pid)
    if (physicsOutputs.has(pid)) throw new CompileError(`${pid} 归作者物理控制，不能直接驱动`)
    const clipped = []
    for (const [t, value] of points) {
      if (!Number.isFinite(value)) throw new CompileError('参数曲线包含非有限值')
      const bounded = clamp(value, parameter.min, parameter.max)
      if (bounded !== value) warnings.push(`${pid} 已限制到模型范围`)
      clipped.push([+t.toFixed(5), +bounded.toFixed(6)])
    }
    for (const old of tracks) {
      if (old.id !== pid || old.action === index) continue
      const overlap = Math.min(old.start + old.duration, start + duration) - Math.max(old.start, start)
      if (overlap <= 0.015) continue
      const overlay = expression ?? old.expression
      // 唯一豁免：一侧是 expression 且声明 overlay、目标在 primary、基础动作不是手势。
      const baseKind = expression ? kinds[old.action] : kinds[index]
      const exempt = Boolean(expression) !== Boolean(old.expression) &&
        overlay?.layer === 'overlay' && primary.has(pid) && baseKind !== 'gesture'
      if (!exempt) throw new CompileError(`动作 ${old.action + 1} 与 ${index + 1} 同时控制 ${pid}，请错开时间或使用明确的 expression overlay`)
    }
    const track = {
      id: pid,
      start: +start.toFixed(4),
      duration: +duration.toFixed(4),
      points: clipped,
      action: index,
      label,
      owner: expression ? 'expression' : kinds[index] === 'gesture' ? 'native-gesture' : 'semantic',
      stage: expression ? 'expression' : 'motion',
    }
    if (expression) track.expression = expression
    tracks.push(track)
  }

  /** 两端淡入淡出，中段保持——所有「摆一个姿势」的动作都走这里。 */
  const hold = (pid, value, index, label, at, duration, fade = 0.42) => {
    const d = requireParam(pid).default
    const f = Math.min(fade, duration * 0.28)
    add(pid, at, duration, [[0, d], [f, value], [duration - f, value], [duration, d]], index, label)
  }

  /** 周期性摆动（点头/摇头）：带预备、逐次收幅、回正。 */
  const waves = (pid, amp, index, label, at, duration, count, symmetric = false) => {
    const d = requireParam(pid).default
    const points = [[0, d], [0.12 * duration, d - amp * 0.16]]
    for (let n = 0; n < count; n += 1) {
      const st = 0.17 * duration + n * 0.66 * duration / count
      const w = 0.66 * duration / count
      points.push([st, d], [st + w * 0.32, d + amp * (1 - 0.1 * n)], [st + w * 0.76, d - amp * (symmetric ? 0.85 : 0.18)])
    }
    points.push([duration, d])
    add(pid, at, duration, points.sort((a, b) => a[0] - b[0] || a[1] - b[1]), index, label)
  }

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index]
    if (!action || typeof action !== 'object') throw new CompileError('每个动作必须是对象')
    const kind = action.kind
    const at = finite(action.at ?? 0, 'at', 0, 59)
    let duration = finite(action.duration ?? 2.5, 'duration', 0.2,
      kind === 'recorded' || kind === 'expression' ? 59 : 20)
    const strength = finite(action.strength ?? 0.6, 'strength', 0, 1)
    const count = action.count ?? 1
    if (!Number.isInteger(count) || count < 1 || count > 4) throw new CompileError('count 必须为 1..4 的整数')
    let label = ''

    if (kind === 'look') {
      const direction = action.direction ?? 'center'
      if (!['left', 'right', 'up', 'down', 'center'].includes(direction)) throw new CompileError('不支持的视线方向')
      label = { left: '看向左侧', right: '看向右侧', up: '抬眼看上方', down: '低头看下方', center: '看向你' }[direction]
      const x = { left: -1, right: 1 }[direction] ?? 0
      const y = { up: 1, down: -1 }[direction] ?? 0
      const headDelay = Math.min(0.09, duration * 0.15)
      const bodyDelay = Math.min(0.19, duration * 0.3)
      // 屏幕左侧对应负的头部与眼球输入。
      if (x || direction === 'center') {
        hold('ParamEyeBallX', x * 0.75 * strength, index, label, at, duration, 0.22)
        hold('AngleX', x * 28 * strength, index, label, at + headDelay, duration - headDelay, 0.28)
        hold('PositionX', x * 14 * strength, index, label, at + bodyDelay, duration - bodyDelay, 0.34)
      }
      if (y) {
        hold('ParamEyeBallY', y * 0.6 * strength, index, label, at, duration, 0.22)
        hold('AngleY', y * 18 * strength, index, label, at + headDelay, duration - headDelay, 0.28)
      }
    } else if (kind === 'nod' || kind === 'shake_head') {
      label = kind === 'nod' ? `点头${count}次` : `轻轻摇头${count}次`
      if (duration < count * 0.45) throw new CompileError('重复点头／摇头的时间太短，请至少每次 0.45 秒')
      waves(kind === 'nod' ? 'AngleY' : 'AngleX', (kind === 'nod' ? -15 : 20) * strength, index, label, at, duration, count, kind === 'shake_head')
      waves(kind === 'nod' ? 'PositionY' : 'PositionX', (kind === 'nod' ? -3 : 8) * strength, index, label, at + 0.08, duration - 0.08, count, kind === 'shake_head')
    } else if (kind === 'tilt') {
      const direction = action.direction ?? 'left'
      if (direction !== 'left' && direction !== 'right') throw new CompileError('歪头方向需要 left 或 right')
      label = '轻轻歪头'
      const sign = direction === 'left' ? -1 : 1
      hold('AngleZ', sign * 19 * strength, index, label, at, duration)
      hold('PositionZ', -sign * 9 * strength, index, label, at + 0.1, duration - 0.1)
    } else if (kind === 'smile') {
      label = '自然微笑'
      for (const [pid, value] of [['ParamMouthForm', 0.8], ['EyeSmile', 0.65], ['MouthSmile_L', 0.55], ['MouthSmile_R', 0.55]]) {
        hold(pid, value * strength, index, label, at, duration)
      }
    } else if (kind === 'blink') {
      const side = action.side ?? 'both'
      if (!['both', 'left', 'right'].includes(side)) throw new CompileError('眨眼 side 需要 both / left / right')
      label = side === 'both' ? '眨眼' : '单眼眨眼'
      if (duration < count * 0.22) throw new CompileError('眨眼频率过高')
      const targets = side === 'both' ? ['ParamEyeLOpen', 'ParamEyeROpen'] : [side === 'left' ? 'ParamEyeLOpen' : 'ParamEyeROpen']
      for (const pid of targets) {
        const points = [[0, 1]]
        for (let n = 0; n < count; n += 1) {
          const t = (n + 0.3) * duration / count
          const w = Math.min(0.32, duration / count * 0.65)
          points.push([t, 1], [t + w * 0.28, 0], [t + w * 0.48, 0], [t + w, 1])
        }
        points.push([duration, 1])
        add(pid, at, duration, points.sort((a, b) => a[0] - b[0] || a[1] - b[1]), index, label)
      }
    } else if (kind === 'expression') {
      const name = action.name
      const expression = expressions[name]
      if (!expression) throw new CompileError(`未知表情 ${name}；请读取 capabilities`)
      label = String(name)
      const layer = action.layer ?? 'exclusive'
      if (layer !== 'exclusive' && layer !== 'overlay') throw new CompileError('expression.layer 需要 exclusive 或 overlay')
      for (const item of expression.Parameters ?? []) {
        const pid = item.Id
        const d = requireParam(pid).default
        const value = item.Value
        const blend = item.Blend ?? 'Add'
        if (!['Add', 'Multiply', 'Overwrite'].includes(blend)) throw new CompileError('不支持的作者表情混合方式')
        const target = blend === 'Add' ? d + value * strength
          : blend === 'Multiply' ? d * (1 + (value - 1) * strength)
            : d + (value - d) * strength
        const fade = Math.min(0.42, duration * 0.28)
        add(pid, at, duration, [[0, d], [fade, target], [duration - fade, target], [duration, d]], index, label,
          { blend, value, layer, weightPoints: [[0, 0], [fade, strength], [duration - fade, strength], [duration, 0]] })
      }
    } else if (kind === 'gesture') {
      const name = action.name
      const gesture = gestures[name]
      if (!gesture) throw new CompileError(`未知手势 ${name}`)
      label = gesture.label ?? name
      let enter = motions[gesture.enter]
      let exit = motions[gesture.exit]
      if (!enter || !exit) throw new CompileError(`手势 ${name} 的动作缺失：${gesture.enter} / ${gesture.exit}`)
      const pair = action.pair
      if (pair !== undefined && pair !== null) {
        if (name !== 'hand_on_chest' || pair !== 'point') throw new CompileError('双手组合仅支持 hand_on_chest + point')
        const other = gestures[pair]
        if (!other) throw new CompileError(`未知手势 ${pair}`)
        enter = combineMotions(enter, motions[other.enter])
        exit = combineMotions(exit, motions[other.exit])
        label = '双手联动 · 抚胸与食指回应'
      }
      const inD = enter.Meta.Duration
      const outD = exit.Meta.Duration
      if (duration < inD + outD + 0.35) {
        duration = inD + outD + 0.35
        warnings.push(`${label} 已延长以保留作者的进入与收回动作`)
      }
      const accents = action.accents ?? []
      const binding = action.armBinding ?? 'guided'
      if (binding !== 'guided' && binding !== 'off') throw new CompileError('armBinding 需要 guided/off')
      if (!Array.isArray(accents) || accents.length > 12) throw new CompileError('手势 accents 需要 0..12 段')
      const joints = gestureJoints[name] ?? {}

      // 关节片段：只在自己的手势姿态里，且互不重叠。
      const jointCues = new Map()
      for (const cue of accents) {
        if (!cue || typeof cue !== 'object') throw new CompileError('关节片段必须是对象')
        const st = finite(cue.at, '关节 at', inD, duration - outD)
        const dur = finite(cue.duration, '关节 duration', 0.4, 20)
        if (st + dur > duration - outD) throw new CompileError('关节片段不可覆盖作者退出动作')
        const values = cue.values
        if (!values || typeof values !== 'object' || !Object.keys(values).length || Object.keys(values).length > 5) {
          throw new CompileError('关节 values 需要 1..5 个控制')
        }
        for (const [joint, value] of Object.entries(values)) {
          if (!joints[joint]) throw new CompileError(`${name} 没有可写关节 ${joint}`)
          const pid = joints[joint]
          const parameter = requireParam(pid)
          const val = finite(value, joint, parameter.min, parameter.max)
          const cues = jointCues.get(pid) ?? []
          if (cues.some(([s, d]) => Math.min(st + dur, s + d) - Math.max(st, s) > 0)) {
            throw new CompileError(`同一关节 ${joint} 的片段重叠`)
          }
          cues.push([st, dur, val])
          jointCues.set(pid, cues)
        }
      }

      // 作者原生动作打底：进入 → 保持 → 退出，最后回到 default。
      const ids = [...new Set([enter, exit].flatMap((motion) => curvesOf(motion).map((curve) => curve.Id)))].sort()
      for (const pid of ids) {
        const d = requireParam(pid).default
        const points = [[0, d]]
        let prev = d
        for (const [motion, offset] of [[enter, 0], [exit, duration - outD]]) {
          const curve = curveOf(motion, pid)
          const md = motion.Meta.Duration
          if (curve) {
            const segments = Math.max(2, Math.ceil(md * 45))
            const samples = []
            for (let k = 0; k <= segments; k += 1) {
              const t = k * md / segments
              samples.push([offset + t, sampleMotion(curve.Segments, t)])
            }
            points.push(...samples)
            prev = samples[samples.length - 1][1]
          } else {
            points.push([offset, prev], [offset + md, prev])
          }
        }
        // 作者退出之后一定要回到中立——否则下一个动作会带着上一个姿态起步。
        points.push([duration + 0.12, d])
        for (const [st, dur, val] of jointCues.get(pid) ?? []) {
          const rest = curveOf(enter, pid) ? sampleMotion(curveOf(enter, pid).Segments, inD) : d
          const fade = Math.min(0.5, dur * 0.28)
          points.push([st, rest], [st + fade, val], [st + dur - fade, val], [st + dur, rest])
        }
        const unique = new Map()
        for (const [t, value] of points) unique.set(+t.toFixed(5), +value.toFixed(6))
        add(pid, at, duration + 0.12, [...unique.entries()].sort((a, b) => a[0] - b[0]), index, label)
      }

      // 手臂联动：只在「有横向/纵深关节被主动摆」的片段里收一收。
      if (accents.length && binding === 'guided') {
        const rest = {}
        for (const [joint, pid] of Object.entries(joints)) {
          const curve = curveOf(enter, pid)
          rest[joint] = curve ? sampleMotion(curve.Segments, inD) : requireParam(pid).default
        }
        const windows = []
        const moving = ['upperArm', 'forearm', 'wrist', 'perspective']
        for (const cue of [...accents].sort((a, b) => a.at - b.at)) {
          if (!moving.some((joint) => joint in (cue.values ?? {}))) continue
          const a = cue.at
          const b = cue.at + cue.duration
          if (windows.length && a <= windows[windows.length - 1][1]) {
            windows[windows.length - 1][1] = Math.max(b, windows[windows.length - 1][1])
          } else windows.push([a, b])
        }
        const limits = {}
        for (const pid of Object.values(joints)) limits[pid] = requireParam(pid)
        let adjusted = false
        for (const [a, b] of windows) {
          adjusted = bindArmTracks(tracks.filter((track) => track.action === index), joints, rest, a, b, limits) || adjusted
        }
        if (adjusted) warnings.push(`${label}：已应用手臂联动，限制小臂过度偏离原手势姿态`)
      }
      duration += 0.12
    } else if (kind === 'talk') {
      label = '说话口型（无音频）'
      const points = [[0, 0]]
      for (let k = 1; k < Math.ceil(duration * 8); k += 1) {
        const t = k / 8
        if (t < duration - 0.2) points.push([t, (0.15 + 0.48 * Math.abs(Math.sin(k * 2.31))) * strength])
      }
      points.push([duration, 0])
      add('ParamMouthOpenY', at, duration, points, index, label)
    } else if (kind === 'recorded') {
      label = '社区手调录制'
      const frames = action.frames
      if (!Array.isArray(frames) || frames.length < 2 || frames.length > 1200) throw new CompileError('录制需要 2..1200 个采样点')
      const aliases = { ParamAngleX: 'AngleX', ParamAngleY: 'AngleY', ParamAngleZ: 'AngleZ' }
      const allowed = new Set([...primary, ...Array.from({ length: 13 }, (_, i) => `key${i + 1}`), ...Array.from({ length: 5 }, (_, i) => `Clothes${i + 1}`), ...allJointIds])
      const rows = []
      const channels = new Set()
      let previous = -1
      for (const frame of frames) {
        if (!frame || typeof frame !== 'object' || !frame.v || typeof frame.v !== 'object') throw new CompileError('每帧需要 t 与 v')
        const t = finite(frame.t, '采样时间', 0, duration)
        if (t <= previous) throw new CompileError('采样时间必须递增')
        previous = t
        const row = {}
        for (const [key, value] of Object.entries(frame.v)) {
          const pid = aliases[key] ?? key
          if (!allowed.has(pid) || !params.has(pid) || physicsOutputs.has(pid) || pid in row) {
            throw new CompileError(`录制通道不支持或冲突：${key}`)
          }
          row[pid] = finite(value, pid, params.get(pid).min, params.get(pid).max)
        }
        rows.push([t, row])
        for (const pid of Object.keys(row)) channels.add(pid)
      }
      if (!channels.size) throw new CompileError('录制没有变化的通道')
      for (const pid of [...channels].sort()) {
        const rest = requireParam(pid).default
        const points = rows.map(([t, row]) => [t, row[pid] ?? rest])
        if (points[0][0] > 0) points.unshift([0, rest])
        if (points[points.length - 1][0] < duration) points.push([duration, points[points.length - 1][1]])
        add(pid, at, duration + 0.2, [...points, [duration + 0.2, rest]], index, label)
      }
      duration += 0.2
    } else if (kind === 'trajectory') {
      const frames = action.frames
      if (!Array.isArray(frames) || frames.length < 2 || frames.length > 60) throw new CompileError('trajectory.frames 需要 2..60 个关键帧')
      label = String(action.label ?? '连续动作').slice(0, 60)
      let ids = null
      let previous = 0
      const paths = {}
      for (const frame of frames) {
        if (!frame || typeof frame !== 'object') throw new CompileError('关键帧必须是对象')
        const t = finite(frame.time, '关键帧 time', 0.15, duration - 0.15)
        if (t - previous < 0.08 - 1e-8) throw new CompileError('关键帧必须按时间递增，间隔至少 0.08 秒')
        previous = t
        const values = frame.values
        const keys = values && typeof values === 'object' ? Object.keys(values) : []
        if (!keys.length || keys.length > 12) throw new CompileError('关键帧需要 1..12 个输入参数')
        if (ids === null) ids = new Set(keys)
        if (keys.length !== ids.size || keys.some((key) => !ids.has(key))) throw new CompileError('每个关键帧必须包含相同输入参数')
        for (const [pid, value] of Object.entries(values)) {
          if (!primary.has(pid) || pid === 'ParamBreath') throw new CompileError(`${pid} 不是可写的语义输入`)
          const parameter = requireParam(pid)
          const v = finite(value, pid, parameter.min, parameter.max)
          paths[pid] = paths[pid] ?? [[0, parameter.default]]
          paths[pid].push([t, v])
        }
      }
      for (const [pid, points] of Object.entries(paths)) {
        add(pid, at, duration, [...points, [duration, params.get(pid).default]], index, label)
      }
    } else if (kind === 'pose') {
      const values = action.values
      const keys = values && typeof values === 'object' ? Object.keys(values) : []
      if (!keys.length || keys.length > 12) throw new CompileError('pose.values 需要 1..12 个输入参数')
      label = String(action.label ?? '自定义姿态').slice(0, 60)
      for (const [pid, value] of Object.entries(values)) {
        if (!primary.has(pid) || pid === 'ParamBreath') throw new CompileError(`${pid} 不是可写的语义输入`)
        const parameter = requireParam(pid)
        hold(pid, finite(value, pid, parameter.min, parameter.max), index, label, at, duration)
      }
    } else {
      throw new CompileError(`不支持动作 ${kind}；请读取 /api/capabilities，不会用无关动作替代`)
    }

    steps.push({ index, label, kind, start: at, duration: +duration.toFixed(4) })
  }

  if (!tracks.length) throw new CompileError('计划没有产出任何可执行轨迹')
  const total = Math.max(...tracks.map((track) => track.start + track.duration)) + 0.7
  if (total > 60) throw new CompileError('动作总长不可超过 60 秒')

  return {
    version: 1,
    driverVersion: '1.2.0',
    intent: String(plan.intent ?? ''),
    summary: String(plan.summary ?? ''),
    duration: +total.toFixed(4),
    tracks,
    steps,
    warnings: [...new Set(warnings)].sort(),
    sourcePlan: structuredClone(plan),
    policy: { returnToIdle: true, physics: 'author-131-rigs', easing: 'smoothstep', parameterLimits: 'moc3-core' },
  }
}
