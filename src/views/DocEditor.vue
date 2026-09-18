<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import RichEditor from '@/components/doc/RichEditor.vue'
import { resolveMerge } from '@/utils/merge'
import { onDocChanged } from '@/utils/sync'

const route = useRoute()
const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()

const isEdit = computed(() => route.params.id && route.params.id !== 'new')
const editingDoc = ref(null)
// 编辑基线快照：保存时据此判断期间是否有其他窗口提交了新版本
const baseDoc = ref(null)

const title = ref('')
const categoryId = ref('')
const tagIds = ref([])
const visibility = ref('public')
const body = ref('')
const stats = ref({ chars: 0, words: 0, imgs: 0 })
const draftKey = 'kb:draft:' + route.params.id
const savedToast = ref('')
const saving = ref(false)

// 版本冲突状态：merge 为三路合并结果，choices 为用户对每处冲突的选择
const conflict = ref(null)
const choices = ref({})
// 其他窗口在此窗口编辑期间保存时的非阻断提示
const remoteNotice = ref('')

const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))
const catById = computed(() => Object.fromEntries(kb.categories.map((c) => [c.id, c])))

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

function currentPayload() {
  return { title: title.value.trim(), categoryId: categoryId.value, tagIds: [...tagIds.value], visibility: visibility.value, body: body.value }
}

function saveDraft() {
  localStorage.setItem(draftKey, JSON.stringify({ ...currentPayload(), ts: Date.now() }))
}

// 冲突字段渲染：从合并分段中取该字段的冲突 / 普通段
function conflictsOfField(field) {
  return conflict.value.merge.conflicts.filter((c) => c.field === field)
}
const conflictFields = computed(() => [...new Set(conflict.value?.merge.conflicts.map((c) => c.field) || [])])
function segmentsOfField(field) {
  return conflict.value.merge.segmentsMap[field] || []
}
function scalarLabel(v, field) {
  if (field === 'categoryId') return catById.value[v]?.name || v || '未分类'
  if (field === 'visibility') return { public: '🌐 公开', team: '👥 团队', private: '🔒 私有' }[v] || v
  return v
}
function whoText(savedBy) {
  return userById.value[savedBy]?.name || savedBy || '其他协作者'
}
const remoteUser = computed(() => whoText(conflict.value?.doc.versions?.[conflict.value.doc.versions.length - 1]?.savedBy))

async function submit() {
  if (!title.value.trim()) { alert('请填写标题'); return }
  if (saving.value) return
  saving.value = true
  try {
    const result = await kb.saveDoc(route.params.id, currentPayload(), auth.user, '编辑文档', {
      base: baseDoc.value
    })
    localStorage.removeItem(draftKey)
    router.push({ path: '/docs/' + route.params.id, query: result?.status === 'merged' ? { merged: 1 } : {} })
  } catch (e) {
    if (e.name === 'ConflictError') {
      // 保留未提交内容：合并结果与用户输入都在内存中，同时落一份安全草稿
      saveDraft()
      conflict.value = e.payload
      choices.value = {}
      for (const c of e.payload.merge.conflicts) choices.value[c.id] = 'ours'
      remoteNotice.value = ''
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } else {
      throw e
    }
  } finally {
    saving.value = false
  }
}

// 按用户逐处选择解决冲突后再次保存
async function submitResolved() {
  if (saving.value) return
  saving.value = true
  try {
    await kb.saveDoc(route.params.id, currentPayload(), auth.user, '合并冲突后保存', {
      base: baseDoc.value,
      choices: choices.value
    })
    localStorage.removeItem(draftKey)
    router.push('/docs/' + route.params.id)
  } catch (e) {
    if (e.name === 'ConflictError') {
      // 解决期间又有新窗口保存：基于最新结果重新生成冲突清单
      saveDraft()
      conflict.value = e.payload
      choices.value = {}
      for (const c of e.payload.merge.conflicts) choices.value[c.id] = 'ours'
    } else {
      throw e
    }
  } finally {
    saving.value = false
  }
}

// 放弃合并，只保留我方修改（以最新远端为新基线、正文等保持当前未提交内容，不保存）
function cancelConflict() {
  if (conflict.value) baseDoc.value = conflict.value.doc
  conflict.value = null
  choices.value = {}
}

