// Per-user habit library: shared across all of the user's groups.
// Stored at loopinLibrary/{uid}.library (array of {id,name,type,target}).
window.LoopinLibrary = (function () {
  let unsubLib = null;
  let saveTimer = null;
  let suppressNextSnap = false;
  let onLibraryCb = null;
  let ready = false;
  let cached = [];

  async function start(uid, onLibrary) {
    onLibraryCb = onLibrary;
    const { db, doc, onSnapshot } = window.fb;
    if (unsubLib) { unsubLib(); unsubLib = null; }
    ready = false;
    unsubLib = onSnapshot(doc(db, 'loopinLibrary', uid), (snap) => {
      if (suppressNextSnap) { suppressNextSnap = false; ready = true; return; }
      const lib = (snap.exists() && Array.isArray(snap.data().library)) ? snap.data().library : [];
      cached = lib;
      ready = true;
      onLibraryCb && onLibraryCb(lib);
    });
  }

  function stop() { if (unsubLib) { unsubLib(); unsubLib = null; } cached = []; ready = false; }

  function scheduleSave(library) {
    const user = window.LoopinAuth?.getUser();
    if (!user) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const { db, doc, setDoc } = window.fb;
      try {
        suppressNextSnap = true;
        await setDoc(doc(db, 'loopinLibrary', user.uid), {
          library, updatedAt: Date.now()
        }, { merge: true });
      } catch (e) {
        suppressNextSnap = false;
        console.error('保存习惯库失败:', e);
      }
    }, 500);
  }

  function isReady() { return ready; }

  return { start, stop, scheduleSave, isReady };
})();
