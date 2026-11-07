// 指令箱：宿主进程把「演一段」交给浏览器舞台的唯一通道。
//
// 为什么需要它：插件注入了 connection，但那只是鉴权口（requestRejection），
// 没有推送能力；舞台是浏览器里的代码，宿主不能直接调它。所以走一条反过来的路——
// 舞台长轮询「有没有活」，宿主在有活时立刻应答。不开新依赖、不占端口、复用现有鉴权。
//
// 这里全是纯逻辑（不碰 fs / 不碰 socket / 不自己起定时器），Node 里可以直接测；
// 「等多久」「怎么长轮询」由 http.mjs 决定，它只把 wait 传进来。
//
// 三条设计取舍：
//   1. **一次性取走**：claim 立刻把 job 标成 claimed，两个面板同开时只有一个会演，
//      另一个拿到空——宁可少演一次，也不要两个舞台各演一遍。
//   2. **回执而不是轮询队列**：演到哪由舞台主动报（started/progress/completed），
//      队列只记状态。这样 l2d_state 读到的是「真的演完了」还是「只是发出去了」。
//   3. **过期而不是无限等**：没人取、或取走后没回执，都要有个说法（expired / stalled），
//      否则模型会一直以为还在演。

/**
 * 未取走的 job 多久算过期。
 * 给到 2 分钟：面板切到后台时浏览器会节流长轮询，任务可能等一会儿才被取走，
 * 60 秒太容易在「人刚好在别处」时白扔掉一次编排。
 */
export const QUEUE_JOB_TTL_MS = 120_000
/** 取走后没有回执，在动作本身时长之外再宽限这么久才算卡住。 */
export const STALL_GRACE_MS = 30_000
/**
 * 多久没收到舞台的长轮询，就认为舞台没打开。
 *
 * 这个值不能贴着长轮询时长设。实测：面板切到后台标签页后，浏览器会节流它的请求，
 * 心跳间隔轻松超过 40 秒——40 秒窗口会把活着的舞台误判成「没打开」，
 * 于是表演排进没人取的队列、然后过期。给到 2 分钟，容忍后台节流。
 */
export const STAGE_ALIVE_MS = 120_000
/** 允许的 job 状态。 */
export const JOB_STATUSES = Object.freeze(['queued', 'claimed', 'started', 'progress', 'completed', 'failed', 'expired', 'stalled'])

const clamp01 = (value) => Math.min(1, Math.max(0, value))

/**
 * 建一个指令箱。
 *
 * @param {object} [options]
 * @param {number} [options.depth]    队列上限（超过就拒绝，而不是挤掉正在演的）
 * @param {() => number} [options.now] 注入时钟，方便测试
 */
