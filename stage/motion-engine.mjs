/**
 * 按帧演出：把编译好的轨迹采样出来，写进 Cubism 参数。
 *
 * 刻意做成**最小接管**：只有表演真正写到的通道才被我们写，其余一概不碰。
 * 于是眨眼、呼吸、看向鼠标、作者物理、待机动作全部照旧——既保住了观感，
 * 也让「没有表演在播时零改动」成为可验证的事实（`tick` 直接 return，一次写都没有）。
 *
 * 注入点由 stage.mjs 负责（覆写 `internalModel.updateNaturalMovements`）：
 * 那是 motion/blink 之后、作者物理与 `coreModel.update()` 之前，正好是我们该动手的位置。
 */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const smoothstep = (u) => u * u * (3 - 2 * u)

/** 关键帧折线采样（smoothstep，与鲸语引擎一致）。 */
export function samplePoints(points, t) {
  if (t <= points[0][0]) return points[0][1]
  for (let i = 1; i < points.length; i += 1) {
    if (t <= points[i][0]) {
      const [a, x] = points[i - 1]
      const [b, y] = points[i]
      return x + (y - x) * smoothstep(clamp((t - a) / Math.max(1e-8, b - a), 0, 1))
    }
  }
  return points[points.length - 1][1]
}

/** exp3 的三种混合方式，按权重在基础值上叠加。 */
export function blendExpression(base, value, weight, mode) {
  if (![base, value, weight].every(Number.isFinite)) throw new Error('表情权重出现非有限值')
  const w = clamp(weight, 0, 1)
  if (mode === 'Add') return base + value * w
  if (mode === 'Multiply') return base * (1 + (value - 1) * w)
  if (mode === 'Overwrite') return base + (value - base) * w
  throw new Error(`未知的表情混合方式：${mode}`)
}

export class MotionEngine {
  /**
   * @param {object} core     Cubism CoreModel（要有 setParameterValueById）
   * @param {object} catalog  buildCatalog 的结果（只用 params 与 physicsOutputs）
   */
  constructor(core, catalog, { notify = null, amplitude = 1 } = {}) {
    this.core = core
    this.params = catalog.params
    this.physicsOutputs = catalog.physicsOutputs ?? new Set()
    this.notify = notify
    this.amplitude = amplitude
    this.current = new Map()
    this.job = null
    this.elapsed = 0
    this.frames = 0
    this.status = 'idle'
    // 诊断用：写入次数 + 最后一次「写完立刻回读」。Cubism 每帧末尾会 loadParameters 还原参数，
    // 所以在帧后读值是读不到我们写的东西的——要证明真的写进了 core，只能在写之后当场回读。
    this.writeCount = 0
    this.lastWrite = null
  }

  get playing() {
    return this.job !== null
  }

  /** 开始一段表演。宁可在这里抛错，也不要在帧循环里静默写坏参数。 */
  play(compiled) {
    const tracks = compiled?.tracks
    if (!Array.isArray(tracks) || tracks.length === 0) throw new Error('这段表演没有可执行的轨迹')
    for (const track of tracks) {
      if (!this.params.has(track.id)) throw new Error(`表演里有模型没有的参数：${track.id}`)
      if (this.physicsOutputs.has(track.id)) throw new Error(`表演试图直接驱动物理输出：${track.id}`)
    }
    this.job = compiled
    this.elapsed = 0
    this.frames = 0
    this.writeCount = 0
    this.lastWrite = null
    this.status = 'playing'
    this.notify?.('playing', compiled)
  }

  stop() {
    if (this.job === null) return
    this.job = null
    this.elapsed = 0
    this.status = 'idle'
    this.notify?.('idle', null)
  }

  /**
   * 每帧一次。没有表演在播时**直接返回**——舞台行为与没有这个引擎时逐帧一致。
   */
  tick(deltaMs) {
    const job = this.job
    if (!job) return

    const wall = Math.max(0, deltaMs) / 1000
    const dt = Math.min(wall, 1) // 切走标签页再回来时别一次性补一大段
    if (dt <= 0) return
    this.elapsed += wall
    this.frames += 1

    const targets = new Map()
    const layers = []

    for (const track of job.tracks) {
      const local = this.elapsed - track.start
      if (local < 0 || local > track.duration) continue
      if (track.expression) {
        layers.push([track, local])
        continue
      }
      const parameter = this.params.get(track.id)
      let value = samplePoints(track.points, local)
      const kind = job.steps?.[track.action]?.kind
      // 手势、表情、眨眼是「整段形态」，不该被全局幅度缩放。
      if (kind !== 'gesture' && kind !== 'expression' && kind !== 'blink') {
        value = parameter.default + (value - parameter.default) * this.amplitude
      }
      targets.set(track.id, value)
    }

    // 表情永远在基础值之上叠加：先有姿势，再上妆。
    for (const [track, local] of layers) {
      const parameter = this.params.get(track.id)
      const weight = samplePoints(track.expression.weightPoints, local)
      const base = targets.get(track.id) ?? parameter.default
      targets.set(track.id, blendExpression(base, track.expression.value, weight, track.expression.blend))
    }

    for (const [id, target] of targets) {
      const parameter = this.params.get(id)
      const previous = this.current.get(id) ?? parameter.default
      // 眼睛开合变化最快，跟得太慢会糊成「半闭着发呆」。
      const tau = id.includes('Eye') && id.includes('Open') ? 0.016 : 0.055
      const value = clamp(previous + (target - previous) * (1 - Math.exp(-dt / tau)), parameter.min, parameter.max)
      this.current.set(id, value)
      this.core.setParameterValueById(id, value)
      this.writeCount += 1
      const readback = typeof this.core.getParameterValueById === 'function'
        ? this.core.getParameterValueById(id)
        : null
      this.lastWrite = {
        id,
        value: +value.toFixed(4),
        readback: readback === null || !Number.isFinite(readback) ? null : +readback.toFixed(4),
      }
    }

    if (this.elapsed >= job.duration) {
      const finished = this.job
      this.job = null
      this.elapsed = 0
      this.frames = 0
      this.status = 'completed'
      this.notify?.('completed', finished)
    }
  }
}
