<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute } from 'vue-router'
import { db } from '@/db'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import DocPill from '@/components/common/DocPill.vue'
import RichEditor from '@/components/doc/RichEditor.vue'
import { formatFull } from '@/utils/format'
import { shareStatus, canShareEdit } from '@/utils/share'
import { onDocChanged } from '@/utils/sync'

const route = useRoute()
const kb = useKbStore()
const auth = useAuthStore()

const share = ref(null)
const doc = ref(null)
const status = ref('loading')

const editing = ref(false)
const editBody = ref('')
const saving = ref(false)
// 共享编辑的基线快照与冲突状态
const baseDoc = ref(null)
const conflict = ref(null)
const choices = ref({})
const remoteNotice = ref('')

const token = computed(() => route.params.token)
const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))
// 编辑入口与链接状态绑定：撤销/过期后立即失去编辑权限
const editable = computed(() => canShareEdit(share.value))
const bodySegments = computed(() => conflict.value?.merge.segmentsMap.body || [])
const remoteUser = computed(() => {
  const vers = conflict.value?.doc.versions
  const savedBy = vers?.[vers.length - 1]?.savedBy
  return userById.value[savedBy]?.name || savedBy || '其他协作者'
})

async function resolve(tokenVal) {
  status.value = 'loading'
  share.value = null
  doc.value = null
  editing.value = false
  const s = await db.shares.where('token').equals(tokenVal).first()
  if (!s) { status.value = 'notfound'; return }
  const st = shareStatus(s)
  if (st === 'revoked') { status.value = 'revoked'; return }
  if (st === 'expired') { status.value = 'expired'; return }
  const d = await kb.getDoc(s.docId)
  if (!d) { status.value = 'notfound'; return }
  share.value = s
  doc.value = d
  status.value = 'ok'
}

function startEdit() {
  // 编辑前刷新到最新版本并记录基线，避免覆盖其他窗口/协作者的保存
  kb.getDoc(share.value.docId).then((d) => {
    if (!d) return
    doc.value = d
    baseDoc.value = JSON.parse(JSON.stringify(d))
    editBody.value = d.body
    editing.value = true
    conflict.value = null
  })
}

function failSoft(msg) {
  alert(msg)
}

async function saveEdit() {
  if (saving.value) return
  saving.value = true
  try {
    const result = await kb.saveDoc(doc.value.id, { body: editBody.value }, auth.user, '通过共享链接编辑', {
      base: baseDoc.value
    })
    if (result) {
      doc.value = result.doc
      baseDoc.value = JSON.parse(JSON.stringify(result.doc))
    }
    editing.value = false
    conflict.value = null
  } catch (e) {
    if (e.name === 'ConflictError') {
      conflict.value = e.payload
      choices.value = {}
      for (const c of e.payload.merge.conflicts) choices.value[c.id] = 'ours'
      remoteNotice.value = ''
    } else {
      failSoft('保存失败，请重试')
    }
  } finally {
    saving.value = false
  }
}

// 访客按逐处选择解决正文冲突后保存
async function saveResolved() {
  if (saving.value) return
  saving.value = true
  try {
    const result = await kb.saveDoc(doc.value.id, { body: editBody.value }, auth.user, '通过共享链接合并冲突后保存', {
      base: baseDoc.value,
      choices: choices.value
    })
    if (result) {
      doc.value = result.doc
      baseDoc.value = JSON.parse(JSON.stringify(result.doc))
      editBody.value = result.doc.body
    }
    editing.value = false
    conflict.value = null
  } catch (e) {
    if (e.name === 'ConflictError') {
      conflict.value = e.payload
      choices.value = {}
      for (const c of e.payload.merge.conflicts) choices.value[c.id] = 'ours'
    } else {
      failSoft('保存失败，请重试')
    }
  } finally {
    saving.value = false
  }
}

// 继续编辑我的版本：以远端最新为新基线，正文保留访客未提交内容，稍后再试保存
function deferConflict() {
  if (conflict.value) {
    baseDoc.value = conflict.value.doc
    doc.value = conflict.value.doc
  }
  conflict.value = null
  choices.value = {}
}

function cancelEdit() {
  editing.value = false
  conflict.value = null
}

let unsub = null
onMounted(() => {
  resolve(token.value)
  unsub = onDocChanged(async (msg) => {
    if (msg?.type !== 'saved' || !doc.value || msg.id !== doc.value.id) return
    const fresh = await kb.getDoc(doc.value.id)
    if (!fresh) return
    if (!editing.value) doc.value = fresh
    else if (!conflict.value) remoteNotice.value = '其他协作者刚保存了该文档，本次保存将自动合并'
  })
})
onBeforeUnmount(() => unsub?.())
watch(token, () => resolve(token.value))
</script>

