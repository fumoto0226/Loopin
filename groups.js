// Group management: list/create/switch/invite, sync current group's data to/from Firestore.
window.LoopinGroups = (function () {
  const LS_LAST_GROUP = 'loopin_last_group';
  const MAX_GROUPS = 10;
  let groups = [];
  let limitNoticeShown = false;
  let currentGroupId = null;
  let unsubGroups = null;
  let unsubCurrent = null;
  let saveTimer = null;
  let suppressNextSnap = false;   // ignore the snapshot triggered by our own write
  let onGroupDataCb = null;       // called when remote group data changes
  let memberCache = {};           // uid -> userDoc cached after fetch

  function freshData() { return { people: [], library: [], weeks: {}, meta: { lastWeek: null } }; }

  async function start(user, onGroupData) {
    onGroupDataCb = onGroupData;
    const { db, collection, query, where, onSnapshot, getDocs, updateDoc, arrayUnion, doc } = window.fb;

    // Auto-join any group that previously invited this user's email (capped by MAX_GROUPS).
    try {
      const { getDocs: _getDocs } = window.fb;
      const qExisting = query(collection(db, 'loopinGroups'), where('memberIds', 'array-contains', user.uid));
      const exSnap = await _getDocs(qExisting);
      let remaining = Math.max(0, MAX_GROUPS - exSnap.size);

      const qPending = query(collection(db, 'loopinGroups'), where('pendingEmails', 'array-contains', user.email));
      const pendSnap = await getDocs(qPending);
      for (const d of pendSnap.docs) {
        if (remaining <= 0) break;
        await updateDoc(doc(db, 'loopinGroups', d.id), {
          memberIds: arrayUnion(user.uid),
        });
        // Remove email from pendingEmails in a second op to keep it simple.
        const fb2 = window.fb;
        await updateDoc(doc(db, 'loopinGroups', d.id), { pendingEmails: fb2.arrayRemove(user.email) });
        remaining--;
      }
      if (remaining === 0 && pendSnap.size > 0) {
        // There were pending invites but we hit the cap. Notify once.
        setTimeout(() => {
          window.appAlert && window.appAlert(`你已加入 ${MAX_GROUPS} 个打卡组，已达上限。如需加入新的邀请，请先退出或删除一个旧的组。`, { title: '已达上限' });
        }, 800);
      }
    } catch (e) { console.warn('auto-join pending failed:', e); }

    const q = query(collection(db, 'loopinGroups'), where('memberIds', 'array-contains', user.uid));
    unsubGroups = onSnapshot(q, async (snap) => {
      groups = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      groups.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      renderGroupSwitcher();
      renderGroupPicker();

      if (!groups.length) {
        currentGroupId = null;
        showGroupPicker();
        return;
      }
      // Pick last-used or first.
      const last = localStorage.getItem(LS_LAST_GROUP);
      const want = (last && groups.find(g => g.id === last)) ? last : groups[0].id;
      if (currentGroupId !== want) {
        await switchTo(want);
      } else {
        hideGroupPicker();
      }
    });
  }

  async function switchTo(groupId) {
    const { db, doc, onSnapshot } = window.fb;
    if (unsubCurrent) { unsubCurrent(); unsubCurrent = null; }
    currentGroupId = groupId;
    localStorage.setItem(LS_LAST_GROUP, groupId);
    hideGroupPicker();
    const ref = doc(db, 'loopinGroups', groupId);
    unsubCurrent = onSnapshot(ref, async (s) => {
      if (!s.exists()) return;
      if (suppressNextSnap) { suppressNextSnap = false; return; }
      const g = { id: s.id, ...s.data() };
      await cacheMembers(g.memberIds || []);
      const members = (g.memberIds || []).map(uid => {
        const u = memberCache[uid];
        // Prefer the Loopin-specific avatar so each app can have its own emoji.
        return { uid, name: u?.name || '未知用户', emoji: u?.loopinEmoji || u?.emoji || '🙂', email: u?.email || '' };
      });
      const data = g.data || freshData();
      onGroupDataCb && onGroupDataCb(g, data, members);
      updateCurrentGroupName(g.name);
    });
  }

  function getCurrentGroupId() { return currentGroupId; }
  function getCurrentGroup() { return groups.find(g => g.id === currentGroupId) || null; }

  // Debounced write of group state to Firestore. `people` is derived from
  // memberIds; `library` is per-user (saved separately) so it's not stored on the group.
  function scheduleSave(state) {
    if (!currentGroupId) return;
    const data = { weeks: state.weeks, meta: state.meta };
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const { db, doc, updateDoc } = window.fb;
      try {
        suppressNextSnap = true;
        await updateDoc(doc(db, 'loopinGroups', currentGroupId), { data, updatedAt: Date.now() });
      } catch (e) {
        suppressNextSnap = false;
        console.error('保存失败:', e);
      }
    }, 500);
  }

  async function createGroup(name) {
    if (groups.length >= MAX_GROUPS) {
      await window.appAlert(`你已加入 ${MAX_GROUPS} 个打卡组，已达数量上限。请先退出或删除一个旧的组，再创建新的。`, { title: '已达上限' });
      return null;
    }
    const { db, collection, addDoc } = window.fb;
    const user = window.LoopinAuth.getUser();
    const docRef = await addDoc(collection(db, 'loopinGroups'), {
      name: name || '我的打卡组',
      ownerId: user.uid,
      memberIds: [user.uid],
      pendingEmails: [],
      data: freshData(),
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    localStorage.setItem(LS_LAST_GROUP, docRef.id);
    // Reached the cap with this creation — let the user know once.
    if (groups.length + 1 >= MAX_GROUPS && !limitNoticeShown) {
      limitNoticeShown = true;
      setTimeout(() => {
        window.appAlert(`这是你的第 ${MAX_GROUPS} 个打卡组，已达数量上限。如需创建或加入新的组，请先退出或删除一个旧的组。`, { title: '已达上限' });
      }, 300);
    }
    return docRef.id;
  }

  async function renameGroupById(groupId, name) {
    const { db, doc, updateDoc } = window.fb;
    await updateDoc(doc(db, 'loopinGroups', groupId), { name });
  }

  async function deleteGroupById(groupId) {
    const { db, doc, deleteDoc } = window.fb;
    const g = groups.find(x => x.id === groupId);
    const user = window.LoopinAuth.getUser();
    if (g && g.ownerId !== user.uid) { await window.appAlert('只有组创建者可以删除。'); return; }
    await deleteDoc(doc(db, 'loopinGroups', groupId));
    if (groupId === currentGroupId) localStorage.removeItem(LS_LAST_GROUP);
  }

  async function leaveGroupById(groupId) {
    const { db, doc, updateDoc, arrayRemove } = window.fb;
    const user = window.LoopinAuth.getUser();
    await updateDoc(doc(db, 'loopinGroups', groupId), { memberIds: arrayRemove(user.uid) });
    if (groupId === currentGroupId) localStorage.removeItem(LS_LAST_GROUP);
  }

  async function inviteByEmail(email) {
    if (!currentGroupId) return { ok: false, msg: '未选择组' };
    email = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, msg: '邮箱格式错误' };
    const { db, collection, query, where, getDocs, doc, updateDoc, arrayUnion } = window.fb;
    const qUser = query(collection(db, 'users'), where('email', '==', email));
    const snap = await getDocs(qUser);
    if (!snap.empty) {
      const u = snap.docs[0].data();
      await updateDoc(doc(db, 'loopinGroups', currentGroupId), { memberIds: arrayUnion(u.uid) });
      return { ok: true, msg: `已添加 ${u.name || email}`, immediate: true };
    } else {
      await updateDoc(doc(db, 'loopinGroups', currentGroupId), { pendingEmails: arrayUnion(email) });
      return { ok: true, msg: `${email} 未注册，Ta 用此邮箱 Google 登录后将自动加入。`, immediate: false };
    }
  }

  async function cacheMembers(uids) {
    const { db, doc, getDoc } = window.fb;
    for (const uid of uids) {
      if (memberCache[uid]) continue;
      try {
        const s = await getDoc(doc(db, 'users', uid));
        if (s.exists()) memberCache[uid] = s.data();
      } catch (e) {}
    }
  }
  function getMember(uid) { return memberCache[uid] || null; }

  // ---------- UI ----------
  function renderGroupSwitcher() {
    const btn = document.getElementById('groupSwitchBtn');
    const cur = getCurrentGroup();
    document.getElementById('currentGroupName').textContent = cur ? cur.name : '选择组';
    btn.onclick = openGroupMenu;
  }
  function updateCurrentGroupName(name) {
    document.getElementById('currentGroupName').textContent = name || '—';
  }
  function openGroupMenu() {
    closeGroupSheet();
    const me = window.LoopinAuth.getUser();
    const cur = getCurrentGroup();
    const isOwner = cur && me && cur.ownerId === me.uid;

    const sheet = document.createElement('div');
    sheet.className = 'group-sheet-backdrop';
    sheet.innerHTML = `
      <div class="group-sheet" onclick="event.stopPropagation()">
        <div class="group-sheet-head">
          <h3>我的打卡组</h3>
          <button class="sheet-close" aria-label="关闭">×</button>
        </div>
        <div class="group-sheet-list">
          ${groups.map(g => {
            const mine = g.ownerId === me?.uid;
            const ownerTag = mine ? '<span class="role-tag owner">创建者</span>' : '<span class="role-tag member">成员</span>';
            const count = (g.memberIds || []).length;
            return `<div class="group-sheet-item ${g.id === currentGroupId ? 'active' : ''}" data-id="${g.id}">
              <span class="gs-name">${escapeHtml(g.name)}</span>
              <button class="gs-action rename" data-action="rename" data-id="${g.id}" title="重命名">✎</button>
              <span class="gs-meta">${ownerTag}<span class="gs-count">${count} 人</span></span>
              ${mine
                ? `<button class="gs-action danger" data-action="delete" data-id="${g.id}" title="删除此组">删除</button>`
                : `<button class="gs-action danger" data-action="leave" data-id="${g.id}" title="退出此组">退出</button>`}
            </div>`;
          }).join('')}
        </div>
        <button class="group-sheet-new" data-action="new">+ 新建打卡组</button>
      </div>
    `;
    document.body.appendChild(sheet);
    sheet.addEventListener('click', () => closeGroupSheet());
    sheet.querySelector('.sheet-close').onclick = closeGroupSheet;

    // Whole-row click = switch (but ignore clicks on action buttons inside).
    sheet.querySelectorAll('.group-sheet-item').forEach(row => {
      row.onclick = async (e) => {
        if (e.target.closest('.gs-action')) return;
        e.stopPropagation();
        closeGroupSheet();
        await switchTo(row.dataset.id);
      };
    });
    sheet.querySelectorAll('[data-action]').forEach(b => {
      b.onclick = async (e) => {
        e.stopPropagation();
        const a = b.dataset.action;
        const gid = b.dataset.id;
        if (a === 'new') {
          closeGroupSheet();
          const name = await window.appPrompt('打卡组名称', '新的一组', { title: '新建打卡组' });
          if (name) { const id = await createGroup(name); if (id) await switchTo(id); }
        } else if (a === 'rename') {
          const g = groups.find(x => x.id === gid); if (!g) return;
          const name = await window.appPrompt('新名称', g.name, { title: '重命名打卡组' });
          if (name && name !== g.name) await renameGroupById(gid, name);
        } else if (a === 'leave') {
          const g = groups.find(x => x.id === gid); if (!g) return;
          if (await window.appConfirm(`确认退出「${g.name}」？退出后无法访问该组的数据。`, { danger: true, okText: '退出' })) await leaveGroupById(gid);
        } else if (a === 'delete') {
          const g = groups.find(x => x.id === gid); if (!g) return;
          if (await window.appConfirm(`确认删除「${g.name}」？此操作不可恢复，组内所有数据（成员、习惯库、打卡记录）都会被删除。`, { danger: true, okText: '删除' })) await deleteGroupById(gid);
        }
      };
    });
  }
  function closeGroupSheet() {
    document.querySelectorAll('.group-sheet-backdrop').forEach(n => n.remove());
  }

  function renderGroupPicker() {
    const list = document.getElementById('groupPickerList');
    if (!list) return;
    list.innerHTML = groups.map(g => `<button class="group-pick-item" data-id="${g.id}">${escapeHtml(g.name)}</button>`).join('');
    list.querySelectorAll('.group-pick-item').forEach(b => {
      b.onclick = () => switchTo(b.dataset.id);
    });
    document.getElementById('createGroupBtn').onclick = async () => {
      const name = await window.appPrompt('打卡组名称', '我的打卡组', { title: '新建打卡组' });
      if (name) { const id = await createGroup(name); await switchTo(id); }
    };
    const who = document.getElementById('groupPickerWho');
    const me = window.LoopinAuth.getUser();
    if (who && me) {
      who.innerHTML = `<span class="who-em">${normalizeEmoji(me.emoji || '🙂')}</span><span class="who-text">已登录：<b>${escapeHtml(me.name || '')}</b> · ${escapeHtml(me.email || '')}</span>`;
    }
    const out = document.getElementById('groupPickerSignOut');
    if (out) out.onclick = () => window.LoopinAuth.signOutNow();
  }
  function showGroupPicker() {
    document.getElementById('groupPickerOverlay').classList.remove('hidden');
    document.getElementById('topbar').classList.add('hidden');
    document.getElementById('mainArea').classList.add('hidden');
  }
  function hideGroupPicker() {
    document.getElementById('groupPickerOverlay').classList.add('hidden');
    document.getElementById('topbar').classList.remove('hidden');
    document.getElementById('mainArea').classList.remove('hidden');
    const ma = document.getElementById('mobileActionbar'); if (ma) ma.classList.remove('hidden');
  }

  async function removeMember(uid) {
    if (!currentGroupId) return;
    const { db, doc, updateDoc, arrayRemove } = window.fb;
    await updateDoc(doc(db, 'loopinGroups', currentGroupId), { memberIds: arrayRemove(uid) });
  }
  async function cancelInvite(email) {
    if (!currentGroupId) return;
    const { db, doc, updateDoc, arrayRemove } = window.fb;
    await updateDoc(doc(db, 'loopinGroups', currentGroupId), { pendingEmails: arrayRemove(email) });
  }

  function openInviteDialog() {
    closeGroupSheet();
    const cur = getCurrentGroup();
    if (!cur) return;
    const me = window.LoopinAuth.getUser();
    const isOwner = cur.ownerId === me?.uid;

    const sheet = document.createElement('div');
    sheet.className = 'group-sheet-backdrop';
    sheet.innerHTML = `
      <div class="group-sheet" onclick="event.stopPropagation()">
        <div class="group-sheet-head">
          <h3>邀请成员 · ${escapeHtml(cur.name)}</h3>
          <button class="sheet-close">×</button>
        </div>
        <div class="invite-row">
          <input id="inviteEmail" type="email" placeholder="输入对方邮箱" class="text-input" />
          <button id="inviteSubmit" class="primary">邀请</button>
        </div>
        <div class="hint-sm">若对方未注册，等 Ta 用此邮箱 Google 登录后会自动加入。</div>
        <div class="group-sheet-sep"></div>
        <div class="invite-list" id="inviteList"></div>
      </div>
    `;
    document.body.appendChild(sheet);
    sheet.addEventListener('click', () => closeGroupSheet());
    sheet.querySelector('.sheet-close').onclick = closeGroupSheet;

    const listEl = sheet.querySelector('#inviteList');
    function renderList() {
      const cur2 = getCurrentGroup(); if (!cur2) return;
      const members = (cur2.memberIds || []).map(uid => {
        const u = getMember(uid);
        const isMe = uid === me?.uid;
        const tag = cur2.ownerId === uid ? '<span class="role-tag owner">创建者</span>' : '';
        const canRemove = isOwner && !isMe && cur2.ownerId !== uid;
        return `<div class="invite-row-member">
          <span class="invite-em">${normalizeEmoji(u?.loopinEmoji || u?.emoji || '🙂')}</span>
          <span class="invite-name">${escapeHtml(u?.name || uid)} ${isMe ? '<span class="me-tag">你</span>' : ''} ${tag}</span>
          <span class="invite-email">${escapeHtml(u?.email || '')}</span>
          ${canRemove ? `<button class="invite-remove" data-uid="${uid}" title="移出此组">移出</button>` : ''}
        </div>`;
      }).join('');
      const pending = (cur2.pendingEmails || []).map(em => `
        <div class="invite-row-member pending">
          <span class="invite-em">✉️</span>
          <span class="invite-name">${escapeHtml(em)} <span class="me-tag">待加入</span></span>
          <span class="invite-email"></span>
          ${isOwner ? `<button class="invite-remove" data-email="${escapeHtml(em)}" title="取消邀请">取消</button>` : ''}
        </div>
      `).join('');
      listEl.innerHTML = members + pending;
      listEl.querySelectorAll('.invite-remove').forEach(b => {
        b.onclick = async (ev) => {
          ev.stopPropagation();
          if (b.dataset.uid) { if (await window.appConfirm('移出该成员？', { danger: true, okText: '移出' })) await removeMember(b.dataset.uid); }
          else if (b.dataset.email) { await cancelInvite(b.dataset.email); }
        };
      });
    }
    renderList();
    // Re-render list when group snapshot updates (memberIds change).
    const prevCb = onGroupDataCb;
    onGroupDataCb = (g, data, members) => { prevCb && prevCb(g, data, members); renderList(); };
    sheet._restoreCb = () => { onGroupDataCb = prevCb; };
    sheet.addEventListener('DOMNodeRemoved', () => { if (sheet._restoreCb) sheet._restoreCb(); }, { once: true });

    const inp = sheet.querySelector('#inviteEmail');
    sheet.querySelector('#inviteSubmit').onclick = async () => {
      const r = await inviteByEmail(inp.value);
      if (!r.ok) { await window.appAlert(r.msg); return; }
      window.toast && window.toast(r.msg);
      inp.value = '';
    };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') sheet.querySelector('#inviteSubmit').click(); });
  }

  function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  return {
    start, switchTo, getCurrentGroupId, getCurrentGroup,
    scheduleSave, createGroup, inviteByEmail,
    openInviteDialog, openGroupMenu, getMember
  };
})();
