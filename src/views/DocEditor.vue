<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import RichEditor from '@/components/doc/RichEditor.vue'
import { uid } from '@/utils/format'

const route = useRoute()
const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()

const isEdit = computed(() => route.params.id && route.params.id !== 'new')
const editingDoc = ref(null)

const title = ref('')
const categoryId = ref('')
const tagIds = ref([])
const visibility = ref('public')
const body = ref('')
const stats = ref({ chars: 0, words: 0, imgs: 0 })
const draftKey = 'kb:draft:' + route.params.id
const savedToast = ref('')

const tagChecked = (id) => tagIds.value.includes(id)
function toggleTag(id) {
  tagIds.value = tagIds.value.includes(id) ? tagIds.value.filter((x) => x !== id) : [...tagIds.value, id]
}
async function addNewTag() {
  const name = prompt('新标签名称：')
  if (!name) return
  const t = await kb.addTag(name.trim())
  toggleTag(t.id)
}
async function addNewCat() {
  const name = prompt('新分类名称：')
  if (!name) return
  const c = await kb.addCategory(name.trim())
  categoryId.value = c.id
}

function saveDraft() {
  localStorage.setItem(draftKey, JSON.stringify({ title: title.value, categoryId: categoryId.value, tagIds: tagIds.value, visibility: visibility.value, body: body.value, ts: Date.now() }))
}

async function submit() {
  if (!title.value.trim()) { alert('请填写标题'); return }
  const payload = { title: title.value.trim(), categoryId: categoryId.value, tagIds: [...tagIds.value], visibility: visibility.value, body: body.value }
  if (isEdit.value) {
    await kb.updateDoc(route.params.id, payload, auth.user, '编辑文档')
    localStorage.removeItem(draftKey)
    router.push('/docs/' + route.params.id)
  } else {
    const d = await kb.createDoc(payload, auth.user)
    localStorage.removeItem(draftKey)
    router.push('/docs/' + d.id)
  }
}

function doCancel() {
  if (isEdit.value) router.push('/docs/' + route.params.id)
  else router.push('/docs')
}

function manualSave() {
  saveDraft()
  savedToast.value = '已保存草稿 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  setTimeout(() => { savedToast.value = '' }, 2000)
}

async function load() {
  if (isEdit.value) {
    const d = await kb.getDoc(route.params.id)
    if (d) {
      editingDoc.value = d
      title.value = d.title; categoryId.value = d.categoryId; tagIds.value = [...(d.tagIds || [])]
      visibility.value = d.visibility; body.value = d.body
    }
  } else {
    const draft = localStorage.getItem(draftKey)
    if (draft) {
      const p = JSON.parse(draft)
      title.value = p.title || ''
      categoryId.value = p.categoryId || kb.categories[0]?.id || ''
      tagIds.value = p.tagIds || []
      visibility.value = p.visibility || 'public'
      body.value = p.body || ''
    } else if (kb.categories[0]) {
      categoryId.value = kb.categories[0].id
    }
  }
}

const saveTimer = ref(null)
function scheduleAutoSave() {
  clearTimeout(saveTimer.value)
  saveTimer.value = setTimeout(() => {
    saveDraft()
    savedToast.value = '草稿已自动保存 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    setTimeout(() => { savedToast.value = '' }, 2000)
  }, 1200)
}
watch([title, categoryId, tagIds, visibility, body], scheduleAutoSave, { deep: true })

onMounted(load)
onBeforeUnmount(() => { clearTimeout(saveTimer.value); if (!isEdit.value) saveDraft() })

const canPublish = computed(() => title.value.trim() && categoryId.value)
</script>

<template>
  <div class="editor-page">
    <div class="toolbar row">
      <button class="btn" @click="doCancel">← 返回</button>
      <span class="mode-badge">{{ isEdit ? '编辑文档' : '新建文档' }}</span>
      <span class="toast">{{ savedToast }}</span>
      <div class="spacer"></div>
      <button class="btn" @click="manualSave">保存草稿</button>
      <button class="btn primary" :disabled="!canPublish" @click="submit">{{ isEdit ? '保存变更' : '发布文档' }}</button>
    </div>

    <div class="form card">
      <div class="field title-field">
        <input class="big-title" v-model="title" placeholder="文档标题…" maxlength="80" />
      </div>

      <div class="field row-auto">
        <label>分类</label>
        <div class="chips">
          <span v-for="c in kb.categories" :key="c.id" class="chip" :class="{ on: categoryId === c.id }" @click="categoryId = c.id">{{ c.name }}</span>
          <button class="chip add" @click="addNewCat">＋ 新建分类</button>
        </div>
      </div>

      <div class="field row-auto">
        <label>标签</label>
        <div class="chips">
          <span v-for="t in kb.tags" :key="t.id" class="chip" :class="{ on: tagChecked(t.id) }" :style="tagChecked(t.id) ? { background: t.color, borderColor: t.color, color: '#fff' } : {}" @click="toggleTag(t.id)">#{{ t.name }}</span>
          <button class="chip add" @click="addNewTag">＋ 新建标签</button>
        </div>
      </div>

      <div class="field row-auto">
        <label>可见性</label>
        <div class="chips">
          <span class="chip" :class="{ on: visibility === 'public' }" @click="visibility = 'public'">🌐 公开</span>
          <span class="chip" :class="{ on: visibility === 'team' }" @click="visibility = 'team'">👥 团队</span>
          <span class="chip" :class="{ on: visibility === 'private' }" @click="visibility = 'private'">🔒 私有</span>
        </div>
      </div>
    </div>

    <div class="card editor-wrap">
      <RichEditor v-model="body" @stats="stats = $event" />
    </div>
    <div class="statline">正文 {{ stats.chars }} 字 · {{ stats.words }} 词 · 图片 {{ stats.imgs }} 张</div>
  </div>
</template>

<style scoped>
.editor-page { max-width: 860px; margin: 0 auto; }
.toolbar.row { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.mode-badge { font-weight: 600; color: var(--text-2); }
.toast { color: var(--accent); font-size: 12px; }
.spacer { flex: 1; }
.form { padding: 20px 24px; margin-bottom: 14px; display: flex; flex-direction: column; gap: 14px; }
.field { display: flex; flex-direction: column; gap: 8px; }
.field.row-auto { flex-direction: row; align-items: center; gap: 14px; }
.field label { font-size: 13px; color: var(--text-2); width: 60px; }
.big-title { width: 100%; border: none; outline: none; font-size: 26px; font-weight: 700; color: var(--text); padding: 6px 0; border-bottom: 2px solid var(--border); }
.big-title:focus { border-color: var(--primary); }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { padding: 4px 12px; border-radius: 999px; border: 1px solid var(--border); background: var(--panel-2); cursor: pointer; font-size: 13px; transition: all 0.15s; }
.chip.on { background: var(--primary); border-color: var(--primary); color: #fff; }
.chip.add { border-style: dashed; color: var(--text-3); background: transparent; }
.editor-wrap { padding: 0; overflow: hidden; }
.statline { color: var(--text-3); font-size: 12px; margin-top: 8px; padding-left: 4px; }
</style>