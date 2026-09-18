import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { db } from '@/db'
import { uid } from '@/utils/format'
import { mergeDocPatch, resolveMerge } from '@/utils/merge'
import { broadcastDocChanged, onDocChanged } from '@/utils/sync'
import { useAuthStore } from './auth'

// 版本冲突：远端文档自本地加载后已被其他窗口保存。携带合并结果与冲突明细，由界面让用户逐处解决。
class ConflictError extends Error {
  constructor(payload) {
    super('文档已被其他窗口更新，存在版本冲突')
    this.name = 'ConflictError'
    this.payload = payload
  }
}

// 兼容历史数据：已有文档没有 rev / editors / versions 字段时就地补齐
// rev 为乐观锁版本号，每次保存 +1；历史文档首次见到视为 rev=1
export function normalizeDoc(doc) {
  if (!doc) return doc
  if (typeof doc.rev !== 'number') doc.rev = 1
  if (!Array.isArray(doc.versions)) {
    doc.versions = doc.updatedAt
      ? [{ version: 1, savedAt: doc.updatedAt, savedBy: doc.ownerId || 'u-guest', note: '初始版本' }]
      : []
  }
  if (!Array.isArray(doc.editors)) doc.editors = doc.ownerId ? [doc.ownerId] : []
  return doc
}