// 冲突解决时直接拉取远端最新版本；本地未提交内容额外备份到独立草稿键，不被自动保存覆盖
async function useRemoteVersion() {
  const d = conflict.value.doc
  const backupKey = draftKey + ':conflict-copy'
  localStorage.setItem(backupKey, JSON.stringify({ ...currentPayload(), ts: Date.now() }))
  suppressAutoSave = true
  clearTimeout(saveTimer.value)
  baseDoc.value = d
  title.value = d.title
  categoryId.value = d.categoryId || ''
  tagIds.value = [...(d.tagIds || [])]
  visibility.value = d.visibility
  body.value = d.body
  conflict.value = null
  choices.value = {}
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
      baseDoc.value = JSON.parse(JSON.stringify(d))
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

// 其他窗口保存了同一文档：保存时会自动合并；若此时尚未开始改则直接同步到最新
let unsubDocChanged = null
onMounted(() => {
  load()
  unsubDocChanged = onDocChanged((msg) => {
    if (msg?.type !== 'saved' || msg.id !== route.params.id) return
    if (conflict.value) return
    if (!baseDoc.value) return
    remoteNotice.value = '其他窗口刚保存了该文档，本次保存将自动合并双方修改'
  })
})
onBeforeUnmount(() => {
  clearTimeout(saveTimer.value)
  unsubDocChanged?.()
  if (!isEdit.value) saveDraft()
})

const saveTimer = ref(null)
let suppressAutoSave = false
function scheduleAutoSave() {
  if (suppressAutoSave) { suppressAutoSave = false; return } // 程序化填入对方版本时不要用它覆盖草稿
  clearTimeout(saveTimer.value)
  saveTimer.value = setTimeout(() => {
    saveDraft()
    savedToast.value = '草稿已自动保存 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    setTimeout(() => { savedToast.value = '' }, 2000)
  }, 1200)
}
watch([title, categoryId, tagIds, visibility, body], scheduleAutoSave, { deep: true })

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
      <button v-if="!conflict" class="btn primary" :disabled="!canPublish || saving" @click="submit">{{ saving ? '保存中…' : isEdit ? '保存变更' : '发布文档' }}</button>
    </div>

    <div v-if="remoteNotice && !conflict" class="remote-notice">🔔 {{ remoteNotice }}</div>

    <div v-if="conflict" class="conflict-panel card">
      <div class="cf-head">
        <span class="cf-title">⚠️ 检测到版本冲突</span>
        <span class="cf-sub">{{ remoteUser }} 在此期间保存了新版本（v{{ conflict.doc.versions.length }}）。你的修改已保留，可逐处对比后决定保留哪一方。</span>
      </div>

      <div v-for="f in conflictFields" :key="f" class="cf-field">
        <div class="cf-field-label">{{ { title: '标题', body: '正文', categoryId: '分类', visibility: '可见性' }[f] || f }}</div>

        <template v-if="f === 'body'">
          <div v-for="(seg, si) in segmentsOfField('body')" :key="seg.t === 'cf' ? seg.id : 't-' + si" class="cf-seg">
            <div v-if="seg.t === 'text'" class="cf-text" v-html="seg.v"></div>
            <div v-else class="cf-choice">
              <div class="cf-pick" :class="{ pick: choices[seg.id] === 'ours' }" @click="choices[seg.id] = 'ours'">
                <div class="pick-tag">我的修改</div>
                <div class="pick-body" v-html="seg.ours || '<span class=empty>（空）</span>'"></div>
              </div>
              <div class="cf-pick" :class="{ pick: choices[seg.id] === 'theirs' }" @click="choices[seg.id] = 'theirs'">
                <div class="pick-tag theirs">{{ remoteUser }} 的修改</div>
                <div class="pick-body" v-html="seg.theirs || '<span class=empty>（空）</span>'"></div>
              </div>
            </div>
          </div>
        </template>

        <template v-else-if="f === 'title'">
          <div v-for="(seg, si) in segmentsOfField('title')" :key="seg.t === 'cf' ? seg.id : 't-' + si">
            <span v-if="seg.t === 'text'">{{ seg.v }}</span>
            <template v-else>
              <label class="cf-radio" :class="{ pick: choices[seg.id] === 'ours' }">
                <input type="radio" :name="seg.id" :checked="choices[seg.id] === 'ours'" @change="choices[seg.id] = 'ours'" />我的：{{ seg.ours || '（空）' }}
              </label>
              <label class="cf-radio" :class="{ pick: choices[seg.id] === 'theirs' }">
                <input type="radio" :name="seg.id" :checked="choices[seg.id] === 'theirs'" @change="choices[seg.id] = 'theirs'" />{{ remoteUser }}：{{ seg.theirs || '（空）' }}
              </label>
            </template>
          </div>
        </template>

        <template v-else>
          <div v-for="c in conflictsOfField(f)" :key="c.id" class="cf-scalar">
            <label class="cf-radio" :class="{ pick: choices[c.id] === 'ours' }">
              <input type="radio" :name="c.id" :checked="choices[c.id] === 'ours'" @change="choices[c.id] = 'ours'" />我的：{{ scalarLabel(c.ours, f) }}
            </label>
            <label class="cf-radio" :class="{ pick: choices[c.id] === 'theirs' }">
              <input type="radio" :name="c.id" :checked="choices[c.id] === 'theirs'" @change="choices[c.id] = 'theirs'" />{{ remoteUser }}：{{ scalarLabel(c.theirs, f) }}
            </label>
          </div>
        </template>
      </div>

      <div class="cf-actions">
        <button class="btn" @click="useRemoteVersion">采用对方版本（我的修改已备份到草稿副本）</button>
        <button class="btn" @click="cancelConflict">稍后处理（继续编辑我的版本）</button>
        <button class="btn primary" :disabled="saving" @click="submitResolved">{{ saving ? '保存中…' : '按选择合并并保存' }}</button>
      </div>
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

.remote-notice { padding: 10px 16px; margin-bottom: 14px; border-radius: var(--radius); background: var(--primary-weak); color: var(--primary); font-size: 13px; border: 1px solid var(--primary); }
.conflict-panel { padding: 18px 22px; margin-bottom: 14px; border-color: var(--warn, #f7a24f); border-width: 1px; }
.cf-head { display: flex; flex-direction: column; gap: 4px; padding-bottom: 12px; border-bottom: 1px dashed var(--border); margin-bottom: 12px; }
.cf-title { font-weight: 700; color: var(--warn, #c77a2b); font-size: 15px; }
.cf-sub { color: var(--text-2); font-size: 13px; }
.cf-field { padding: 10px 0; border-bottom: 1px dashed var(--border); }
.cf-field:last-of-type { border-bottom: none; }
.cf-field-label { font-size: 12px; color: var(--text-3); margin-bottom: 8px; font-weight: 600; }
.cf-seg { margin-bottom: 8px; }
.cf-text { padding: 4px 2px; color: var(--text-2); }
.cf-choice { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.cf-pick { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; cursor: pointer; transition: all 0.15s; }
.cf-pick:hover { border-color: var(--primary); }
.cf-pick.pick { border-color: var(--primary); box-shadow: 0 0 0 2px var(--primary-weak); }
.pick-tag { font-size: 12px; font-weight: 600; color: var(--primary); margin-bottom: 4px; }
.pick-tag.theirs { color: var(--warn, #c77a2b); }
.pick-body { font-size: 13px; max-height: 180px; overflow: auto; }
.pick-body :deep(.empty) { color: var(--text-3); }
.cf-radio { display: flex; align-items: center; gap: 6px; padding: 6px 10px; margin: 4px 0; border: 1px solid var(--border); border-radius: 8px; cursor: pointer; font-size: 13px; }
.cf-radio.pick { border-color: var(--primary); background: var(--primary-weak); }
.cf-scalar { display: flex; gap: 10px; flex-wrap: wrap; }
.cf-scalar .cf-radio { margin: 0; }
.cf-actions { display: flex; justify-content: flex-end; gap: 10px; padding-top: 14px; flex-wrap: wrap; }
</style>
