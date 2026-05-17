// ============== Loopin · habit tracker ==============
// people palette excludes red/green (those are reserved for habit types)
const DOW_CN = ['周一','周二','周三','周四','周五','周六','周日'];

function _freshState(){ return { people:[], library:[], weeks:{}, meta:{lastWeek:null} } }
function _migrateState(s){
  try {
    if(!s || typeof s !== 'object') s = _freshState();
    if(!Array.isArray(s.people)) s.people = [];
    if(!Array.isArray(s.library)) s.library = [];
    if(!s.weeks || typeof s.weeks !== 'object') s.weeks = {};
    if(!s.meta || typeof s.meta !== 'object') s.meta = {lastWeek:null};

    if(s.templates && !s.library.length){
      s.library = Array.isArray(s.templates) ? s.templates : [];
      Object.keys(s.weeks).forEach(k=>{
        const w = s.weeks[k]; if(!w) return;
        w.habits = (s.templates||[]).map(t=>({id:t.id,libId:t.id,name:t.name,type:t.type,target:t.target}));
        Object.values(w.days||{}).forEach(arr=>{ if(Array.isArray(arr)) arr.forEach(b=>{ if(b && b.templateId && !b.habitId){ b.habitId = b.templateId; delete b.templateId } }) });
      });
      delete s.templates;
    }
    Object.values(s.weeks).forEach(w=>{
      if(!w) return;
      if(!Array.isArray(w.habits)) w.habits = [];
      if(!Array.isArray(w.dividers)) w.dividers = [];
      if(!w.days || typeof w.days !== 'object') w.days = {0:[],1:[],2:[],3:[],4:[],5:[],6:[]};
      Object.keys(w.days).forEach(k=>{
        const arr = Array.isArray(w.days[k]) ? w.days[k] : [];
        const expanded=[];
        arr.forEach(b=>{
          if(!b || typeof b !== 'object') return;
          const c = b.count!=null ? Math.max(1, b.count|0) : 1;
          for(let i=0;i<c;i++){
            const nb = {id: i===0 ? (b.id||Math.random().toString(36).slice(2,9)) : Math.random().toString(36).slice(2,9), habitId:b.habitId, participantId:b.participantId||null, note:b.note||''};
            if(typeof b.y === 'number') nb.y = b.y;
            else if(typeof b.slot === 'number') nb.y = b.slot * 40 + 8;
            expanded.push(nb);
          }
        });
        let nextY = 8;
        expanded.forEach(b=>{ if(typeof b.y==='number') nextY = Math.max(nextY, b.y + 40) });
        expanded.forEach(b=>{ if(typeof b.y!=='number'){ b.y = nextY; nextY += 40 } });
        w.days[k] = expanded;
      });
      w.dividers = w.dividers
        .map(d=>{
          const rawY = d && typeof d === 'object' ? d.y : d;
          const id = d && typeof d === 'object' && d.id ? d.id : uid();
          const rawFrac = d && typeof d === 'object' && typeof d.frac === 'number' ? d.frac : null;
          const y = Math.max(0, Number(rawY)||0);
          if(!Number.isFinite(y) && rawFrac == null) return null;
          const out = {id, y};
          if(rawFrac != null) out.frac = rawFrac;
          return out;
        })
        .filter(Boolean)
        .sort((a,b)=>a.y-b.y);
      delete w._asked;
    });
    // Note: `frac` (device-independent relative position 0..1) is filled in lazily on
    // first render using the actual measured canvas height, so existing pixel positions
    // are preserved exactly. See renderCalendar.
  } catch(err) {
    console.warn('Loopin: state migration failed, resetting.', err);
    s = _freshState();
  }
  return s;
}

const state = _freshState();
const weekMondays = {};
let currentWeek = isoWeekKey(new Date());

function uid(){ return Math.random().toString(36).slice(2,9) }
let _applyingRemote = false;
let _applyingRemoteLib = false;
// AUTHORITATIVE seg derivation at render-time. Looks at the block's b.frac vs the
// current dividers' fracs (both are canvas-independent ratios). This is what we trust —
// stored b.seg is IGNORED at render time because it can be corrupted by earlier saves
// where canvasH was wrong (e.g. mobile measuring body before layout settled).
function _segFromFrac(blockFrac, sortedDivFracs){
  if(!sortedDivFracs || sortedDivFracs.length === 0) return 0;
  let seg = 0;
  for(let i = 0; i < sortedDivFracs.length; i++){
    if(blockFrac < sortedDivFracs[i]) break;
    seg = i + 1;
  }
  return seg;
}

// Given a pixel y and sorted divider pixel positions, return { seg, segOffset } where
// seg is the integer index of the containing segment (0 = above first divider) and
// segOffset is the block's ABSOLUTE pixel distance from the segment's inner-top (i.e.
// from divider_y + DIVIDER_CLEAR). This is what gets persisted — same value across any
// device. The visual distance from the divider stays the same regardless of canvas size.
function _yToSegmentSlot(y, canvasH, sortedDivYs){
  if(!sortedDivYs || sortedDivYs.length === 0){
    return { seg: 0, segOffset: Math.max(0, y) };
  }
  let seg = 0;
  for(let i = 0; i < sortedDivYs.length; i++){
    if(y < sortedDivYs[i]) break;
    seg = i + 1;
  }
  const segTop = seg === 0 ? 0 : sortedDivYs[seg - 1];
  const innerTop = segTop + (seg > 0 ? DIVIDER_CLEAR : 0);
  return { seg, segOffset: Math.max(0, y - innerTop) };
}

// Given an explicit { seg, segOffset } and the current dividers (in pixels), compute the
// pixel y. The offset is taken as-is in pixels; if the segment is smaller than the offset
// (e.g. on a phone where canvas is short), the offset is clamped so the block stays
// inside its assigned segment rather than spilling across the next divider.
function _segSlotToY(seg, segOffset, canvasH, sortedDivYs, blockH){
  const safeSeg = Math.max(0, Math.min(seg || 0, sortedDivYs.length));
  const segTop = safeSeg === 0 ? 0 : sortedDivYs[safeSeg - 1];
  const segBottom = safeSeg < sortedDivYs.length ? sortedDivYs[safeSeg] : canvasH;
  const innerTop = segTop + (safeSeg > 0 ? DIVIDER_CLEAR : 0);
  const innerBottom = segBottom - (safeSeg < sortedDivYs.length ? DIVIDER_CLEAR : 0);
  const innerSpan = Math.max(0, innerBottom - innerTop);
  const safeBlockH = blockH || 0;
  const maxOffset = Math.max(0, innerSpan - safeBlockH);
  const clampedOffset = Math.max(0, Math.min(maxOffset, segOffset || 0));
  return innerTop + clampedOffset;
}

// Convert a pixel y to a globally-stored frac using THE SAME segmented math as render,
// so save → load round-trips exactly. Without this, render adds a 6px clear-zone offset
// that save (linear) doesn't account for — every drag cycle then drifts blocks 6px away
// from the divider. This function is the inverse of the segmented render path.
function _yToSegmentedGlobalFrac(y, canvasH, sortedDivYs, sortedDivFracs){
  if(canvasH <= 0) return 0;
  if(!sortedDivYs || sortedDivYs.length === 0){
    return Math.max(0, Math.min(0.99, y / canvasH));
  }
  let seg = 0;
  for(let i = 0; i < sortedDivYs.length; i++){
    if(y < sortedDivYs[i]) break;
    seg = i + 1;
  }
  const segTop = seg === 0 ? 0 : sortedDivYs[seg - 1];
  const segBottom = seg < sortedDivYs.length ? sortedDivYs[seg] : canvasH;
  const innerTop = segTop + (seg > 0 ? DIVIDER_CLEAR : 0);
  const innerBottom = segBottom - (seg < sortedDivYs.length ? DIVIDER_CLEAR : 0);
  const innerSpan = Math.max(0.0001, innerBottom - innerTop);
  const relFrac = Math.max(0, Math.min(1, (y - innerTop) / innerSpan));
  const segStartFrac = seg === 0 ? 0 : sortedDivFracs[seg - 1];
  const segEndFrac = seg < sortedDivFracs.length ? sortedDivFracs[seg] : 1;
  let result = segStartFrac + relFrac * (segEndFrac - segStartFrac);
  // Nudge strictly inside the segment's frac range so it can't be mis-classified back
  // into a neighbouring segment by the next render pass.
  const eps = 0.0001;
  if(seg > 0) result = Math.max(segStartFrac + eps, result);
  if(seg < sortedDivFracs.length) result = Math.min(segEndFrac - eps, result);
  return Math.max(0, Math.min(0.99, result));
}

function _syncFracsForSave(){
  const sampleBody = document.querySelector('.calendar .day .body');
  const canvasH = (sampleBody && sampleBody.clientHeight > 50) ? sampleBody.clientHeight
                  : (parseFloat(localStorage.getItem('loopin_canvas_h')) || 800);
  if(canvasH <= 0) return;
  const wk = state.weeks[currentWeek];
  if(!wk) return;
  (wk.dividers || []).forEach(d => {
    if(typeof d.y !== 'number') return;
    d.frac = Math.max(0, Math.min(0.99, d.y / canvasH));
  });
  const sortedDividers = getSortedDividers(wk);
  const sortedDivYs = sortedDividers.map(d => clampDividerY(d.y));
  const sortedDivFracs = sortedDividers.map(d => d.frac);
  Object.values(wk.days || {}).forEach(arr => {
    (arr || []).forEach(b => {
      if(typeof b.y !== 'number') return;
      b.frac = _yToSegmentedGlobalFrac(b.y, canvasH, sortedDivYs, sortedDivFracs);
    });
  });
}
function save(){
  if(_applyingRemote) return;
  _syncFracsForSave();
  if(window.LoopinGroups && window.LoopinGroups.getCurrentGroupId()){
    window.LoopinGroups.scheduleSave(state);
  }
  if(!_applyingRemoteLib && window.LoopinLibrary){
    window.LoopinLibrary.scheduleSave(state.library);
  }
}
function startOfWeek(d){ const x=new Date(d); x.setHours(0,0,0,0); const day=(x.getDay()+6)%7; x.setDate(x.getDate()-day); return x }
function isoWeekKey(d){
  const m=startOfWeek(d);
  const jan1=new Date(m.getFullYear(),0,1);
  const week=Math.floor(((m-jan1)/86400000 + jan1.getDay()+6)/7)+1;
  const k=`${m.getFullYear()}-W${String(week).padStart(2,'0')}`;
  weekMondays[k]=m; return k;
}
function fmtRange(monday){ const sun=new Date(monday); sun.setDate(sun.getDate()+6); const f=d=>`${d.getMonth()+1}月${d.getDate()}日`; return `${f(monday)} – ${f(sun)}` }
function getMonday(key){ return weekMondays[key] }
function escapeHtml(s){ return String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) }

// toast & modal
const toastEl=document.getElementById('toast'); let toastTimer=null;
function toast(msg){ toastEl.textContent=msg; toastEl.classList.remove('hidden'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>toastEl.classList.add('hidden'),2000) }

const mb=document.getElementById('modalBackdrop');
const mTitle=document.getElementById('modalTitle');
const mBody=document.getElementById('modalBody');
const mOk=document.getElementById('modalOk');
const mCancel=document.getElementById('modalCancel');
function openModal(title, html, onOk, opts={}){
  mTitle.textContent=title; mBody.innerHTML=html; mb.classList.remove('hidden');
  mOk.style.display = opts.hideOk ? 'none' : '';
  const cleanup=()=>{ mb.classList.add('hidden'); mOk.onclick=null; mCancel.onclick=null; mOk.style.display=''; };
  mOk.onclick=()=>{ if(onOk && onOk()!==false) cleanup() };
  mCancel.onclick=cleanup;
}

