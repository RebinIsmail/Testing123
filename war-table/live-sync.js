/* Middle-earth War Table live-sync adapter.
 * Requires ./live-config.js and Supabase's browser client library.
 * When unconfigured, the original local-only tracker remains functional.
 */
(() => {
  'use strict';
  const config = window.WOTR_SYNC_CONFIG || {};
  const mode = document.getElementById('liveStatus');
  const createButton = document.getElementById('createRoomBtn');
  const shareButton = document.getElementById('shareRoomBtn');
  const reloadButton = document.getElementById('reloadRoomBtn');
  const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(config.url || '') &&
    typeof config.publishableKey === 'string' && config.publishableKey.length > 12 &&
    !!window.supabase?.createClient;
  const status = msg => { if (mode) mode.textContent = msg; };
  if (!configured) {
    status('Local only · live database not connected');
    return;
  }
  const client = window.supabase.createClient(config.url, config.publishableKey, {
    auth: { persistSession:true, autoRefreshToken:true, detectSessionInUrl:false }
  });
  const originalSave = save;
  let roomId = null, roomKey = null, revision = null;
  let saving = false, dirty = false, applying = false, conflict = false, reading = false, authOk = false;
  let lastSavedSnapshot = null;
  const credentials = () => ({p_room_id:roomId, p_room_key:roomKey});
  const showError = e => { status('Sync error · changes kept locally'); console.error('Live sync error:',e); };
  function setControls() {
    if (createButton) createButton.hidden = !!roomId;
    if (shareButton) shareButton.hidden = !roomId;
    if (reloadButton) reloadButton.hidden = !roomId;
  }
  function updateFragment() {
    const params = new URLSearchParams();
    params.set('room', roomId);
    params.set('key', roomKey);
    history.replaceState(null, '', location.pathname + location.search + '#' + params);
  }
  async function authenticate() {
    // Shared rooms are protected by a random, unguessable room key in the URL fragment.
    // Room RPCs explicitly grant the anon role access only through validated server functions.
    // No anonymous Auth provider needs to be enabled.
    authOk = true;
  }
  async function readRoom() {
    if (!roomId || !authOk) return null;
    const {data, error} = await client.rpc('wotr_get_room', credentials());
    if (error) throw error;
    if (!data || !Number.isFinite(Number(data.revision)) || !data.game_state?.regions) {
      throw Error('Unexpected response from game-room backend');
    }
    return data;
  }
  function showSharedStatus() {
    status(conflict ? 'Edit conflict · review before continuing'
      : dirty || saving ? 'Saving to shared board…'
      : 'Shared room · synced · revision ' + revision);
  }
  async function openSharedRoom() {
    if (reading) return;
    reading = true;
    status('Loading shared board…');
    try {
      const data = await readRoom();
      if (!data) throw Error('Room not available');
      if (dirty || saving) throw Error('Local edit is being saved');
      applying = true;
      state = structuredClone(data.game_state);
      revision = Number(data.revision);
      lastSavedSnapshot = JSON.stringify(state);
      originalSave();
      applying = false;
      conflict = false;
      dirty = false;
      showSharedStatus();
    } catch(e) {
      applying = false;
      showError(e);
    } finally {reading = false;}
  }
  async function flush() {
    if (!authOk || !roomId || saving || !dirty || conflict || reading) return;
    saving = true;
    dirty = false;
    showSharedStatus();
    const snapshot = structuredClone(state);
    try {
      const {data,error} = await client.rpc('wotr_save_room', {
        ...credentials(),
        p_expected_revision:revision,
        p_game_state:snapshot
      });
      if (error) throw error;
      if (data?.status === 'conflict') {
        conflict = true;
        dirty = true;
        status('Conflict · another browser changed the board');
        toast('Another browser updated the board. Copy for ChatGPT or review before reloading.');
        return;
      }
      if (data?.status !== 'saved') throw Error('Unexpected server save response');
      revision = Number(data.revision);
      lastSavedSnapshot = JSON.stringify(snapshot);
      showSharedStatus();
    } catch(e) {
      dirty = true;
      showError(e);
    } finally {
      saving = false;
      if (dirty && !conflict && navigator.onLine) {
        // Retry only on the next polling tick; do not spin on network errors.
        showSharedStatus();
      }
    }
  }
  save = function() {
    originalSave();
    if (applying || !roomId) return;
    dirty = true;
    showSharedStatus();
    void flush();
  };
  if (createButton) createButton.addEventListener('click', async () => {
    if (roomId || !authOk) return;
    createButton.disabled = true;
    status('Creating shared room…');
    try {
      const {data,error} = await client.rpc('wotr_create_room', {
        p_initial_state:state
      });
      if (error) throw error;
      if (!data?.room_id || !data?.room_key) throw Error('Invalid room response');
      roomId = data.room_id;
      roomKey = data.room_key;
      revision = Number(data.revision || 1);
      lastSavedSnapshot = JSON.stringify(state);
      updateFragment();
      setControls();
      showSharedStatus();
      toast('Room created. Use Copy room link to invite the other player.');
    } catch(e) {
      showError(e);
    } finally {createButton.disabled = false;}
  });
  if (shareButton) shareButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast('Shared room link copied.');
    } catch(e) {
      prompt('Copy your private shared-room link:',location.href);
    }
  });
  if (reloadButton) reloadButton.addEventListener('click', async () => {
    if ((dirty || conflict) && !confirm('Discard unsynced local edits and use the current shared board?')) return;
    dirty = false; conflict = false;
    await openSharedRoom();
  });
  async function poll() {
    if (!authOk || !roomId || reading || saving || conflict) return;
    if (dirty) { await flush(); return;}
    reading = true;
    try {
      const localBefore = JSON.stringify(state);
      const data = await readRoom();
      if (!data || saving || dirty || conflict || localBefore !== JSON.stringify(state)) return;
      if (Number(data.revision) <= revision) return;
      applying = true;
      state = structuredClone(data.game_state);
      revision = Number(data.revision);
      lastSavedSnapshot = JSON.stringify(state);
      originalSave();
      applying = false;
      showSharedStatus();
    } catch(e) {
      applying = false;
      showError(e);
    } finally { reading = false; }
  }
  (async () => {
    try {
      status('Connecting to shared database…');
      await authenticate();
      const hash = new URLSearchParams(location.hash.slice(1));
      roomId = hash.get('room');
      roomKey = hash.get('key');
      if (roomId && roomKey) {
        setControls();
        await openSharedRoom();
      } else {
        roomId = null; roomKey = null;
        setControls();
        status('Local board · create a shared room to sync');
      }
      setInterval(() => {void poll();},2500);
      window.addEventListener('online', () => {void poll();});
    } catch(e) {
      roomId = null;
      setControls();
      showError(e);
      toast('Live database sign-in failed. The local tracker still works.');
    }
  })();
})();