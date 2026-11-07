// 路径安全：把 URL 里的相对路径钉死在允许的根目录里。
//
// 单独一个文件，是因为这条逻辑散落两份就迟早会有一份写松。
// 舞台的服务端、静态资源、测试都用这一个实现。
import { join, normalize, resolve, sep } from 'node:path'

/**
 * @param {string} root 允许的根（会被 resolve 成绝对路径）
 * @param {string} relative URL 里的相对路径
 * @returns {string|null} 落在根内的绝对路径；越界或解码失败返回 null
 */
export function safeJoin(root, relative) {
  let decoded
  try {
    decoded = decodeURIComponent(relative)
  } catch {
    // 非法的百分号编码（比如 %zz）不该让请求崩掉，按越界处理。
    return null
  }
  const base = resolve(root)
  const target = resolve(join(base, normalize(decoded)))
  if (target !== base && !target.startsWith(base + sep)) return null
  return target
}