export function createQueue({ depth = 8, now = Date.now } = {}) {
  if (!Number.isSafeInteger(depth) || depth < 1) throw new Error('depth 必须是正整数')

  /** jobId -> job。保持插入顺序，取最早的。 */
  const jobs = new Map()
  /** requestId -> jobId，用来做幂等。 */
  const byRequest = new Map()
  /** 等待中的 claim 回调：{ resolve, timer }。 */
  const waiters = new Set()
  let stopRequested = false
  let lastSeen = 0
  /** 舞台最近一次自报的页面可见性：visible / hidden / unknown。 */
  let lastVisibility = 'unknown'
  /** 舞台自报的最后一次异常（跟随循环出过错才有）。 */
  let lastStageError = null
  let sequence = 0

  const touch = () => { lastSeen = now() }
  const alive = () => lastSeen !== 0 && now() - lastSeen < STAGE_ALIVE_MS

  /**
   * 还占着队列位置的只有 `queued`：已经交付给舞台的那个属于舞台，不该占队列位。
   * 这样「正在演一段 20 秒的戏」不会把后续编排挤掉。
   */
  const queuedCount = () => {
    let count = 0
    for (const job of jobs.values()) if (job.status === 'queued') count += 1
    return count
  }

  const snapshot = (job) => ({
    jobId: job.jobId,
    status: job.status,
    progress: clamp01(job.progress),
    duration: job.duration,
    tracks: job.tracks,
    enqueuedAt: job.enqueuedAt,
    claimedAt: job.claimedAt,
    finishedAt: job.finishedAt,
    error: job.error ?? null,
    warnings: job.warnings ?? [],
  })

  /** 把过期/卡住的判定集中在一处：取状态和发活之前都先跑一遍。 */
  function sweep() {
    const at = now()
    for (const job of jobs.values()) {
      if (job.status === 'queued' && at - job.enqueuedAt > QUEUE_JOB_TTL_MS) {
        job.status = 'expired'
        job.finishedAt = at
      } else if ((job.status === 'claimed' || job.status === 'started' || job.status === 'progress')
        && job.claimedAt !== null
        && at - job.claimedAt > job.duration * 1000 + STALL_GRACE_MS) {
        job.status = 'stalled'
        job.finishedAt = at
      }
    }
    // 终态 job 只留最近一段时间，避免无限长大。
    for (const [jobId, job] of jobs) {
      const terminal = job.status === 'completed' || job.status === 'failed' || job.status === 'expired' || job.status === 'stalled'
      if (terminal && job.finishedAt !== null && at - job.finishedAt > 10 * 60_000) {
        jobs.delete(jobId)
        if (job.requestId) byRequest.delete(job.requestId)
      }
    }
  }

  /** 有等待者时立刻喂给他；返回是否喂到了。 */
  function feedWaiter() {
    for (const waiter of waiters) {
      const payload = takeNext()
      if (payload !== null) {
        waiters.delete(waiter)
        clearTimeout(waiter.timer)
        waiter.resolve(payload)
        return true
      }
      return false
    }
    return false
  }

  /** 取下一个可执行的活：stop 优先，其次最早的 queued。 */
  function takeNext() {
    sweep()
    if (stopRequested) {
      stopRequested = false
      return { type: 'stop' }
    }
    for (const job of jobs.values()) {
      if (job.status !== 'queued') continue
      job.status = 'claimed'
      job.claimedAt = now()
      return {
        type: 'perform',
        jobId: job.jobId,
        duration: job.duration,
        compiled: job.compiled,
      }
    }
    return null
  }

  return {
    /**
     * 入队一段已经编译好的表演。
     * requestId 相同则返回原来那个 jobId（幂等：模型重试不会演两遍）。
     */
    enqueue({ plan = null, compiled, requestId = null, sessionId = null }) {
      if (!compiled || !Array.isArray(compiled.tracks) || compiled.tracks.length === 0) {
        throw new Error('入队需要一份编译好的表演')
      }
      if (requestId !== null && byRequest.has(requestId)) {
        return { jobId: byRequest.get(requestId), deduplicated: true }
      }
      if (queuedCount() >= depth) throw new Error(`指令箱已满（${depth} 个待处理），先用 l2d_state 看看`)
      sequence += 1
      const jobId = `job-${now().toString(36)}-${sequence.toString(36)}`
      const job = {
        jobId,
        requestId,
        sessionId,
        plan,
        compiled,
        duration: compiled.duration,
        tracks: compiled.tracks.length,
        warnings: compiled.warnings ?? [],
        status: 'queued',
        progress: 0,
        enqueuedAt: now(),
        claimedAt: null,
        finishedAt: null,
        error: null,
      }
      jobs.set(jobId, job)
      if (requestId !== null) byRequest.set(requestId, jobId)
      // 有舞台正在等就立刻递过去，省掉一次轮询。
      feedWaiter()
      return { jobId, deduplicated: false }
    },

    /**
     * 舞台来取活。没有活就等到 waitMs（或直到有新活被 enqueue 立刻唤醒）。
     * 返回 `{type:'perform', …}` / `{type:'stop'}` / `{}`（超时）。
     */
    claim({ waitMs = 0, visibility = null, stageError = null } = {}) {
      touch()
      // 顺手记下页面在不在前台：排查「心跳断了」时，这一条能直接区分
      // 「浏览器把后台标签页节流了」和「跟随循环真的挂了」。
      if (typeof visibility === 'string' && visibility !== '') lastVisibility = visibility
      // 舞台把「上一次为什么断了」捎过来：宿主这边能直接看到原因，不用猜。
      if (typeof stageError === 'string' && stageError.trim() !== '') lastStageError = stageError.slice(0, 300)
      const immediate = takeNext()
      if (immediate !== null) return Promise.resolve(immediate)
      if (!Number.isFinite(waitMs) || waitMs <= 0) return Promise.resolve({})
      return new Promise((resolve) => {
        const waiter = { resolve, timer: null }
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter)
          // 超时也要记住「舞台还活着」——长轮询本身就是心跳。
          touch()
          resolve({})
        }, Math.min(waitMs, 60_000))
        // 定时器不该把进程按住。
        if (typeof waiter.timer.unref === 'function') waiter.timer.unref()
        waiters.add(waiter)
      })
    },

    /** 舞台回报进度/结果。status 必须是合法值，jobId 必须存在。 */
    receipt(jobId, { status, progress, error = null } = {}) {
      touch()
      if (!JOB_STATUSES.includes(status)) throw new Error(`未知的回执状态：${status}`)
      if (!['started', 'progress', 'completed', 'failed'].includes(status)) {
        throw new Error('回执只能是 started / progress / completed / failed')
      }
      const job = jobs.get(jobId)
      if (!job) throw new Error(`没有这个任务：${jobId}`)
      if (job.status === 'expired' || job.status === 'stalled') {
        // 已经判死的任务不接受回执，但也不抛：舞台只是在晚到的路上。
        return { ...snapshot(job), stopRequested }
      }
      job.status = status
      if (typeof progress === 'number' && Number.isFinite(progress)) job.progress = clamp01(progress)
      if (status === 'completed') job.progress = 1
      if (status === 'failed') job.error = typeof error === 'string' && error !== '' ? error.slice(0, 500) : '舞台报告失败'
      if (status === 'completed' || status === 'failed') job.finishedAt = now()
      // 把「有人要求停止」随回执一起带回去：舞台正在演时也要能被打断，
      // 而它下一次开口就是这条进度回执，不必再发一个请求。
      return { ...snapshot(job), stopRequested }
    },

    /** 请求停止：下一个 claim 立刻拿到 stop。 */
    requestStop() {
      stopRequested = true
      feedWaiter()
      return { requested: true }
    },

    /**
     * 模型用来看「到底演了没有」。
     * 注意：这里**不刷新心跳**——模型问一句「演完了吗」，不该让一个没打开的舞台显得在线。
     */
    state() {
      sweep()
      // 最近一个非 queued 的 job 才是有意义的那个（queued 是还没人取走）。
      let latest = null
      for (const job of jobs.values()) {
        if (job.status === 'queued') continue
        latest = job
      }
      if (latest === null) {
        for (const job of jobs.values()) latest = job
      }
      return {
        stageAlive: alive(),
        visibility: lastVisibility,
        stageError: lastStageError,
        lastSeenMs: lastSeen === 0 ? null : now() - lastSeen,
        pending: queuedCount(),
        depth,
        job: latest === null ? null : snapshot(latest),
      }
    },

    /** 测试与诊断用：当前队列内容的浅快照（先清扫，看到的就是真实判定后的状态）。 */
    inspect() {
      sweep()
      return [...jobs.values()].map(snapshot)
    },

    /** 让所有还在等的长轮询立刻返回（宿主 dispose 时用，避免连接悬着）。 */
    dispose() {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer)
        waiter.resolve({})
      }
      waiters.clear()
    },
  }
}
