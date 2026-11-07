/**
 * 舞台渲染层：把 Live2D 模型画进一块 canvas。
 *
 * 只用三样东西：Cubism Core、pixi.js、pixi-live2d-display 的 cubism4 包。
 * 初始化参数照搬鲸语的 app.mjs（透明背景、autoDensity、分辨率封顶 1.5、
 * 锚点 (0.5,0) 让角色从脚下站位、窗口 0.9/0.95 的比例内缩），这样同一个模型
 * 在旧工作台和新面板里的构图是一致的。
 *
 * 视角分两层：
 *   基准 —— 由画布和模型尺寸算出来（fitGeometry），面板一改大小就重算；
 *   视角 —— 用户自己滚出来的缩放和平移（DEFAULT_VIEW 形状）。
 * 应用时把两者相乘，所以改窗口只换基准，用户的视角既不重置也不漂移。
 * 视角还受一条可见性规则约束（limitView）：角色的包围盒至少要有三成留在画布里，
 * 拖不丢；放大之后这条范围会自动变宽，不会反过来夹住「以光标为锚点」的缩放。
 *
 * 这一层只管「画出来 + 会呼吸 + 跟着鼠标看 + 听滚轮和拖动」；
 * 语义表演（情绪、口型）由上层驱动。
 */

import { compilePlan } from './performance-compiler.mjs'
import { loadCatalog, performanceUrl } from './model-assets.mjs'
import { MotionEngine } from './motion-engine.mjs'

// 挂载前缀：独立舞台跑在站点根上（空串），嵌在别处时才需要前缀。
const BASE = (typeof window !== 'undefined' && window.__STAGE_BASE__) ?? ''
const VENDOR = `${BASE}/vendor`
const API = BASE

/**
 * 从渲染地址（/models/<模型名>/model3.json）里取模型名。
 * 资产接口要的是中间那一段，不是整条地址。
 */
