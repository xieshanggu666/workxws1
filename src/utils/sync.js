// 多窗口协作通知：同一浏览器不同窗口 / 标签页共享 IndexedDB，
// 一个窗口保存后通过 BroadcastChannel 通知其他窗口刷新数据与编辑基线，避免后保存覆盖先保存。

const CHANNEL = 'knowbase-doc-sync'
const listeners = new Set()
let channel = null

function ensureChannel() {
  if (channel !== null || typeof BroadcastChannel === 'undefined') return channel
  try {
    channel = new BroadcastChannel(CHANNEL)
    channel.onmessage = (e) => {
      // postMessage 不会回到发送窗口，因此这里只会收到其他窗口的通知，避免把本窗口保存误报为协作变更
      listeners.forEach((fn) => {
        try { fn(e.data) } catch { /* 监听器异常不影响其他窗口通知 */ }
      })
    }
  } catch {
    channel = null // 不支持的环境退化为无通知（保存本身仍以库中最新数据为准）
  }
  return channel
}

export function onDocChanged(fn) {
  ensureChannel()
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// 向其他窗口广播文档变更（保存 / 新建 / 删除）
export function broadcastDocChanged(type, id) {
  const ch = ensureChannel()
  if (ch) ch.postMessage({ type, id, at: Date.now() })
}