<template>
  <div class="share">
    <div v-if="status === 'loading'" class="empty card"><div class="ico">⏳</div>正在加载共享文档…</div>
    <div v-else-if="status === 'notfound'" class="empty card"><div class="ico">🚫</div>共享链接无效或文档不存在</div>
    <div v-else-if="status === 'revoked'" class="empty card"><div class="ico">⛔</div>该共享链接已被撤销，如需访问请联系分享者重新生成</div>
    <div v-else-if="status === 'expired'" class="empty card"><div class="ico">⏰</div>该共享链接已过期，如需访问请联系分享者重新生成</div>

    <template v-else-if="doc">
      <div class="share-banner card">
        <span>🔗 您正在通过共享链接查看「{{ share.permission === 'edit' ? '可编辑' : '只读' }}」副本</span>
        <span class="owner">由 {{ userById[share.createdBy]?.name || share.createdBy }} 分享</span>
      </div>

      <div class="page-head card">
        <div class="title-row">
          <h1 class="title">{{ doc.title }}</h1>
          <button v-if="editable && !editing" class="btn primary sm" @click="startEdit">✎ 编辑文档</button>
        </div>
        <div class="sub">
          <DocPill :doc="doc" />
          <span>更新于 {{ formatFull(doc.updatedAt) }}</span>
        </div>
      </div>

      <div v-if="remoteNotice && !conflict" class="remote-notice">🔔 {{ remoteNotice }}</div>

      <div v-if="conflict" class="conflict-panel card">
        <div class="cf-head">
          <span class="cf-title">⚠️ 检测到版本冲突</span>
          <span class="cf-sub">{{ remoteUser }} 在此期间保存了新版本。你的修改已保留，逐处选择保留哪一方后合并保存。</span>
        </div>
        <div v-for="(seg, si) in bodySegments" :key="seg.t === 'cf' ? seg.id : 't-' + si" class="cf-seg">
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
        <div class="cf-actions">
          <button class="btn" @click="deferConflict">稍后处理（保留我的修改继续编辑）</button>
          <button class="btn primary" :disabled="saving" @click="saveResolved">{{ saving ? '保存中…' : '按选择合并并保存' }}</button>
        </div>
      </div>

      <template v-if="editing">
        <div class="card editor-wrap">
          <RichEditor v-model="editBody" />
        </div>
        <div class="edit-bar card">
          <span class="hint">修改将直接保存到原文档，并记录为新版本；与他人同时修改时会先自动合并</span>
          <div class="edit-actions">
            <button class="btn" :disabled="saving" @click="cancelEdit">取消</button>
            <button v-if="!conflict" class="btn primary" :disabled="saving" @click="saveEdit">{{ saving ? '保存中…' : '保存修改' }}</button>
          </div>
        </div>
      </template>
      <article v-else class="render card" v-html="doc.body"></article>

      <div class="foot card">
        <span class="link-label">以访客身份阅读</span>
        <a class="btn" href="#/">前往知识库首页 →</a>
      </div>
    </template>
  </div>
</template>

<style scoped>
.share { padding: 20px 0; }
.share-banner { padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; background: var(--primary-weak); border-color: var(--primary); color: var(--primary); font-weight: 500; }
.owner { font-weight: 400; font-size: 12px; opacity: 0.8; }
.page-head { padding: 20px 24px; margin-bottom: 14px; }
.title-row { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
.title { margin: 0 0 10px; }
.title-row .title { margin: 0; }
.sub { display: flex; align-items: center; gap: 12px; color: var(--text-3); font-size: 12px; margin-top: 10px; }
.render { padding: 28px 32px; line-height: 1.8; margin-bottom: 14px; }
.render :deep(h1) { font-size: 26px; } .render :deep(h2) { font-size: 21px; }
.render :deep(pre) { background: #1f2733; color: #dff2ff; padding: 12px 14px; border-radius: 8px; overflow: auto; }
.render :deep(blockquote) { border-left: 3px solid var(--primary); margin: 8px 0; padding: 4px 12px; color: var(--text-2); background: var(--primary-weak); }
.render :deep(img) { max-width: 100%; }
.editor-wrap { padding: 0; overflow: hidden; margin-bottom: 14px; }
.edit-bar { padding: 12px 16px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.hint { color: var(--text-3); font-size: 12px; }
.edit-actions { display: flex; gap: 8px; }
.foot { padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; }
.link-label { color: var(--text-3); font-size: 13px; }

.remote-notice { padding: 10px 16px; margin-bottom: 14px; border-radius: var(--radius); background: var(--primary-weak); color: var(--primary); font-size: 13px; border: 1px solid var(--primary); }
.conflict-panel { padding: 18px 22px; margin-bottom: 14px; border: 1px solid #f7a24f; }
.cf-head { display: flex; flex-direction: column; gap: 4px; padding-bottom: 12px; border-bottom: 1px dashed var(--border); margin-bottom: 12px; }
.cf-title { font-weight: 700; color: #c77a2b; font-size: 15px; }
.cf-sub { color: var(--text-2); font-size: 13px; }
.cf-seg { margin-bottom: 8px; }
.cf-text { padding: 4px 2px; color: var(--text-2); }
.cf-choice { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.cf-pick { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; cursor: pointer; transition: all 0.15s; }
.cf-pick:hover { border-color: var(--primary); }
.cf-pick.pick { border-color: var(--primary); box-shadow: 0 0 0 2px var(--primary-weak); }
.pick-tag { font-size: 12px; font-weight: 600; color: var(--primary); margin-bottom: 4px; }
.pick-tag.theirs { color: #c77a2b; }
.pick-body { font-size: 13px; max-height: 200px; overflow: auto; }
.pick-body :deep(.empty) { color: var(--text-3); }
.cf-actions { display: flex; justify-content: flex-end; gap: 10px; padding-top: 12px; flex-wrap: wrap; }
</style>