function modelKeyFrom(modelPath) {
  const segments = String(modelPath).split('?')[0].split('/').filter(Boolean)
  if (segments.length < 2) return ''
  const raw = segments[segments.length - 2]
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** 默认视角：zoom 是相对初始构图的倍数，panX/panY 是画布宽高的比例。 */
export const DEFAULT_VIEW = Object.freeze({ zoom: 1, panX: 0, panY: 0 })

/**
 * 视角的硬边界。zoom 是真的上下限；maxPan 只是个「别让手改的配置文件把角色
 * 扔到天边」的数字护栏——真正允许挪多远由 panLimits 按包围盒算，
 * 所以它必须比任何 zoom 下可能需要的 pan 都宽（包围盒最宽也就 ~2.5 个画布）。
 */
export const VIEW_LIMITS = Object.freeze({ minZoom: 0.35, maxZoom: 5, maxPan: 8 })

/**
 * 拖动时角色的包围盒至少要和画布重叠这么多，别把它拖丢了。
 * 注意这不是一个固定的 pan 范围：放大之后本来就该允许挪得更远，
 * 否则「以光标为锚点缩放」会被夹得变形——5 倍时要让光标停住，
 * pan 会走到 ±1.3 上下，用一个常数去夹它就是把缩放夹坏。
 */
const KEEP_VISIBLE = 0.3

/** 滚轮：factor = exp(-delta * 0.0025)，单次最多缩/放 2 倍，手抖也不会瞬移。 */
const WHEEL_SENSITIVITY = 0.0025
const WHEEL_MIN_STEP = 0.5
const WHEEL_MAX_STEP = 2
/** deltaMode 归一化：1 = 行、2 = 页。 */
const WHEEL_LINE = 16
const WHEEL_PAGE = 100
/** 视角稳定这么久之后才回报给面板：拖动和滚轮过程中不刷请求。 */
const SAVE_DEBOUNCE_MS = 600

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const finite = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
const round6 = value => Math.round(value * 1e6) / 1e6

/**
 * 把任意输入收成一个合法视角。脏值不报错，只回落到默认值——
 * 配置文件是被手改过的，服务端还拿它兜底，所以这里必须宽容。
 */
export function clampView(view) {
  const source = view !== null && typeof view === 'object' ? view : {}
  return {
    zoom: round6(clamp(finite(source.zoom, DEFAULT_VIEW.zoom), VIEW_LIMITS.minZoom, VIEW_LIMITS.maxZoom)),
    panX: round6(clamp(finite(source.panX, DEFAULT_VIEW.panX), -VIEW_LIMITS.maxPan, VIEW_LIMITS.maxPan)),
    panY: round6(clamp(finite(source.panY, DEFAULT_VIEW.panY), -VIEW_LIMITS.maxPan, VIEW_LIMITS.maxPan)),
  }
}

/** 初始构图：0.9/0.95 内缩、锚点在顶中（与鲸语 app.mjs 的那三行完全同值）。 */
export function fitGeometry(size, original) {
  const w = Math.max(1, finite(size?.w, 1))
  const h = Math.max(1, finite(size?.h, 1))
  const ow = Math.max(1, finite(original?.width, 1))
  const oh = Math.max(1, finite(original?.height, 1))
  return {
    w,
    h,
    originalW: ow,
    originalH: oh,
    baseScale: Math.min((w * 0.9) / ow, (h * 0.95) / oh),
    baseX: w / 2,
    baseY: h * 0.025,
  }
}

/**
 * 拖动允许的 pan 范围：角色（锚点在顶中，锚点就是 position）的包围盒
 * 至少还要有 KEEP_VISIBLE 的部分落在画布里。
 * 模型高矮和 zoom 都会改变这个范围，所以它是个函数而不是一个常数。
 * 上下界恒有 min < max：minX - maxX = -(0.4w + W)/w < 0。
 */
export function panLimits(geometry, view) {
  const v = clampView(view)
  const scaledW = geometry.originalW * geometry.baseScale * v.zoom
  const scaledH = geometry.originalH * geometry.baseScale * v.zoom
  return {
    minX: (KEEP_VISIBLE * geometry.w - scaledW / 2 - geometry.baseX) / geometry.w,
    maxX: ((1 - KEEP_VISIBLE) * geometry.w + scaledW / 2 - geometry.baseX) / geometry.w,
    minY: (KEEP_VISIBLE * geometry.h - scaledH - geometry.baseY) / geometry.h,
    maxY: ((1 - KEEP_VISIBLE) * geometry.h - geometry.baseY) / geometry.h,
  }
}

/** 收尾：先夹 zoom，再用包围盒范围夹 pan。用户改视角的地方都过这一道。 */
export function limitView(geometry, view) {
  const v = clampView(view)
  const limits = panLimits(geometry, v)
  return clampView({
    zoom: v.zoom,
    panX: clamp(v.panX, limits.minX, limits.maxX),
    panY: clamp(v.panY, limits.minY, limits.maxY),
  })
}

/** 基准 + 视角 → 真正落到 pixi 上的 scale / position。 */
export function viewTransform(geometry, view) {
  const v = clampView(view)
  return {
    scale: geometry.baseScale * v.zoom,
    x: geometry.baseX + v.panX * geometry.w,
    y: geometry.baseY + v.panY * geometry.h,
  }
}

/**
 * 以 point（舞台像素）为锚点缩放：光标底下的那个点前后不动。
 *
 * 模型的锚点就是它的 position，放大 k 倍时「离锚点的偏移」也放大 k 倍，
 * 要让 point 固定住，新锚点 = point - k * (point - 旧锚点)。
 */
export function zoomAtPoint(geometry, view, point, factor) {
  const v = clampView(view)
  const zoom = clamp(v.zoom * finite(factor, 1), VIEW_LIMITS.minZoom, VIEW_LIMITS.maxZoom)
  // 顶到上下限时原样返回：不然 pan 会被反复重算，画面会自己爬。
  if (zoom === v.zoom) return v
  const k = zoom / v.zoom
  const from = viewTransform(geometry, v)
  const px = finite(point?.x, from.x)
  const py = finite(point?.y, from.y)
  const x = px - k * (px - from.x)
  const y = py - k * (py - from.y)
  return clampView({
    zoom,
    panX: (x - geometry.baseX) / geometry.w,
    panY: (y - geometry.baseY) / geometry.h,
  })
}

/** 按顺序加载脚本；同一个文件只加载一次。 */
const loaded = new Map()
function loadScript(src) {
  if (loaded.has(src)) return loaded.get(src)
  const promise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.async = false
    script.dataset.dshLive2d = 'vendor'
    script.addEventListener('load', () => resolve(), { once: true })
    script.addEventListener('error', () => reject(new Error(`加载失败：${src}`)), { once: true })
    document.head.append(script)
  })
  loaded.set(src, promise)
  return promise
}

