/**
 * 手势关节的「保守手臂联动」：不是骨骼 IK，只是在手势保持区间内限制小臂过度偏离。
 *
 * 移植自鲸语 `arm_binding.py`（48 行，语义逐条对齐）。这套耦合解决一个具体问题：
 * 三个手势的原生动作（进入/退出）只驱动大臂、透视、小臂、手腕四条曲线，
 * 而模型知识允许 JEV/规划器在这些关节上叠「关节片段」。如果片段随意取值，
 * 小臂会从手势姿态里扯出去，看起来像手臂脱臼。
 *
 * 办法是把相对量在小范围内重新分配：
 *   upper      = clamp(Δupper + .18·Δforearm, ±.42)
 *   center     = .45·upper          —— 小臂跟随大臂的趋势
 *   allowance  = .32·(1 − .35·min(1, |persp|/.22))   —— 透视越大，允许的自由度越小
 *   forearm    = center + clamp(Δforearm, ±allowance)
 *   wrist      = clamp(Δwrist − .2·forearm, ±.38)
 * 窗口两端各有 0.25 秒 smoothstep 过渡，窗口外的原始关键帧一个字都不改。
 */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const smoothstep = (u) => u * u * (3 - 2 * u)

/** 关键帧折线的 smoothstep 采样（注意：这里不是编译器里用的线性/贝塞尔）。 */
function samplePoints(points, t) {
  if (t <= points[0][0]) return points[0][1]
  for (let i = 1; i < points.length; i += 1) {
    const [a, x] = points[i - 1]
    const [b, y] = points[i]
    if (t <= b) {
      const u = clamp((t - a) / Math.max(1e-8, b - a), 0, 1)
      return x + (y - x) * smoothstep(u)
    }
  }
  return points[points.length - 1][1]
}

const REQUIRED = ['upperArm', 'forearm', 'wrist', 'perspective']

/**
 * 在 [start, end] 内重算四条关节轨迹。
 *
 * @param {Array} tracks            当前动作已经产出的轨迹（会被就地改写）
 * @param {Record<string,string>} joints  关节名 → 参数 id
 * @param {Record<string,number>} rest    该手势在进入结束时的姿态（相对量的基准）
 * @param {number} start            保持区间起点
 * @param {number} end              保持区间终点
 * @param {Record<string,{min:number,max:number}>} limits 参数范围
 * @returns {boolean} 是否真的改动过（没改动就不该报「已应用手臂联动」）
 */
export function bindArmTracks(tracks, joints, rest, start, end, limits) {
  const byId = new Map(tracks.map((track) => [track.id, track]))
  // 少一个关节就不动——宁可保持原样，也不要只改一半。
  if (REQUIRED.some((key) => !joints[key] || !byId.has(joints[key]))) return false

  const original = Object.fromEntries(REQUIRED.map((key) => [key, byId.get(joints[key]).points.map(([t, v]) => [t, v])]))

  // 共用同一组时间戳，逐关节单独打点会让插值互相错位。
  const times = new Set([+start.toFixed(5), +end.toFixed(5)])
  for (const points of Object.values(original)) {
    for (const [t] of points) if (t > start && t < end) times.add(t)
  }
  const count = Math.max(1, Math.ceil((end - start) * 45))
  for (let i = 0; i <= count; i += 1) times.add(+(start + (end - start) * i / count).toFixed(5))

  const output = Object.fromEntries(REQUIRED.map((key) => [key, []]))
  let changed = false

  for (const t of [...times].sort((a, b) => a - b)) {
    const raw = Object.fromEntries(REQUIRED.map((key) => [key, samplePoints(original[key], t)]))
    const delta = Object.fromEntries(REQUIRED.map((key) => [key, raw[key] - rest[key]]))

    const upper = clamp(delta.upperArm + 0.18 * delta.forearm, -0.42, 0.42)
    const perspective = clamp(delta.perspective, -0.22, 0.22)
    const center = 0.45 * upper
    const allowance = 0.32 * (1 - 0.35 * Math.min(1, Math.abs(perspective) / 0.22))
    const residual = clamp(delta.forearm, -allowance, allowance)
    const forearm = center + residual
    const wrist = clamp(delta.wrist - 0.2 * forearm, -0.38, 0.38)
    const desired = { upperArm: upper, forearm, wrist, perspective }

    // 窗口两端收窄，保证和窗口外的原始姿态接得上。
    const edge = smoothstep(clamp(Math.min(t - start, end - t) / 0.25, 0, 1))

    for (const key of REQUIRED) {
      const limit = limits[joints[key]]
      const value = clamp(raw[key] + (rest[key] + desired[key] - raw[key]) * edge, limit.min, limit.max)
      changed = changed || Math.abs(value - raw[key]) > 0.00001
      output[key].push([t, +value.toFixed(6)])
    }
  }

  for (const key of REQUIRED) {
    const track = byId.get(joints[key])
    track.points = [
      ...original[key].filter(([t]) => t < start),
      ...output[key],
      ...original[key].filter(([t]) => t > end),
    ]
    track.armBinding = 'gesture-relative-v1'
  }

  return changed
}
