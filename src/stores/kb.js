import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { db } from '@/db'
import { uid } from '@/utils/format'
import { useAuthStore } from './auth'

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
    docs.value = await db.docs.toArray()
    categories.value = await db.categories.toArray()
    tags.value = await db.tags.toArray()
    comments.value = await db.comments.toArray()
    loaded.value = true
  }

  async function reloadDocs() {
    docs.value = await db.docs.toArray()
  }

  async function getDoc(id) {
    await loadAll()
    return docs.value.find((d) => d.id === id) || null
  }

  async function createDoc(payload, currentUser) {
    await loadAll()
    const now = new Date().toISOString()
    const doc = {
      id: uid('doc'),
      title: payload.title || '无标题文档',
      categoryId: payload.categoryId || categories.value[0]?.id || null,
      tagIds: payload.tagIds || [],
      body: payload.body || '',
      visibility: payload.visibility || 'public',
      ownerId: currentUser?.id || 'u-guest',
      editors: [currentUser?.id || 'u-guest'],
      createdAt: now,
      updatedAt: now,
      versions: [{ version: 1, savedAt: now, savedBy: currentUser?.id || 'u-guest', note: '创建文档' }]
    }
    await db.docs.add(doc)
    await reloadDocs()
    return doc
  }

  async function updateDoc(id, patch, currentUser, note) {
    await loadAll()
    const existing = docs.value.find((d) => d.id === id)
    if (!existing) return null
    const now = new Date().toISOString()
    const nextVersion = existing.versions.length + 1
    const updated = {
      ...existing,
      ...patch,
      updatedAt: now,
      versions: [
        ...existing.versions,
        { version: nextVersion, savedAt: now, savedBy: currentUser?.id || 'u-guest', note: note || '编辑文档' }
      ]
    }
    await db.docs.put(updated)
    await reloadDocs()
    return updated
  }

  async function deleteDoc(id) {
    await db.docs.delete(id)
    await db.comments.where('docId').equals(id).delete()
    await db.shares.where('docId').equals(id).delete()
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

  return {
    docs, categories, tags, comments, loaded,
    catMap, tagMap, loadAll, reloadDocs, getDoc, createDoc, updateDoc, deleteDoc,
    addCategory, addTag, addComment, commentsOf
  }
})