// ===== In-app dialog helpers (replace native alert/confirm/prompt) =====
function _showDialog({ title='提示', msg='', input=false, defaultVal='', placeholder='', okText='确定', cancelText='取消', danger=false, showCancel=true }){
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'app-dialog-backdrop';
    back.innerHTML = `
      <div class="app-dialog" role="dialog">
        ${title ? `<h3 class="ad-title">${escapeHtml(title)}</h3>` : ''}
        ${msg ? `<div class="ad-msg">${escapeHtml(msg)}</div>` : ''}
        ${input ? `<input class="ad-input text-input" placeholder="${escapeHtml(placeholder)}" />` : ''}
        <div class="ad-actions">
          ${showCancel ? `<button class="ghost ad-cancel">${escapeHtml(cancelText)}</button>` : ''}
          <button class="primary ad-ok ${danger ? 'danger' : ''}">${escapeHtml(okText)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(back);
    const inp = back.querySelector('.ad-input');
    if (inp) { inp.value = defaultVal; setTimeout(()=>{ inp.focus(); inp.select(); }, 30); }

    const close = (val) => { back.remove(); document.removeEventListener('keydown', keyHandler); resolve(val); };
    const ok = () => close(input ? (inp.value.trim()) : true);
    const cancel = () => close(input ? null : false);
    back.querySelector('.ad-ok').onclick = ok;
    const cancelBtn = back.querySelector('.ad-cancel');
    if (cancelBtn) cancelBtn.onclick = cancel;
    back.addEventListener('click', (e) => { if (e.target === back) cancel(); });
    function keyHandler(e){
      if (e.key === 'Enter' && (!inp || document.activeElement === inp)) { e.preventDefault(); ok(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    }
    document.addEventListener('keydown', keyHandler);
  });
}
window.appAlert = (msg, opts={}) => _showDialog({ title: opts.title || '提示', msg, okText: opts.okText || '知道了', showCancel: false });
window.appConfirm = (msg, opts={}) => _showDialog({ title: opts.title || '请确认', msg, okText: opts.okText || '确定', cancelText: opts.cancelText || '取消', danger: !!opts.danger });
window.appPrompt = (label, defaultVal='', opts={}) => _showDialog({ title: opts.title || '请输入', msg: label, input: true, defaultVal, placeholder: opts.placeholder || '', okText: opts.okText || '确定' });

async function promptInstallToHome(){
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  const isAndroid = /Android/.test(ua);
  const dp = window.__deferredInstallPrompt;
  if (dp) {
    try {
      dp.prompt();
      const res = await dp.userChoice;
      if (res && res.outcome === 'accepted') {
        window.__deferredInstallPrompt = null;
      }
      return;
    } catch (e) { /* fall through to manual instructions */ }
  }
  let msg = '';
  if (isIOS) {
    msg = '在 Safari 中：\n1. 点击底部工具栏的「分享」按钮（方框 + 向上箭头）\n2. 在菜单中选择「添加到主屏幕」\n3. 点右上角「添加」\n\n注意：iOS 仅 Safari 浏览器支持，微信/Chrome 内置浏览器不行。';
  } else if (isAndroid) {
    msg = '在 Chrome / Edge 中：\n1. 点击右上角的 ⋮ 菜单\n2. 选择「添加到主屏幕」或「安装应用」\n3. 确认安装\n\n如果在微信中打开，请点右上角「⋯」→「在浏览器中打开」后再操作。';
  } else {
    msg = '请在浏览器菜单里选择「添加到主屏幕」或「安装应用」。';
  }
  window.appAlert(msg, { title: '添加到桌面' });
}
function makeDragPreview(habit, person, note){
  const el = document.createElement('div');
  el.className = 'block drag-preview t-' + habit.type;
  const avHtml = person
    ? `<span class="av av-emoji">${normalizeEmoji(person.emoji)}</span>`
    : `<span class="av empty">?</span>`;
  const noteHtml = note ? `<div class="note">${escapeHtml(note)}</div>` : '';
  el.innerHTML = `<div class="row1">${avHtml}<div class="title">${escapeHtml(habit.name)}</div></div>${noteHtml}`;
  const dayBody = document.querySelector('.day .body');
  const w = dayBody ? Math.max(80, dayBody.clientWidth - 16) : 160;
  el.style.width = w + 'px';
  document.body.appendChild(el);
  return el;
}
function attachDragImage(e, habit, person, note){
  const p = makeDragPreview(habit, person, note);
  try{ e.dataTransfer.setDragImage(p, 20, dragGrabY) }catch{}
  setTimeout(()=>p.remove(), 0);
}

function attachMultiDragImage(e, payload){
  const anchorEl = document.querySelector(`[data-bid="${payload.anchorId}"]`);
  if(!anchorEl) return;
  const anchorRect = anchorEl.getBoundingClientRect();
  const container = document.createElement('div');
  container.className = 'drag-preview';
  container.style.position = 'absolute';
  container.style.left = '-3000px';
  container.style.top = '-3000px';

  let minDx = 0, minDy = 0, maxDx = 0, maxDy = 0;
  const positions = [];
  for(const it of payload.items){
    const el = document.querySelector(`[data-bid="${it.id}"]`);
    if(!el) continue;
    const r = el.getBoundingClientRect();
    const dx = r.left - anchorRect.left;
    const dy = r.top - anchorRect.top;
    minDx = Math.min(minDx, dx);
    minDy = Math.min(minDy, dy);
    maxDx = Math.max(maxDx, dx + r.width);
    maxDy = Math.max(maxDy, dy + r.height);
    positions.push({el, dx, dy, w: r.width, h: r.height});
  }
  const totalW = maxDx - minDx;
  const totalH = maxDy - minDy;
  container.style.width = totalW + 'px';
  container.style.height = totalH + 'px';
  container.style.boxShadow = 'none';
  for(const p of positions){
    const clone = p.el.cloneNode(true);
    clone.classList.remove('selected');
    clone.classList.remove('dragging');
    clone.style.position = 'absolute';
    clone.style.left = (p.dx - minDx) + 'px';
    clone.style.top = (p.dy - minDy) + 'px';
    clone.style.right = 'auto';
    clone.style.width = p.w + 'px';
    container.appendChild(clone);
  }
  document.body.appendChild(container);

  const cursorXInAnchor = e.clientX - anchorRect.left;
  const cursorYInAnchor = e.clientY - anchorRect.top;
  const offsetX = -minDx + cursorXInAnchor;
  const offsetY = -minDy + cursorYInAnchor;
  try{ e.dataTransfer.setDragImage(container, offsetX, offsetY) }catch{}
  setTimeout(()=>container.remove(), 0);
}

// free-Y positioning
const BODY_PAD = 8;
const BLOCK_GAP = 6;
const DIVIDER_CLEAR = BLOCK_GAP;
const DIVIDER_SNAP_THRESHOLD = 10;
const DIVIDER_MIN_SPAN = DIVIDER_CLEAR * 2 + 1;
let dragGrabY = 16; // pixels from top of source block where user grabbed
let ph = null;
let mobileBlockDrag = null;
let suppressBlockClickUntil = 0;
function ensurePh(){ if(!ph){ ph = document.createElement('div'); ph.className='ph' } return ph }
function computeY(body, clientY){
  const r = body.getBoundingClientRect();
  return Math.max(0, clientY - r.top + body.scrollTop - dragGrabY);
}
function computeCursorY(body, clientY){
  const r = body.getBoundingClientRect();
  return Math.max(0, clientY - r.top + body.scrollTop);
}
function positionPh(body, y){
  ensurePh();
  ph.style.top = y + 'px';
  if(ph.parentElement !== body) body.appendChild(ph);
}
function removePh(){ if(ph && ph.parentElement) ph.parentElement.removeChild(ph) }
function isMobileWeekLayout(){
  return !!(window.LoopinMobile && window.LoopinMobile.isMobile());
}
function setBodyExtent(body, maxBottom){
  if(!body) return;
  if(isMobileWeekLayout()){
    body.style.minHeight = '';
    return;
  }
  body.style.minHeight = (maxBottom + BODY_PAD) + 'px';
}
function findCalendarBodyAtPoint(clientX, clientY){
  const hitList = (document.elementsFromPoint && document.elementsFromPoint(clientX, clientY)) || [];
  for(const node of hitList){
    const body = node?.closest?.('.calendar .day .body');
    if(body) return body;
  }
  const fallback = document.querySelectorAll('.calendar .day .body');
  let best = null;
  let bestDx = Infinity;
  fallback.forEach(body => {
    const rect = body.getBoundingClientRect();
    const dx = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
    if(dx < bestDx){
      bestDx = dx;
      best = body;
    }
  });
  return best;
}
function finishMobileBlockDrag(cancelled){
  const session = mobileBlockDrag;
  if(!session) return;
  clearTimeout(session.timer);
  if(session.started){
    const el = session.el;
    const dstBody = session.lastBody || document.querySelector(`.calendar .day .body[data-day="${session.dayIdx}"]`);
    const dstDay = session.lastDayIdx != null ? session.lastDayIdx : session.dayIdx;
    if(!cancelled && dstBody){
      const computed = dragSession.lastComputed || {};
      const finalY = (dragSession.lastDraggedY != null)
        ? dragSession.lastDraggedY
        : Math.max(BODY_PAD, session.origY);
      placeAndCommitMap({kind:'move', blockId:session.blockId, srcDay:session.dayIdx}, dstDay, finalY, computed);
      suppressBlockClickUntil = Date.now() + 500;
      hideGuideLine();
      hideStickIndicator();
      hideDividerSnapLine();
      removePh();
      clearDragPreviewState();
      document.getElementById('calendar')?.classList.remove('dragging');
    } else {
      document.getElementById('calendar')?.classList.remove('dragging');
      hideGuideLine();
      hideStickIndicator();
      hideDividerSnapLine();
      if(el) el.classList.remove('dragging');
      removePh();
      const srcBody = document.querySelector(`.calendar .day .body[data-day="${session.dayIdx}"]`);
      if(srcBody) resolveOverlapsForBody(srcBody, session.dayIdx);
      resetDragSession();
      clearDragPreviewState();
    }
  }
  mobileBlockDrag = null;
}
function bindMobileBlockDrag(el, block, dayIdx){
  if(!isMobileWeekLayout()) return;
  const LONG_PRESS_MS = 240;
  const MOVE_CANCEL_PX = 8;
  let startX = 0;
  let startY = 0;

  const startDrag = () => {
    if(!mobileBlockDrag) return;
    const touch = mobileBlockDrag.lastTouch;
    if(!touch) return;
    clearSelection();
    const rect = el.getBoundingClientRect();
    dragGrabY = Math.max(0, touch.clientY - rect.top);
    currentDragPayload = {kind:'move', blockId:block.id, srcDay:dayIdx};
    currentDragHeight = el.offsetHeight;
    committedDropThisDrag = false;
    resetDragSession();
    mobileBlockDrag.started = true;
    mobileBlockDrag.origY = block.y || BODY_PAD;
    el.classList.add('dragging');
    document.getElementById('calendar')?.classList.add('dragging');
    const body = findCalendarBodyAtPoint(touch.clientX, touch.clientY) || el.closest('.body');
    if(body){
      mobileBlockDrag.lastBody = body;
      mobileBlockDrag.lastDayIdx = Number(body.dataset.day);
      previewLayout(body, mobileBlockDrag.lastDayIdx, touch.clientY);
    }
  };

  el.addEventListener('touchstart', (e) => {
    if(!isMobileWeekLayout()) return;
    if(e.touches.length !== 1) return;
    if(e.target.closest('.av') || e.target.closest('.edit') || e.target.closest('.x')) return;
    const touch = e.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    mobileBlockDrag = {
      blockId: block.id,
      dayIdx,
      el,
      started: false,
      lastTouch: {clientX: touch.clientX, clientY: touch.clientY},
      timer: setTimeout(startDrag, LONG_PRESS_MS),
      origY: block.y || BODY_PAD,
      lastBody: null,
      lastDayIdx: null
    };
  }, { passive: true });

  el.addEventListener('touchmove', (e) => {
    if(!mobileBlockDrag || mobileBlockDrag.blockId !== block.id) return;
    if(e.touches.length !== 1){
      finishMobileBlockDrag(true);
      return;
    }
    const touch = e.touches[0];
    mobileBlockDrag.lastTouch = {clientX: touch.clientX, clientY: touch.clientY};
    if(!mobileBlockDrag.started){
      if(Math.abs(touch.clientX - startX) > MOVE_CANCEL_PX || Math.abs(touch.clientY - startY) > MOVE_CANCEL_PX){
        clearTimeout(mobileBlockDrag.timer);
        mobileBlockDrag = null;
      }
      return;
    }
    e.preventDefault();
    const body = findCalendarBodyAtPoint(touch.clientX, touch.clientY);
    if(!body) return;
    mobileBlockDrag.lastBody = body;
    mobileBlockDrag.lastDayIdx = Number(body.dataset.day);
    previewLayout(body, mobileBlockDrag.lastDayIdx, touch.clientY);
  }, { passive: false });

  el.addEventListener('touchend', (e) => {
    if(!mobileBlockDrag || mobileBlockDrag.blockId !== block.id) return;
    if(mobileBlockDrag.started) e.preventDefault();
    finishMobileBlockDrag(false);
  }, { passive: false });

  el.addEventListener('touchcancel', () => {
    if(!mobileBlockDrag || mobileBlockDrag.blockId !== block.id) return;
    finishMobileBlockDrag(true);
  });
}

function getSortedDividers(wk, excludeId){
  return (wk?.dividers || [])
    .filter(d=>d && (!excludeId || d.id !== excludeId))
    .slice()
    .sort((a,b)=>a.y-b.y);
}
function getSegmentIndexForY(dividerYs, y){
  let idx = 0;
  while(idx < dividerYs.length && y >= dividerYs[idx]) idx++;
  return idx;
}
function getSegmentBounds(dividerYs, idx){
  const maxY = getDividerMaxY();
  const prev = idx > 0 ? dividerYs[idx-1] : null;
  const next = idx < dividerYs.length ? dividerYs[idx] : null;
  return {
    top: prev == null ? BODY_PAD : prev + DIVIDER_CLEAR,
    bottom: (next == null ? maxY : next) - DIVIDER_CLEAR,
    prev,
    next
  };
}
function packBlocksDown(blocks, topBound, bottomBound){
  if(blocks.length === 0) return {};
  if(bottomBound < topBound) return null;
  const pos = {};
  let cursor = topBound;
  for(const b of blocks){
    const y = Math.max(b.y, cursor);
    pos[b.id] = y;
    cursor = y + b.h + BLOCK_GAP;
  }
  const last = blocks[blocks.length - 1];
  if(pos[last.id] + last.h > bottomBound) return null;
  return pos;
}
function packBlocksUp(blocks, topBound, bottomBound){
  if(blocks.length === 0) return {};
  if(bottomBound < topBound) return null;
  const pos = {};
  let cursor = bottomBound;
  for(let i=blocks.length-1;i>=0;i--){
    const b = blocks[i];
    const y = Math.min(b.y, cursor - b.h);
    pos[b.id] = y;
    cursor = y - BLOCK_GAP;
  }
  if(pos[blocks[0].id] < topBound) return null;
  return pos;
}
function buildSegmentLayout(blocks, dividerYs){
  const buckets = Array.from({length: dividerYs.length + 1}, ()=>[]);
  blocks
    .slice()
    .sort((a,b)=>a.y-b.y)
    .forEach(b=>{
      const center = b.y + b.h / 2;
      buckets[getSegmentIndexForY(dividerYs, center)].push(b);
    });
  const pos = {};
  for(let i=0;i<buckets.length;i++){
    const seg = buckets[i];
    if(seg.length === 0) continue;
    const bounds = getSegmentBounds(dividerYs, i);
    const packed = packBlocksDown(seg, bounds.top, bounds.bottom) || packBlocksUp(seg, bounds.top, bounds.bottom);
    if(!packed) return null;
    Object.assign(pos, packed);
  }
  return pos;
}

function resolveOverlapsForBody(body, dayIdx){
  const wk = state.weeks[currentWeek]; if(!wk) return false;
  const arr = wk.days[dayIdx] || [];
  const blocks = arr.map(b=>{
    const el = body.querySelector(`[data-bid="${b.id}"]`);
    return {id:b.id, y:b.y||0, h:el?el.offsetHeight:36};
  });
  const dividerYs = getSortedDividers(wk).map(d=>clampDividerY(d.y));
  const pos = buildSegmentLayout(blocks, dividerYs);
  if(!pos) return false;
  let changed = false;
  let maxBottom = BODY_PAD;
  for(const b of arr){
    const el = body.querySelector(`[data-bid="${b.id}"]`);
    if(!el) continue;
    const h = el.offsetHeight;
    const newY = pos[b.id];
    if(newY !== b.y){ b.y = newY; changed = true }
    el.style.top = newY + 'px';
    maxBottom = Math.max(maxBottom, newY + h);
  }
  setBodyExtent(body, maxBottom);
  return changed;
}

// Map a saved global frac to a y value using SEGMENTED math — each region between
// dividers is its own independent coordinate space. Blocks below the divider are
// positioned relative to the divider; their visual gap from the divider scales with
// segment height, not body height. This is what makes positions on mobile and desktop
// agree on "block sits 5% into the lower segment" instead of disagreeing on absolute px.
function segmentedFracToY(blockFrac, canvasH, sortedDivFracs){
  if(!sortedDivFracs || sortedDivFracs.length === 0){
    return blockFrac * canvasH;
  }
  let segStart = 0, segEnd = 1;
  for(let i = 0; i < sortedDivFracs.length; i++){
    if(blockFrac < sortedDivFracs[i]){
      segEnd = sortedDivFracs[i];
      break;
    }
    segStart = sortedDivFracs[i];
    segEnd = (i + 1 < sortedDivFracs.length) ? sortedDivFracs[i+1] : 1;
  }
  const segLen = Math.max(0.0001, segEnd - segStart);
  const relFrac = Math.max(0, Math.min(1, (blockFrac - segStart) / segLen));
  // Clear zone (DIVIDER_CLEAR px) on each side of the divider — blocks never land flush
  // against the divider line. This is what makes the math NOT collapse to linear: the
  // 6px buffer enforces "blocks belong to a segment, not to the body as a whole".
  const segStartY = segStart * canvasH + (segStart > 0 ? DIVIDER_CLEAR : 0);
  const segEndY = segEnd * canvasH - (segEnd < 1 ? DIVIDER_CLEAR : 0);
  return Math.max(BODY_PAD, segStartY + relFrac * Math.max(0, segEndY - segStartY));
}

function hydrateWeekLayoutFromFractions(canvasH){
  const wk = state.weeks[currentWeek]; if(!wk) return;
  if(canvasH <= 0) return;
  (wk.dividers || []).forEach(d => {
    if(typeof d.frac !== 'number') return;
    d.y = d.frac * canvasH;
  });
  const sortedDivFracs = getSortedDividers(wk)
    .map(d => (typeof d.frac === 'number' ? d.frac : null))
    .filter(f => f != null);
  Object.values(wk.days || {}).forEach(arr => {
    (arr || []).forEach(b => {
      if(typeof b.frac !== 'number') return;
      b.y = segmentedFracToY(b.frac, canvasH, sortedDivFracs);
    });
  });
  return sortedDivFracs;
}

// Re-place divider lines using the same fresh canvasH that blocks see — divider position
// is the raw frac×canvasH (they're the boundaries themselves, not subject to segment mapping).
function repositionDividersRaw(canvasH){
  const wk = state.weeks[currentWeek]; if(!wk) return;
  const cal = document.getElementById('calendar'); if(!cal) return;
  const bodyOffset = getCalendarBodyOffset();
  (wk.dividers || []).forEach(divider => {
    if(typeof divider.frac !== 'number') return;
    const line = cal.querySelector(`.divider-line[data-id="${divider.id}"]`);
    if(!line) return;
    const y = divider.frac * canvasH;
    line.style.top = (bodyOffset + y) + 'px';
  });
}

let _calResizeObserver = null;
function _ensureCalResizeObserver(){
  if(_calResizeObserver) return _calResizeObserver;
  if(typeof ResizeObserver === 'undefined') return null;
  let _lastH = 0;
  _calResizeObserver = new ResizeObserver(entries => {
    if(!window.LoopinMobile || !window.LoopinMobile.isMobile()) return;
    if(currentDragPayload || dividerDrag) return;
    if(document.getElementById('calendar')?.classList.contains('dragging')) return;
    // Debounce on changed height only — ignore sub-pixel jitter and width-only changes.
    const h = entries[0]?.contentRect?.height || 0;
    if(Math.abs(h - _lastH) < 1) return;
    _lastH = h;
    // Run on next frame so the new layout is fully painted before we recompute.
    requestAnimationFrame(() => {
      if(currentView !== 'week') return;
      resolveAllOverlaps();
    });
  });
  return _calResizeObserver;
}
function _watchBodyResize(){
  const obs = _ensureCalResizeObserver(); if(!obs) return;
  const sampleBody = document.querySelector('.calendar .day .body');
  if(!sampleBody) return;
  obs.disconnect();
  obs.observe(sampleBody);
}

function resolveAllOverlaps(){
  const isMobile = window.LoopinMobile && window.LoopinMobile.isMobile();
  const bodies = document.querySelectorAll('.calendar .day .body');
  if(isMobile){
    // Mobile: re-project every block inside its divider segment, then enforce the minimum
    // gap inside each segment. This keeps the divider acting as a true boundary instead of
    // a decorative line when the phone's calendar body is shorter than desktop.
    const sampleBody = bodies[0];
    const canvasH = sampleBody ? sampleBody.getBoundingClientRect().height : 0;
    if(canvasH > 50){
      hydrateWeekLayoutFromFractions(canvasH);
      repositionDividersRaw(canvasH);
      bodies.forEach((body, i) => resolveOverlapsForBody(body, i));
    }
    _watchBodyResize();
    return;
  }
  let changed = false;
  bodies.forEach((body, i) => { if(resolveOverlapsForBody(body, i)) changed = true });
  if(changed) save();
}

let currentDragPayload = null;
let currentDragHeight = null;
let lastDragY = null;
let dragDir = 'down';
let dividerDrag = null;
// Safety net: clear stuck divider-drag state on every condition where mouseup might be
// missed (window blur, mouse leaves the browser window, tab visibility change, ESC key).
function _clearDividerDragSafety(){
  // Always clear any leftover .dragging state on the calendar so .divider-line stays
  // pointer-events:auto. (When .calendar.dragging is on, divider-lines are explicitly
  // non-interactive — a lingering class is the most likely cause of "can't drag divider
  // until refresh".)
  try{ document.getElementById('calendar')?.classList.remove('dragging'); }catch{}
  try{ document.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging')); }catch{}
  if(!dividerDrag) return;
  try{ if(typeof hideDividerSnapLine === 'function') hideDividerSnapLine(); }catch{}
  dividerDrag = null;
}
window.addEventListener('blur', _clearDividerDragSafety);
window.addEventListener('mouseleave', _clearDividerDragSafety);
document.addEventListener('visibilitychange', () => {
  if(document.hidden) _clearDividerDragSafety();
});
window.addEventListener('keydown', (e) => {
  if(e.key === 'Escape') _clearDividerDragSafety();
});
let suppressSourceReveal = false;
let suppressPlacementAnimation = false;
let _initialRenderDone = false;
let committedDropThisDrag = false;

const dragSession = {
  column: null,
  dirMap: {},   // blockId -> 'up'|'down'
  ratchet: {},  // blockId -> last pushed Y
  lastDraggedY: null,
  lastComputed: null
};
function resetDragSession(){
  dragSession.column = null;
  dragSession.dirMap = {};
  dragSession.ratchet = {};
  dragSession.lastDraggedY = null;
  dragSession.lastComputed = null;
  dragSession.multiCol = null;
  dragSession.lastMultiDelta = null;
  dragSession.lastAnchorY = null;
  dragSession.lastAnchorDay = null;
}

// undo stack (only for block moves)
const undoStack = [];
const UNDO_LIMIT = 30;
function pushUndo(){
  undoStack.push(JSON.stringify({people:state.people, library:state.library, weeks:state.weeks, meta:state.meta}));
  if(undoStack.length > UNDO_LIMIT) undoStack.shift();
}
function undo(){
  if(undoStack.length === 0){ toast('没有可以撤回的操作'); return }
  const prev = JSON.parse(undoStack.pop());
  state.people = prev.people;
  state.library = prev.library;
  state.weeks = prev.weeks;
  state.meta = prev.meta;
  clearSelection();
  save(); renderAll();
  toast('已撤回');
}
document.addEventListener('keydown', e=>{
  const z = (e.key === 'z' || e.key === 'Z');
  if(z && (e.metaKey || e.ctrlKey) && !e.shiftKey){
    // Skip if focus is in an input/textarea
    const t = e.target;
    if(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault();
    undo();
  }
});

// box-selection
const selectedIds = new Set();
function clearSelection(){
  selectedIds.clear();
  document.querySelectorAll('.block.selected').forEach(el=>el.classList.remove('selected'));
}
function applySelectionStyles(){
  document.querySelectorAll('.calendar .block').forEach(el=>{
    if(selectedIds.has(el.dataset.bid)) el.classList.add('selected');
    else el.classList.remove('selected');
  });
}
function clearDragPreviewState(){
  currentDragPayload = null;
  currentDragHeight = null;
  lastDragY = null;
  dragDir = 'down';
}

document.addEventListener('dragend', ()=>{
  if(!suppressSourceReveal){
    document.querySelectorAll('.dragging').forEach(el=>el.classList.remove('dragging'));
  }
  document.getElementById('calendar')?.classList.remove('dragging');
  removePh();
  hideGuideLine();
  hideStickIndicator();
  hideDividerSnapLine();
  // Only restore preview layout if this drag did NOT successfully commit.
  if(!committedDropThisDrag && dragSession.column != null){
    const body = document.querySelectorAll('.calendar .day .body')[dragSession.column];
    if(body) resolveOverlapsForBody(body, dragSession.column);
  }
  resetDragSession();
  clearDragPreviewState();
  if(!committedDropThisDrag) requestAnimationFrame(resolveAllOverlaps);
  committedDropThisDrag = false;
});

function weakSnap(dstDay, targetY, draggedBlockId, draggedH){
  const wk = state.weeks[currentWeek];
  if(!wk) return {y:targetY, snapLine:null};
  const SNAP_X = 6;
  const dH = draggedH || 36;
  const targetTop = targetY;
  const targetBot = targetY + dH;
  const excludeSet = new Set(Array.isArray(draggedBlockId) ? draggedBlockId : (draggedBlockId ? [draggedBlockId] : []));
  // candidates: top and bottom edges of every block in OTHER columns
  const candidates = [];
  for(let d=0; d<7; d++){
    if(d===dstDay) continue;
    const bodyEl = document.querySelectorAll('.calendar .day .body')[d];
    (wk.days[d]||[]).forEach(b=>{
      if(excludeSet.has(b.id)) return;
      const el = bodyEl?.querySelector(`[data-bid="${b.id}"]`);
      const h = el ? el.offsetHeight : 36;
      const y = b.y || BODY_PAD;
      candidates.push({y, edge:'top'});
      candidates.push({y: y + h, edge:'bot'});
    });
  }
  let best=null, bestDist=SNAP_X+1;
  for(const c of candidates){
    const ref = c.edge==='top' ? targetTop : targetBot;
    const dist = Math.abs(ref - c.y);
    if(dist < bestDist){ bestDist = dist; best = c }
  }
  if(best){
    if(best.edge === 'top') return {y: best.y, snapLine: best.y};
    return {y: best.y - dH, snapLine: best.y};
  }
  return {y:targetY, snapLine:null};
}

function computeLayoutForSession(blocks, draggedY, draggedH){
  // Direction-locked layout. Blocks track current need from dragged's position
  // (no ratchet — they retreat back toward origY when dragged moves away).
  const GAP = BLOCK_GAP;
  let pos = {};
  for(let pass=0; pass<6; pass++){
    pos = {};
    const upBlocks = blocks.filter(b => dragSession.dirMap[b.id] === 'up').sort((a,b)=>b.origY-a.origY);
    const downBlocks = blocks.filter(b => dragSession.dirMap[b.id] === 'down').sort((a,b)=>a.origY-b.origY);
    const stayBlocks = blocks.filter(b => !dragSession.dirMap[b.id]);

    // Up stack (each closer-to-dragged item gets placed first)
    let ceil = draggedY;
    let stuck = false;
    for(const b of upBlocks){
      let target = ceil - b.h - GAP;
      target = Math.min(target, b.origY); // never push above origY (allow retreat)
      if(target < BODY_PAD){ stuck = true; break }
      pos[b.id] = target;
      ceil = target;
    }
    if(stuck){
      // Pack the up-stack tight from top, dragged is forced down past it
      const upTopDown = upBlocks.slice().sort((a,b)=>a.origY - b.origY);
      let y = BODY_PAD;
      for(const b of upTopDown){
        pos[b.id] = y;
        y += b.h + GAP;
      }
      draggedY = Math.max(draggedY, y);
    }

    // Down stack
    let floor = draggedY + draggedH;
    for(const b of downBlocks){
      let target = floor + GAP;
      target = Math.max(target, b.origY); // never pull above origY (allow retreat back to origY)
      pos[b.id] = target;
      floor = target + b.h;
    }

    // Stay blocks at origY
    for(const b of stayBlocks){ pos[b.id] = b.origY }

    // Cascade: stay blocks overlapped by pushed blocks become engaged in same direction
    let cascaded = false;
    for(const sb of stayBlocks){
      if(dragSession.dirMap[sb.id]) continue;
      for(const other of blocks){
        if(other.id === sb.id) continue;
        if(!dragSession.dirMap[other.id]) continue;
        const oy = pos[other.id];
        if(oy < sb.origY + sb.h && oy + other.h > sb.origY){
          dragSession.dirMap[sb.id] = dragSession.dirMap[other.id];
          cascaded = true;
          break;
        }
      }
    }
    if(!cascaded) break;
  }
  return {pos, draggedY};
}

function showGuideLine(body, yInBody){
  const cal = document.getElementById('calendar');
  let g = document.getElementById('guideLine');
  if(!g){ g = document.createElement('div'); g.id='guideLine'; g.className='guide-line'; cal.appendChild(g) }
  const cRect = cal.getBoundingClientRect();
  const bRect = body.getBoundingClientRect();
  const yInCal = bRect.top - cRect.top + yInBody - body.scrollTop;
  g.style.top = yInCal + 'px';
  g.classList.remove('hidden');
}
function hideGuideLine(){ const g=document.getElementById('guideLine'); if(g) g.classList.add('hidden') }

function showStickIndicator(body, yInBody){
  const cal = document.getElementById('calendar');
  let s = document.getElementById('stickIndicator');
  if(!s){ s = document.createElement('div'); s.id='stickIndicator'; s.className='stick-indicator'; cal.appendChild(s) }
  const cRect = cal.getBoundingClientRect();
  const bRect = body.getBoundingClientRect();
  const yInCal = bRect.top - cRect.top + yInBody - body.scrollTop;
  s.style.top = (yInCal - 1) + 'px';
  s.style.left = (bRect.left - cRect.left + 8) + 'px';
  s.style.width = (bRect.width - 16) + 'px';
  s.classList.remove('hidden');
}
function hideStickIndicator(){ const s=document.getElementById('stickIndicator'); if(s) s.classList.add('hidden') }

// If dragged Y is within STICK px of a non-engaged block's adjacent position,
// snap to flush so user can drop next to it without pushing.
const EDGE_STICK = 10;
function applyEdgeStick(targetY, draggedH, blocks){
  let bestAdj = 0;
  let bestDist = EDGE_STICK + 1;
  let bestEdgeY = null;
  for(const b of blocks){
    if(dragSession.dirMap && dragSession.dirMap[b.id]) continue;
    // Sit just above b (dragged.bot = b.origY - GAP). Gap midline at b.origY - GAP/2.
    const candAbove = b.origY - BLOCK_GAP - draggedH;
    const dA = Math.abs(targetY - candAbove);
    if(dA <= EDGE_STICK && dA < bestDist){
      bestDist = dA; bestAdj = candAbove - targetY;
      bestEdgeY = b.origY - BLOCK_GAP/2;
    }
    // Sit just below b (dragged.top = b.bot + GAP). Gap midline at b.bot + GAP/2.
    const candBelow = b.origY + b.h + BLOCK_GAP;
    const dB = Math.abs(targetY - candBelow);
    if(dB <= EDGE_STICK && dB < bestDist){
      bestDist = dB; bestAdj = candBelow - targetY;
      bestEdgeY = b.origY + b.h + BLOCK_GAP/2;
    }
  }
  return {y: targetY + bestAdj, edgeY: bestEdgeY, dist: bestDist};
}

function applyBoundaryStick(dayIdx, targetY, draggedH){
  const wk = state.weeks[currentWeek];
  const maxY = getDividerMaxY();
  if(!wk) return {y:targetY, edgeY:null, dist:EDGE_STICK+1};
  let bestY = targetY;
  let bestEdgeY = null;
  let bestDist = EDGE_STICK + 1;
  const candidates = [
    {placeY: BODY_PAD, edgeY: BODY_PAD},
    {placeY: Math.max(BODY_PAD, maxY - draggedH), edgeY: maxY}
  ];
  getSortedDividers(wk).forEach(d=>{
    const y = clampDividerY(d.y);
    candidates.push({placeY: y - DIVIDER_CLEAR - draggedH, edgeY: y - 3});
    candidates.push({placeY: y + DIVIDER_CLEAR, edgeY: y + DIVIDER_CLEAR});
  });
  for(const c of candidates){
    const placeY = Math.max(BODY_PAD, c.placeY);
    const dist = Math.abs(targetY - placeY);
    if(dist <= EDGE_STICK && dist < bestDist){
      bestDist = dist;
      bestY = placeY;
      bestEdgeY = c.edgeY;
    }
  }
  return {y: bestY, edgeY: bestEdgeY, dist: bestDist};
}

function forcePlaceAroundDivider(dayIdx, targetY, draggedH, cursorY){
  const wk = state.weeks[currentWeek];
  if(!wk) return {y:targetY, edgeY:null, forced:false};
  for(const d of getSortedDividers(wk)){
    const lineY = clampDividerY(d.y);
    const aboveY = lineY - DIVIDER_CLEAR - draggedH;
    const belowY = lineY + DIVIDER_CLEAR;
    if(targetY > aboveY && targetY < belowY){
      return {
        y: cursorY >= lineY ? belowY : Math.max(BODY_PAD, aboveY),
        edgeY: cursorY >= lineY ? lineY + DIVIDER_CLEAR : lineY - 3,
        forced: true
      };
    }
  }
  return {y:targetY, edgeY:null, forced:false};
}

function computeMultiColumnLayout(others, ghosts, dirMap){
  const GAP = BLOCK_GAP;
  // detect new contacts: any "other" block overlapping any ghost
  for(const b of others){
    if(dirMap[b.id]) continue;
    for(const g of ghosts){
      if(b.origY < g.y + g.h && b.origY + b.h > g.y){
        dirMap[b.id] = (b.origY < g.y) ? 'up' : 'down';
        break;
      }
    }
  }
  const upBlocks = others.filter(b => dirMap[b.id] === 'up').sort((a,b)=>b.origY - a.origY); // bottom-up
  const downBlocks = others.filter(b => dirMap[b.id] === 'down').sort((a,b)=>a.origY - b.origY);
  const stayBlocks = others.filter(b => !dirMap[b.id]);
  const pos = {};

  // Down: walk top-down. Push past any actually-overlapping ghost or already-placed down block.
  const downPlaced = [];
  for(const b of downBlocks){
    let y = b.origY;
    for(let it=0; it<8; it++){
      let moved = false;
      for(const g of ghosts){
        if(y < g.y + g.h && y + b.h > g.y){
          y = g.y + g.h + GAP; moved = true;
        }
      }
      for(const p of downPlaced){
        if(y < p.y + p.h && y + b.h > p.y){
          y = p.y + p.h + GAP; moved = true;
        }
      }
      if(!moved) break;
    }
    pos[b.id] = y;
    downPlaced.push({y, h:b.h});
  }

  // Up: walk bottom-up
  const upPlaced = [];
  let stuck = false;
  for(const b of upBlocks){
    let y = b.origY;
    for(let it=0; it<8; it++){
      let moved = false;
      for(const g of ghosts){
        if(y < g.y + g.h && y + b.h > g.y){
          y = g.y - b.h - GAP; moved = true;
        }
      }
      for(const p of upPlaced){
        if(y < p.y + p.h && y + b.h > p.y){
          y = p.y - b.h - GAP; moved = true;
        }
      }
      if(!moved) break;
    }
    if(y < BODY_PAD){ stuck = true; break }
    pos[b.id] = y;
    upPlaced.push({y, h:b.h});
  }
  if(stuck){
    const upAsc = upBlocks.slice().sort((a,b)=>a.origY - b.origY);
    let y = BODY_PAD;
    for(const b of upAsc){ pos[b.id] = y; y += b.h + GAP }
  }

  for(const b of stayBlocks){ pos[b.id] = b.origY }

  // Cascade: if a pushed block now overlaps a stay block, stay engages with same direction
  let cascaded = true; let iters = 0;
  while(cascaded && iters < 5){
    cascaded = false; iters++;
    for(const sb of stayBlocks){
      if(dirMap[sb.id]) continue;
      for(const other of others){
        if(other.id === sb.id) continue;
        if(!dirMap[other.id]) continue;
        const oy = pos[other.id];
        if(oy < sb.origY + sb.h && oy + other.h > sb.origY){
          dirMap[sb.id] = dirMap[other.id];
          cascaded = true; break;
        }
      }
    }
    if(cascaded) return computeMultiColumnLayout(others, ghosts, dirMap);
  }
  return pos;
}

function previewLayoutMulti(cursorBody, cursorDayIdx, cursorY){
  const payload = currentDragPayload;
  const anchor = payload.items.find(it => it.id === payload.anchorId);
  if(!anchor) return;

  const draggedH = currentDragHeight || 36;
  const rawY = computeY(cursorBody, cursorY);
  const excludeIds = payload.items.map(it => it.id);

  // Column shift: anchor moves to cursor column; ALL selected blocks shift columns by same delta.
  // Clamp colDelta so no selected ends up out-of-bounds.
  const desiredColDelta = cursorDayIdx - anchor.dayIdx;
  let minDelta = -6, maxDelta = 6;
  for(const it of payload.items){
    minDelta = Math.max(minDelta, -it.dayIdx);
    maxDelta = Math.min(maxDelta, 6 - it.dayIdx);
  }
  const colDelta = Math.max(minDelta, Math.min(maxDelta, desiredColDelta));

  // Heights map for all items
  const heights = {};
  for(const it of payload.items){
    const el = document.querySelector(`[data-bid="${it.id}"]`);
    heights[it.id] = el ? el.offsetHeight : 36;
  }

  // Multi-ghost snap (horizontal alignment) + edge-stick (vertical adjacency)
  // + boundary stick (divider lines and body top/bottom).
  const baseYDelta = rawY - anchor.y;
  let bestAnchorY = rawY;
  let bestAbsAdjust = Infinity;
  let bestKind = null; // 'snap' | 'stick' | 'boundary'
  let bestSnapCol = null;
  let bestSnapLine = null;
  let bestStickCol = null;
  let bestStickEdgeY = null;
  let bestBoundaryCol = null;
  let bestBoundaryEdgeY = null;
  const wkSnap = state.weeks[currentWeek];
  const allBodiesSnap = document.querySelectorAll('.calendar .day .body');
  for(const it of payload.items){
    const newCol = it.dayIdx + colDelta;
    const ghostY = (it.id === payload.anchorId) ? rawY : (it.y + baseYDelta);
    const ghostH = heights[it.id];
    const gSnap = weakSnap(newCol, ghostY, excludeIds, ghostH);
    if(gSnap.snapLine != null){
      const adj = gSnap.y - ghostY;
      if(Math.abs(adj) < bestAbsAdjust){
        bestAbsAdjust = Math.abs(adj);
        bestAnchorY = rawY + adj;
        bestKind = 'snap';
        bestSnapCol = newCol; bestSnapLine = gSnap.snapLine;
      }
    }
    // Divider / body-boundary stick — same logic as the single-block path.
    const bs = applyBoundaryStick(newCol, ghostY, ghostH);
    if(bs.edgeY != null && bs.dist < bestAbsAdjust){
      bestAbsAdjust = bs.dist;
      bestAnchorY = rawY + (bs.y - ghostY);
      bestKind = 'boundary';
      bestBoundaryCol = newCol; bestBoundaryEdgeY = bs.edgeY;
    }
    const colSess = dragSession.multiCol && dragSession.multiCol[newCol];
    const dstBody = allBodiesSnap[newCol];
    const dstBlocks = (wkSnap?.days[newCol]||[])
      .filter(b => !excludeIds.includes(b.id))
      .map(b => {
        const el = dstBody?.querySelector(`[data-bid="${b.id}"]`);
        return {id:b.id, origY:b.y||0, h: el?el.offsetHeight:36};
      });
    for(const ob of dstBlocks){
      if(colSess && colSess.dirMap && colSess.dirMap[ob.id]) continue;
      const candAbove = ob.origY - BLOCK_GAP - ghostH;
      const adjA = candAbove - ghostY;
      if(Math.abs(adjA) <= EDGE_STICK && Math.abs(adjA) < bestAbsAdjust){
        bestAbsAdjust = Math.abs(adjA);
        bestAnchorY = rawY + adjA;
        bestKind = 'stick';
        bestStickCol = newCol; bestStickEdgeY = ob.origY - BLOCK_GAP/2;
      }
      const candBelow = ob.origY + ob.h + BLOCK_GAP;
      const adjB = candBelow - ghostY;
      if(Math.abs(adjB) <= EDGE_STICK && Math.abs(adjB) < bestAbsAdjust){
        bestAbsAdjust = Math.abs(adjB);
        bestAnchorY = rawY + adjB;
        bestKind = 'stick';
        bestStickCol = newCol; bestStickEdgeY = ob.origY + ob.h + BLOCK_GAP/2;
      }
    }
  }
  const anchorY = bestAnchorY;
  const delta = anchorY - anchor.y;

  if(!dragSession.multiCol) dragSession.multiCol = {};
  const allBodies = document.querySelectorAll('.calendar .day .body');
  const wk = state.weeks[currentWeek];

  // Build ghost positions per column. All selected shift by colDelta and Y delta.
  const ghostsByDay = {};
  for(let d=0;d<7;d++) ghostsByDay[d] = [];
  for(const it of payload.items){
    const h = heights[it.id];
    const newCol = it.dayIdx + colDelta;
    const newY = (it.id === payload.anchorId) ? anchorY : (it.y + delta);
    ghostsByDay[newCol].push({id: it.id, y: Math.max(BODY_PAD, newY), h});
  }

  const selectedSet = new Set(excludeIds);
  for(let d=0; d<7; d++){
    const colBody = allBodies[d];
    if(!colBody) continue;
    const ghosts = ghostsByDay[d];
    if(ghosts.length === 0){
      if(dragSession.multiCol[d]){
        resolveOverlapsForBody(colBody, d);
        delete dragSession.multiCol[d];
      }
      continue;
    }
    if(!dragSession.multiCol[d]) dragSession.multiCol[d] = {dirMap:{}, lastPos:{}};
    const colSess = dragSession.multiCol[d];

    const others = (wk.days[d]||[])
      .filter(b => !selectedSet.has(b.id))
      .map(b => {
        const el = colBody.querySelector(`[data-bid="${b.id}"]`);
        return {id:b.id, origY:b.y||0, h: el?el.offsetHeight:36};
      });

    const pos = computeMultiColumnLayout(others, ghosts, colSess.dirMap);
    colSess.lastPos = pos;

    for(const o of others){
      const el = colBody.querySelector(`[data-bid="${o.id}"]`);
      if(el) el.style.top = pos[o.id] + 'px';
    }
    let maxBot = 0;
    for(const g of ghosts) maxBot = Math.max(maxBot, g.y + g.h);
    for(const o of others) maxBot = Math.max(maxBot, pos[o.id] + o.h);
    setBodyExtent(colBody, maxBot);
  }

  if(bestKind === 'snap' && bestSnapLine != null){
    showGuideLine(allBodies[bestSnapCol] || cursorBody, bestSnapLine);
    hideStickIndicator();
  } else if(bestKind === 'stick' && bestStickEdgeY != null){
    showStickIndicator(allBodies[bestStickCol] || cursorBody, bestStickEdgeY);
    hideGuideLine();
  } else if(bestKind === 'boundary' && bestBoundaryEdgeY != null){
    showStickIndicator(allBodies[bestBoundaryCol] || cursorBody, bestBoundaryEdgeY);
    hideGuideLine();
  } else {
    hideGuideLine();
    hideStickIndicator();
  }

  dragSession.lastMultiDelta = delta;
  dragSession.lastAnchorY = anchorY;
  dragSession.lastAnchorDay = cursorDayIdx;
  dragSession.lastColDelta = colDelta;
}

// live preview during dragover (direction-locked ratcheting push)
function previewLayout(body, dayIdx, cursorY){
  if(!currentDragPayload) return;
  if(currentDragPayload.kind === 'move-multi'){
    previewLayoutMulti(body, dayIdx, cursorY);
    return;
  }

  // Switch column? Restore the previous column if any.
  if(dragSession.column !== dayIdx){
    if(dragSession.column != null){
      const prevBody = document.querySelectorAll('.calendar .day .body')[dragSession.column];
      if(prevBody) resolveOverlapsForBody(prevBody, dragSession.column);
    }
    dragSession.column = dayIdx;
    dragSession.dirMap = {};
    dragSession.ratchet = {};
  }

  const draggedH = currentDragHeight || 36;
  const rawY = computeY(body, cursorY);
  const cursorBodyY = computeCursorY(body, cursorY);
  const draggedId = currentDragPayload.kind==='move' ? currentDragPayload.blockId : null;
  const snap = weakSnap(dayIdx, rawY, draggedId, draggedH);
  let draggedY = snap.y;

  const wk = state.weeks[currentWeek];
  const blocks = (wk.days[dayIdx]||[]).filter(b=>b.id!==draggedId).map(b=>{
    const el = body.querySelector(`[data-bid="${b.id}"]`);
    return {id:b.id, origY:b.y||0, h: el?el.offsetHeight:36};
  });

  const forcedBoundary = forcePlaceAroundDivider(dayIdx, draggedY, draggedH, cursorBodyY);
  let stickEdgeY = null;
  if(forcedBoundary.forced){
    draggedY = forcedBoundary.y;
    stickEdgeY = forcedBoundary.edgeY;
  } else {
    const blockStick = applyEdgeStick(draggedY, draggedH, blocks);
    const boundaryStick = applyBoundaryStick(dayIdx, draggedY, draggedH);
    if(boundaryStick.edgeY != null && boundaryStick.dist < blockStick.dist){
      draggedY = boundaryStick.y;
      stickEdgeY = boundaryStick.edgeY;
    } else {
      draggedY = blockStick.y;
      stickEdgeY = blockStick.edgeY;
    }
  }

  // Detect new contacts → lock direction by relative position at contact time
  for(const b of blocks){
    if(dragSession.dirMap[b.id]) continue;
    if(draggedY < b.origY + b.h && draggedY + draggedH > b.origY){
      dragSession.dirMap[b.id] = (b.origY < draggedY) ? 'up' : 'down';
    }
  }

  const out = computeLayoutForSession(blocks, draggedY, draggedH);
  draggedY = out.draggedY;
  const pos = out.pos;

  for(const b of blocks){
    const el = body.querySelector(`[data-bid="${b.id}"]`);
    if(el) el.style.top = pos[b.id] + 'px';
  }
  let maxBot = draggedY + draggedH;
  for(const b of blocks) maxBot = Math.max(maxBot, pos[b.id] + b.h);
  setBodyExtent(body, maxBot);

  if(stickEdgeY != null){
    showStickIndicator(body, stickEdgeY);
    hideGuideLine();
  } else {
    hideStickIndicator();
    if(snap.snapLine != null && Math.abs(draggedY - snap.y) < 2) showGuideLine(body, snap.snapLine);
    else hideGuideLine();
  }

  dragSession.lastDraggedY = draggedY;
  dragSession.lastComputed = pos;
}

const TYPE_LABEL = {min:'至少 N 次/周', max:'最多 N 次/周'};
function typeSelectHtml(id, val){
  const v = val||'min';
  return `
    <div class="cselect" id="${id}" data-value="${v}">
      <button type="button" class="cs-btn">${TYPE_LABEL[v]}</button>
      <div class="cs-menu hidden">
        <div class="cs-opt ${v==='min'?'sel':''}" data-v="min">至少 N 次/周</div>
        <div class="cs-opt ${v==='max'?'sel':''}" data-v="max">最多 N 次/周</div>
      </div>
    </div>`;
}
function bindCSelect(id){
  const el = document.getElementById(id); if(!el) return;
  const btn = el.querySelector('.cs-btn');
  const menu = el.querySelector('.cs-menu');
  btn.onclick = (e)=>{
    e.stopPropagation();
    const open = el.classList.toggle('open');
    menu.classList.toggle('hidden', !open);
    if(open){
      setTimeout(()=>document.addEventListener('click', function off(ev){
        if(!el.contains(ev.target)){ el.classList.remove('open'); menu.classList.add('hidden'); document.removeEventListener('click', off) }
      }),0);
    }
  };
  menu.querySelectorAll('.cs-opt').forEach(o=>{
    o.onclick = (e)=>{
      e.stopPropagation();
      const v = o.dataset.v;
      el.dataset.value = v;
      btn.textContent = TYPE_LABEL[v];
      menu.querySelectorAll('.cs-opt').forEach(x=>x.classList.toggle('sel', x.dataset.v===v));
      el.classList.remove('open'); menu.classList.add('hidden');
    };
  });
}
function readCSelect(id){ return document.getElementById(id)?.dataset.value }

// people (group members synced from Firestore)
function renderPeople(){
  const me = window.LoopinAuth?.getUser();
  const buildChip = (p, compact) => {
    const el = document.createElement('div'); el.className = 'person-chip' + (compact ? ' compact' : '');
    const isMe = me && p.uid === me.uid;
    el.innerHTML = `<span class="av av-emoji">${normalizeEmoji(p.emoji)}</span>` +
      (compact ? '' : `<span class="name">${escapeHtml(p.name)}${isMe ? ' (你)' : ''}</span>`);
    el.title = (p.name || '') + (p.email ? ` · ${p.email}` : '') + (isMe ? ' · 你' : '');
    return el;
  };
  const wrap = document.getElementById('peopleList');
  if (wrap) {
    wrap.innerHTML = '';
    state.people.forEach(p => wrap.appendChild(buildChip(p, false)));
  }
  const wrapM = document.getElementById('peopleListMobile');
  if (wrapM) {
    wrapM.innerHTML = '';
    state.people.forEach(p => wrapM.appendChild(buildChip(p, true)));
  }
}
document.getElementById('addPerson').onclick=()=>{
  window.LoopinGroups.openInviteDialog();
};

// library
function renderLibrary(){
  const wrap=document.getElementById('libraryList'); wrap.innerHTML='';
  const wk=ensureWeek(currentWeek);
  state.library.forEach(t=>{
    const inWeek=wk.habits.some(h=>h.libId===t.id);
    const el=document.createElement('div'); el.className='lib-item t-'+t.type;
    el.innerHTML=`
      <div class="swatch"></div>
      <div class="meta"><div class="name">${escapeHtml(t.name)}</div><div class="rule">${t.type==='min'?'至少':'最多'} ${t.target} 次/周</div></div>
      <button class="add" ${inWeek?'disabled':''}>${inWeek?'已添加':'加到本周'}</button>
      <button class="edit" title="编辑">✎</button>
      <button class="del" title="删除">×</button>
    `;
    el.querySelector('.add').onclick=()=>addHabitToWeek(t);
    el.querySelector('.edit').onclick=()=>editLibrary(t.id);
    el.querySelector('.del').onclick=async()=>{
      if(!await window.appConfirm(`从习惯库删除「${t.name}」？已加到各周的习惯不受影响。`, { danger: true, okText: '删除' })) return;
      state.library=state.library.filter(x=>x.id!==t.id); save(); renderLibrary();
    };
    wrap.appendChild(el);
  });
}
function editLibrary(id){
  const t=id?state.library.find(x=>x.id===id):null;
  openModal(t?'编辑习惯（库）':'新建习惯（加入库）',`
    <div class="field"><label>名字</label><input id="hName" maxlength="40" value="${escapeHtml(t?.name||'')}" /></div>
    <div class="row type-target">
      <div class="field"><label>类型</label>${typeSelectHtml('hType', t?.type)}</div>
      <div class="field"><label>次数 N</label><input id="hTarget" type="number" min="1" value="${t?.target||3}" /></div>
    </div>
  `,()=>{
    const name=document.getElementById('hName').value.trim();
    const type=readCSelect('hType');
    const target=Math.max(1, parseInt(document.getElementById('hTarget').value,10)||1);
    if(!name){ toast('请输入名字'); return false }
    if(t) Object.assign(t,{name,type,target});
    else state.library.push({id:uid(),name,type,target});
    save(); renderAll();
  });
  bindCSelect('hType');
}
document.getElementById('addLibrary').onclick=()=>editLibrary(null);

// week habits
function ensureWeek(key){
  if(!state.weeks[key]) state.weeks[key]={ habits:[], dividers:[], days:{0:[],1:[],2:[],3:[],4:[],5:[],6:[]} };
  if(!state.weeks[key].habits) state.weeks[key].habits=[];
  if(!Array.isArray(state.weeks[key].dividers)) state.weeks[key].dividers=[];
  return state.weeks[key];
}
function addHabitToWeek(libT){
  const wk=ensureWeek(currentWeek);
  if(wk.habits.some(h=>h.libId===libT.id)){ toast('本周已添加'); return }
  wk.habits.push({id:uid(), libId:libT.id, name:libT.name, type:libT.type, target:libT.target});
  save(); renderAll();
}
function weeklySumByPerson(wk, habitId, pid){
  let n=0;
  for(let i=0;i<7;i++){ (wk.days[i]||[]).forEach(b=>{ if(b.habitId===habitId && b.participantId===pid) n++ }) }
  return n;
}

// copy-prev button
function prevWeekKey(key){ const m=getMonday(key); if(!m) return null; const p=new Date(m); p.setDate(p.getDate()-7); return isoWeekKey(p) }
function renderCopyPrevButton(){
  const sec = document.getElementById('weekHabitSec');
  let btn = document.getElementById('copyPrevBtn');
  if(btn) btn.remove();
  const wk = ensureWeek(currentWeek);
  if(wk.habits.length>0) return;
  const pk = prevWeekKey(currentWeek);
  if(!pk || !state.weeks[pk] || !state.weeks[pk].habits || state.weeks[pk].habits.length===0) return;
  btn = document.createElement('button');
  btn.id = 'copyPrevBtn'; btn.className = 'copy-prev';
  btn.innerHTML = `<b>↩ 复制上周的 ${state.weeks[pk].habits.length} 个习惯</b><br>打卡记录不会复制，只搬习惯本身`;
  btn.onclick = ()=>{
    const prev = state.weeks[pk];
    wk.habits = prev.habits.map(h=>({id:uid(),libId:h.libId,name:h.name,type:h.type,target:h.target}));
    save(); renderAll(); toast('已复制上周习惯');
  };
  sec.insertBefore(btn, document.getElementById('habitCards'));
}

function renderWeekHabitStrip(){
  const wrap = document.getElementById('weekStripChips');
  if(!wrap) return;
  wrap.innerHTML = '';
  if (window.LoopinMobile && window.LoopinMobile.attachMouseDragScroll) {
    window.LoopinMobile.attachMouseDragScroll(wrap, 'x');
  }
  const wk = ensureWeek(currentWeek);
  wk.habits.forEach(h => {
    const chip = document.createElement('div');
    chip.className = `ws-chip t-${h.type}`;
    chip.innerHTML = `<span class="ws-chip-name">${escapeHtml(h.name)}</span><span class="ws-chip-num">${h.target}</span>`;
    chip.title = `${h.name} · ${h.type==='min'?'至少':'最多'} ${h.target}/周`;
    if (window.LoopinMobile && window.LoopinMobile.isMobile() && window.LoopinMobile.bindMobileTap) {
      window.LoopinMobile.bindMobileTap(chip, () => {
        window.LoopinMobile.openDayPicker(chip, h, null);
      });
    }
    wrap.appendChild(chip);
  });
}

function renderHabitCards(){
  renderWeekHabitStrip();
  const wrap=document.getElementById('habitCards'); wrap.innerHTML='';
  if(window.LoopinMobile && window.LoopinMobile.isMobile()) window.LoopinMobile.attachMouseDragScroll(wrap, 'x');
  const wk=ensureWeek(currentWeek);
  wk.habits.forEach(h=>{
    const card=document.createElement('div'); card.className='h-card t-'+h.type;
    const rule = `${h.type==='min'?'至少':'最多'} ${h.target}/周`;
    card.innerHTML=`
      <div class="hdr">
        <div class="nm" title="${escapeHtml(h.name)}">${escapeHtml(h.name)}</div>
        <span class="rule">${rule}</span>
        <button class="ic edit" title="编辑">✎</button>
        <button class="ic del" title="移除">×</button>
      </div>
      <div class="rows"></div>
    `;
    const hdr=card.querySelector('.hdr');
    // Native drag only on desktop — on mobile, swipe across the card scrolls the list, long-press triggers custom drag.
    hdr.draggable = !window.LoopinMobile.isMobile();
    hdr.addEventListener('dragstart', e=>{
      e.dataTransfer.effectAllowed='copy';
      dragGrabY = 16;
      const payload = {kind:'new', habitId:h.id, participantId:null};
      e.dataTransfer.setData('application/x-loopin', JSON.stringify(payload));
      attachDragImage(e, h, null);
      currentDragPayload = payload; currentDragHeight = 36;
      committedDropThisDrag = false;
      resetDragSession();
      hdr.classList.add('dragging');
    });
    hdr.addEventListener('dragend', ()=>hdr.classList.remove('dragging'));
    // Mobile: tap card header opens a day-picker; swipe scrolls the list (no opening).
    if (window.LoopinMobile.isMobile()) {
      window.LoopinMobile.bindMobileTap(hdr, (e) => {
        if (e.target && e.target.closest && e.target.closest('.ic')) return;
        window.LoopinMobile.openDayPicker(hdr, h, null);
      });
    }
    card.querySelector('.edit').onclick=(e)=>{ e.stopPropagation(); editWeekHabit(h.id) };
    card.querySelector('.del').onclick=async(e)=>{
      e.stopPropagation();
      const hasBlocks=Object.values(wk.days).some(arr=>arr.some(b=>b.habitId===h.id));
      const msg=hasBlocks?`从本周移除「${h.name}」？日历上 ${h.name} 的打卡也会一起删除。`:`从本周移除「${h.name}」？`;
      if(!await window.appConfirm(msg, { danger: true, okText: '移除' })) return;
      wk.habits=wk.habits.filter(x=>x.id!==h.id);
      Object.keys(wk.days).forEach(k=>{ wk.days[k]=wk.days[k].filter(b=>b.habitId!==h.id) });
      save(); renderAll();
    };
    const rows=card.querySelector('.rows');
    state.people.forEach(p=>{
      const n=weeklySumByPerson(wk, h.id, p.uid);
      let stateCls='';
      if(h.type==='min' && n>=h.target) stateCls='met';
      if(h.type==='max' && n>h.target) stateCls='over';
      if(h.type==='max' && n===h.target) stateCls='met';
      const pct=Math.min(100, Math.round((n/h.target)*100));
      const barColor = h.type==='min' ? '#1bb673' : '#e94a5f';
      const row=document.createElement('div'); row.className=`p-row t-${h.type} ${stateCls}`;
      // Native drag only on desktop — on mobile we use a custom long-press handler that doesn't block scroll.
      row.draggable = !window.LoopinMobile.isMobile();
      row.innerHTML=`
        <span class="av av-emoji">${normalizeEmoji(p.emoji)}</span>
        <span class="pn">${escapeHtml(p.name)}</span>
        <span class="bar"><span class="f" style="width:${pct}%;background:${barColor}"></span></span>
        <span class="cnt">${n}/${h.target}</span>
      `;
      row.addEventListener('dragstart', e=>{
        e.stopPropagation();
        e.dataTransfer.effectAllowed='copy';
        dragGrabY = 16;
        const payload = {kind:'new', habitId:h.id, participantId:p.uid};
        e.dataTransfer.setData('application/x-loopin', JSON.stringify(payload));
        attachDragImage(e, h, p);
        currentDragPayload = payload; currentDragHeight = 36;
        committedDropThisDrag = false;
        resetDragSession();
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', ()=>row.classList.remove('dragging'));
      if (window.LoopinMobile.isMobile()) {
        window.LoopinMobile.bindMobileTap(row, () => window.LoopinMobile.openDayPicker(row, h, p));
      }
      rows.appendChild(row);
    });
    wrap.appendChild(card);
  });
}

function editWeekHabit(hid){
  const wk=ensureWeek(currentWeek);
  const h=wk.habits.find(x=>x.id===hid); if(!h) return;
  openModal('编辑本周习惯',`
    <div class="field"><label>名字</label><input id="hName" maxlength="40" value="${escapeHtml(h.name)}" /></div>
    <div class="row type-target">
      <div class="field"><label>类型</label>${typeSelectHtml('hType', h.type)}</div>
      <div class="field"><label>次数 N</label><input id="hTarget" type="number" min="1" value="${h.target}" /></div>
    </div>
    <div class="field"><label class="check"><input type="checkbox" id="hSync" /> 同步修改到习惯库</label></div>
  `,()=>{
    const name=document.getElementById('hName').value.trim();
    const type=readCSelect('hType');
    const target=Math.max(1, parseInt(document.getElementById('hTarget').value,10)||1);
    const sync=document.getElementById('hSync').checked;
    if(!name){ toast('请输入名字'); return false }
    Object.assign(h,{name,type,target});
    if(sync && h.libId){ const lib=state.library.find(x=>x.id===h.libId); if(lib) Object.assign(lib,{name,type,target}) }
    save(); renderAll();
  });
  bindCSelect('hType');
}

document.getElementById('addWeekHabit').onclick=(e)=>{
  e.stopPropagation();
  document.querySelectorAll('.popover').forEach(p=>p.remove());
  const pop=document.createElement('div'); pop.className='popover';
  const wk=ensureWeek(currentWeek);
  if(state.library.length===0){
    const d=document.createElement('div'); d.style.cssText='font-size:12px;color:var(--ink-soft);padding:6px 8px';
    d.textContent='习惯库是空的';
    pop.appendChild(d);
  } else {
    state.library.forEach(t=>{
      const added = wk.habits.some(h=>h.libId===t.id);
      const r=document.createElement('div'); r.className='opt' + (added ? ' disabled' : '');
      const tag = added ? '<span class="rl dim">已添加</span>' : `<span class="rl">${t.type==='min'?'至少':'最多'} ${t.target}/周</span>`;
      r.innerHTML=`<span class="sw" style="background:${t.type==='min'?'var(--good)':'var(--bad)'}"></span><span class="nm">${escapeHtml(t.name)}</span>${tag}`;
      if(!added) r.onclick=()=>{ addHabitToWeek(t); pop.remove() };
      pop.appendChild(r);
    });
  }
  const div=document.createElement('div'); div.className='divider'; pop.appendChild(div);
  const o1=document.createElement('div'); o1.className='opt action'; o1.textContent='+ 仅本周新建（不加入库）'; o1.onclick=()=>{ pop.remove(); newWeekOnlyHabit() }; pop.appendChild(o1);
  const o2=document.createElement('div'); o2.className='opt action'; o2.textContent='+ 新建并加入习惯库'; o2.onclick=()=>{ pop.remove(); editLibraryAndAddToWeek() }; pop.appendChild(o2);
  document.body.appendChild(pop);
  const r=e.currentTarget.getBoundingClientRect();
  // Position with viewport clamping so the popover never overflows offscreen.
  pop.style.visibility='hidden';
  pop.style.left='0';
  pop.style.top='0';
  requestAnimationFrame(()=>{
    const pw=pop.offsetWidth, ph=pop.offsetHeight;
    const vw=window.innerWidth, vh=window.innerHeight;
    // Prefer aligning right edge of popover with right edge of trigger; fall back to left-align if it fits better.
    let left = r.right - pw;
    if(left < 8) left = Math.min(r.left, vw - pw - 8);
    left = Math.max(8, Math.min(left, vw - pw - 8));
    // Vertical: below the trigger if there's room, else above.
    let top = r.bottom + 6;
    if(top + ph > vh - 8) top = Math.max(8, r.top - ph - 6);
    pop.style.left = (window.scrollX + left) + 'px';
    pop.style.top  = (window.scrollY + top)  + 'px';
    pop.style.visibility='';
  });
  setTimeout(()=>document.addEventListener('click', function off(ev){ if(!pop.contains(ev.target)){ pop.remove(); document.removeEventListener('click',off) } }),0);
};

function newWeekOnlyHabit(){
  const wk=ensureWeek(currentWeek);
  openModal('新建（仅本周）',`
    <div class="field"><label>名字</label><input id="hName" maxlength="40" placeholder="如 跑步" /></div>
    <div class="row type-target">
      <div class="field"><label>类型</label>${typeSelectHtml('hType','min')}</div>
      <div class="field"><label>次数 N</label><input id="hTarget" type="number" min="1" value="3" /></div>
    </div>
  `,()=>{
    const name=document.getElementById('hName').value.trim();
    const type=readCSelect('hType');
    const target=Math.max(1, parseInt(document.getElementById('hTarget').value,10)||1);
    if(!name){ toast('请输入名字'); return false }
    wk.habits.push({id:uid(),libId:null,name,type,target});
    save(); renderAll();
  });
  bindCSelect('hType');
}
function editLibraryAndAddToWeek(){
  const before=new Set(state.library.map(x=>x.id));
  editLibrary(null);
  const origOk=mOk.onclick;
  mOk.onclick=()=>{ const r=origOk(); if(r!==false){ const added=state.library.find(x=>!before.has(x.id)); if(added) addHabitToWeek(added) } };
}

// calendar
function renderCalendar(){
  ensureWeek(currentWeek);
  const cal=document.getElementById('calendar'); cal.innerHTML='';
  const monday=getMonday(currentWeek);
  document.getElementById('weekLabel').textContent=fmtRange(monday);
  try{ localStorage.setItem('loopin_last_week', currentWeek) }catch{}
  const todayKey=isoWeekKey(new Date());
  document.getElementById('thisWeek').classList.toggle('is-current', currentWeek === todayKey);
  const todayDow=(new Date().getDay()+6)%7;
  const wk=state.weeks[currentWeek];

  // PASS 1: Build the 7 day frames first so the body layout is established. We need
  // each body's actual pixel height to convert `frac` (0..1 relative position) into a
  // pixel `y` for this device. The data is stored as `frac` so that desktop and mobile
  // render at identical proportional positions.
  const days = [];
  for(let i=0;i<7;i++){
    const date=new Date(monday); date.setDate(monday.getDate()+i);
    const day=document.createElement('div'); day.className='day';
    if(currentWeek===todayKey && i===todayDow) day.classList.add('today');
    day.innerHTML=`<div class="head"><div><div class="dow">${DOW_CN[i]}</div><div class="date">${date.getMonth()+1}/${date.getDate()}</div></div></div><div class="body" data-day="${i}"></div>`;
    cal.appendChild(day);
    days.push(day);
  }
  // Measure the body height now (forces layout). Use this as the canvas reference.
  const sampleBody = days[0].querySelector('.body');
  const canvasH = sampleBody.clientHeight;
  if(canvasH > 50){
    // Only record the canvas height from desktop renders — that's the reference we want
    // future mobile loads to use when migrating legacy pixel `y` values.
    if(!window.LoopinMobile.isMobile()){
      try{ localStorage.setItem('loopin_canvas_h', String(canvasH)) }catch{}
    }
    // For legacy data missing `frac`, infer a plausible "canvas height when placed" so
    // items aren't clamped. The largest known canvas (from a desktop session in
    // localStorage) is the best signal; otherwise use the data's own max y as a lower
    // bound (the canvas at placement must have been at least that tall).
    let migrationRefH = canvasH;
    try {
      const stored = parseFloat(localStorage.getItem('loopin_canvas_h')) || 0;
      if(stored > migrationRefH) migrationRefH = stored;
    } catch {}
    let maxLegacyY = 0;
    Object.values(wk.days || {}).forEach(arr => (arr || []).forEach(b => {
      if(typeof b.frac !== 'number' && typeof b.y === 'number' && b.y > maxLegacyY) maxLegacyY = b.y;
    }));
    (wk.dividers || []).forEach(d => {
      if(typeof d.frac !== 'number' && typeof d.y === 'number' && d.y > maxLegacyY) maxLegacyY = d.y;
    });
    if(maxLegacyY > 0) migrationRefH = Math.max(migrationRefH, maxLegacyY + 80);
    if(migrationRefH < 600) migrationRefH = 800;

    Object.values(wk.days || {}).forEach(arr => {
      (arr || []).forEach(b => {
        if(typeof b.frac !== 'number' && typeof b.y === 'number'){
          b.frac = Math.max(0, Math.min(0.99, b.y / migrationRefH));
        }
      });
    });
    (wk.dividers || []).forEach(d => {
      if(typeof d.frac !== 'number' && typeof d.y === 'number'){
        d.frac = Math.max(0, Math.min(0.99, d.y / migrationRefH));
      }
    });
    hydrateWeekLayoutFromFractions(canvasH);
  }

  // PASS 2: Wire each body's drag handlers and append blocks.
  for(let i=0;i<7;i++){
    const day = days[i];
    const body=day.querySelector('.body');
    const blocks = wk.days[i] || [];
    body.addEventListener('dragenter', e=>{ if(e.dataTransfer.types.includes('application/x-loopin')){ e.preventDefault(); body.classList.add('over') } });
    body.addEventListener('dragover', e=>{
      if(!e.dataTransfer.types.includes('application/x-loopin')) return;
      e.preventDefault();
      body.classList.add('over');
      if(lastDragY != null){
        if(e.clientY > lastDragY + 0.5) dragDir = 'down';
        else if(e.clientY < lastDragY - 0.5) dragDir = 'up';
      }
      lastDragY = e.clientY;
      previewLayout(body, i, e.clientY);
    });
    body.addEventListener('dragleave', e=>{
      if(!body.contains(e.relatedTarget)){
        body.classList.remove('over');
        // In multi mode, don't restore here — multi previewLayout manages all columns globally
        if(currentDragPayload && currentDragPayload.kind === 'move-multi') return;
        hideGuideLine();
        hideStickIndicator();
        resolveOverlapsForBody(body, i);
        if(dragSession.column === i){
          dragSession.column = null;
          dragSession.dirMap = {};
          dragSession.ratchet = {};
          dragSession.lastDraggedY = null;
          dragSession.lastComputed = null;
        }
      }
    });
    body.addEventListener('drop', e=>{
      e.preventDefault(); body.classList.remove('over');
      hideGuideLine();
      const raw=e.dataTransfer.getData('application/x-loopin'); if(!raw) return;
      let payload; try{ payload=JSON.parse(raw) }catch{ return }
      // Prefer the last computed preview state (which captures ratcheted pushes)
      const finalY = (dragSession.lastDraggedY != null) ? dragSession.lastDraggedY : (function(){
        const rawY = computeY(body, e.clientY);
        const cursorBodyY = computeCursorY(body, e.clientY);
        const draggedId = payload.kind==='move' ? payload.blockId : null;
        let y = weakSnap(i, rawY, draggedId, currentDragHeight || 36).y;
        const forcedBoundary = forcePlaceAroundDivider(i, y, currentDragHeight || 36, cursorBodyY);
        if(forcedBoundary.forced) return forcedBoundary.y;
        const boundaryStick = applyBoundaryStick(i, y, currentDragHeight || 36);
        if(boundaryStick.edgeY != null) return boundaryStick.y;
        return y;
      })();
      const computed = dragSession.lastComputed || {};
      placeAndCommitMap(payload, i, finalY, computed);
    });
    blocks.forEach(b=>body.appendChild(renderBlock(b,i,wk)));
  }
  renderWeekDividers();
}

function getCalendarBodyOffset(){
  const cal = document.getElementById('calendar');
  const firstBody = cal?.querySelector('.day .body');
  if(!cal || !firstBody) return 0;
  // Use bounding rects so the value doesn't depend on offsetParent chain (which can give
  // different results on iOS Safari when layout hasn't fully settled).
  const calRect = cal.getBoundingClientRect();
  const bodyRect = firstBody.getBoundingClientRect();
  return Math.max(0, bodyRect.top - calRect.top);
}
function getDividerMaxY(){
  const firstBody = document.querySelector('.calendar .day .body');
  if(firstBody) return Math.max(0, firstBody.clientHeight - 1);
  const cal = document.getElementById('calendar');
  if(!cal) return 0;
  return Math.max(0, cal.clientHeight - getCalendarBodyOffset() - 1);
}
function clampDividerY(y){
  return Math.max(0, Math.min(getDividerMaxY(), Number(y)||0));
}
function clampDividerYBetween(y, prevY, nextY){
  const minY = prevY == null ? 0 : prevY + DIVIDER_MIN_SPAN;
  const maxY = nextY == null ? getDividerMaxY() : nextY - DIVIDER_MIN_SPAN;
  return Math.max(minY, Math.min(maxY, clampDividerY(y)));
}
function getDividerYFromPointer(clientY){
  const cal = document.getElementById('calendar');
  if(!cal) return BODY_PAD;
  const rect = cal.getBoundingClientRect();
  return clampDividerY(clientY - rect.top - getCalendarBodyOffset());
}
function getDividerSnapTarget(targetY, prevY, nextY){
  const top = prevY == null ? 0 : prevY;
  const bottom = nextY == null ? getDividerMaxY() : nextY;
  const span = bottom - top;
  if(span <= DIVIDER_MIN_SPAN * 2) return null;
  const candidates = [
    top + span / 3,
    top + span / 2,
    top + span * 2 / 3
  ];
  let best = null;
  let bestDist = DIVIDER_SNAP_THRESHOLD + 1;
  for(const cand of candidates){
    const dist = Math.abs(targetY - cand);
    if(dist <= DIVIDER_SNAP_THRESHOLD && dist < bestDist){
      bestDist = dist;
      best = cand;
    }
  }
  return best == null ? null : clampDividerYBetween(best, prevY, nextY);
}
function showDividerSnapLine(y){
  const cal = document.getElementById('calendar');
  if(!cal) return;
  let g = document.getElementById('dividerSnapLine');
  if(!g){
    g = document.createElement('div');
    g.id = 'dividerSnapLine';
    g.className = 'guide-line divider-snap-line';
    cal.appendChild(g);
  }
  g.style.top = (getCalendarBodyOffset() + y) + 'px';
  g.classList.remove('hidden');
}
function hideDividerSnapLine(){
  const g = document.getElementById('dividerSnapLine');
  if(g) g.classList.add('hidden');
}
function snapshotDividerDrag(dividerId){
  const wk = ensureWeek(currentWeek);
  const bodies = document.querySelectorAll('.calendar .day .body');
  return {
    id: dividerId,
    baseDividers: getSortedDividers(wk).map(d=>({id:d.id, y:clampDividerY(d.y)})),
    dayBlocks: Array.from({length:7}, (_, dayIdx)=>{
      const body = bodies[dayIdx];
      return (wk.days[dayIdx] || []).map(b=>{
        const el = body?.querySelector(`[data-bid="${b.id}"]`);
        return {id:b.id, y:b.y||0, h:el?el.offsetHeight:36};
      }).sort((a,b)=>a.y-b.y);
    })
  };
}
function getDividerRange(snapshot){
  const idx = snapshot.baseDividers.findIndex(d=>d.id === snapshot.id);
  const prevY = idx > 0 ? snapshot.baseDividers[idx-1].y : null;
  const nextY = idx >= 0 && idx < snapshot.baseDividers.length - 1 ? snapshot.baseDividers[idx+1].y : null;
  const current = idx >= 0 ? snapshot.baseDividers[idx].y : null;
  return {idx, prevY, nextY, current};
}
function computeDividerDayLayout(dayBlocks, prevY, oldY, newY, nextY, mode){
  const dividerYs = [];
  if(prevY != null) dividerYs.push(prevY);
  dividerYs.push(newY);
  if(nextY != null) dividerYs.push(nextY);
  const inCurrentRegion = center => (prevY == null || center >= prevY) && (nextY == null || center < nextY);

  if(mode === 'insert'){
    const upper = [];
    const lower = [];
    const stable = [];
    dayBlocks.forEach(b=>{
      const center = b.y + b.h / 2;
      if(!inCurrentRegion(center)) stable.push(b);
      else if(center < newY) upper.push(b);
      else lower.push(b);
    });
    const upperBounds = getSegmentBounds(dividerYs, prevY == null ? 0 : 1);
    const lowerBounds = getSegmentBounds(dividerYs, prevY == null ? 1 : 2);
    const upperPos = packBlocksUp(upper, upperBounds.top, upperBounds.bottom);
    const lowerPos = packBlocksDown(lower, lowerBounds.top, lowerBounds.bottom);
    if(!upperPos || !lowerPos) return null;
    return {
      ...Object.fromEntries(stable.map(b=>[b.id, b.y])),
      ...upperPos,
      ...lowerPos
    };
  }

  if(oldY == null || newY === oldY){
    return Object.fromEntries(dayBlocks.map(b=>[b.id, b.y]));
  }

  const movingUp = newY < oldY;
  const affected = [];
  const stable = [];
  dayBlocks.forEach(b=>{
    const center = b.y + b.h / 2;
    if(!inCurrentRegion(center)) stable.push(b);
    else if(movingUp ? center < oldY : center >= oldY) affected.push(b);
    else stable.push(b);
  });

  // First try: shift the whole affected group uniformly so block-to-block gaps are
  // preserved. Only fall back to packing if the uniform shift wouldn't fit on the other
  // end of the segment.
  const idx = prevY == null ? 0 : 1;
  const bounds = movingUp
    ? getSegmentBounds(dividerYs, idx)
    : getSegmentBounds(dividerYs, idx + 1);
  if(affected.length > 0){
    let shift = 0;
    if(movingUp){
      // Upper segment shrinks (divider rose). If lowest block's bottom now sits past
      // the new lower boundary, push every affected block up by the same amount.
      let maxBottom = -Infinity;
      for(const b of affected){ maxBottom = Math.max(maxBottom, b.y + b.h); }
      const overflow = maxBottom - bounds.bottom;
      if(overflow > 0) shift = -overflow;
    } else {
      // Lower segment shrinks (divider dropped). If topmost block now sits above the
      // new top boundary, push every affected block down by the same amount.
      let minTop = Infinity;
      for(const b of affected){ minTop = Math.min(minTop, b.y); }
      const overflow = bounds.top - minTop;
      if(overflow > 0) shift = overflow;
    }
    let shiftFits = true;
    if(shift !== 0){
      for(const b of affected){
        const ny = b.y + shift;
        if(ny < bounds.top || (ny + b.h) > bounds.bottom){ shiftFits = false; break; }
      }
    }
    if(shiftFits){
      const out = Object.fromEntries(stable.map(b=>[b.id, b.y]));
      for(const b of affected){ out[b.id] = b.y + shift; }
      return out;
    }
  }

  // Fallback: blocks really don't fit even after uniform shift, pack tight.
  const affectedPos = movingUp
    ? packBlocksUp(affected, bounds.top, bounds.bottom)
    : packBlocksDown(affected, bounds.top, bounds.bottom);
  if(!affectedPos) return null;

  const out = Object.fromEntries(stable.map(b=>[b.id, b.y]));
  Object.assign(out, affectedPos);
  return out;
}
function applyDividerPreview(snapshot, desiredY, mode){
  const wk = ensureWeek(currentWeek);
  const {idx, prevY, nextY, current} = getDividerRange(snapshot);
  if(idx < 0 || current == null) return {ok:false};
  let y = clampDividerYBetween(desiredY, prevY, nextY);
  const snapY = getDividerSnapTarget(y, prevY, nextY);
  if(snapY != null) y = snapY;

  const dayLayouts = [];
  for(let dayIdx=0; dayIdx<7; dayIdx++){
    const layout = computeDividerDayLayout(snapshot.dayBlocks[dayIdx], prevY, mode === 'insert' ? null : current, y, nextY, mode);
    if(!layout) return {ok:false};
    dayLayouts[dayIdx] = layout;
  }

  wk.dividers = snapshot.baseDividers.map(d=>({
    id:d.id,
    y:d.id === snapshot.id ? y : d.y
  })).sort((a,b)=>a.y-b.y);
  for(let dayIdx=0; dayIdx<7; dayIdx++){
    (wk.days[dayIdx] || []).forEach(b=>{
      if(dayLayouts[dayIdx][b.id] != null) b.y = dayLayouts[dayIdx][b.id];
    });
  }
  renderCalendar();
  const active = document.querySelector(`.divider-line[data-id="${snapshot.id}"]`);
  if(active) active.classList.add('dragging');
  if(snapY != null) showDividerSnapLine(y);
  else hideDividerSnapLine();
  return {ok:true, y};
}
function getNextDividerY(wk){
  const maxY = getDividerMaxY();
  if(maxY <= 0) return 0;
  const points = [0, ...wk.dividers.map(d=>clampDividerY(d.y)).sort((a,b)=>a-b), maxY];
  let bestStart = 0;
  let bestEnd = maxY;
  let bestLen = -1;
  for(let i=0;i<points.length-1;i++){
    const start = points[i];
    const end = points[i+1];
    const len = end - start;
    if(len > bestLen || (Math.abs(len - bestLen) < 0.5 && end > bestEnd)){
      bestLen = len;
      bestStart = start;
      bestEnd = end;
    }
  }
  return clampDividerY(bestStart + bestLen / 2);
}
function renderWeekDividers(){
  const cal = document.getElementById('calendar');
  const wk = ensureWeek(currentWeek);
  const bodyOffset = getCalendarBodyOffset();
  wk.dividers = wk.dividers.slice().sort((a,b)=>a.y-b.y);
  wk.dividers.forEach(divider=>{
      const line = document.createElement('div');
      line.className = 'divider-line';
      line.dataset.id = divider.id;
      // Use raw y (no clamp) so divider stays in the same coordinate system as blocks,
      // which also use raw frac×canvasH. Clamping is reserved for active user drag.
      line.style.top = (bodyOffset + (divider.y || 0)) + 'px';
      line.title = '拖动调整位置';
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'divider-remove';
      removeBtn.setAttribute('aria-label', '删除分割线');
      removeBtn.textContent = '−';
      removeBtn.onmousedown = e=>{
        e.preventDefault();
        e.stopPropagation();
      };
      removeBtn.onclick = e=>{
        e.preventDefault();
        e.stopPropagation();
        wk.dividers = wk.dividers.filter(x=>x.id !== divider.id);
        save();
        renderCalendar();
        hideDividerSnapLine();
        toast('已删除分割线');
      };
      line.appendChild(removeBtn);
      line.addEventListener('mousedown', e=>{
        if(e.button !== 0) return;
        dividerDrag = {
          id: divider.id,
          snapshot: snapshotDividerDrag(divider.id),
          lastValidY: divider.y
        };
        line.classList.add('dragging');
        e.preventDefault();
        e.stopPropagation();
      });
      cal.appendChild(line);
    });
}

function getHabit(wk, hid){ return wk.habits.find(h=>h.id===hid) || {name:'(已删除)',type:'min',target:1} }

function renderBlock(b, dayIdx, wk){
  const h=getHabit(wk, b.habitId);
  const person=state.people.find(p=>p.uid===b.participantId);
  const el=document.createElement('div'); el.className='block t-'+h.type; el.draggable=!isMobileWeekLayout();
  el.dataset.bid = b.id;
  el.style.top = ((b.y!=null) ? b.y : BODY_PAD) + 'px';
  const avHtml = person
    ? `<span class="av av-emoji" title="${escapeHtml(person.name)} · 点击更换">${normalizeEmoji(person.emoji)}</span>`
    : `<span class="av empty" title="点击分配成员">?</span>`;
  const noteHtml = b.note ? `<div class="note">${escapeHtml(b.note)}</div>` : '';
  el.innerHTML=`
    <div class="row1">
      ${avHtml}
      <div class="title" title="${escapeHtml(h.name)}">${escapeHtml(h.name)}</div>
      <button class="edit" title="备注">✎</button>
      <button class="x" title="移除">×</button>
    </div>
    ${noteHtml}
  `;
  el.addEventListener('mousedown', ()=>{
    if(!selectedIds.has(b.id)) clearSelection();
  });
  el.addEventListener('dragstart', e=>{
    // capture where in the block the user grabbed
    const r = el.getBoundingClientRect();
    dragGrabY = Math.max(0, e.clientY - r.top);
    e.dataTransfer.effectAllowed='move';
    let payload;
    if(selectedIds.has(b.id) && selectedIds.size > 1){
      const items = [];
      const wkk = state.weeks[currentWeek];
      for(let d=0; d<7; d++){
        (wkk.days[d]||[]).forEach(blk=>{
          if(selectedIds.has(blk.id)) items.push({id:blk.id, dayIdx:d, y:blk.y});
        });
      }
      payload = {kind:'move-multi', anchorId:b.id, anchorDay:dayIdx, items};
      e.dataTransfer.setData('application/x-loopin', JSON.stringify(payload));
      attachMultiDragImage(e, payload);
      // hide all selected source blocks while dragging
      selectedIds.forEach(id=>{
        const sel = document.querySelector(`[data-bid="${id}"]`);
        if(sel) sel.classList.add('dragging');
      });
    } else {
      payload = {kind:'move', blockId:b.id, srcDay:dayIdx};
      e.dataTransfer.setData('application/x-loopin', JSON.stringify(payload));
      attachDragImage(e, h, person, b.note);
      el.classList.add('dragging');
    }
    currentDragPayload = payload; currentDragHeight = el.offsetHeight;
    committedDropThisDrag = false;
    resetDragSession();
    document.getElementById('calendar')?.classList.add('dragging');
  });
  el.addEventListener('dragend', ()=>{
    if(!suppressSourceReveal) el.classList.remove('dragging');
    removePh();
  });
  el.querySelector('.x').onclick=(e)=>{ e.stopPropagation(); wk.days[dayIdx]=wk.days[dayIdx].filter(x=>x.id!==b.id); save(); renderAll() };
  el.querySelector('.edit').onclick=(e)=>{ e.stopPropagation(); editBlockNote(b) };
  // Mobile: any click on the block (incl. avatar) opens a small popover with all actions; desktop keeps avatar=>assign popover.
  el.querySelector('.av').onclick=(e)=>{
    e.stopPropagation();
    if (window.innerWidth <= 820) showBlockActionsPopover(el, b, dayIdx, wk, h);
    else showPersonPopover(el.querySelector('.av'), b);
  };
  el.addEventListener('click', (e) => {
    if (Date.now() < suppressBlockClickUntil) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (window.innerWidth > 820) return;
    if (e.target.closest('.av') || e.target.closest('.edit') || e.target.closest('.x')) return;
    e.stopPropagation();
    showBlockActionsPopover(el, b, dayIdx, wk, h);
  });
  bindMobileBlockDrag(el, b, dayIdx);
  return el;
}

function editBlockNote(block){
  openModal('备注',`
    <div class="field"><label>备注（可选）</label><textarea id="bNote" maxlength="200" placeholder="例如：跑了5公里 / 吃了一块蛋糕">${escapeHtml(block.note||'')}</textarea></div>
  `,()=>{
    block.note = document.getElementById('bNote').value.trim();
    save(); renderAll();
  });
  setTimeout(()=>document.getElementById('bNote')?.focus(),50);
}

function showBlockActionsPopover(anchor, block, dayIdx, wk, h){
  document.querySelectorAll('.popover').forEach(p => p.remove());
  const person = state.people.find(p => p.uid === block.participantId);
  const pop = document.createElement('div'); pop.className = 'popover block-actions';
  const mkRow = (text, cls, onTap) => {
    const r = document.createElement('div'); r.className = 'opt ' + (cls || '');
    r.textContent = text;
    r.onclick = (e) => { e.stopPropagation(); pop.remove(); onTap(); };
    return r;
  };
  const head = document.createElement('div'); head.className = 'pop-head';
  head.textContent = `${h.name}${person ? ' · ' + person.name : ''}`;
  pop.appendChild(head);
  pop.appendChild(mkRow('编辑习惯（名字/规则）', 'action', () => editWeekHabit(h.id)));
  pop.appendChild(mkRow(person ? '更换分配的成员' : '分配成员', 'action', () => {
    const fakeAnchor = document.createElement('div');
    fakeAnchor.style.cssText = 'position:fixed;left:50%;top:40%;width:0;height:0';
    document.body.appendChild(fakeAnchor);
    showPersonPopover(fakeAnchor, block);
    setTimeout(() => fakeAnchor.remove(), 100);
  }));
  pop.appendChild(mkRow(block.note ? '编辑备注' : '添加备注', 'action', () => editBlockNote(block)));
  pop.appendChild(mkRow('删除这次打卡', 'action danger', async () => {
    if (await window.appConfirm('删除这次打卡？', { danger: true, okText: '删除' })) {
      wk.days[dayIdx] = wk.days[dayIdx].filter(x => x.id !== block.id);
      save(); renderAll();
    }
  }));
  document.body.appendChild(pop);
  pop.style.visibility = 'hidden';
  requestAnimationFrame(() => {
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = r.left + (r.width - pw) / 2;
    left = Math.max(8, Math.min(left, vw - pw - 8));
    let top = r.bottom + 6;
    if (top + ph > vh - 8) top = Math.max(8, r.top - ph - 6);
    pop.style.left = (window.scrollX + left) + 'px';
    pop.style.top = (window.scrollY + top) + 'px';
    pop.style.visibility = '';
  });
  setTimeout(() => document.addEventListener('click', function off(ev){
    if (!pop.contains(ev.target)) { pop.remove(); document.removeEventListener('click', off); }
  }), 0);
}

function openBlockActions(block, dayIdx, wk, h){
  const person = state.people.find(p => p.uid === block.participantId);
  const summary = `${h.name}${person ? ` · ${person.name}` : ''}${block.note ? `\n备注：${block.note}` : ''}`;
  const html = `
    <div class="me-menu-actions">
      <button class="ghost" data-a="edit-habit">编辑习惯（名字/规则）</button>
      <button class="ghost" data-a="assign">${person ? '更换分配的成员' : '分配成员'}</button>
      <button class="ghost" data-a="note">${block.note ? '编辑备注' : '添加备注'}</button>
      <button class="ghost danger" data-a="delete">删除这次打卡</button>
    </div>
  `;
  openModal(summary, html, () => true);
  document.getElementById('modalBody').querySelectorAll('[data-a]').forEach(btn => {
    btn.onclick = async () => {
      document.getElementById('modalBackdrop').classList.add('hidden');
      const a = btn.dataset.a;
      if (a === 'edit-habit') {
        editWeekHabit(h.id);
      } else if (a === 'assign') {
        const fakeAnchor = document.createElement('div');
        fakeAnchor.style.cssText = 'position:fixed;left:50%;top:40%;width:0;height:0';
        document.body.appendChild(fakeAnchor);
        showPersonPopover(fakeAnchor, block);
        setTimeout(() => fakeAnchor.remove(), 100);
      } else if (a === 'note') {
        editBlockNote(block);
      } else if (a === 'delete') {
        if (await window.appConfirm('删除这次打卡？', { danger: true, okText: '删除' })) {
          wk.days[dayIdx] = wk.days[dayIdx].filter(x => x.id !== block.id);
          save(); renderAll();
        }
      }
    };
  });
}

function showPersonPopover(anchor, block){
  document.querySelectorAll('.popover').forEach(p=>p.remove());
  const pop=document.createElement('div'); pop.className='popover';
  if(state.people.length===0){
    pop.innerHTML=`<div style="font-size:12px;color:var(--ink-soft);padding:6px 8px">还没有成员，请先添加</div>`;
  } else {
    state.people.forEach(p=>{
      const r=document.createElement('div'); r.className='opt';
      r.innerHTML=`<span class="av av-emoji">${normalizeEmoji(p.emoji)}</span><span class="nm">${escapeHtml(p.name)}</span>`;
      r.onclick=()=>{ block.participantId=p.uid; save(); renderAll() };
      pop.appendChild(r);
    });
    const clr=document.createElement('div'); clr.className='opt';
    clr.innerHTML=`<span class="av empty">×</span><span class="nm">取消分配</span>`;
    clr.onclick=()=>{ block.participantId=null; save(); renderAll() };
    pop.appendChild(clr);
  }
  document.body.appendChild(pop);
  const r=anchor.getBoundingClientRect();
  pop.style.left=(window.scrollX+r.left)+'px';
  pop.style.top=(window.scrollY+r.bottom+6)+'px';
  setTimeout(()=>document.addEventListener('click', function off(ev){ if(!pop.contains(ev.target)){ pop.remove(); document.removeEventListener('click',off) } }),0);
}

function snapDropY(dstDay, targetY, draggedBlockId, draggedH){
  const wk = state.weeks[currentWeek]; if(!wk) return targetY;
  const SNAP_X = 24;       // horizontal align threshold (vs other columns)
  const APPROX_H = draggedH || 36;

  // 1. horizontal snap to nearest Y from OTHER days' blocks
  const otherYs = [];
  for(let d=0; d<7; d++){
    if(d===dstDay) continue;
    (wk.days[d]||[]).forEach(b=>otherYs.push(b.y || BODY_PAD));
  }
  let best = null, bestDist = SNAP_X+1;
  for(const y of otherYs){
    const dist = Math.abs(targetY - y);
    if(dist < bestDist){ bestDist = dist; best = y }
  }
  if(best!=null) targetY = best;

  // 2. vertical adjacency: if dragged block would overlap with any same-day block, snap
  const bodyEl = document.querySelectorAll('.calendar .day .body')[dstDay];
  const sameDay = (wk.days[dstDay]||[]).filter(b=>b.id!==draggedBlockId).map(b=>{
    const el = bodyEl?.querySelector(`[data-bid="${b.id}"]`);
    return {top: b.y||0, h: el?el.offsetHeight:APPROX_H};
  }).sort((a,b)=>a.top-b.top);
  for(const {top, h} of sameDay){
    const bot = top + h;
    // does dragged [targetY, targetY+APPROX_H] overlap [top, bot]?
    if(targetY < bot && (targetY + APPROX_H) > top){
      const mid = top + h/2;
      const draggedMid = targetY + APPROX_H/2;
      if(draggedMid < mid) targetY = top - 1;          // covering upper half → take its spot
      else targetY = bot + BLOCK_GAP;                  // covering lower half → snap below
      break;
    }
  }
  return Math.max(BODY_PAD, targetY);
}

function placeAndCommitMap(payload, dstDay, snappedY, computedMap){
  committedDropThisDrag = true;
  suppressSourceReveal = true;
  suppressPlacementAnimation = true;
  pushUndo();
  const wk = ensureWeek(currentWeek);
  if(payload.kind === 'move-multi'){
    const anchor = payload.items.find(x=>x.id === payload.anchorId);
    if(!anchor){ resetDragSession(); return }
    const newAnchorY = (dragSession.lastAnchorY != null) ? dragSession.lastAnchorY : snappedY;
    const delta = (dragSession.lastMultiDelta != null) ? dragSession.lastMultiDelta : (newAnchorY - anchor.y);
    const colDelta = dragSession.lastColDelta || 0;

    // Move every selected block: column += colDelta, y += delta
    for(const it of payload.items){
      const oldArr = wk.days[it.dayIdx] || [];
      const idx = oldArr.findIndex(x => x.id === it.id);
      if(idx < 0) continue;
      const [b] = oldArr.splice(idx, 1);
      const newCol = Math.max(0, Math.min(6, it.dayIdx + colDelta));
      b.y = (it.id === payload.anchorId) ? Math.max(BODY_PAD, newAnchorY) : Math.max(BODY_PAD, it.y + delta);
      wk.days[newCol].push(b);
    }

    // Commit pushed positions for non-selected blocks in each affected column
    if(dragSession.multiCol){
      for(const dKey of Object.keys(dragSession.multiCol)){
        const d = Number(dKey);
        const cs = dragSession.multiCol[d];
        if(!cs.lastPos) continue;
        const arr = wk.days[d] || [];
        Object.keys(cs.lastPos).forEach(id=>{
          const b = arr.find(x=>x.id === id);
          if(b) b.y = Math.max(BODY_PAD, cs.lastPos[id]);
        });
      }
    }

    clearSelection();
    resetDragSession();
    save(); renderAll();
    return;
  }
  let block;
  if(payload.kind === 'move'){
    const srcArr = wk.days[payload.srcDay] || [];
    const idx = srcArr.findIndex(b => b.id === payload.blockId);
    if(idx < 0) return;
    [block] = srcArr.splice(idx, 1);
  } else {
    if(!wk.habits.some(h => h.id === payload.habitId)) return;
    block = {id:uid(), habitId:payload.habitId, participantId:payload.participantId||null, note:''};
  }
  block.y = Math.max(BODY_PAD, snappedY);
  wk.days[dstDay].push(block);
  Object.keys(computedMap).forEach(id => {
    const b = wk.days[dstDay].find(x => x.id === id);
    if(b && b.id !== block.id) b.y = Math.max(BODY_PAD, computedMap[id]);
  });
  resetDragSession();
  save(); renderAll();
}

// week nav
document.getElementById('prevWeek').onclick=()=>{ const m=new Date(getMonday(currentWeek)); m.setDate(m.getDate()-7); currentWeek=isoWeekKey(m); renderAll() };
document.getElementById('nextWeek').onclick=()=>{ const m=new Date(getMonday(currentWeek)); m.setDate(m.getDate()+7); currentWeek=isoWeekKey(m); renderAll() };
document.getElementById('thisWeek').onclick=()=>{ currentWeek=isoWeekKey(new Date()); renderAll() };

// drawer
const drawer=document.getElementById('drawer'); const drawerMask=document.getElementById('drawerMask');
function openDrawer(){ drawer.classList.add('open'); drawerMask.classList.remove('hidden'); drawer.setAttribute('aria-hidden','false'); renderLibrary() }
function closeDrawer(){ drawer.classList.remove('open'); drawerMask.classList.add('hidden'); drawer.setAttribute('aria-hidden','true') }
document.getElementById('toggleDrawer').onclick=()=>{ drawer.classList.contains('open')?closeDrawer():openDrawer() };
document.getElementById('closeDrawer').onclick=closeDrawer;
drawerMask.onclick=closeDrawer;

// seed
function seedIfEmpty(){
  if(state.library.length===0){
    state.library=[
      {id:uid(),name:'跑步',type:'min',target:3},
      {id:uid(),name:'吃甜品',type:'max',target:3},
      {id:uid(),name:'读书',type:'min',target:4}
    ];
    save();
  }
}

function renderAll(){
  if(currentView === 'month'){
    renderMonthView();
    return;
  }
  const cal = document.getElementById('calendar');
  const suppress = suppressPlacementAnimation || !_initialRenderDone;
  if(cal) cal.classList.toggle('no-drop-anim', suppress);
  renderPeople(); renderCopyPrevButton(); renderHabitCards(); renderLibrary(); renderCalendar();
  applySelectionStyles();
  requestAnimationFrame(resolveAllOverlaps);
  requestAnimationFrame(()=>{
    requestAnimationFrame(()=>{
      suppressSourceReveal = false;
      suppressPlacementAnimation = false;
      _initialRenderDone = true;
      document.getElementById('calendar')?.classList.remove('no-drop-anim');
    });
  });
  // iOS Safari sometimes reports stale layout values inside rAF — schedule one more pass
  // after the layout has truly settled so blocks and dividers line up at their final canvasH.
  setTimeout(() => {
    if(currentView !== 'week') return;
    if(window.LoopinMobile && window.LoopinMobile.isMobile()) resolveAllOverlaps();
  }, 300);
}

// ===== view switching + month view =====
let currentView = 'week';
let currentMonth = (function(){ const d = new Date(); d.setDate(1); d.setHours(0,0,0,0); return d })();

function setView(v){
  currentView = v;
  const isMonth = (v === 'month');
  document.getElementById('sidebarWeek').classList.toggle('hidden', isMonth);
  document.getElementById('sidebarMonth').classList.toggle('hidden', !isMonth);
  document.getElementById('weekArea').classList.toggle('hidden', isMonth);
  document.getElementById('monthArea').classList.toggle('hidden', !isMonth);
  document.getElementById('weekNav').classList.toggle('hidden', isMonth);
  document.getElementById('monthNav').classList.toggle('hidden', !isMonth);
  document.getElementById('viewWeekBtn').classList.toggle('active', !isMonth);
  document.getElementById('viewMonthBtn').classList.toggle('active', isMonth);
  document.getElementById('viewWeekBtnMobile')?.classList.toggle('active', !isMonth);
  document.getElementById('viewMonthBtnMobile')?.classList.toggle('active', isMonth);
  renderAll();
}

function fmtMonthLabel(d){ return `${d.getFullYear()}年${d.getMonth()+1}月` }
function fmtShortDate(d){ return `${d.getMonth()+1}/${d.getDate()}` }

function renderMonthView(){
  renderLibraryInMonthSidebar();
  document.getElementById('monthLabel').textContent = fmtMonthLabel(currentMonth);
  const now = new Date();
  const isCurMonth = currentMonth.getFullYear() === now.getFullYear() && currentMonth.getMonth() === now.getMonth();
  document.getElementById('thisMonth').classList.toggle('is-current', isCurMonth);
  const grid = document.getElementById('monthGrid');
  grid.innerHTML = '';

  const firstOfMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1);
  const lastOfMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth()+1, 0);
  let mon = startOfWeek(firstOfMonth);
  const lastMon = startOfWeek(lastOfMonth);
  const todayKey = isoWeekKey(new Date());

  while(mon <= lastMon){
    const key = isoWeekKey(mon);
    const sun = new Date(mon); sun.setDate(sun.getDate()+6);
    const habits = (state.weeks[key] && state.weeks[key].habits) || [];

    const row = document.createElement('div');
    row.className = 'mw-row';
    if(key === todayKey) row.classList.add('today');
    row.dataset.weekKey = key;
    const todayTag = key === todayKey ? ' <span class="today-tag">本周</span>' : '';
    row.innerHTML = `
      <div class="mw-head">
        <div class="mw-label">${fmtShortDate(mon)} – ${fmtShortDate(sun)}${todayTag}</div>
        <button class="mw-open">查看周详情 ›</button>
      </div>
      <div class="mw-habits"></div>
    `;
    const habitsEl = row.querySelector('.mw-habits');
    habits.forEach(h=>{
      const chip = document.createElement('div');
      chip.className = 'mw-habit t-' + h.type;
      chip.innerHTML = `<span class="mw-name">${escapeHtml(h.name)}</span><span class="mw-rule">${h.type==='min'?'≥':'≤'} ${h.target}</span><button class="mw-del" title="移除">×</button>`;
      chip.querySelector('.mw-del').onclick = (e)=>{
        e.stopPropagation();
        if(state.weeks[key]){
          // also clean up blocks that reference this habit
          state.weeks[key].habits = state.weeks[key].habits.filter(x=>x.id!==h.id);
          Object.keys(state.weeks[key].days||{}).forEach(d=>{
            state.weeks[key].days[d] = state.weeks[key].days[d].filter(b=>b.habitId !== h.id);
          });
        }
        save(); renderMonthView();
      };
      habitsEl.appendChild(chip);
    });

    row.addEventListener('dragover', e=>{
      if(e.dataTransfer.types.includes('application/x-loopin-lib')){
        e.preventDefault();
        row.classList.add('drag-over');
      }
    });
    row.addEventListener('dragleave', e=>{
      if(!row.contains(e.relatedTarget)) row.classList.remove('drag-over');
    });
    row.addEventListener('drop', e=>{
      const raw = e.dataTransfer.getData('application/x-loopin-lib');
      if(!raw) return;
      e.preventDefault();
      row.classList.remove('drag-over');
      let payload; try{ payload = JSON.parse(raw) }catch{ return }
      const t = state.library.find(x=>x.id === payload.id);
      if(!t) return;
      ensureWeek(key);
      const wk = state.weeks[key];
      if(wk.habits.some(h=>h.libId === t.id)){ toast('该周已添加'); return }
      wk.habits.push({id:uid(), libId:t.id, name:t.name, type:t.type, target:t.target});
      save(); renderMonthView();
    });

    row.querySelector('.mw-open').onclick = ()=>{
      currentWeek = key;
      try{ localStorage.setItem('loopin_last_week', key) }catch{}
      setView('week');
    };

    grid.appendChild(row);
    mon = new Date(mon); mon.setDate(mon.getDate()+7);
  }
}

function renderLibraryInMonthSidebar(){
  const wrap = document.getElementById('libraryListMonth');
  wrap.innerHTML = '';
  if(window.LoopinMobile && window.LoopinMobile.isMobile()) window.LoopinMobile.attachMouseDragScroll(wrap, 'y');
  state.library.forEach(t=>{
    const el = document.createElement('div');
    el.className = 'lib-card t-' + t.type;
    el.draggable = !window.LoopinMobile.isMobile();
    el.innerHTML = `
      <div class="swatch"></div>
      <div class="meta"><div class="name">${escapeHtml(t.name)}</div><div class="rule">${t.type==='min'?'至少':'最多'} ${t.target} 次/周</div></div>
      <button class="edit" title="编辑">✎</button>
      <button class="del" title="删除">×</button>
    `;
    el.querySelector('.edit').onclick = (e)=>{ e.stopPropagation(); editLibrary(t.id) };
    el.querySelector('.del').onclick = async (e) => {
      e.stopPropagation();
      if(!await window.appConfirm(`从习惯库删除「${t.name}」？已加到各周的习惯不受影响。`, { danger: true, okText: '删除' })) return;
      state.library = state.library.filter(x => x.id !== t.id);
      save(); renderLibraryInMonthSidebar(); renderLibrary();
    };
    el.addEventListener('dragstart', e=>{
      e.dataTransfer.effectAllowed='copy';
      e.dataTransfer.setData('application/x-loopin-lib', JSON.stringify({id:t.id}));
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', ()=>el.classList.remove('dragging'));
    if (window.LoopinMobile.isMobile()) {
      window.LoopinMobile.bindMobileTap(el, (e) => {
        if (e.target && e.target.closest && e.target.closest('.edit')) return;
        window.LoopinMobile.openWeekPicker(el, t);
      });
    }
    wrap.appendChild(el);
  });
}

document.getElementById('viewWeekBtn').onclick = ()=>setView('week');
document.getElementById('viewMonthBtn').onclick = ()=>setView('month');
document.getElementById('prevMonth').onclick = ()=>{
  currentMonth = new Date(currentMonth); currentMonth.setMonth(currentMonth.getMonth()-1);
  renderMonthView();
};
document.getElementById('nextMonth').onclick = ()=>{
  currentMonth = new Date(currentMonth); currentMonth.setMonth(currentMonth.getMonth()+1);
  renderMonthView();
};
document.getElementById('thisMonth').onclick = ()=>{
  currentMonth = new Date(); currentMonth.setDate(1); currentMonth.setHours(0,0,0,0);
  renderMonthView();
};
document.getElementById('addLibraryFromMonth').onclick = ()=>editLibrary(null);

document.getElementById('dividerBtn').onclick=()=>{
  const wk = ensureWeek(currentWeek);
  const divider = {id:uid(), y:getNextDividerY(wk)};
  wk.dividers.push(divider);
  wk.dividers.sort((a,b)=>a.y-b.y);
  const snapshot = snapshotDividerDrag(divider.id);
  const out = applyDividerPreview(snapshot, divider.y, 'insert');
  if(!out.ok){
    wk.dividers = wk.dividers.filter(d=>d.id !== divider.id);
    renderCalendar();
    toast('这个位置塞不下参考线，先把附近方块挪开');
    return;
  }
  save();
  renderCalendar();
  hideDividerSnapLine();
  toast('已添加分割线');
};

// box-selection wiring (bind once)
(function setupBoxSelection(){
  let dragSel = null;
  const cal = document.getElementById('calendar');
  cal.addEventListener('mousedown', e=>{
    if(e.button !== 0) return;
    // Skip if pressing on a block, day header, popover, etc.
    if(e.target.closest('.block')) return;
    if(e.target.closest('.divider-line')) return;
    if(e.target.closest('.head')) return;
    if(e.target.closest('.popover')) return;
    if(e.target.closest('.modal-backdrop')) return;
    const calRect = cal.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const boxEl = document.createElement('div');
    boxEl.className = 'select-box';
    cal.appendChild(boxEl);
    if(!e.shiftKey && !e.ctrlKey && !e.metaKey) clearSelection();
    dragSel = {startX, startY, calRect, boxEl, moved:false};
    e.preventDefault();
  });
  document.addEventListener('mousemove', e=>{
    if(dividerDrag){
      const out = applyDividerPreview(dividerDrag.snapshot, getDividerYFromPointer(e.clientY), 'move');
      if(out.ok) dividerDrag.lastValidY = out.y;
      return;
    }
    if(!dragSel) return;
    const {startX, startY, calRect, boxEl} = dragSel;
    if(Math.abs(e.clientX - startX) > 2 || Math.abs(e.clientY - startY) > 2) dragSel.moved = true;
    const x = Math.min(startX, e.clientX), y = Math.min(startY, e.clientY);
    const w = Math.abs(e.clientX - startX), h = Math.abs(e.clientY - startY);
    boxEl.style.left = (x - calRect.left) + 'px';
    boxEl.style.top  = (y - calRect.top)  + 'px';
    boxEl.style.width  = w + 'px';
    boxEl.style.height = h + 'px';
  });
  document.addEventListener('mouseup', e=>{
    if(dividerDrag){
      applyDividerPreview(dividerDrag.snapshot, dividerDrag.lastValidY, 'move');
      save();
      renderCalendar();
      hideDividerSnapLine();
      dividerDrag = null;
      return;
    }
    if(!dragSel) return;
    const {startX, startY, boxEl, moved} = dragSel;
    dragSel = null;
    if(!moved){ boxEl.remove(); return }
    const x1 = Math.min(startX, e.clientX), y1 = Math.min(startY, e.clientY);
    const x2 = Math.max(startX, e.clientX), y2 = Math.max(startY, e.clientY);
    document.querySelectorAll('.calendar .block').forEach(el=>{
      const r = el.getBoundingClientRect();
      const inter = !(r.right < x1 || r.left > x2 || r.bottom < y1 || r.top > y2);
      if(inter){ selectedIds.add(el.dataset.bid); el.classList.add('selected') }
    });
    boxEl.remove();
  });
  document.addEventListener('keydown', e=>{
    if(e.key === 'Escape') clearSelection();
  });
})();

// ===== Boot: wait for auth, then sync the active group's data into `state` =====
function applyGroupData(remote, members){
  _applyingRemote = true;
  const migrated = _migrateState(remote || _freshState());
  // people come from group members (uid/name/emoji), not persisted in data.
  state.people = (members || []).map(m => ({ uid: m.uid, name: m.name, emoji: m.emoji, email: m.email }));
  // library is per-user (loopinLibrary/{uid}) — applied separately by LoopinLibrary.
  // If a legacy group still carries library inside its data, adopt it the first time
  // we encounter it so existing groups don't lose their habits before user-library is set.
  if(state.library.length === 0 && Array.isArray(migrated.library) && migrated.library.length){
    state.library = migrated.library;
    // Promote it to per-user storage.
    window.LoopinLibrary && window.LoopinLibrary.scheduleSave(state.library);
  }
  state.weeks = migrated.weeks;
  state.meta = migrated.meta;
  // Re-seed week keys map.
  isoWeekKey(new Date());
  const known = new Set(Object.keys(state.weeks));
  if(known.size){
    const base = startOfWeek(new Date());
    for(let i=-104;i<=104;i++){ const d=new Date(base); d.setDate(d.getDate()+i*7); isoWeekKey(d); }
  }
  let lastLocal = null;
  try{ lastLocal = localStorage.getItem('loopin_last_week') }catch{}
  currentWeek = lastLocal || isoWeekKey(new Date());
  if(!getMonday(currentWeek)) currentWeek = isoWeekKey(new Date());
  _applyingRemote = false;
  renderAll();
}

function applyUserLibrary(library){
  _applyingRemoteLib = true;
  // First-load case: library doc doesn't exist or is empty. Keep whatever is in state.library
  // (it may have just been promoted from a legacy group via applyGroupData). Seed defaults
  // for brand-new users.
  if(Array.isArray(library) && library.length){
    state.library = library;
  } else if(state.library.length === 0){
    seedIfEmpty();
  }
  _applyingRemoteLib = false;
  renderAll();
}

function bindMeBar(user){
  const av = document.getElementById('meAvatar');
  const nm = document.getElementById('meName');
  const em = document.getElementById('meEmail');
  if(!av) return;
  av.innerHTML = `<span class="me-emoji">${normalizeEmoji(user.emoji || '🙂')}</span><button class="me-dice" title="换个头像" aria-label="换个头像">🎲</button>`;
  av.querySelector('.me-dice').onclick = async (e) => {
    e.stopPropagation();
    const newE = await window.LoopinAuth.randomizeMyEmoji();
    if(newE) av.querySelector('.me-emoji').textContent = normalizeEmoji(newE);
  };
  nm.textContent = user.name || '我';
  em.textContent = user.email || '';
  document.getElementById('meMenuBtn').onclick = () => {
    const isMobileUA = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    const showInstall = isMobileUA && !isStandalone;
    const installBtn = showInstall ? `<button class="primary install-btn full" data-a="install">添加到桌面</button>` : '';
    const html = `
      <div class="me-menu-actions">
        ${installBtn}
        <button class="primary danger full" data-a="signout">退出登录</button>
      </div>`;
    openModal('账户', html, ()=>true, { hideOk: true });
    document.getElementById('modalBody').querySelectorAll('[data-a]').forEach(b=>{
      b.onclick = async ()=>{
        if(b.dataset.a==='signout') {
          document.getElementById('modalBackdrop').classList.add('hidden');
          window.LoopinAuth.signOutNow();
          return;
        }
        if(b.dataset.a==='install') {
          document.getElementById('modalBackdrop').classList.add('hidden');
          await promptInstallToHome();
        }
      };
    });
  };
}

window.toast = toast;
window.openModal = openModal;

window.LoopinAuth.onAuth((user) => {
  if(!user) {
    if(window.LoopinLibrary) window.LoopinLibrary.stop();
    return;
  }
  bindMeBar(user);
  window.LoopinLibrary.start(user.uid, (library) => {
    applyUserLibrary(library);
  });
  window.LoopinGroups.start(user, (group, data, members) => {
    applyGroupData(data, members);
  });
});

document.getElementById('inviteBtn').onclick = () => window.LoopinGroups.openInviteDialog();

// ===== Mobile tap-to-add interactions =====
const isMobile = () => window.innerWidth <= 820;


function _placePopover(anchor, pop){
  document.body.appendChild(pop);
  pop.style.visibility = 'hidden';
  requestAnimationFrame(() => {
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = r.left + (r.width - pw) / 2;
    left = Math.max(8, Math.min(left, vw - pw - 8));
    let top = r.bottom + 6;
    if (top + ph > vh - 8) top = Math.max(8, r.top - ph - 6);
    pop.style.left = (window.scrollX + left) + 'px';
    pop.style.top = (window.scrollY + top) + 'px';
    pop.style.visibility = '';
  });
  setTimeout(() => document.addEventListener('click', function off(ev){
    if (!pop.contains(ev.target)) { pop.remove(); document.removeEventListener('click', off); }
  }), 0);
}

function _appendBlockToDay(habit, person, dayIdx){
  const wk = ensureWeek(currentWeek);
  const arr = wk.days[dayIdx] || (wk.days[dayIdx] = []);
  const nextY = arr.reduce((m, b) => Math.max(m, (b.y || 0) + 40), 8);
  const sampleBody = document.querySelector('.calendar .day .body');
  const canvasH = (sampleBody && sampleBody.clientHeight > 50) ? sampleBody.clientHeight : (parseFloat(localStorage.getItem('loopin_canvas_h')) || 800);
  arr.push({ id: uid(), habitId: habit.id, participantId: person ? person.uid : null, note: '', y: nextY, frac: nextY / canvasH });
  save(); renderAll();
  toast(`已添加到 ${DOW_CN[dayIdx]}`);
}

function openPersonPicker(anchor, habit, dayIdx){
  document.querySelectorAll('.popover').forEach(p => p.remove());
  const pop = document.createElement('div'); pop.className = 'popover person-picker';
  const head = document.createElement('div'); head.className = 'pop-head';
  head.textContent = `${habit.name} · ${DOW_CN[dayIdx]} · 谁打卡？`;
  pop.appendChild(head);
  state.people.forEach(p => {
    const row = document.createElement('div'); row.className = 'opt person-opt';
    row.innerHTML = `<span class="av av-emoji">${normalizeEmoji(p.emoji)}</span><span class="nm">${escapeHtml(p.name)}</span>`;
    row.onclick = (e) => {
      e.stopPropagation();
      pop.remove();
      _appendBlockToDay(habit, p, dayIdx);
    };
    pop.appendChild(row);
  });
  const sep = document.createElement('div'); sep.className = 'divider'; pop.appendChild(sep);
  const un = document.createElement('div'); un.className = 'opt person-opt';
  un.innerHTML = `<span class="av av-emoji">?</span><span class="nm">未分配</span>`;
  un.onclick = (e) => {
    e.stopPropagation();
    pop.remove();
    _appendBlockToDay(habit, null, dayIdx);
  };
  pop.appendChild(un);
  _placePopover(anchor, pop);
}

function openDayPicker(anchor, habit, person){
  document.querySelectorAll('.popover').forEach(p => p.remove());
  const monday = getMonday(currentWeek);
  const todayKey = isoWeekKey(new Date());
  const todayDow = (new Date().getDay() + 6) % 7;
  const pop = document.createElement('div'); pop.className = 'popover day-picker';
  const head = document.createElement('div'); head.className = 'pop-head';
  head.textContent = `${habit.name} · ${person ? person.name : '选择'} · 选择哪天打卡`;
  pop.appendChild(head);
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday); d.setDate(monday.getDate() + i);
    const isToday = (currentWeek === todayKey && i === todayDow);
    const row = document.createElement('div'); row.className = 'opt day-opt' + (isToday ? ' today' : '');
    row.innerHTML = `<span class="dow">${DOW_CN[i]}</span><span class="date">${d.getMonth()+1}/${d.getDate()}</span>${isToday ? '<span class="today-tag">今天</span>' : ''}`;
    row.onclick = (e) => {
      e.stopPropagation();
      pop.remove();
      // If no person preselected and multiple members exist, ask who.
      if (!person && state.people.length > 1) {
        openPersonPicker(anchor, habit, i);
      } else {
        const p = person || (state.people.length === 1 ? state.people[0] : null);
        _appendBlockToDay(habit, p, i);
      }
    };
    pop.appendChild(row);
  }
  _placePopover(anchor, pop);
}

function openWeekPicker(anchor, libItem){
  document.querySelectorAll('.popover').forEach(p => p.remove());
  const pop = document.createElement('div'); pop.className = 'popover week-picker';
  const head = document.createElement('div'); head.className = 'pop-head';
  head.textContent = `加入哪一周：${libItem.name}`;
  pop.appendChild(head);
  // Show the visible weeks of the currently-displayed month.
  const first = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1);
  const last = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0);
  const seen = new Set();
  let cur = new Date(first);
  const todayKey = isoWeekKey(new Date());
  while (cur <= last) {
    const key = isoWeekKey(cur);
    if (!seen.has(key)) {
      seen.add(key);
      const mon = getMonday(key);
      const sun = new Date(mon); sun.setDate(sun.getDate() + 6);
      const wk = state.weeks[key];
      const already = wk && wk.habits && wk.habits.some(h => h.libId === libItem.id);
      const row = document.createElement('div'); row.className = 'opt week-opt' + (key === todayKey ? ' today' : '');
      row.innerHTML = `<span class="rng">${mon.getMonth()+1}/${mon.getDate()} – ${sun.getMonth()+1}/${sun.getDate()}</span>${key === todayKey ? '<span class="today-tag">本周</span>' : ''}${already ? '<span class="dim">已加入</span>' : ''}`;
      if (already) row.classList.add('disabled');
      else row.onclick = (e) => {
        e.stopPropagation();
        pop.remove();
        ensureWeek(key);
        const w = state.weeks[key];
        w.habits.push({ id: uid(), libId: libItem.id, name: libItem.name, type: libItem.type, target: libItem.target });
        save(); renderAll();
        toast(`已加入 ${mon.getMonth()+1}/${mon.getDate()} 那周`);
      };
      pop.appendChild(row);
    }
    cur.setDate(cur.getDate() + 1);
  }
  _placePopover(anchor, pop);
}

// Bind a tap that fires ONLY when the user releases without swiping more than ~8 px.
// This preserves native swipe-to-scroll on touch surfaces while still letting taps trigger an action.
function bindMobileTap(el, fn){
  let sx = 0, sy = 0, moved = false, lastTouchAt = 0;
  el.addEventListener('touchstart', (e) => {
    if(e.touches.length !== 1) return;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; moved = false;
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if(moved || e.touches.length !== 1) return;
    if(Math.abs(e.touches[0].clientX - sx) > 8 || Math.abs(e.touches[0].clientY - sy) > 8) moved = true;
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    lastTouchAt = Date.now();
    if(!moved) fn(e);
  });
  // Mouse / emulator fallback. Skip if we just handled the same gesture via touchend.
  el.addEventListener('click', (e) => {
    if(Date.now() - lastTouchAt < 500) return;
    fn(e);
  });
}

// Mouse-drag-to-scroll: makes the list scrollable by clicking-and-dragging when the user is on a
// non-touch device emulating mobile width (e.g. Chrome DevTools without touch emulation, narrow desktop
// window). On real touch devices this is a no-op because pointerType === 'touch' is filtered out.
function attachMouseDragScroll(container, orient){
  if(!container || container._mdsAttached) return;
  container._mdsAttached = true;
  let dragging = false, startPos = 0, startScroll = 0, moved = false;
  container.addEventListener('pointerdown', (e) => {
    if(e.pointerType !== 'mouse') return;
    if(e.button !== 0) return;
    if(e.target.closest('button, .edit, .ic, input, a')) return;
    dragging = true; moved = false;
    startPos = orient === 'x' ? e.clientX : e.clientY;
    startScroll = orient === 'x' ? container.scrollLeft : container.scrollTop;
    container.style.cursor = 'grabbing';
  });
  container.addEventListener('pointermove', (e) => {
    if(!dragging) return;
    const delta = (orient === 'x' ? e.clientX : e.clientY) - startPos;
    if(Math.abs(delta) > 3) moved = true;
    if(orient === 'x') container.scrollLeft = startScroll - delta;
    else container.scrollTop = startScroll - delta;
  });
  const stop = () => { dragging = false; container.style.cursor = ''; };
  container.addEventListener('pointerup', stop);
  container.addEventListener('pointercancel', stop);
  container.addEventListener('pointerleave', stop);
  // Suppress the synthetic click on the child when the user actually dragged.
  container.addEventListener('click', (e) => {
    if(moved){ e.stopPropagation(); e.preventDefault(); moved = false; }
  }, true);
}

window.LoopinMobile = { isMobile, openDayPicker, openWeekPicker, bindMobileTap, attachMouseDragScroll };

// Month-view library: drag handle to resize sidebar height on mobile.
(function bindMonthSidebarResize(){
  const handle = document.getElementById('monthSidebarResize');
  const sb = document.getElementById('sidebarMonth');
  if(!handle || !sb) return;
  const LS_KEY = 'loopin_month_sb_h';
  let startY = 0, startH = 0, active = false;

  function clamp(h){
    const min = 120;
    const max = Math.round(window.innerHeight * 0.85);
    return Math.max(min, Math.min(max, h));
  }
  function applyHeight(h){
    const v = clamp(h);
    sb.style.height = v + 'px';
  }
  function restore(){
    if(window.innerWidth > 820) return;
    const saved = parseInt(localStorage.getItem(LS_KEY) || '', 10);
    if(saved > 0) applyHeight(saved);
  }
  function onStart(y){
    if(window.innerWidth > 820) return false;
    active = true;
    startY = y;
    startH = sb.getBoundingClientRect().height;
    sb.classList.add('resizing');
    document.body.style.userSelect = 'none';
    return true;
  }
  function onMove(y){
    if(!active) return;
    const dy = startY - y; // dragging up increases height
    applyHeight(startH + dy);
  }
  function onEnd(){
    if(!active) return;
    active = false;
    sb.classList.remove('resizing');
    document.body.style.userSelect = '';
    const h = parseInt(sb.style.height, 10);
    if(h > 0) localStorage.setItem(LS_KEY, String(h));
  }

  handle.addEventListener('touchstart', (e) => {
    if(e.touches.length !== 1) return;
    onStart(e.touches[0].clientY);
  }, { passive: true });
  handle.addEventListener('touchmove', (e) => {
    if(!active || e.touches.length !== 1) return;
    onMove(e.touches[0].clientY);
    e.preventDefault();
  }, { passive: false });
  handle.addEventListener('touchend', onEnd);
  handle.addEventListener('touchcancel', onEnd);

  handle.addEventListener('mousedown', (e) => {
    if(!onStart(e.clientY)) return;
    e.preventDefault();
    const mm = (ev) => onMove(ev.clientY);
    const mu = () => {
      onEnd();
      document.removeEventListener('mousemove', mm);
      document.removeEventListener('mouseup', mu);
    };
    document.addEventListener('mousemove', mm);
    document.addEventListener('mouseup', mu);
  });

  restore();
  window.addEventListener('resize', () => {
    if(window.innerWidth > 820) sb.style.height = '';
    else restore();
  });
})();

// Week-habit bottom sheet (mobile): collapsed = strip + me-bar; expanded covers ~half the calendar.
(function bindWeekStripToggle(){
  const btn = document.getElementById('weekStripToggle');
  const sb = document.getElementById('sidebarWeek');
  if (!btn || !sb) return;
  btn.onclick = (e) => {
    e.stopPropagation();
    const expanded = sb.classList.toggle('expanded');
    btn.textContent = expanded ? '收起' : '展开';
  };
})();

// Mobile action-bar proxy buttons: just trigger the existing desktop handlers.
(function bindMobileActionbar(){
  const click = (id, fn) => { const b = document.getElementById(id); if (b) b.onclick = fn; };
  click('inviteBtnMobile', () => document.getElementById('inviteBtn').click());
  click('toggleDrawerMobile', () => document.getElementById('toggleDrawer').click());
  click('viewWeekBtnMobile', () => document.getElementById('viewWeekBtn').click());
  click('viewMonthBtnMobile', () => document.getElementById('viewMonthBtn').click());
})();

// Auto-hide scrollbars: toggle `.scrolling` while the user is actively scrolling so CSS can fade the thumb in/out.
(function bindAutoHideScrollbars(){
  const ids = ['habitCards', 'libraryListMonth', 'libraryList', 'monthGrid'];
  const bind = (el) => {
    if(!el || el._autoHideBound) return;
    el._autoHideBound = true;
    let t = null;
    el.addEventListener('scroll', () => {
      el.classList.add('scrolling');
      clearTimeout(t);
      t = setTimeout(() => el.classList.remove('scrolling'), 800);
    }, { passive: true });
  };
  ids.forEach(id => bind(document.getElementById(id)));
})();

// Mobile sidebar toggle.
(function bindSidebarToggle(){
  const toggle = document.getElementById('sidebarToggle');
  const mask = document.getElementById('sidebarMask');
  function openSide(){ document.body.classList.add('sidebar-open'); mask.classList.remove('hidden'); }
  function closeSide(){ document.body.classList.remove('sidebar-open'); mask.classList.add('hidden'); }
  if(toggle) toggle.onclick = () => {
    if(document.body.classList.contains('sidebar-open')) closeSide(); else openSide();
  };
  if(mask) mask.onclick = closeSide;
})();