/** 三个脚本有严格顺序：Core 必须先于 cubism4 包，pixi 必须最先准备好命名空间。 */
async function loadRuntime() {
  if (window.Live2DCubismCore && window.PIXI?.live2d?.Live2DModel) return
  if (!window.Live2DCubismCore) await loadScript(`${VENDOR}/live2dcubismcore.min.js`)
  if (!window.PIXI) await loadScript(`${VENDOR}/pixi.min.js`)
  if (!window.PIXI?.live2d?.Live2DModel) await loadScript(`${VENDOR}/cubism4.min.js`)
  if (!window.Live2DCubismCore) {
    throw new Error('Cubism Core 没有加载成功（vendor/live2dcubismcore.min.js）')
  }
  if (!window.PIXI?.live2d?.Live2DModel) {
    throw new Error('Live2D 显示层没有加载成功（vendor/cubism4.min.js）')
  }
}

/**
 * 把模型挂到 canvas 上。
 *
 * @param {HTMLCanvasElement} canvas 舞台画布
 * @param {object} options
 * @param {string} options.modelPath model3.json 的地址
 * @param {{zoom:number,panX:number,panY:number}} [options.initialView] 上次记住的视角
 * @param {() => void} [options.onReady] 首帧画出来之后回调
 * @param {(view: {zoom:number,panX:number,panY:number}) => void} [options.onView] 视角稳定后回调（面板拿它落盘）
 * @returns {Promise<{model: object, getView: () => object, setView: (view: object) => void, resetView: () => void, destroy: () => void}>}
 */
