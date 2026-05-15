// Auth: Google sign-in, user doc creation, share `users` collection with CollabSync.
window.LoopinAuth = (function () {
  let currentUser = null;       // { uid, name, email, emoji }
  let authReady = false;
  const listeners = [];

  function onAuth(fn) { listeners.push(fn); if (authReady) fn(currentUser); }
  function emit() { listeners.forEach(fn => { try { fn(currentUser); } catch (e) { console.warn(e); } }); }

  async function init() {
    const fb = window.fb;
    const { auth, db, doc, getDoc, setDoc, getRedirectResult, onAuthStateChanged } = fb;

    try { await getRedirectResult(auth); } catch (e) { console.warn('redirect result:', e); }

    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        currentUser = null;
        authReady = true;
        localStorage.removeItem('loopin_signed_in');
        document.documentElement.classList.remove('auth-pending');
        showLogin();
        emit();
        return;
      }
      localStorage.setItem('loopin_signed_in', '1');
      document.documentElement.classList.remove('auth-pending');
      // User doc is shared with CollabSync. Loopin uses its own `loopinEmoji` field so
      // each app keeps an independent avatar; CollabSync continues to use `emoji`.
      const ref = doc(db, 'users', user.uid);
      const snap = await getDoc(ref);
      let data = snap.exists() ? snap.data() : null;
      if (!data) {
        const first = pickRandomEmoji();
        data = {
          uid: user.uid,
          name: user.displayName || user.email?.split('@')[0] || '用户',
          email: user.email,
          emoji: first,
          loopinEmoji: first,
          createdAt: Date.now()
        };
        await setDoc(ref, data);
      } else if (!data.loopinEmoji) {
        // First Loopin visit for an existing user — seed loopinEmoji from their collab emoji
        // (or a fresh random) without touching `emoji` itself.
        const seed = data.emoji || pickRandomEmoji();
        data.loopinEmoji = seed;
        await setDoc(ref, { loopinEmoji: seed }, { merge: true });
      }
      // Loopin code reads `userData.emoji` — point it at loopinEmoji so the rest of the
      // app doesn't need to know about the distinction.
      data.emoji = data.loopinEmoji;
      data.uid = user.uid;
      currentUser = data;
      authReady = true;
      hideLogin();
      emit();
    });

    document.getElementById('googleSignInBtn').onclick = async () => {
      const { signInWithPopup, signInWithRedirect, googleProvider } = fb;
      try {
        await signInWithPopup(auth, googleProvider);
      } catch (err) {
        // Fallback to redirect for browsers that block popups.
        console.warn('popup failed, falling back to redirect:', err?.code);
        try { await signInWithRedirect(auth, googleProvider); } catch (e2) { (window.appAlert || alert)('登录失败：' + (e2?.code || e2?.message)); }
      }
    };
  }

  function showLogin() {
    document.getElementById('loginOverlay').classList.remove('hidden');
    document.getElementById('groupPickerOverlay').classList.add('hidden');
    document.getElementById('topbar').classList.add('hidden');
    document.getElementById('mainArea').classList.add('hidden');
  }
  function hideLogin() {
    document.getElementById('loginOverlay').classList.add('hidden');
  }

  async function signOutNow() {
    const { auth, signOut } = window.fb;
    localStorage.removeItem('loopin_signed_in');
    await signOut(auth);
    location.reload();
  }

  async function randomizeMyEmoji() {
    if (!currentUser) return;
    const { db, doc, updateDoc } = window.fb;
    const next = pickRandomEmoji();
    currentUser.loopinEmoji = next;
    currentUser.emoji = next;
    try {
      await updateDoc(doc(db, 'users', currentUser.uid), { loopinEmoji: next });
    } catch (e) {
      console.error('保存头像失败:', e);
    }
    emit();
    return next;
  }

  function getUser() { return currentUser; }

  // Wait for fb-ready, then init.
  if (window.fb) init();
  else window.addEventListener('fb-ready', init, { once: true });

  return { onAuth, getUser, signOutNow, randomizeMyEmoji };
})();