export const useKbStore = defineStore('kb', () => {
  const docs = ref([])
  const categories = ref([])
  const tags = ref([])
  const comments = ref([])
  const loaded = ref(false)

  const catMap = computed(() => Object.fromEntries(categories.value.map((c) => [c.id, c])))
  const tagMap = computed(() => Object.fromEntries(tags.value.map((t) => [t.id, t])))

  async function loadAll() {
    if (loaded.value) return
    docs.value = (await db.docs.toArray()).map(normalizeDoc)
    categories.value = await db.categories.toArray()
    tags.value = await db.tags.toArray()
    comments.value = await db.comments.toArray()
    loaded.value = true
  }

  // 始终以 IndexedDB 中的最新数据重建内存缓存（其他窗口保存后调用）
  async function reloadDocs() {
    docs.value = (await db.docs.toArray()).map(normalizeDoc)
  }

  // 读取单个文档时直接查库，避免本窗口或其他窗口刚保存后仍读到内存旧值
  async function getDoc(id) {
    await loadAll()
    const fresh = await db.docs.get(id)
    if (fresh) {
      normalizeDoc(fresh)
      const idx = docs.value.findIndex((d) => d.id === id)
      if (idx >= 0) docs.value[idx] = fresh
      else docs.value.push(fresh)
      return fresh
    }
    return docs.value.find((d) => d.id === id) || null
  }

  async function createDoc(payload, currentUser) {
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || 'u-guest'
    const doc = {
      id: uid('doc'),
      title: payload.title || '无标题文档',
      categoryId: payload.categoryId || categories.value[0]?.id || null,
      tagIds: payload.tagIds || [],
      body: payload.body || '',
      visibility: payload.visibility || 'public',
      ownerId: userId,
      editors: [userId],
      createdAt: now,
      updatedAt: now,
      rev: 1,
      versions: [{
        version: 1, savedAt: now, savedBy: userId, note: '创建文档',
        title: payload.title || '无标题文档', body: payload.body || ''
      }]
    }
    await db.docs.add(doc)
    broadcastDocChanged('saved', doc.id)
    await reloadDocs()
    return doc
  }

  // 带版本冲突检测的保存。
  //   base：编辑开始时的文档快照（含 rev）；patch：用户修改的字段；
  //   choices：冲突时用户逐处选择 'ours' | 'theirs' 后的结果。
  // 返回 { status, doc }：status 为 saved（直接保存）/ merged（自动合并后保存）/ resolved（冲突已选择后保存）。
  // 远端有更新且无法自动合并时抛出 ConflictError，未提交内容不会落库，由调用方保留给用户处理。
  async function saveDoc(id, patch, currentUser, note, options = {}) {
    await loadAll()
    const { base, choices } = options

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await db.transaction('rw', db.docs, async () => {
          const fresh = normalizeDoc((await db.docs.get(id)) || null)
          if (!fresh) return null

          const baseRev = typeof base?.rev === 'number' ? base.rev : fresh.rev
          let finalPatch = patch
          let merged = false
          let hasConflicts = false
          let conflict = null

          // 乐观锁：编辑基线落后于库中最新版本，说明期间有其他窗口保存
          if (baseRev < fresh.rev) {
            const merge = mergeDocPatch(base || fresh, fresh, patch)
            if (merge.conflicts.length) {
              if (!choices) {
                conflict = { doc: fresh, merge }
                hasConflicts = true
              } else {
                finalPatch = resolveMerge(merge, choices)
              }
            } else {
              finalPatch = merge.fields
            }
            merged = true
          }

          // 事务内抛出会回滚整个保存：冲突时远端文档与版本记录保持原样
          if (hasConflicts) throw new ConflictError(conflict)

          const now = new Date().toISOString()
          const userId = currentUser?.id || 'u-guest'
          const nextVersion = fresh.versions.length + 1
          const updated = normalizeDoc({
            ...fresh,
            ...finalPatch,
            rev: fresh.rev + 1,
            updatedAt: now,
            editors: fresh.editors.includes(userId) ? fresh.editors : [...fresh.editors, userId],
            versions: [
              ...fresh.versions,
              {
                version: nextVersion,
                savedAt: now,
                savedBy: userId,
                note: note || '编辑文档',
                baseRev,
                merged,
                // 保存正文与标题快照，供后续排查覆盖问题与历史追溯
                title: finalPatch.title != null ? finalPatch.title : fresh.title,
                body: finalPatch.body != null ? finalPatch.body : fresh.body
              }
            ]
          })
          await db.docs.put(updated)
          return { status: choices ? 'resolved' : merged ? 'merged' : 'saved', doc: updated }
        })

        if (result === null) return null
        broadcastDocChanged('saved', id)
        await reloadDocs()
        return result
      } catch (e) {
        if (e instanceof ConflictError) throw e
        // IndexedDB 事务冲突等瞬时错误：重新读取最新版本后重试（重新走合并流程）
        if (attempt === 2) throw e
      }
    }
    return null
  }

  // 兼容旧调用：未提供编辑基线时不做冲突检测，仍以库中最新文档为基准保存，
  // 版本记录在最新列表后追加，不会覆盖其他窗口的修改。
  async function updateDoc(id, patch, currentUser, note) {
    const result = await saveDoc(id, patch, currentUser, note)
    return result ? result.doc : null
  }

  async function deleteDoc(id) {
    await db.docs.delete(id)
    await db.comments.where('docId').equals(id).delete()
    await db.shares.where('docId').equals(id).delete()
    broadcastDocChanged('deleted', id)
    await reloadDocs()
  }

  async function addCategory(name, icon) {
    const cat = { id: uid('c'), name, icon: icon || 'doc' }
    await db.categories.add(cat)
    categories.value.push(cat)
    return cat
  }

  async function addTag(name, color) {
    const tag = { id: uid('t'), name, color: color || '#4f6ef7' }
    await db.tags.add(tag)
    tags.value.push(tag)
    return tag
  }

  // ---- 评论 ----
  async function addComment(docId, content, mentionIds, authorId) {
    const cmt = { id: uid('cmt'), docId, authorId, content, mentionIds: mentionIds || [], createdAt: new Date().toISOString() }
    await db.comments.add(cmt)
    comments.value.push(cmt)
    return cmt
  }

  function commentsOf(docId) {
    return comments.value
      .filter((c) => c.docId === docId)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
  }

  // 其他窗口保存 / 删除文档时刷新内存缓存
  onDocChanged((msg) => {
    if (!loaded.value) return
    if (msg?.type === 'saved') reloadDocs()
    else if (msg?.type === 'deleted') reloadDocs()
  })

  return {
    docs, categories, tags, comments, loaded,
    catMap, tagMap, loadAll, reloadDocs, getDoc, createDoc, saveDoc, updateDoc, deleteDoc,
    addCategory, addTag, addComment, commentsOf
  }
})