export async function mount(canvas, {
  modelPath, initialView = null, onReady, onView, follow = true,
  // 取档案/表情/动作要用哪个 fetch。独立舞台需要带令牌，所以由调用方注入；
  // 不注入就退回全局 fetch（测试与嵌入式场景）。
  fetchImpl = (typeof fetch === 'function' ? fetch : null),
} = {}) {
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('舞台需要一个 canvas')
  if (!modelPath) throw new Error('没有可用的 model3.json 地址')

  await loadRuntime()

  const PIXI = window.PIXI
  // 交互面就是舞台那一块：canvas 是 inset:0 铺满它的，两者的矩形一致。
  const box = canvas.parentElement ?? canvas
  const width = Math.max(1, box.clientWidth || 1)
  const height = Math.max(1, box.clientHeight || 1)

  const app = new PIXI.Application({
    view: canvas,
    width,
    height,
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 1.5),
    powerPreference: 'high-performance',
  })
  PIXI.live2d.Live2DModel.registerTicker(PIXI.Ticker)

  let model
  try {
    model = await PIXI.live2d.Live2DModel.from(modelPath, {
      autoInteract: false,
      autoUpdate: true,
      motionPreload: 'NONE',
    })
  } catch (error) {
    app.destroy(true, { children: true })
    throw new Error(`模型加载失败：${error?.message ?? error}`)
  }

  app.stage.addChild(model)

  /* ---- 表演层：只有真的在演的时候才写参数 ---- */
  // 注入点选 updateNaturalMovements：它在 motion/blink 之后、作者物理与 coreModel.update() 之前，
  // 所以同一帧就生效，而且不绕过物理。没有表演在播时 engine.tick 直接 return，一次写都没有。
  const internalModel = model.internalModel
  const originalUpdateNaturalMovements = internalModel.updateNaturalMovements
  let engine = null
  let hookLast = performance.now()
  internalModel.updateNaturalMovements = function patchedUpdateNaturalMovements(...args) {
    const now = performance.now()
    const deltaMs = now - hookLast
    hookLast = now
    originalUpdateNaturalMovements?.apply(this, args)
    try {
      engine?.tick(deltaMs)
    } catch (error) {
      // 一帧出错不该把整个舞台拖垮：停掉表演，控制台留痕。
      console.warn('[live2d] 表演中断：', error?.message ?? error)
      engine?.stop()
    }
  }

  const playPerformance = async (nameOrPlan) => {
    const plan = typeof nameOrPlan === 'string'
      ? await (await fetch(performanceUrl(nameOrPlan))).json()
      : nameOrPlan
    // 每次重新装：不同计划要用到不同的表情与原生动作，缓存整本会漏。
    const catalog = await loadCatalog({
      plan,
      modelKey: modelKeyFrom(modelPath),
      ...fetchImpl === null ? {} : { fetchImpl },
    })
    const compiled = compilePlan(plan, catalog)
    if (engine === null || engine.params !== catalog.params) {
      engine?.stop()
      engine = new MotionEngine(internalModel.coreModel, catalog)
    }
    engine.play(compiled)
    return compiled
  }

  /**
   * 点到了哪儿。这个模型没有 HitAreas（model3 里没声明），所以只能按几何判断：
   * 点在角色包围盒里就算点中，再按上下三分之一分「头」和「身上」。
   *
   * @returns {{region: 'head'|'body'|null, point: {x:number, y:number}}}
   */
  const hitTest = (localX, localY) => {
    const bounds = model.getBounds()
    // 包围盒是舞台坐标系（PIXI 的局部坐标），指针也要先换算到同一处。
    const inside = localX >= bounds.x && localX <= bounds.x + bounds.width
      && localY >= bounds.y && localY <= bounds.y + bounds.height
    if (!inside) return { region: null, point: { x: localX, y: localY } }
    const threshold = bounds.y + bounds.height * 0.34
    return { region: localY <= threshold ? 'head' : 'body', point: { x: localX, y: localY } }
  }

  /**
   * 被碰了一下的反应：本地立即播，不经过 agent，也不排队。
   *
   * 优先级按研究包的约定：说话 > 点击 > 待机。正在演一段的时候不去抢，
   * 否则手指点两下就把编排好的表演切碎了。
   */
  const REACTIONS = {
    head: [
      { version: 1, intent: '被摸头', actions: [
        { kind: 'expression', at: 0, name: '脸红', duration: 2.2, strength: 0.9, layer: 'overlay' },
        { kind: 'tilt', at: 0, duration: 1.1, direction: 'left', strength: 0.5 },
        { kind: 'nod', at: 1.0, duration: 1.0, strength: 0.4 },
      ] },
      { version: 1, intent: '被摸头（二）', actions: [
        { kind: 'expression', at: 0, name: '＞＜', duration: 1.6, strength: 0.85, layer: 'overlay' },
        { kind: 'shake_head', at: 0.3, duration: 1.2, count: 2, strength: 0.5 },
      ] },
    ],
    body: [
      { version: 1, intent: '被拍了一下', actions: [
        { kind: 'expression', at: 0, name: '屑屑眼', duration: 1.6, strength: 0.8, layer: 'overlay' },
        { kind: 'tilt', at: 0.1, duration: 1.2, direction: 'right', strength: 0.45 },
      ] },
      { version: 1, intent: '被拍了（二）', actions: [
        { kind: 'nod', at: 0, duration: 0.8, count: 1, strength: 0.7 },
        { kind: 'smile', at: 0.2, duration: 1.4, strength: 0.7 },
      ] },
    ],
  }

  const react = async (region, point) => {
    if (region !== 'head' && region !== 'body') {
      // 点空白处只把目光挪过去，不做表情——不然点哪儿都演一段会很烦。
      if (point !== undefined) model.focus(point.x, point.y)
      return null
    }
    if (engine?.playing === true) return null
    const pool = REACTIONS[region]
    const plan = pool[Math.floor(Math.random() * pool.length)]
    return await playPerformance(plan)
  }

  const sleep = (ms, signal) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })

  let view = clampView(initialView)
  const geometry = () => fitGeometry(
    { w: box.clientWidth || 1, h: box.clientHeight || 1 },
    { width: model.internalModel.originalWidth, height: model.internalModel.originalHeight },
  )
  // 记住的视角也过一道可见范围：换了窗口大小再打开，角色不该已经在画外。
  view = limitView(geometry(), view)

  const applyView = () => {
    const geo = geometry()
    app.renderer.resize(geo.w, geo.h)
    const transform = viewTransform(geo, view)
    model.scale.set(transform.scale)
    model.position.set(transform.x, transform.y)
  }
  model.anchor.set(0.5, 0)
  applyView()

  /* 视角存档：稳定 SAVE_DEBOUNCE_MS 之后才回报一次，拖动中途不发请求。 */
  let saveTimer = null
  const flushView = () => {
    if (saveTimer === null) return
    clearTimeout(saveTimer)
    saveTimer = null
    onView?.(clampView(view))
  }
  const scheduleSave = () => {
    if (typeof onView !== 'function') return
    if (saveTimer !== null) clearTimeout(saveTimer)
    saveTimer = setTimeout(flushView, SAVE_DEBOUNCE_MS)
  }
  const setView = next => {
    view = limitView(geometry(), next)
    applyView()
    scheduleSave()
  }

  // 待机动作：模型自己带了 Idle 组就让它转起来，呼吸和眨眼由 Cubism 自己维持。
  const idleGroups = Object.keys(model.internalModel.motionManager.definitions ?? {})
    .filter(group => /^idle$/i.test(group))
  if (idleGroups.length > 0) {
    model.internalModel.motionManager.startRandomMotion(idleGroups[0])
  }

  // 目光跟随：把指针位置换算成舞台内坐标，交给模型自己算眼球角度。
  // focus() 内部走的是 toModelPosition（对 worldTransform 求逆），
  // 所以缩放和拖动之后目光依然落在光标上，不用额外补偿。
  const onPointerMove = event => {
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const x = ((event.clientX - rect.left) / rect.width) * box.clientWidth
    const y = ((event.clientY - rect.top) / rect.height) * box.clientHeight
    model.focus(x, y)
  }
  window.addEventListener('pointermove', onPointerMove, { passive: true })

  /* 滚轮：以光标为锚点缩放，并且不让页面跟着滚。 */
  const onWheel = event => {
    event.preventDefault()
    const rect = box.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const unit = event.deltaMode === 1 ? WHEEL_LINE : event.deltaMode === 2 ? WHEEL_PAGE : 1
    const factor = clamp(Math.exp(-event.deltaY * unit * WHEEL_SENSITIVITY), WHEEL_MIN_STEP, WHEEL_MAX_STEP)
    const geo = geometry()
    const point = {
      x: ((event.clientX - rect.left) / rect.width) * geo.w,
      y: ((event.clientY - rect.top) / rect.height) * geo.h,
    }
    view = limitView(geo, zoomAtPoint(geo, view, point, factor))
    applyView()
    scheduleSave()
  }
  box.addEventListener('wheel', onWheel, { passive: false })

  /* 拖动：按屏幕像素 1:1 平移；指针捕获拿不到也不影响（拖动状态在本地）。 */
  let dragging = null
  const onPointerDown = event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    // 舞台空白处的按钮（比如「重试」）留给它自己点，别抢成拖动。
    if (event.target?.closest?.('button')) return
    const rect = box.getBoundingClientRect()
    dragging = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      w: Math.max(1, rect.width),
      h: Math.max(1, rect.height),
    }
    // 合成事件或已失活的 pointerId 会让 capture 抛错，捕获只是锦上添花。
    try { box.setPointerCapture?.(event.pointerId) } catch { /* 没有捕获也照样拖 */ }
    box.dataset.dragging = 'true'
  }
  const onDragMove = event => {
    if (dragging === null || event.pointerId !== dragging.id) return
    const dx = (event.clientX - dragging.x) / dragging.w
    const dy = (event.clientY - dragging.y) / dragging.h
    dragging.x = event.clientX
    dragging.y = event.clientY
    view = limitView(geometry(), { zoom: view.zoom, panX: view.panX + dx, panY: view.panY + dy })
    applyView()
    scheduleSave()
  }
  const onDragEnd = event => {
    if (dragging === null) return
    if (event?.pointerId !== undefined && event.pointerId !== dragging.id) return
    try { box.releasePointerCapture?.(dragging.id) } catch { /* 本来就没捕获 */ }
    dragging = null
    delete box.dataset.dragging
    // 松手就落盘，不用再等那 600ms。
    flushView()
  }
  const onDoubleClick = () => setView(DEFAULT_VIEW)
  box.addEventListener('pointerdown', onPointerDown)
  box.addEventListener('pointermove', onDragMove)
  box.addEventListener('pointerup', onDragEnd)
  box.addEventListener('pointercancel', onDragEnd)
  box.addEventListener('dblclick', onDoubleClick)

  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(applyView) : null
  observer?.observe(box)
  window.addEventListener('resize', applyView)

  // 等第一帧真的画出来再报 ready，避免空画布一闪。
  let ready = false
  const ticker = () => {
    if (ready) return
    ready = true
    PIXI.Ticker.shared.remove(ticker)
    onReady?.()
    // 验证入口：?perform=01-curiosity 或 ?perform=01-curiosity.json
    // 演不起来只留一条警告——舞台照常画，不能白屏。
    const requested = new URLSearchParams(window.location.search).get('perform')
    if (requested) {
      const name = requested.replace(/\.json$/i, '')
      playPerformance(name).catch((error) => {
        console.warn(`[live2d] 表演「${name}」没演起来：${error?.message ?? error}`)
      })
    }
  }
  PIXI.Ticker.shared.add(ticker)

  return {
    model,
    getView: () => clampView(view),
    setView,
    resetView: () => setView(DEFAULT_VIEW),
    /** 演一段：给表演名（不含 .json）或一份现成的计划。 */
    play: playPerformance,
    /** 指针落在哪：给页面的点击判断用。 */
    hitTest,
    /** 被碰一下的反应（本地立即播）。 */
    react,
    stop() {
      engine?.stop()
    },
    get performing() {
      return engine?.playing ?? false
    },
    get performance() {
      return engine?.job ?? null
    },
    /** 诊断快照：证明表演真的在写参数，而不是「看起来在动」。 */
    debug() {
      if (engine === null) return { attached: false }
      return {
        attached: true,
        playing: engine.playing,
        status: engine.status,
        elapsed: +engine.elapsed.toFixed(3),
        frames: engine.frames,
        writeCount: engine.writeCount,
        lastWrite: engine.lastWrite,
      }
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      engine?.stop()
      engine = null
      // 把注入点还回去：不留一个空引擎挂在模型上。
      internalModel.updateNaturalMovements = originalUpdateNaturalMovements
      // 还有没存下的视角就补一次：刚滚完就切面板也不该丢。
      flushView()
      box.removeEventListener('wheel', onWheel)
      box.removeEventListener('pointerdown', onPointerDown)
      box.removeEventListener('pointermove', onDragMove)
      box.removeEventListener('pointerup', onDragEnd)
      box.removeEventListener('pointercancel', onDragEnd)
      box.removeEventListener('dblclick', onDoubleClick)
      delete box.dataset.dragging
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('resize', applyView)
      observer?.disconnect()
      PIXI.Ticker.shared.remove(ticker)
      try { app.destroy(true, { children: true }) } catch { /* 已经销毁 */ }
    },
  }
}

/** 三个运行时文件是否都到位（面板用它给出明确的缺失提示，而不是白屏）。 */
export async function probeRuntime() {
  const files = ['live2dcubismcore.min.js', 'pixi.min.js', 'cubism4.min.js']
  const missing = []
  for (const file of files) {
    try {
      const res = await fetch(`${VENDOR}/${file}`, { method: 'HEAD' })
      if (!res.ok) missing.push(file)
    } catch {
      missing.push(file)
    }
  }
  return { ok: missing.length === 0, missing }
}
