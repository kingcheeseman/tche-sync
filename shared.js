(function(){
  "use strict";

  // ========== CONFIG ==========
  const TEAM_TAG = "IMT";
  const TEAM_NAME = "Immortals III";
  const NT_API = (tag) => `https://www.nitrotype.com/api/v2/teams/${encodeURIComponent(tag)}`;
  const NT_TEAM_URL = (tag) => `https://www.nitrotype.com/team/${encodeURIComponent(tag)}`;
  const NT_RACER_URL = (user) => `https://www.nitrotype.com/racer/${encodeURIComponent(user)}`;
  // Data lives in ./data/*.json (same-origin — GitHub Pages serves repo root).
  // GitHub Actions keeps data/ fresh every 15 min.
  const DATA_BASE = "./data";
  const GITHUB_REPO = "kingcheeseman/tche-sync";
  // Firebase Realtime DB — shared reactions store (free tier).
  const FIREBASE_URL = "https://imt-dashboard-cd8eb-default-rtdb.firebaseio.com";
  const REACTIONS_POLL_MS = 15000;
  const GITHUB_EDIT = (file) => `https://github.com/${GITHUB_REPO}/edit/main/${file}`;
  const SYNC_INTERVAL_MS = 5 * 60 * 1000; // re-poll data/*.json every 5 min
  // Admin password hash — SHA-256 of the password. To change, hash the new one
  // and update here (then commit). The site is static, so client-side auth only
  // protects local features on this browser.
  const ADMIN_USERNAME = "admin";
  const ADMIN_PW_HASH = "3648bca86d68192ab88204c1cdaefd0be24e3bacbb5b002c6aefa8e8228ab101";
  const STALE_MS = 15 * 60 * 1000;
  const PAGES = {
    home: "index.html",
    stats: "stats.html",
    racers: "racers.html",
    activity: "activity.html",
    competitions: "competitions.html",
    tournament: "tournament.html",
    allies: "allies.html",
    showdown: "showdown.html",
    notifications: "notifications.html",
    info: "info.html",
  };
  const LABELS = {
    home: "Home",
    stats: "Team Stats",
    racers: "Racers",
    activity: "Activity",
    competitions: "Competitions",
    tournament: "Tournament",
    allies: "Allies",
    showdown: "Showdown",
    notifications: "Notifications",
    info: "Info",
  };

  // ========== STATE ==========
  const state = {
    db: null,
    user: null,
    mcp: null,
    browserServer: null,
    team: null,
    startrack: null,
    comps: null,
    seasons: null,
    selectedSeason: null,
    tournament: null,       // { tournaments: [...], _syncedAt } — every tournament the team has a bracket in
    selectedTournamentId: null,
    tournamentRoundIdx: null,
    weekly: null,          // per-racer weekly stats (Startrack)
    daily: null,           // per-racer 24h stats (Startrack)
    roster: null,          // squad/tier/role + thresholds (Startrack roster API)
    activity: null,        // hourly races per racer, last ~24h (Startrack)
    notifications: null,   // team event feed (new members, milestones, comps, tournament results)
    selectedRivalTag: null, // Showdown page: which ally tag is the current head-to-head opponent
    notes: {},             // notes/<username> → { text, updatedAt }
    pinnedNotice: null,    // settings/pinnedNotice doc
    history: [],           // history/YYYY-MM-DD list for charts
    allySeason: {},        // allySeason/<tag> → Startrack season data for ally
    compLeaderboards: {},  // compLeaderboards/<eventId> → racers[]
    compareIds: [],        // transient — selected usernames for comparison
    racerFilter: "all",    // "all", "recent-join", "recent-active", "inactive"
    racerSquadFilter: "all", // "all" or a squad name (from roster.json)
    seasons: {},        // keyed by season key
    currentSeasonKey: null,
    allies: [],
    allyData: {},
    info: { posts: [] },
    auth: null, // { username, pwHash }
    isAdmin: false,
    reactions: {}, // reactions/<target> → { "<emoji>": { "<userId>": ts } }
    myUserId: null,
    lastSync: null,
    syncError: null,
    page: "home",
    racerSort: { key: "wpm", dir: "desc" },
  };

  // ========== BOOT ==========
  function boot() {
    const root = document.getElementById("root");
    const page = (root && root.dataset.page) || "home";
    state.page = page;
    document.title = page === "home" ? `${TEAM_TAG} Dashboard` : `${TEAM_TAG} · ` + (LABELS[page] || "Racer");
    // Check admin from session
    try { state.isAdmin = sessionStorage.getItem("tcheAdmin") === "1"; } catch(_) {}
    // Build shell + initial empty render
    mountShell();
    render();
    initCaps();
  }

  function mountShell() {
    const body = document.body;
    // Header
    const header = document.createElement("header");
    header.className = "topbar";
    header.innerHTML = `
      <div class="wrap topbar-inner">
        <nav class="tabs" id="nav">
          ${Object.entries(LABELS).map(([k,v])=>`<a href="${PAGES[k]}" data-tab="${k}" ${k===state.page?'class="active"':''}>${v}</a>`).join("")}
        </nav>
        <div class="header-actions">
          <div class="sync-chip" id="sync-chip">
            <span class="sync-dot" id="sync-dot"></span>
            <span id="sync-text">Never synced</span>
          </div>
          <button class="btn primary btn-sm" id="sync-btn">Sync now</button>
          <span id="admin-slot"></span>
        </div>
      </div>`;
    body.insertBefore(header, body.firstChild);

    // Main container (root becomes main)
    const root = document.getElementById("root");
    const main = document.createElement("main");
    const wrap = document.createElement("div");
    wrap.className = "wrap";
    const view = document.createElement("div");
    view.id = "view";
    wrap.appendChild(view);
    main.appendChild(wrap);
    root.parentNode.insertBefore(main, root);
    root.remove();

    // Footer
    const foot = document.createElement("footer");
    foot.className = "foot";
    foot.innerHTML = `<div class="wrap">${TEAM_TAG} Dashboard · Data from nitrotype.com · Auto-syncs every 10 min while open</div>`;
    body.appendChild(foot);

    // Toast
    const toastEl = document.createElement("div");
    toastEl.className = "toast";
    toastEl.id = "toast";
    body.appendChild(toastEl);

    // Modal mount
    const modalMount = document.createElement("div");
    modalMount.id = "modal-mount";
    body.appendChild(modalMount);

    // Sync button
    document.getElementById("sync-btn").addEventListener("click", async () => {
      setSyncLoading && setSyncLoading(true);
      try { await loadFromGitHub(); render(); toast("Refreshed ✓"); }
      catch (e) { toast("Refresh failed: " + (e.message || e), 4000); }
      finally { setSyncLoading && setSyncLoading(false); }
    });
    updateSyncChip();
    updateAdminSlot();
  }

  function updateAdminSlot() {
    const slot = document.getElementById("admin-slot");
    if (!slot) return;
    if (state.isAdmin) {
      slot.innerHTML = `
        <span class="admin-chip">Admin</span>
        <button class="btn btn-sm ghost" id="admin-menu-btn" style="margin-left:6px;">Logout</button>
      `;
      document.getElementById("admin-menu-btn").addEventListener("click", logout);
    } else {
      slot.innerHTML = `<button class="btn btn-sm outline" id="admin-login-btn">Admin</button>`;
      document.getElementById("admin-login-btn").addEventListener("click", openLoginModal);
    }
  }

  // ========== INIT (static site — no Claude capabilities) ==========
  async function initCaps() {
    // Stable per-browser id for emoji reactions
    try {
      let anon = localStorage.getItem("imt-anon-id");
      if (!anon) { anon = "anon-" + Math.random().toString(36).slice(2, 11); localStorage.setItem("imt-anon-id", anon); }
      state.myUserId = anon;
    } catch(_) { state.myUserId = "anon-session"; }
    // Admin login state kept in localStorage
    try {
      state.isAdmin = localStorage.getItem("imt-admin") === "1";
    } catch(_) {}
    // Load user-local collections (notes, reactions, pinned, info-overrides)
    try { state.notes = JSON.parse(localStorage.getItem("imt-notes") || "{}"); } catch(_) { state.notes = {}; }
    try { state.reactions = JSON.parse(localStorage.getItem("imt-reactions") || "{}"); } catch(_) { state.reactions = {}; }
    try { state.pinnedNotice = JSON.parse(localStorage.getItem("imt-pinned") || "null"); } catch(_) { state.pinnedNotice = null; }
    await loadFromGitHub();
    updateAdminSlot();
    render();
    scheduleAutoSync();
    startReactionsSync();
  }

  async function fetchGH(name) {
    const bust = Math.floor(Date.now() / 60000);
    try {
      const r = await fetch(`${DATA_BASE}/${name}?t=${bust}`, { cache: "no-store" });
      if (!r.ok) { state._lastFetchErr = `${r.status} ${name}`; return null; }
      return await r.json();
    } catch (e) {
      state._lastFetchErr = `${name}: ${(e && e.message) || e}`;
      return null;
    }
  }

  async function loadFromGitHub() {
    try {
      const [team, startrack, comps, seasons, weekly, daily, allies, allySeason, compLBs, history, index, info, pinned, tournament, roster, activity, notifications] = await Promise.all([
        fetchGH("team.json"),
        fetchGH("startrack.json"),
        fetchGH("comps.json"),
        fetchGH("seasons.json"),
        fetchGH("weekly.json"),
        fetchGH("daily.json"),
        fetchGH("allies.json"),
        fetchGH("allySeason.json"),
        fetchGH("compLeaderboards.json"),
        fetchGH("history.json"),
        fetchGH("index.json"),
        fetchGH("info.json"),
        fetchGH("pinned.json"),
        fetchGH("tournament.json"),
        fetchGH("roster.json"),
        fetchGH("activity.json"),
        fetchGH("notifications.json"),
      ]);
      if (team) { state.team = team; state.lastSync = team._syncedAt || state.lastSync; }
      if (startrack) state.startrack = startrack;
      if (comps) state.comps = comps;
      if (seasons) {
        state.seasons = seasons;
        if (!state.selectedSeason && seasons.currentValue) state.selectedSeason = seasons.currentValue;
      }
      if (weekly) state.weekly = weekly;
      if (daily) state.daily = daily;
      if (allies && typeof allies === "object") state.allyData = { ...state.allyData, ...allies };
      if (allySeason && typeof allySeason === "object") state.allySeason = { ...state.allySeason, ...allySeason };
      if (compLBs && typeof compLBs === "object") state.compLeaderboards = { ...state.compLeaderboards, ...compLBs };
      if (history && typeof history === "object") {
        const arr = Object.entries(history).map(([date, d]) => ({ date, ...d }));
        arr.sort((a, b) => a.date.localeCompare(b.date));
        state.history = arr;
      }
      if (info) state.info = normalizeInfo(info);
      if (pinned) state.pinnedNotice = pinned;
      if (tournament) state.tournament = tournament;
      if (roster) state.roster = roster;
      if (activity) state.activity = activity;
      if (notifications) state.notifications = notifications;
      if (allies && typeof allies === "object") state.allies = Object.keys(allies);
      state.syncIndex = index || null;
      if (!team && !startrack && !comps) {
        state.syncError = state._lastFetchErr ? `Data fetch failed (${state._lastFetchErr})` : "No data yet";
      } else {
        state.syncError = null;
      }
    } catch (e) {
      state.syncError = e.message || String(e);
    } finally {
      updateSyncChip && updateSyncChip();
    }
  }

  async function loadFromDb() { /* no-op on static site; see loadFromGitHub */ }
  function sub() { /* no live subs on a static site */ }

  // ========== AUTH ==========
  async function sha256(str) {
    const enc = new TextEncoder().encode(str);
    const buf = await crypto.subtle.digest("SHA-256", enc);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("");
  }

  function openLoginModal() {
    const html = `
      <div class="modal-backdrop" id="modal-bd">
        <div class="modal" role="dialog" aria-modal="true" aria-label="Admin login">
          <h2>Admin login</h2>
          <p class="sub">Sign in to edit team info and manage settings.</p>
          <div class="err" id="login-err" hidden></div>
          <form id="login-form">
            <div class="form-row">
              <label for="login-user">Username</label>
              <input id="login-user" required autocomplete="username" />
            </div>
            <div class="form-row">
              <label for="login-pw">Password</label>
              <input id="login-pw" type="password" required autocomplete="current-password" />
            </div>
            <div class="modal-actions">
              <button type="button" class="btn ghost" id="login-cancel">Cancel</button>
              <button type="submit" class="btn primary">Sign in</button>
            </div>
          </form>
        </div>
      </div>`;
    document.getElementById("modal-mount").innerHTML = html;
    document.getElementById("login-cancel").addEventListener("click", closeModal);
    document.getElementById("modal-bd").addEventListener("click", (e)=>{ if (e.target.id === "modal-bd") closeModal(); });
    document.getElementById("login-form").addEventListener("submit", async (e)=>{
      e.preventDefault();
      const user = document.getElementById("login-user").value.trim();
      const pw = document.getElementById("login-pw").value;
      const err = document.getElementById("login-err");
      const hash = await sha256(pw);
      if (user === ADMIN_USERNAME && hash === ADMIN_PW_HASH) {
        try { localStorage.setItem("imt-admin", "1"); } catch(_) {}
        state.isAdmin = true;
        closeModal();
        updateAdminSlot();
        render();
        toast("Signed in ✓");
      } else {
        err.textContent = "Incorrect username or password.";
        err.hidden = false;
      }
    });
    setTimeout(()=>{ const u = document.getElementById("login-user"); if (u) u.focus(); }, 50);
  }

  function openNoteModal(username) {
    const existing = state.notes[username];
    const racer = state.team && state.team.racers ? state.team.racers.find(r => r.username === username) : null;
    const name = racer ? (racer.displayName || racer.username) : username;
    document.getElementById("modal-mount").innerHTML = `
      <div class="modal-backdrop" id="modal-bd">
        <div class="modal">
          <h2>Note on ${esc(name)}</h2>
          <p class="sub">Only you (admin) see these notes. Teammates don't.</p>
          <form id="note-form">
            <div class="form-row">
              <label for="note-text">Note</label>
              <textarea id="note-text" placeholder="e.g. new recruit, still ramping up / away this week, don't boot">${existing && existing.text ? esc(existing.text) : ""}</textarea>
            </div>
            <div class="modal-actions">
              ${existing ? `<button type="button" class="btn danger" id="note-delete" style="margin-right:auto;">Delete</button>` : ""}
              <button type="button" class="btn ghost" id="note-cancel">Cancel</button>
              <button type="submit" class="btn primary">Save note</button>
            </div>
          </form>
        </div>
      </div>`;
    document.getElementById("note-cancel").addEventListener("click", closeModal);
    document.getElementById("modal-bd").addEventListener("click", (e)=>{ if (e.target.id === "modal-bd") closeModal(); });
    document.getElementById("note-form").addEventListener("submit", async (e)=>{
      e.preventDefault();
      const text = document.getElementById("note-text").value.trim();
      if (!text) { toast("Note can't be empty"); return; }
      try {
        await writeDoc(`notes/${username}`, { text, updatedAt: Date.now() });
        state.notes[username] = { text, updatedAt: Date.now() };
        closeModal();
        render();
        toast("Note saved ✓");
      } catch(err) { toast("Save failed: " + (err.message||err), 4000); }
    });
    const delBtn = document.getElementById("note-delete");
    if (delBtn) delBtn.addEventListener("click", async ()=>{
      try {
        delete state.notes[username];
        localStorage.setItem("imt-notes", JSON.stringify(state.notes));
        closeModal();
        render();
        toast("Note deleted");
      } catch(err) { toast("Delete failed: " + (err.message||err), 4000); }
    });
    setTimeout(()=>{ const el = document.getElementById("note-text"); if (el) el.focus(); }, 50);
  }

  async function exportRacersCSV() {
    if (!state.isAdmin) { toast("Admin only."); return; }
    const t = state.team;
    if (!t || !t.racers) { toast("No data to export."); return; }
    const weeklyMap = {};
    if (state.weekly && Array.isArray(state.weekly.racers)) state.weekly.racers.forEach(r => { weeklyMap[r.username] = r; });
    const dailyMap = {};
    if (state.daily && Array.isArray(state.daily.racers)) state.daily.racers.forEach(r => { dailyMap[r.username] = r; });
    const seasonMap = {};
    const curSeason = state.seasons && state.seasons.currentValue && state.seasons.seasons && state.seasons.seasons[state.seasons.currentValue];
    if (curSeason && curSeason.racers) curSeason.racers.forEach(r => { seasonMap[r.username] = r; });
    const rosterMap = {};
    if (state.roster && Array.isArray(state.roster.racers)) state.roster.racers.forEach(r => { rosterMap[r.username] = r; });

    const headers = ["Display name","Username","Role","Squad","Tier","Avg WPM","Top WPM","Accuracy","Total races","Team races","Daily races (goal 20)","Weekly races (goal 100)","Season races","Season points","Season rank","Joined","Last login","Note"];
    const quote = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = t.racers.map(r => {
      const wk = weeklyMap[r.username] || {};
      const dy = dailyMap[r.username] || {};
      const se = seasonMap[r.username] || {};
      const ro = rosterMap[r.username] || {};
      const note = state.notes[r.username];
      return [
        r.displayName || r.username,
        r.username,
        r.role || "member",
        ro.squad || "",
        ro.tier || "",
        r.wpm || 0,
        r.highestWPM || 0,
        (r.acc || 0) + "%",
        r.allTimeRaces || 0,
        r.teamRaces || 0,
        dy.races || "",
        wk.races || "",
        se.races || "",
        se.points || "",
        se.rank || "",
        r.joinStamp ? new Date(r.joinStamp * 1000).toISOString().slice(0,10) : "",
        r.lastLogin ? new Date(r.lastLogin * 1000).toISOString().slice(0,10) : "",
        note ? note.text : "",
      ].map(quote).join(",");
    });
    const csv = [headers.map(quote).join(","), ...rows].join("\n");
    const filename = `tche-racers-${new Date().toISOString().slice(0,10)}.csv`;

    // Plain browser blob download
    try {
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("CSV exported ✓");
      return;
      /* legacy: */
      if (false) {
        const downloads = null;
        downloads.save({ filename, data: csv });
      }
    } catch(_) {}
    // Fallback: open in a new tab for copy/save
    try {
      const win = window.open("", "_blank");
      if (win) {
        win.document.write(`<pre style="font-family:monospace; white-space: pre; padding: 20px;">${esc(csv)}</pre>`);
        win.document.title = filename;
        toast("Exported — opened in new tab");
      } else {
        toast("Could not open download. Try again in the desktop app.", 4500);
      }
    } catch(_) { toast("Export failed in this view.", 4000); }
  }

  function openChangePwModal() {
    document.getElementById("modal-mount").innerHTML = `
      <div class="modal-backdrop" id="modal-bd">
        <div class="modal">
          <h2>Change admin password</h2>
          <p class="sub">Set a new password for the admin account.</p>
          <div class="err" id="cp-err" hidden></div>
          <form id="cp-form">
            <div class="form-row"><label for="cp-old">Current password</label><input id="cp-old" type="password" required /></div>
            <div class="form-row"><label for="cp-new">New password</label><input id="cp-new" type="password" required minlength="6" /></div>
            <div class="form-row"><label for="cp-conf">Confirm new password</label><input id="cp-conf" type="password" required /></div>
            <div class="modal-actions">
              <button type="button" class="btn ghost" id="cp-cancel">Cancel</button>
              <button type="submit" class="btn primary">Update password</button>
            </div>
          </form>
        </div>
      </div>`;
    document.getElementById("cp-cancel").addEventListener("click", closeModal);
    document.getElementById("modal-bd").addEventListener("click", (e)=>{ if (e.target.id === "modal-bd") closeModal(); });
    document.getElementById("cp-form").addEventListener("submit", async (e)=>{
      e.preventDefault();
      const err = document.getElementById("cp-err");
      const oldPw = document.getElementById("cp-old").value;
      const newPw = document.getElementById("cp-new").value;
      const conf = document.getElementById("cp-conf").value;
      if (newPw !== conf) { err.textContent = "New passwords don't match."; err.hidden = false; return; }
      if (!state.auth) { err.textContent = "No admin record found."; err.hidden = false; return; }
      const oldHash = await sha256(oldPw);
      if (oldHash !== state.auth.pwHash) { err.textContent = "Current password is incorrect."; err.hidden = false; return; }
      const newHash = await sha256(newPw);
      const next = { username: state.auth.username, pwHash: newHash, updatedAt: Date.now() };
      try {
        await writeDoc("settings/auth", next);
        state.auth = next;
        closeModal();
        toast("Password updated ✓");
      } catch(e2) {
        err.textContent = "Could not save: " + (e2.message || e2);
        err.hidden = false;
      }
    });
  }

  function closeModal() {
    const m = document.getElementById("modal-mount");
    if (m) m.innerHTML = "";
  }

  function logout() {
    try { localStorage.removeItem("imt-admin"); } catch(_) {}
    state.isAdmin = false;
    updateAdminSlot();
    render();
    toast("Signed out");
  }

  // ========== SYNC (via Claude Browser) ==========
  async function getBrowserServer() {
    if (state.browserServer) return state.browserServer;
    if (!state.mcp) throw new Error("Live sync needs the Claude desktop app's browser. Open this dashboard inside the Claude app to enable it.");
    const srv = await state.mcp.server("host:claude_browser");
    if (!srv) throw new Error("Claude Browser isn't available in this view.");
    state.browserServer = srv;
    return srv;
  }

  async function fetchTeamViaBrowser(tag) {
    const srv = await getBrowserServer();
    await srv.navigate({ url: NT_API(tag) });
    await new Promise(r => setTimeout(r, 1200));
    // Try a few text-extraction methods — the exact return shape varies
    let body = null;
    try {
      const txt = await srv.get_page_text({ max_chars: 100000 });
      body = typeof txt === "string" ? txt : (txt && (txt.text || txt.content || JSON.stringify(txt)));
    } catch(_) {}
    if (!body && typeof srv.javascript_tool === "function") {
      try {
        const r = await srv.javascript_tool({ action: "javascript_exec", text: "document.body.innerText" });
        body = typeof r === "string" ? r : (r && (r.result || r.text));
      } catch(_) {}
    }
    if (!body) throw new Error("Empty response from browser");
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start < 0 || end < 0) throw new Error("Response wasn't JSON (team not found, or Nitro Type blocked the request)");
    const json = JSON.parse(body.slice(start, end+1));
    if (json && json.status && json.status !== "OK" && json.status !== "ok") throw new Error("Nitro Type: " + json.status);
    return json;
  }

  async function syncAll({ silent } = {}) {
    if (!silent) toast("Syncing TCHE…");
    setSyncLoading(true);
    state.syncError = null;
    try {
      const team = await fetchTeamViaBrowser(TEAM_TAG);
      const payload = normalizeTeam(team);
      payload._syncedAt = Date.now();
      state.team = payload;
      state.lastSync = payload._syncedAt;
      if (state.db) await writeDoc("snapshot/team", payload);
      // Startrack sync (season/period data)
      try {
        const st = await fetchStartrackSnapshot();
        if (st) {
          state.startrack = st;
          if (state.db) await writeDoc("snapshot/startrack", st);
        }
      } catch(err) { console.warn("startrack sync", err); }
      // Comps sync
      try {
        const cp = await fetchCompsSnapshot();
        if (cp) {
          state.comps = cp;
          if (state.db) await writeDoc("snapshot/comps", cp);
        }
      } catch(err) { console.warn("comps sync", err); }
      // Per-racer season sync (current season only; past seasons stay cached)
      try {
        const ss = await fetchCurrentSeasonRacers();
        if (ss && ss.value) {
          const existing = (state.seasons && state.seasons.seasons) ? { ...state.seasons.seasons } : {};
          existing[ss.value] = ss;
          const order = state.seasons && Array.isArray(state.seasons.order) ? state.seasons.order.slice() : [];
          if (!order.includes(ss.value)) order.unshift(ss.value);
          const merged = { seasons: existing, order, currentValue: ss.value, _syncedAt: Date.now() };
          state.seasons = merged;
          if (state.db) await writeDoc("snapshot/seasons", merged);
        }
      } catch(err) { console.warn("seasons sync", err); }
      // Weekly per-racer sync (Startrack individual leaderboard, Weekly timeframe)
      try {
        const w = await fetchStartrackIndividualLeaderboard("Weekly");
        if (w) {
          state.weekly = { racers: w, _syncedAt: Date.now() };
          if (state.db) await writeDoc("snapshot/weekly", state.weekly);
        }
      } catch(err) { console.warn("weekly sync", err); }
      // Daily per-racer sync (Startrack individual leaderboard, 24 Hour timeframe)
      try {
        const d = await fetchStartrackIndividualLeaderboard("24 Hour");
        if (d) {
          state.daily = { racers: d, _syncedAt: Date.now() };
          if (state.db) await writeDoc("snapshot/daily", state.daily);
        }
      } catch(err) { console.warn("daily sync", err); }
      // Per-active-comp leaderboards
      try {
        const activeComps = ((state.comps && state.comps.events) || []).filter(c => /active|live|ongoing/i.test(c.status || ""));
        for (const c of activeComps) {
          try {
            const lb = await fetchCompLeaderboard(c.id);
            if (lb) {
              state.compLeaderboards[c.id] = lb;
              if (state.db) await writeDoc(`snapshot/compLeaderboards/data/${c.id}`, lb);
            }
          } catch(e) { console.warn("comp lb", c.id, e); }
        }
      } catch(err) { console.warn("comp lb sync", err); }
      // Allies — team data + season rank from Startrack
      for (const tag of state.allies) {
        try {
          const a = await fetchTeamViaBrowser(tag);
          const ap = normalizeTeam(a);
          ap._syncedAt = Date.now();
          state.allyData[tag] = ap;
          if (state.db) await writeDoc(`snapshot/allies/data/${tag}`, ap);
        } catch(err) { console.warn("ally sync", tag, err); }
        try {
          const as = await fetchAllyStartrackSeason(tag);
          if (as) {
            state.allySeason[tag] = as;
            if (state.db) await writeDoc(`snapshot/allySeason/data/${tag}`, as);
          }
        } catch(err) { console.warn("ally season", tag, err); }
      }
      // Daily history snapshot (one per calendar day — only writes if today's doesn't exist)
      try {
        const today = new Date().toISOString().slice(0, 10);
        const dailyRaces = (payload.aggregates && payload.aggregates.daily && payload.aggregates.daily.races) || 0;
        const allTimeRaces = (payload.aggregates && payload.aggregates.alltime && payload.aggregates.alltime.races) || 0;
        const seasonPoints = (state.startrack && state.startrack.timeframes && state.startrack.timeframes.season && state.startrack.timeframes.season.points) || 0;
        const seasonRank = (state.startrack && state.startrack.timeframes && state.startrack.timeframes.season && state.startrack.timeframes.season.rank) || null;
        const histDoc = { dailyRaces, allTimeRaces, seasonPoints, seasonRank, _syncedAt: Date.now() };
        if (state.db) await writeDoc(`history/${today}`, histDoc);
      } catch(err) { console.warn("history", err); }
      updateSyncChip();
      render();
      if (!silent) toast("Synced ✓");
    } catch(e) {
      state.syncError = e.message || String(e);
      updateSyncChip();
      if (!silent) toast("Sync failed: " + state.syncError, 5500);
    } finally {
      setSyncLoading(false);
    }
  }

  async function fetchStartrackSnapshot() {
    const srv = await getBrowserServer();
    await srv.navigate({ url: "https://ntstartrack.org" });
    await new Promise(r => setTimeout(r, 2500));
    // Click each timeframe and scrape TCHE row
    const script = `
      (async () => {
        const click = (txt) => { const b = [...document.querySelectorAll("button, [role='button']")].find(x => x.textContent.trim() === txt); if (b) { b.click(); return true; } return false; };
        async function capture() {
          await new Promise(r => setTimeout(r, 1200));
          const row = [...document.querySelectorAll("tr")].find(r => /\\[TCHE\\]/.test(r.textContent));
          if (!row) return null;
          const c = [...row.querySelectorAll("td")].map(td => td.textContent.replace(/\\s+/g," ").trim());
          const rm = c[0] && c[0].match(/^(\\d+)/);
          const parseNum = s => { if (!s) return 0; const n = Number(String(s).replace(/[,%]/g, "")); return isNaN(n) ? 0 : n; };
          return {
            rank: rm ? Number(rm[1]) : null,
            races: parseNum(c[1]),
            accuracy: parseNum(c[2]),
            wpm: parseNum(c[3]),
            points: parseNum(c[4]),
            ppr: parseNum(c[5]),
          };
        }
        const out = {};
        const map = {"24h":"24 Hour","season":"Season","week":"7 Day","weekly":"Weekly","alltime":"All-Time"};
        for (const [k, label] of Object.entries(map)) { click(label); out[k] = await capture(); }
        return JSON.stringify(out);
      })()
    `;
    let txt;
    try {
      const r = await srv.javascript_tool({ action: "javascript_exec", text: script });
      txt = typeof r === "string" ? r : (r && (r.result || r.text || JSON.stringify(r)));
    } catch(e) {
      throw new Error("Startrack scrape failed: " + (e.message || e));
    }
    let parsed = {};
    try {
      // txt is a string that itself is a JSON-encoded string
      parsed = JSON.parse(typeof txt === "string" && txt.startsWith('"') ? JSON.parse(txt) : txt);
    } catch(_) {
      try { parsed = JSON.parse(txt); } catch(__) {}
    }
    return {
      timeframes: parsed,
      source: "ntstartrack.org",
      _syncedAt: Date.now(),
    };
  }

  // Generic: scrape Startrack Individual Leaderboard for TCHE at a given timeframe label
  async function fetchStartrackIndividualLeaderboard(timeframeLabel) {
    const srv = await getBrowserServer();
    await srv.navigate({ url: "https://ntstartrack.org/leaderboards" });
    await new Promise(r => setTimeout(r, 2500));
    const script = `
      (async () => {
        const bb = [...document.querySelectorAll("button, a")].find(x => x.textContent.trim() === "Individual Leaderboards");
        if (bb) bb.click();
        await new Promise(r => setTimeout(r, 1500));
        const tf = [...document.querySelectorAll("button, [role='button']")].find(x => x.textContent.trim() === ${JSON.stringify(timeframeLabel)});
        if (tf) tf.click();
        await new Promise(r => setTimeout(r, 2500));
        const teamSel = [...document.querySelectorAll("select")].find(se => se.classList.contains("tag-dropdown"));
        for (let i = 0; i < 20; i++) { if ([...teamSel.options].some(o => o.value === "TCHE")) break; await new Promise(r => setTimeout(r, 400)); }
        teamSel.value = "TCHE";
        teamSel.dispatchEvent(new Event("change", {bubbles:true}));
        for (let i = 0; i < 25; i++) { await new Promise(r => setTimeout(r, 500)); if ([...document.querySelectorAll("tr")].some(r => /\\[TCHE\\]/.test(r.textContent))) break; }
        await new Promise(r => setTimeout(r, 800));
        const rows = [...document.querySelectorAll("tr")].filter(r => /\\[TCHE\\]/.test(r.textContent)).map(r => {
          const cells = [...r.querySelectorAll("td")].map(td => td.textContent.replace(/\\s+/g," ").trim());
          const link = r.querySelector("a[href*='/racer/']");
          const username = link ? link.href.split("/racer/")[1].split(/[?#]/)[0] : null;
          const first = cells[0] || "";
          const m = first.match(/^(\\d+)\\[TCHE\\](.+?)"(.*)"$/);
          return { rank: m ? Number(m[1]) : null, username, displayName: m ? m[2].trim() : first, races: Number((cells[3]||"").replace(/,/g,""))||0, accuracy: parseFloat((cells[4]||"").replace("%",""))||0, wpm: parseFloat(cells[5])||0, points: Number((cells[6]||"").replace(/,/g,""))||0, ppr: Number((cells[7]||"").replace(/,/g,""))||0 };
        });
        return JSON.stringify(rows);
      })()
    `;
    let txt;
    try {
      const r = await srv.javascript_tool({ action: "javascript_exec", text: script });
      txt = typeof r === "string" ? r : (r && (r.result || r.text || JSON.stringify(r)));
    } catch(e) { throw new Error("Individual LB scrape failed: " + (e.message || e)); }
    try { return JSON.parse(typeof txt === "string" && txt.startsWith('"') ? JSON.parse(txt) : txt); }
    catch(_){ try { return JSON.parse(txt); } catch(__) { return null; } }
  }

  // Scrape per-comp racer leaderboard from Startrack event viewer
  async function fetchCompLeaderboard(eventId) {
    if (!eventId) return null;
    const srv = await getBrowserServer();
    await srv.navigate({ url: `https://ntstartrack.org/eventviewer?tag=TCHE&event=${encodeURIComponent(eventId)}` });
    await new Promise(r => setTimeout(r, 2500));
    const script = `
      (async () => {
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 400));
          if ([...document.querySelectorAll("*")].some(e => /\\[TCHE\\]/.test(e.textContent || ""))) break;
        }
        // Each racer is in an .m-card with points + tier
        const racers = [...document.querySelectorAll(".m-card")].map(c => {
          const text = c.textContent.replace(/\\s+/g," ").trim();
          const link = c.querySelector("a[href*='/racer/']");
          const username = link ? link.href.split("/racer/")[1].split(/[?#]/)[0] : null;
          const nameM = text.match(/\\[TCHE\\]\\s*([^"]+?)\\s*"/);
          const titleM = text.match(/"([^"]+)"/);
          const ptsM = text.match(/([0-9,]+)\\s*POINTS/i);
          const tierM = text.match(/POINTS\\s+([ABC])\\s*$/);
          return { username, displayName: nameM ? nameM[1].trim() : "", title: titleM ? titleM[1] : "", points: ptsM ? Number(ptsM[1].replace(/,/g,"")) : 0, tier: tierM ? tierM[1] : "" };
        }).filter(r => r.points > 0);
        racers.sort((a,b) => b.points - a.points);
        return JSON.stringify({ eventId: ${JSON.stringify(eventId)}, racers, _syncedAt: Date.now() });
      })()
    `;
    let txt;
    try {
      const r = await srv.javascript_tool({ action: "javascript_exec", text: script });
      txt = typeof r === "string" ? r : (r && (r.result || r.text || JSON.stringify(r)));
    } catch(e) { throw new Error("Comp LB scrape failed: " + (e.message || e)); }
    try { return JSON.parse(typeof txt === "string" && txt.startsWith('"') ? JSON.parse(txt) : txt); }
    catch(_){ try { return JSON.parse(txt); } catch(__) { return null; } }
  }

  // Scrape Startrack ALL timeframes team ranking for an ally
  async function fetchAllyStartrackSeason(tag) {
    if (!tag) return null;
    const srv = await getBrowserServer();
    await srv.navigate({ url: "https://ntstartrack.org" });
    await new Promise(r => setTimeout(r, 2500));
    const script = `
      (async () => {
        const click = (txt) => { const b = [...document.querySelectorAll("button, [role='button']")].find(x => x.textContent.trim() === txt); if (b) { b.click(); return true; } return false; };
        const needle = "[" + ${JSON.stringify(tag)} + "]";
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        function findRow() {
          return [...document.querySelectorAll("tr")].find(r => r.textContent.includes(needle));
        }
        async function tryTypeInSearch() {
          // Try to find any input that behaves like a search / filter
          const inputs = [...document.querySelectorAll("input")].filter(i => {
            const t = (i.type || "").toLowerCase();
            if (t && t !== "text" && t !== "search") return false;
            const p = ((i.placeholder || "") + " " + (i.name || "") + " " + (i.id || "") + " " + (i.className || "")).toLowerCase();
            return /search|filter|team|tag/.test(p) || t === "search" || !i.placeholder;
          });
          for (const inp of inputs) {
            try {
              inp.focus();
              const prev = inp.value;
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
              setter.call(inp, ${JSON.stringify(tag)});
              inp.dispatchEvent(new Event("input", { bubbles: true }));
              inp.dispatchEvent(new Event("change", { bubbles: true }));
              await sleep(900);
              if (findRow()) return true;
              // reset so next search works clean
              setter.call(inp, prev || "");
              inp.dispatchEvent(new Event("input", { bubbles: true }));
            } catch(_) {}
          }
          return false;
        }
        async function scrollToFind() {
          // Scroll the window AND any scrollable table containers
          const containers = [document.scrollingElement, ...document.querySelectorAll("div, section, main")].filter(el => {
            try { const s = getComputedStyle(el); return (s.overflowY === "auto" || s.overflowY === "scroll") && el.scrollHeight > el.clientHeight; } catch(_){ return false; }
          });
          const scrollables = [window, ...containers];
          for (let i = 0; i < 60; i++) {
            if (findRow()) return true;
            for (const s of scrollables) {
              try { if (s === window) window.scrollBy(0, 1200); else s.scrollTop = s.scrollTop + 1200; } catch(_) {}
            }
            await sleep(250);
          }
          // Also try scrolling back up — some lists reset
          for (const s of scrollables) { try { if (s === window) window.scrollTo(0, 0); else s.scrollTop = 0; } catch(_){} }
          return !!findRow();
        }
        async function cap() {
          await sleep(1200);
          if (!findRow()) { if (!(await tryTypeInSearch())) { await scrollToFind(); } }
          const row = findRow();
          if (!row) return null;
          const c = [...row.querySelectorAll("td")].map(td => td.textContent.replace(/\\s+/g," ").trim());
          const rm = c[0] && c[0].match(/^(\\d+)/);
          const pn = s => { if (!s) return 0; const n = Number(String(s).replace(/[,%]/g, "")); return isNaN(n) ? 0 : n; };
          return { rank: rm ? Number(rm[1]) : null, races: pn(c[1]), accuracy: pn(c[2]), wpm: pn(c[3]), points: pn(c[4]), ppr: pn(c[5]) };
        }
        const out = {};
        const map = {"24h":"24 Hour","season":"Season","week":"7 Day","weekly":"Weekly","alltime":"All-Time"};
        for (const [k, label] of Object.entries(map)) { click(label); out[k] = await cap(); }
        return JSON.stringify({ timeframes: out, rank: out.season && out.season.rank, races: out.season && out.season.races, accuracy: out.season && out.season.accuracy, wpm: out.season && out.season.wpm, points: out.season && out.season.points, ppr: out.season && out.season.ppr, _syncedAt: Date.now() });
      })()
    `;
    let txt;
    try {
      const r = await srv.javascript_tool({ action: "javascript_exec", text: script });
      txt = typeof r === "string" ? r : (r && (r.result || r.text || JSON.stringify(r)));
    } catch(e) { throw new Error("Ally Startrack scrape failed: " + (e.message || e)); }
    try { return JSON.parse(typeof txt === "string" && txt.startsWith('"') ? JSON.parse(txt) : txt); }
    catch(_){ try { return JSON.parse(txt); } catch(__) { return null; } }
  }

  async function fetchCurrentSeasonRacers() {
    const srv = await getBrowserServer();
    await srv.navigate({ url: "https://ntstartrack.org/leaderboards" });
    await new Promise(r => setTimeout(r, 2500));
    const script = `
      (async () => {
        const bb = [...document.querySelectorAll("button, a")].find(x => x.textContent.trim() === "Individual Leaderboards");
        if (bb) bb.click();
        await new Promise(r => setTimeout(r, 1500));
        const s = [...document.querySelectorAll("button, [role='button']")].find(x => x.textContent.trim() === "Season");
        if (s) s.click();
        await new Promise(r => setTimeout(r, 2500));
        const teamSel = [...document.querySelectorAll("select")].find(se => se.classList.contains("tag-dropdown"));
        for (let i = 0; i < 20; i++) { if ([...teamSel.options].some(o => o.value === "TCHE")) break; await new Promise(r => setTimeout(r, 400)); }
        teamSel.value = "TCHE";
        teamSel.dispatchEvent(new Event("change", {bubbles:true}));
        for (let i = 0; i < 25; i++) {
          await new Promise(r => setTimeout(r, 500));
          if ([...document.querySelectorAll("tr")].some(r => /\\[TCHE\\]/.test(r.textContent))) break;
        }
        await new Promise(r => setTimeout(r, 800));
        const seasonSel = [...document.querySelectorAll("select")].find(se => [...se.options].some(o => /\\d{1,2}\\/\\d{1,2}\\/\\d{4}/.test(o.textContent)));
        const curOpt = seasonSel && seasonSel.options[seasonSel.selectedIndex];
        const value = curOpt ? curOpt.value : null;
        const label = curOpt ? curOpt.textContent.trim() : null;
        const rows = [...document.querySelectorAll("tr")].filter(r => /\\[TCHE\\]/.test(r.textContent)).map(r => {
          const cells = [...r.querySelectorAll("td")].map(td => td.textContent.replace(/\\s+/g," ").trim());
          const link = r.querySelector("a[href*='/racer/']");
          const username = link ? link.href.split("/racer/")[1].split(/[?#]/)[0] : null;
          const first = cells[0] || "";
          const m = first.match(/^(\\d+)\\[TCHE\\](.+?)"(.*)"$/);
          return { rank: m ? Number(m[1]) : null, username, displayName: m ? m[2].trim() : first, races: Number((cells[3]||"").replace(/,/g,""))||0, accuracy: parseFloat((cells[4]||"").replace("%",""))||0, wpm: parseFloat(cells[5])||0, points: Number((cells[6]||"").replace(/,/g,""))||0, ppr: Number((cells[7]||"").replace(/,/g,""))||0 };
        });
        return JSON.stringify({ value, label, racers: rows, _syncedAt: Date.now() });
      })()
    `;
    let txt;
    try {
      const r = await srv.javascript_tool({ action: "javascript_exec", text: script });
      txt = typeof r === "string" ? r : (r && (r.result || r.text || JSON.stringify(r)));
    } catch(e) { throw new Error("Season racer scrape failed: " + (e.message || e)); }
    try { return JSON.parse(typeof txt === "string" && txt.startsWith('"') ? JSON.parse(txt) : txt); }
    catch(_){ try { return JSON.parse(txt); } catch(__) { return null; } }
  }

  async function fetchCompsSnapshot() {
    const srv = await getBrowserServer();
    await srv.navigate({ url: "https://ntstartrack.org/events?tag=TCHE" });
    await new Promise(r => setTimeout(r, 2500));
    const script = `
      (async () => {
        await new Promise(r => setTimeout(r, 1000));
        const events = [...document.querySelectorAll(".m-event")].map(e => {
          const idSpan = [...e.querySelectorAll("span")].find(s => /^#\\d+$/.test(s.textContent.trim()));
          const id = idSpan ? idSpan.textContent.trim().replace("#","") : null;
          const status = e.querySelector(".m-status")?.textContent?.trim() || null;
          const title = e.querySelector(".m-event__title")?.textContent?.trim() || null;
          const desc = e.querySelector(".m-event__desc")?.textContent?.trim() || null;
          const times = [...e.querySelectorAll(".m-event__times span")].map(s => s.textContent.replace(/\\s+/g," ").trim());
          const start = times[0] ? times[0].replace(/^▶\\s*Start\\s*/,"") : null;
          const end = times[1] ? times[1].replace(/^■\\s*End\\s*/,"") : null;
          return { id, status, title, desc, start, end };
        });
        return JSON.stringify({ events, source: "ntstartrack.org", _syncedAt: Date.now() });
      })()
    `;
    let txt;
    try {
      const r = await srv.javascript_tool({ action: "javascript_exec", text: script });
      txt = typeof r === "string" ? r : (r && (r.result || r.text || JSON.stringify(r)));
    } catch(e) { throw new Error("Comps scrape failed: " + (e.message || e)); }
    let parsed = null;
    try { parsed = JSON.parse(typeof txt === "string" && txt.startsWith('"') ? JSON.parse(txt) : txt); } catch(_){ try { parsed = JSON.parse(txt); } catch(__) {} }
    return parsed;
  }

  // Static-site writeDoc — persists to localStorage, or routes shared-content
  // edits to a GitHub Edit page in a new tab.
  async function writeDoc(path, data) {
    try {
      if (path.startsWith("notes/")) {
        const u = path.slice("notes/".length);
        state.notes = { ...state.notes, [u]: data };
        localStorage.setItem("imt-notes", JSON.stringify(state.notes));
        return;
      }
      if (path.startsWith("reactions/")) {
        const target = path.slice("reactions/".length);
        state.reactions = { ...state.reactions, [target]: data };
        localStorage.setItem("imt-reactions", JSON.stringify(state.reactions));
        return;
      }
      if (path === "settings/pinnedNotice") {
        state.pinnedNotice = data;
        localStorage.setItem("imt-pinned", JSON.stringify(data));
        return;
      }
      if (path === "settings/info") {
        // Shared content — the static site can't write to GitHub itself, so
        // the full updated file is copied to the clipboard and the admin
        // pastes it into GitHub's own editor (which opens pre-loaded with
        // the current file) and commits. The site shows it live afterward.
        state.info = data;
        const json = JSON.stringify(data, null, 2);
        let copied = false;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(json);
            copied = true;
          }
        } catch(_) {}
        try { window.open(GITHUB_EDIT("data/info.json"), "_blank", "noopener"); } catch(_) {}
        if (copied) {
          toast("Copied the updated Info content to your clipboard. On the GitHub tab that just opened: select all (Ctrl/Cmd+A), paste, then commit.", 9000);
        } else {
          toast("Couldn't copy automatically — select all text in the GitHub tab, delete it, and paste this instead: " + json.slice(0, 120) + "…", 9000);
        }
        return;
      }
      if (path === "settings/auth") {
        // Just change the local saved hash — the hardcoded one in shared.js
        // is the ultimate source. For a real change, edit shared.js.
        toast("To change the admin password permanently, update ADMIN_PW_HASH in shared.js and commit.", 6500);
        return;
      }
      // snapshot/* and history/* writes are now owned by the GitHub Action — no-op here.
    } catch (e) {
      console.warn("writeDoc", path, e);
    }
  }

  // ========== REACTIONS ==========
  const REACTION_EMOJIS = ["👍", "❤️", "🔥", "🧀", "🏁", "🎉", "👀", "💯"];

  function reactionCounts(target) {
    const doc = state.reactions && state.reactions[target];
    const counts = {};
    let myEmoji = null;
    for (const emoji of REACTION_EMOJIS) {
      const users = doc && doc[emoji] && typeof doc[emoji] === "object" ? doc[emoji] : null;
      counts[emoji] = users ? Object.keys(users).length : 0;
      if (users && state.myUserId && users[state.myUserId]) myEmoji = emoji;
    }
    return { counts, myEmoji };
  }

  function renderReactionBar(target) {
    const { counts, myEmoji } = reactionCounts(target);
    const buttons = REACTION_EMOJIS.map(emoji => {
      const n = counts[emoji] || 0;
      const active = emoji === myEmoji;
      return `<button class="reaction-btn${active ? ' is-active' : ''}" data-reaction="${esc(target)}" data-emoji="${esc(emoji)}" aria-pressed="${active}">
        <span class="reaction-emoji">${emoji}</span>${n ? `<span class="reaction-count">${n}</span>` : ""}
      </button>`;
    }).join("");
    return `<div class="reaction-bar" role="group" aria-label="React to this">
      <span class="reaction-label">React:</span>${buttons}
    </div>`;
  }

  // Firebase Realtime DB — shared reactions store
  async function fetchSharedReactions() {
    try {
      const r = await fetch(`${FIREBASE_URL}/reactions.json?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return null;
      return (await r.json()) || {};
    } catch (_) { return null; }
  }
  async function pushReactionLeaf(target, emoji, userId, isSet) {
    // Firebase REST: PUT a single leaf, or DELETE it. target may contain slashes; encode.
    const path = `reactions/${encodeURIComponent(target)}/${encodeURIComponent(emoji)}/${encodeURIComponent(userId)}.json`;
    try {
      if (isSet) {
        await fetch(`${FIREBASE_URL}/${path}`, { method: "PUT", body: JSON.stringify(Date.now()) });
      } else {
        await fetch(`${FIREBASE_URL}/${path}`, { method: "DELETE" });
      }
      return true;
    } catch (_) { return false; }
  }

  async function toggleReaction(target, emoji) {
    if (!state.myUserId) { toast("Can't react right now", 3000); return; }
    const current = (state.reactions && state.reactions[target]) || {};
    const next = { ...current };
    const uid = state.myUserId;
    // Clear this user's prior reaction (one at a time)
    const removes = [];
    for (const e of REACTION_EMOJIS) {
      if (next[e] && typeof next[e] === "object" && next[e][uid]) {
        const nu = { ...next[e] };
        delete nu[uid];
        next[e] = nu;
        removes.push(e);
      }
    }
    const was = current[emoji] && current[emoji][uid];
    let addedEmoji = null;
    if (!was) {
      next[emoji] = { ...(next[emoji] || {}), [uid]: Date.now() };
      addedEmoji = emoji;
    }
    // Optimistic UI update
    state.reactions = { ...state.reactions, [target]: next };
    render();
    // Push to Firebase: delete any prior emojis, set the new one
    try {
      await Promise.all(removes.map(e => pushReactionLeaf(target, e, uid, false)));
      if (addedEmoji) await pushReactionLeaf(target, addedEmoji, uid, true);
    } catch (e) {
      toast("Couldn't save your reaction", 3500);
    }
  }

  function startReactionsSync() {
    const refresh = async () => {
      const data = await fetchSharedReactions();
      if (data != null) {
        state.reactions = data;
        if (state.page === "info" || state.page === "home") render();
      }
    };
    refresh();
    setInterval(() => { if (!document.hidden) refresh(); }, REACTIONS_POLL_MS);
  }

  function wireReactions() {
    document.querySelectorAll(".reaction-btn").forEach(btn => {
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        toggleReaction(btn.dataset.reaction, btn.dataset.emoji);
      });
    });
  }

  function normalizeTeam(raw) {
    const r = (raw && raw.results) || raw || {};
    const info = r.info || {};
    const members = r.members || [];
    const statsArr = r.stats || [];
    const seasonArr = r.season || [];
    const seasonByUser = {};
    for (const s of seasonArr) seasonByUser[s.username] = s;
    const teamBoards = {};
    for (const s of statsArr) {
      teamBoards[s.board] = {
        races: Number(s.played) || 0,
        typed: Number(s.typed) || 0,
        errs: Number(s.errs) || 0,
        secs: Number(s.secs) || 0,
      };
    }
    const racers = members.map(m => {
      const sm = seasonByUser[m.username];
      const sb = sm && sm.played != null ? { races: sm.played, typed: sm.typed||0, errs: sm.errs||0, secs: sm.secs||0 } : null;
      return {
        username: m.username,
        displayName: m.displayName || m.username,
        role: m.role || "member",
        joinStamp: m.joinStamp,
        allTimeRaces: m.racesPlayed || 0,
        wpm: m.avgSpeed || 0,
        highestWPM: m.highestSpeed || 0,
        teamRaces: m.played || 0,
        acc: computeAcc(m.typed||0, m.errs||0),
        season: sb ? { races: sb.races, wpm: computeWPM(sb.typed, sb.secs), acc: computeAcc(sb.typed, sb.errs) } : null,
        status: m.status,
        lastLogin: m.lastLogin,
      };
    });
    const alltime = teamBoards.alltime ? {
      races: teamBoards.alltime.races,
      avgWPM: computeWPM(teamBoards.alltime.typed, teamBoards.alltime.secs),
      avgAcc: computeAcc(teamBoards.alltime.typed, teamBoards.alltime.errs),
      members: members.length,
    } : null;
    const daily = teamBoards.daily ? {
      races: teamBoards.daily.races,
      avgWPM: computeWPM(teamBoards.daily.typed, teamBoards.daily.secs),
      avgAcc: computeAcc(teamBoards.daily.typed, teamBoards.daily.errs),
      members: members.length,
    } : null;
    const seasonMembers = racers.filter(r => r.season);
    const seasonAgg = seasonMembers.length ? {
      races: seasonMembers.reduce((s,r)=>s+r.season.races,0),
      avgWPM: Math.round(seasonMembers.reduce((s,r)=>s+r.season.wpm,0) / seasonMembers.length),
      avgAcc: +(seasonMembers.reduce((s,r)=>s+r.season.acc,0) / seasonMembers.length).toFixed(2),
      members: seasonMembers.length,
    } : null;
    return {
      tag: info.tag || TEAM_TAG,
      name: info.name || info.tag || TEAM_TAG,
      members: members.length,
      activePercent: info.activePercent,
      createdStamp: info.createdStamp,
      otherInfo: info.otherRequirements || info.otherInfo,
      profileViews: info.profileViews,
      leagueTier: info.leagueTier,
      racers,
      aggregates: { alltime, daily, season: seasonAgg },
      season: null,
    };
  }
  function computeWPM(typed, secs) {
    if (!secs || !typed) return 0;
    return Math.round((typed / 5) / (secs / 60));
  }
  function computeAcc(typed, errs) {
    if (!typed) return 0;
    const total = typed + errs;
    return total ? +((typed / total) * 100).toFixed(2) : 0;
  }

  // ========== SYNC CHIP ==========
  function setSyncLoading(on) {
    const dot = document.getElementById("sync-dot");
    const text = document.getElementById("sync-text");
    const btn = document.getElementById("sync-btn");
    if (!dot || !text || !btn) return;
    if (on) {
      dot.className = "sync-dot loading";
      text.textContent = "Syncing…";
      btn.setAttribute("disabled","");
    } else {
      btn.removeAttribute("disabled");
      updateSyncChip();
    }
  }
  function updateSyncChip() {
    const dot = document.getElementById("sync-dot");
    const text = document.getElementById("sync-text");
    const chip = document.getElementById("sync-chip");
    if (!dot || !text) return;
    if (state.syncError) {
      dot.className = "sync-dot err";
      // Short label on chip, full error on hover + click toast
      const brief = String(state.syncError).replace(/^GitHub fetch blocked \(/, "").replace(/\)$/, "").slice(0, 40);
      text.textContent = "Err: " + brief;
      if (chip) {
        chip.title = state.syncError;
        chip.style.cursor = "pointer";
        chip.onclick = () => toast(state.syncError, 6000);
      }
      return;
    }
    if (chip) { chip.title = ""; chip.onclick = null; chip.style.cursor = ""; }
    if (!state.lastSync) {
      dot.className = "sync-dot";
      text.textContent = "Never synced";
      return;
    }
    dot.className = "sync-dot " + ((Date.now() - state.lastSync) < STALE_MS ? "live" : "stale");
    text.textContent = `Synced ${timeAgo(state.lastSync)}`;
  }
  setInterval(updateSyncChip, 30 * 1000);

  function scheduleAutoSync() {
    // Primary: refresh from GitHub (free, no credits, no device required).
    setInterval(() => {
      if (!document.hidden) loadFromGitHub().then(() => render());
    }, SYNC_INTERVAL_MS);
  }

  // ========== TOAST ==========
  let toastTimer = null;
  function toast(msg, ms) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(()=>el.classList.remove("show"), ms || 2400);
  }

  // ========== RENDER ==========
  function staleBanner() {
    if (!state.lastSync) return "";
    const ageMin = (Date.now() - state.lastSync) / 60000;
    if (ageMin < 75) return "";
    return `<div class="stale-banner"><div>
      Data is <strong>${Math.round(ageMin)} minutes</strong> old. Open the dashboard in the Claude desktop app and click <strong>Sync now</strong> for a fresh pull. The background sync on your computer updates once an hour.
    </div></div>`;
  }

  function render() {
    const view = document.getElementById("view");
    if (!view) return;
    try {
      const p = state.page;
      if (p === "home") view.innerHTML = staleBanner() + renderHome();
      else if (p === "stats") view.innerHTML = staleBanner() + renderStats();
      else if (p === "racers") view.innerHTML = staleBanner() + renderRacers();
      else if (p === "activity") view.innerHTML = staleBanner() + renderActivity();
      else if (p === "competitions") view.innerHTML = staleBanner() + renderCompetitions();
      else if (p === "tournament") view.innerHTML = staleBanner() + renderTournament();
      else if (p === "allies") view.innerHTML = staleBanner() + renderAllies();
      else if (p === "showdown") view.innerHTML = staleBanner() + renderShowdown();
      else if (p === "notifications") view.innerHTML = staleBanner() + renderNotifications();
      else if (p === "info") view.innerHTML = renderInfo();
      else if (p === "racer") view.innerHTML = staleBanner() + renderRacerProfile();
      else view.innerHTML = `<div class="empty"><h3>Unknown page</h3><p>Open <a href="${PAGES.home}">Home</a>.</p></div>`;
      wireHandlers();
      updateNotifDot();
    } catch(e) {
      console.error("render", e);
      view.innerHTML = `<div class="empty"><h3>Something broke rendering this page</h3><p>${esc(e.message)}</p></div>`;
    }
  }

  // ----- HOME -----
  function renderHome() {
    const t = state.team;
    const agg = (t && t.aggregates) || {};
    const alltime = agg.alltime || agg.team || { races:0, avgWPM:0, avgAcc:0, members:0 };
    const daily = agg.daily || { races:0, avgWPM:0, avgAcc:0, members:0 };
    const name = t ? esc(t.name) : "TCHE";
    const members = t ? t.members : "—";

    // Season countdown (compute from Startrack season label parsing)
    const seasonTF = state.startrack && state.startrack.timeframes && state.startrack.timeframes.season;
    const seasonsDoc = state.seasons || {};
    const seasonsMap = seasonsDoc.seasons || {};
    const curSeason = seasonsDoc.currentValue ? seasonsMap[seasonsDoc.currentValue] : null;
    let seasonCountdown = null;
    if (curSeason && curSeason.label) {
      // label like "Nitro City (9/13/2026 - 10/18/2026)"
      const m = curSeason.label.match(/-\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*\)/);
      if (m) {
        const end = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]), 23, 59, 59);
        const diffMs = end.getTime() - Date.now();
        if (diffMs > 0) {
          const days = Math.floor(diffMs / 86400000);
          const hours = Math.floor((diffMs % 86400000) / 3600000);
          seasonCountdown = { days, hours, endDate: end, name: curSeason.label.split(" (")[0] };
        }
      }
    }

    // Comp banner (active or starting soon)
    const comps = (state.comps && Array.isArray(state.comps.events)) ? state.comps.events : [];
    const liveComp = comps.find(c => /active|live|ongoing/i.test(c.status || ""));
    const upcomingComp = comps.find(c => /upcoming/i.test(c.status || ""));

    // Top 3 of today (by current all-time WPM; later we'll replace with daily if available)
    const dailyRacers = (state.daily && Array.isArray(state.daily.racers)) ? state.daily.racers : [];
    const topToday = dailyRacers.length
      ? dailyRacers.slice().sort((a,b)=>b.races - a.races).slice(0,3)
      : (t && t.racers ? t.racers.slice().sort((a,b)=>b.wpm - a.wpm).slice(0,3) : []);
    const topTodayLabel = dailyRacers.length ? "Today's top racers" : "Top racers by WPM";
    const topTodaySub = dailyRacers.length ? "By races in last 24h" : "By average WPM";

    // Pinned notice (from Info page)
    const pinned = state.pinnedNotice && state.pinnedNotice.content ? state.pinnedNotice : null;

    return `
      ${pinned ? `
      <div class="pinned-notice">
        <div class="pinned-notice-head">
          <span class="pinned-notice-icon">📌</span>
          <span class="pinned-notice-label">Pinned by Admin</span>
          ${pinned.updatedAt ? `<span class="pinned-notice-time">${timeAgo(pinned.updatedAt)}</span>` : ""}
        </div>
        <div class="info-content">${renderMarkdownLite(pinned.content)}</div>
      </div>` : ""}

      ${liveComp ? `
      <div class="comp-banner comp-banner-live">
        <div><strong>Live cash comp:</strong> ${esc(liveComp.title)} — ends ${esc(liveComp.end || "soon")}</div>
        <a href="${PAGES.competitions}" class="btn btn-sm">View details →</a>
      </div>` : upcomingComp ? `
      <div class="comp-banner comp-banner-upcoming">
        <div><strong>Upcoming comp:</strong> ${esc(upcomingComp.title)} — starts ${esc(upcomingComp.start || "soon")}</div>
        <a href="${PAGES.competitions}" class="btn btn-sm">Details →</a>
      </div>` : ""}

      <section class="hero">
        <div class="hero-main">
          <div class="hero-content">
            <div class="hero-tag">Team Dashboard</div>
            <h1 class="hero-name">${name}</h1>
            <p class="hero-motto">${t && t.otherInfo ? esc(stripHtml(t.otherInfo).slice(0, 200)) : "Live telemetry for the TCHE Nitro Type team — races, speed, accuracy and current competitions in one clean dashboard."}</p>
            <div class="hero-actions">
              <a class="btn primary" href="${NT_TEAM_URL(TEAM_TAG)}" target="_blank" rel="noopener">Visit team on Nitro Type →</a>
              <a class="btn" href="https://tinyurl.com/the-cheese-empire" target="_blank" rel="noopener">Team Padlet →</a>
              <a class="btn" href="https://ntstartrack.org/roster?tag=${esc(TEAM_TAG)}" target="_blank" rel="noopener">View on Startrack →</a>
              <a class="btn" href="${PAGES.racers}">Racers</a>
              <a class="btn ghost" href="${PAGES.stats}">Stats</a>
            </div>
          </div>
        </div>
        <div class="hero-side">
          <div class="stat highlight">
            <div class="stat-label">Members</div>
            <div class="stat-value">${fmt(members)}</div>
            <div class="stat-sub">${t && t.createdStamp ? "Est. " + new Date(t.createdStamp*1000).toLocaleDateString() : "Nitro Type team"}</div>
          </div>
          <div class="stat gold">
            <div class="stat-label">Races · all-time</div>
            <div class="stat-value">${fmt(alltime.races)}</div>
            <div class="stat-sub">Across every member</div>
          </div>
          <div class="stat">
            <div class="stat-label">Today</div>
            <div class="stat-value">${fmt(daily.races)}<span class="stat-unit">races</span></div>
            <div class="stat-sub">${fmt(daily.avgWPM)} WPM · ${fmt(daily.avgAcc)}% acc</div>
          </div>
          ${seasonTF ? `
          <div class="stat gold">
            <div class="stat-label">Season rank</div>
            <div class="stat-value">#${fmt(seasonTF.rank)}</div>
            <div class="stat-sub">${fmt(seasonTF.points)} pts · <a href="${PAGES.competitions}" style="color:inherit;">details →</a></div>
          </div>` : ""}
          ${seasonCountdown ? `
          <div class="stat">
            <div class="stat-label">Season ends in</div>
            <div class="stat-value">${seasonCountdown.days}<span class="stat-unit">d ${seasonCountdown.hours}h</span></div>
            <div class="stat-sub">${esc(seasonCountdown.name)}</div>
          </div>` : ""}
        </div>
      </section>

      ${topToday.length ? `
      <div class="card" style="margin-bottom: 20px;">
        <div class="card-head">
          <h3 class="card-title">${esc(topTodayLabel)}</h3>
          <span class="text-muted" style="font-size:11px;">${esc(topTodaySub)}</span>
        </div>
        <div class="podium">
          ${topToday.map((r, i) => {
            const positions = ["Gold", "Silver", "Bronze"];
            const primaryVal = dailyRacers.length ? r.races : r.wpm;
            const primaryLabel = dailyRacers.length ? "races" : "WPM";
            return `
              <div class="podium-card p${i+1}">
                <div class="podium-badge">${i+1}</div>
                <div class="podium-position">${positions[i]}</div>
                <div class="podium-name"><a href="${NT_RACER_URL(r.username || '')}" target="_blank" rel="noopener" style="color:inherit;">${esc(r.displayName || r.username || '')}</a></div>
                <div class="podium-handle">${primaryVal} ${primaryLabel}</div>
              </div>`;
          }).join("")}
        </div>
      </div>` : ""}

      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h3 class="card-title">Quick stats</h3><a href="${PAGES.stats}" class="btn btn-sm ghost">Team stats →</a></div>
          <div class="stat-grid">
            <div class="stat"><div class="stat-label">Team WPM</div><div class="stat-value">${fmt(alltime.avgWPM)}</div><div class="stat-sub">All-time mean</div></div>
            <div class="stat"><div class="stat-label">Accuracy</div><div class="stat-value">${fmt(alltime.avgAcc)}%</div><div class="stat-sub">All-time mean</div></div>
            ${t && t.racers && t.racers.length ? `<div class="stat"><div class="stat-label">Top WPM</div><div class="stat-value">${fmt(Math.max(...t.racers.map(r=>r.highestWPM||0)))}</div><div class="stat-sub">Best in team</div></div>` : ""}
            ${t && t.activePercent ? `<div class="stat"><div class="stat-label">Active</div><div class="stat-value">${fmt(t.activePercent)}%</div><div class="stat-sub">Members racing recently</div></div>` : ""}
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3 class="card-title">Allies</h3><a href="${PAGES.allies}" class="btn btn-sm ghost">Manage →</a></div>
          ${state.allies.length ? renderAlliesPreview() : `<p class="text-dim" style="margin:0;">No allies tracked. Add team tags on the <a href="${PAGES.allies}">Allies</a> page.</p>`}
        </div>
      </div>

      ${!state.lastSync ? `
      <div class="card" style="margin-top:24px; border:1.5px solid var(--yellow); background: var(--yellow-wash);">
        <div class="card-head"><h3 class="card-title">Get started</h3></div>
        <p class="text-dim" style="margin:0;">Click <b>Sync now</b> in the top bar to pull live team data from Nitro Type. Live sync runs through the Claude app's browser — open this page in the Claude desktop app if the sync button says the browser isn't available.</p>
      </div>` : ""}
    `;
  }

  function renderAlliesPreview() {
    const items = state.allies.slice(0, 4).map(tag => {
      const d = state.allyData[tag];
      const agg = d && d.aggregates && d.aggregates.alltime;
      return `
        <div class="progress-row">
          <div><div class="progress-name">${esc(tag)}</div><div class="progress-sub">${d && d.name ? esc(d.name) : "Not synced"}</div></div>
          <div class="progress-num"><div class="big">${agg ? fmt(agg.avgWPM) : "—"}</div><div class="small">${agg ? "WPM avg" : ""}</div></div>
        </div>`;
    }).join("");
    return `<div class="progress-list">${items}</div>`;
  }

  // ----- STATS -----
  function renderStats() {
    const t = state.team;
    if (!t) return emptyState("No team data yet", "Hit Sync now to fetch the latest stats from Nitro Type.");
    const agg = t.aggregates || {};
    const all = agg.alltime || agg.team;
    const day = agg.daily;
    const season = agg.season;
    const seasonInfo = t.season;
    return `
      <div class="page-head"><div>
        <div class="page-eyebrow">${esc(t.tag || TEAM_TAG)} · Team</div>
        <h1 class="page-title">Team stats</h1>
        <p class="page-sub">Aggregated across all ${fmt(t.members)} members. Updated ${state.lastSync ? timeAgo(state.lastSync) : "never"}.</p>
      </div></div>
      <div class="space-y">
        <section><h3 class="section-head">All-time</h3>${all ? renderAggGrid(all) : emptyState("No all-time data", "Sync to populate.")}</section>
        <section><h3 class="section-head">Today</h3>${day ? renderAggGrid(day) : emptyState("No daily races", "The team hasn't raced in the last 24 hours, or data hasn't synced yet.")}</section>
        <section>
          <h3 class="section-head">Current season <span style="font-weight:500; color: var(--text-muted); font-size:12px;">· via Startrack</span></h3>
          ${renderStartrackSeason()}
        </section>
        <section>
          <h3 class="section-head">Trends <span style="font-weight:500; color: var(--text-muted); font-size:12px;">· last 30 days</span></h3>
          ${renderTrendChart()}
        </section>
      </div>
    `;
  }

  function renderTrendChart() {
    const hist = (state.history || []).slice(-30);
    if (hist.length < 2) {
      return `<div class="empty" style="padding:28px;"><h3>Not enough history yet</h3><p>The chart fills in as the dashboard syncs daily. Come back in a day or two to see trends.</p></div>`;
    }
    // Lay out an SVG line chart with race volume per day
    const W = 720, H = 220, P = { l: 44, r: 16, t: 20, b: 32 };
    const vals = hist.map(h => h.dailyRaces || 0);
    const maxV = Math.max(1, ...vals);
    const niceMax = Math.ceil(maxV / 100) * 100 || 100;
    const xStep = (W - P.l - P.r) / Math.max(1, hist.length - 1);
    const yFor = v => P.t + (H - P.t - P.b) * (1 - v / niceMax);
    const points = vals.map((v, i) => `${P.l + i * xStep},${yFor(v)}`).join(" ");
    const yTicks = [0, Math.round(niceMax * 0.5), niceMax];
    const xLabels = hist.length <= 10
      ? hist.map((h, i) => ({ i, label: h.date.slice(5) }))
      : hist.map((h, i) => ({ i, label: h.date.slice(5) })).filter((_, i) => i === 0 || i === hist.length - 1 || i % Math.ceil(hist.length / 6) === 0);
    return `
      <div class="chart-card">
        <div class="chart-head">
          <div><div class="chart-title">Daily team races</div><div class="chart-sub">${hist.length} days · peak ${fmt(maxV)}</div></div>
        </div>
        <svg viewBox="0 0 ${W} ${H}" class="chart-svg" preserveAspectRatio="none" role="img" aria-label="Daily race volume">
          ${yTicks.map(t => `<line x1="${P.l}" x2="${W - P.r}" y1="${yFor(t)}" y2="${yFor(t)}" stroke="var(--border)" stroke-width="1"/>`).join("")}
          ${yTicks.map(t => `<text x="${P.l - 8}" y="${yFor(t) + 4}" text-anchor="end" font-size="10" fill="var(--text-muted)">${fmt(t)}</text>`).join("")}
          <polyline fill="none" stroke="var(--gold)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" points="${points}"/>
          <polyline fill="var(--yellow-wash)" stroke="none" points="${P.l},${H - P.b} ${points} ${P.l + (hist.length-1) * xStep},${H - P.b}"/>
          ${vals.map((v, i) => `<circle cx="${P.l + i * xStep}" cy="${yFor(v)}" r="3" fill="var(--gold-strong)"/>`).join("")}
          ${xLabels.map(({i, label}) => `<text x="${P.l + i * xStep}" y="${H - P.b + 18}" text-anchor="middle" font-size="10" fill="var(--text-muted)">${esc(label)}</text>`).join("")}
        </svg>
      </div>`;
  }
  function renderStartrackSeason() {
    const s = state.startrack && state.startrack.timeframes && state.startrack.timeframes.season;
    if (!s) return emptyState("No season data", "Season stats appear once Startrack has data for TCHE.");
    return `
      <div class="stat-grid">
        <div class="stat gold"><div class="stat-label">Season rank</div><div class="stat-value">#${fmt(s.rank)}</div><div class="stat-sub">Among tracked teams</div></div>
        <div class="stat highlight"><div class="stat-label">Points</div><div class="stat-value">${fmt(s.points)}</div><div class="stat-sub">${fmt(s.ppr)} per race</div></div>
        <div class="stat"><div class="stat-label">Season races</div><div class="stat-value">${fmt(s.races)}</div><div class="stat-sub">${fmt(s.wpm)} WPM avg</div></div>
        <div class="stat"><div class="stat-label">Accuracy</div><div class="stat-value">${fmt(s.accuracy)}%</div><div class="stat-sub">Season mean</div></div>
      </div>`;
  }

  function renderAggGrid(a) {
    return `
      <div class="stat-grid">
        <div class="stat"><div class="stat-label">Total races</div><div class="stat-value">${fmt(a.races)}</div><div class="stat-sub">${fmt(a.members || 0)} racer${a.members === 1 ? "" : "s"}</div></div>
        <div class="stat highlight"><div class="stat-label">Avg WPM</div><div class="stat-value">${fmt(a.avgWPM)}<span class="stat-unit">wpm</span></div><div class="stat-sub">Mean across members</div></div>
        <div class="stat gold"><div class="stat-label">Avg accuracy</div><div class="stat-value">${fmt(a.avgAcc)}<span class="stat-unit">%</span></div><div class="stat-sub">Characters typed vs errors</div></div>
        <div class="stat"><div class="stat-label">Per racer</div><div class="stat-value">${a.members ? fmt(Math.round(a.races / a.members)) : "—"}</div><div class="stat-sub">Races per member</div></div>
      </div>`;
  }

  // Role resolution: roster.json (from Startrack) distinguishes captain from
  // officer; team.json (from Nitro Type's own API) only has officer/member.
  // Prefer roster.json when it's loaded, fall back to team.json's role.
  function resolveRole(username, fallbackRole) {
    const ro = state.roster && Array.isArray(state.roster.racers) ? state.roster.racers.find(r => r.username === username) : null;
    if (ro && ro.role) return ro.role;
    return fallbackRole || "member";
  }
  function rolePill(role) {
    if (role === "captain") return `<span class="pill pill-role-captain">👑 Captain</span>`;
    if (role === "officer") return `<span class="pill pill-role-officer">★ Officer</span>`;
    return "";
  }

  // ----- RACERS -----
  function renderRacers() {
    const t = state.team;
    if (!t) return emptyState("No racers yet", "Sync the team to see every member.");
    const allRacers = (t.racers || []).slice();
    const now = Date.now();
    const DAY_MS = 86400000;

    // Build weekly + daily maps (from Startrack scrapes, keyed by username)
    const weeklyMap = {};
    if (state.weekly && Array.isArray(state.weekly.racers)) {
      state.weekly.racers.forEach(r => { weeklyMap[r.username] = r; });
    }
    const dailyMap = {};
    if (state.daily && Array.isArray(state.daily.racers)) {
      state.daily.racers.forEach(r => { dailyMap[r.username] = r; });
    }
    // Squad + tier (from Startrack's roster API), keyed by username
    const rosterMap = {};
    const hasRosterData = !!(state.roster && Array.isArray(state.roster.racers) && state.roster.racers.length);
    if (hasRosterData) state.roster.racers.forEach(r => { rosterMap[r.username] = r; });
    const squadOf = u => (rosterMap[u] && rosterMap[u].squad) || null;
    const tierOf = u => (rosterMap[u] && rosterMap[u].tier) || null;

    // Apply filter
    const filter = state.racerFilter || "all";
    const squadFilter = state.racerSquadFilter || "all";
    const racers = allRacers.filter(r => {
      if (squadFilter !== "all") {
        const sq = squadOf(r.username) || "No squad";
        if (sq !== squadFilter) return false;
      }
      if (filter === "all") return true;
      if (filter === "recent-join") {
        // joined in last 14 days
        return r.joinStamp && (now - r.joinStamp * 1000) < 14 * DAY_MS;
      }
      if (filter === "recent-active") {
        // active in last 48 hours
        return r.lastLogin && (now - r.lastLogin * 1000) < 2 * DAY_MS;
      }
      if (filter === "inactive") {
        // not active in last 14 days
        return !r.lastLogin || (now - r.lastLogin * 1000) > 14 * DAY_MS;
      }
      return true;
    });

    const { key, dir } = state.racerSort;
    const extract = {
      name: r => (r.displayName || r.username || "").toLowerCase(),
      wpm: r => r.wpm || 0,
      highestWPM: r => r.highestWPM || 0,
      acc: r => r.acc || 0,
      alltime: r => r.allTimeRaces || 0,
      teamRaces: r => r.teamRaces || 0,
      season: r => (r.season && r.season.races) || 0,
      weekly: r => (weeklyMap[r.username] && weeklyMap[r.username].races) || 0,
      daily: r => (dailyMap[r.username] && dailyMap[r.username].races) || 0,
      joinStamp: r => r.joinStamp || 0,
      lastLogin: r => r.lastLogin || 0,
      tier: r => tierOf(r.username) || "ZZ",
      squad: r => (squadOf(r.username) || "zzz").toLowerCase(),
    };
    racers.sort((a,b)=>{
      const av = extract[key](a), bv = extract[key](b);
      if (av === bv) return 0;
      if (typeof av === "string") return dir === "desc" ? (bv > av ? 1 : -1) : (av > bv ? 1 : -1);
      return dir === "desc" ? bv - av : av - bv;
    });

    const WEEKLY_REQ = 100; // team weekly goal
    const DAILY_REQ = 20;   // team daily goal
    const compareSet = new Set(state.compareIds || []);

    const top3 = racers.slice(0, 3);
    const positions = ["Gold", "Silver", "Bronze"];
    const podiumHTML = racers.length >= 1 ? `
      <section class="podium">
        ${top3.map((r, i) => `
          <div class="podium-card p${i+1}">
            <div class="podium-badge">${i+1}</div>
            <div class="podium-position">${positions[i]}</div>
            <div class="podium-name"><a href="racer.html?u=${encodeURIComponent(r.username)}" style="color:inherit;">${esc(r.displayName || r.username)}</a></div>
            <div class="podium-handle">@${esc(r.username)} ${rolePill(resolveRole(r.username, r.role))}</div>
            <div class="podium-stats">
              <div><div class="podium-stat-k">Avg WPM</div><div class="podium-stat-v">${fmt(extract.wpm(r))}</div></div>
              <div><div class="podium-stat-k">Top WPM</div><div class="podium-stat-v">${fmt(extract.highestWPM(r))}</div></div>
              <div><div class="podium-stat-k">Races</div><div class="podium-stat-v">${fmt(extract.alltime(r))}</div></div>
            </div>
          </div>`).join("")}
      </section>` : "";

    const arrow = (k) => key === k ? `<span class="arrow">${dir === "desc" ? "▼" : "▲"}</span>` : "";

    const goalBar = (count, req) => {
      const pct = Math.min(100, Math.round((count / req) * 100));
      const cls = count >= req ? "weekly-bar-met" : count >= req * 0.6 ? "weekly-bar-ok" : "weekly-bar-low";
      return `
        <div class="weekly-cell">
          <div class="weekly-num">${fmt(count)}<span class="weekly-of">/${req}</span></div>
          <div class="weekly-bar-wrap"><div class="weekly-bar ${cls}" style="width:${pct}%;"></div></div>
        </div>`;
    };
    const weeklyBar = (count) => goalBar(count, WEEKLY_REQ);
    const dailyBar = (count) => goalBar(count, DAILY_REQ);
    const tierPill = (tier) => tier ? `<span class="pill pill-tier-${tier.toLowerCase()}">Tier ${esc(tier)}</span>` : `<span class="text-muted" style="font-size:11px;">—</span>`;
    const squadPill = (squad) => squad ? `<span class="squad-pill">${esc(squad)}</span>` : `<span class="text-muted" style="font-size:11px;">—</span>`;

    const rows = racers.map((r, i) => {
      const rankCls = i === 0 ? "top1" : i === 1 ? "top2" : i === 2 ? "top3" : "";
      const weeklyRaces = extract.weekly(r);
      const hasWeeklyData = Object.keys(weeklyMap).length > 0;
      const dailyRaces = extract.daily(r);
      const hasDailyData = Object.keys(dailyMap).length > 0;
      const note = state.notes[r.username];
      const isCompared = compareSet.has(r.username);
      const isNew = r.joinStamp && (now - r.joinStamp * 1000) < 14 * DAY_MS;
      const lastSeenMs = r.lastLogin ? (now - r.lastLogin * 1000) : null;
      const activePill = lastSeenMs == null ? ""
        : lastSeenMs < DAY_MS ? `<span class="pill pill-green">Active today</span>`
        : lastSeenMs < 7 * DAY_MS ? `<span class="pill pill-yellow">${Math.floor(lastSeenMs/DAY_MS)}d</span>`
        : `<span class="pill pill-gray">${Math.floor(lastSeenMs/DAY_MS)}d away</span>`;
      return `
        <tr${isCompared ? ' class="row-compared"' : ''}>
          <td class="rank-cell ${rankCls}">${i+1}</td>
          <td>
            <input type="checkbox" class="compare-check" data-compare="${esc(r.username)}" ${isCompared ? "checked" : ""} aria-label="Compare ${esc(r.displayName || r.username)}">
          </td>
          <td class="name">
            <a href="${NT_RACER_URL(r.username)}" target="_blank" rel="noopener">${esc(r.displayName || r.username)}</a>
            ${isNew ? '<span class="pill pill-gold" style="margin-left:6px;">New</span>' : ''}
            <div class="name-sub">@${esc(r.username)} ${rolePill(resolveRole(r.username, r.role))} ${activePill}</div>
            <a class="profile-link" href="racer.html?u=${encodeURIComponent(r.username)}">View profile →</a>
            ${note && note.text ? `<div class="racer-note">💬 ${esc(note.text)}</div>` : ""}
            ${state.isAdmin ? `<button class="note-edit-btn" data-note-user="${esc(r.username)}">${note && note.text ? "Edit note" : "+ Add note"}</button>` : ""}
          </td>
          <td>${hasRosterData ? squadPill(squadOf(r.username)) : `<span class="text-muted" style="font-size:11px;">—</span>`}</td>
          <td>${hasRosterData ? tierPill(tierOf(r.username)) : `<span class="text-muted" style="font-size:11px;">—</span>`}</td>
          <td class="num num-primary">${fmt(extract.wpm(r))}</td>
          <td class="num">${fmt(extract.highestWPM(r))}</td>
          <td class="num">${fmt(extract.acc(r))}%</td>
          <td class="num">${fmt(extract.alltime(r))}</td>
          <td class="num">${fmt(extract.teamRaces(r))}</td>
          <td class="num">${hasDailyData ? dailyBar(dailyRaces) : `<span class="text-muted" style="font-size:11px;">—</span>`}</td>
          <td class="num">${hasWeeklyData ? weeklyBar(weeklyRaces) : `<span class="text-muted" style="font-size:11px;">—</span>`}</td>
          <td class="num">${fmt(extract.season(r))}</td>
        </tr>`;
    }).join("");

    // Comparison panel (when 2+ selected)
    const compareRacers = (state.compareIds || []).map(id => allRacers.find(r => r.username === id)).filter(Boolean);
    const comparePanel = compareRacers.length >= 2 ? `
      <div class="card compare-panel">
        <div class="card-head">
          <h3 class="card-title">Comparing ${compareRacers.length} racers</h3>
          <button class="btn btn-sm ghost" id="compare-clear">Clear</button>
        </div>
        <div class="compare-grid">
          ${compareRacers.map(r => {
            const weeklyRaces = (weeklyMap[r.username] && weeklyMap[r.username].races) || 0;
            const dailyRaces = (dailyMap[r.username] && dailyMap[r.username].races) || 0;
            const ro = rosterMap[r.username];
            return `
              <div class="compare-card">
                <div class="compare-name"><a href="racer.html?u=${encodeURIComponent(r.username)}" style="color:inherit;">${esc(r.displayName || r.username)}</a></div>
                <div class="compare-handle">@${esc(r.username)} ${rolePill(resolveRole(r.username, r.role))} ${ro && ro.squad ? `<span class="squad-pill" style="margin-left:4px;">${esc(ro.squad)}</span>` : ""} ${ro && ro.tier ? `<span class="pill pill-tier-${ro.tier.toLowerCase()}" style="margin-left:4px;">Tier ${esc(ro.tier)}</span>` : ""}</div>
                <div class="compare-stats">
                  <div><div class="compare-k">Avg WPM</div><div class="compare-v">${fmt(r.wpm)}</div></div>
                  <div><div class="compare-k">Top WPM</div><div class="compare-v">${fmt(r.highestWPM)}</div></div>
                  <div><div class="compare-k">Accuracy</div><div class="compare-v">${fmt(r.acc)}%</div></div>
                  <div><div class="compare-k">Total races</div><div class="compare-v">${fmt(r.allTimeRaces)}</div></div>
                  <div><div class="compare-k">Team races</div><div class="compare-v">${fmt(r.teamRaces)}</div></div>
                  <div><div class="compare-k">Daily</div><div class="compare-v">${fmt(dailyRaces)}/${DAILY_REQ}</div></div>
                  <div><div class="compare-k">Weekly</div><div class="compare-v">${fmt(weeklyRaces)}/${WEEKLY_REQ}</div></div>
                  <div><div class="compare-k">Season races</div><div class="compare-v">${fmt((r.season&&r.season.races)||0)}</div></div>
                  <div><div class="compare-k">Season pts</div><div class="compare-v">${fmt(((state.seasons&&state.seasons.seasons&&state.seasons.seasons[state.seasons.currentValue]&&state.seasons.seasons[state.seasons.currentValue].racers)||[]).find(x=>x.username===r.username)?.points || 0)}</div></div>
                </div>
              </div>`;
          }).join("")}
        </div>
      </div>` : (compareRacers.length === 1 ? `
      <div class="card compare-panel" style="padding: 14px 20px;">
        <p class="text-dim" style="margin:0;font-size:13px;">Pick one more racer to compare, or <a href="#" id="compare-clear">clear</a>.</p>
      </div>` : "");

    const squadNames = hasRosterData ? [...new Set(state.roster.racers.map(r => r.squad || "No squad"))].sort((a,b)=>a.localeCompare(b)) : [];
    const filterChips = `
      <div class="filter-chips" style="align-items:center;">
        <button class="filter-chip ${filter === 'all' ? 'active' : ''}" data-filter="all">All (${allRacers.length})</button>
        <button class="filter-chip ${filter === 'recent-join' ? 'active' : ''}" data-filter="recent-join">Recently joined</button>
        <button class="filter-chip ${filter === 'recent-active' ? 'active' : ''}" data-filter="recent-active">Active (48h)</button>
        <button class="filter-chip ${filter === 'inactive' ? 'active' : ''}" data-filter="inactive">Inactive (14d+)</button>
        ${squadNames.length ? `
          <select id="squad-filter" class="input-select" style="margin-left:auto;">
            <option value="all" ${squadFilter === 'all' ? 'selected' : ''}>All squads</option>
            ${squadNames.map(sq => `<option value="${esc(sq)}" ${squadFilter === sq ? 'selected' : ''}>${esc(sq)}</option>`).join("")}
          </select>` : ""}
      </div>`;

    return `
      <div class="page-head">
        <div>
          <div class="page-eyebrow">${esc(TEAM_TAG)} · Roster</div>
          <h1 class="page-title">Racers</h1>
          <p class="page-sub">${fmt(racers.length)} of ${fmt(allRacers.length)} shown. Click a column to sort, check boxes to compare, filter chips above the table. Team goals: ${DAILY_REQ} races/day · ${WEEKLY_REQ} races/week.</p>
        </div>
        ${state.isAdmin ? `<button class="btn" id="export-csv">Export CSV</button>` : ""}
      </div>

      ${podiumHTML}
      ${comparePanel}
      ${filterChips}

      <div class="table-wrap">
        <table class="racers">
          <thead>
            <tr>
              <th>Rank</th>
              <th style="width:40px;">⇔</th>
              <th data-sort="name" class="${key==='name'?'sorted':''}">Racer${arrow('name')}</th>
              <th data-sort="squad" class="${key==='squad'?'sorted':''}">Squad${arrow('squad')}</th>
              <th data-sort="tier" class="${key==='tier'?'sorted':''}">Tier${arrow('tier')}</th>
              <th data-sort="wpm" class="${key==='wpm'?'sorted':''}" style="text-align:right;">Avg WPM${arrow('wpm')}</th>
              <th data-sort="highestWPM" class="${key==='highestWPM'?'sorted':''}" style="text-align:right;">Top WPM${arrow('highestWPM')}</th>
              <th data-sort="acc" class="${key==='acc'?'sorted':''}" style="text-align:right;">Accuracy${arrow('acc')}</th>
              <th data-sort="alltime" class="${key==='alltime'?'sorted':''}" style="text-align:right;">Total races${arrow('alltime')}</th>
              <th data-sort="teamRaces" class="${key==='teamRaces'?'sorted':''}" style="text-align:right;">Team races${arrow('teamRaces')}</th>
              <th data-sort="daily" class="${key==='daily'?'sorted':''}" style="text-align:right;">Daily goal${arrow('daily')}</th>
              <th data-sort="weekly" class="${key==='weekly'?'sorted':''}" style="text-align:right;">Weekly goal${arrow('weekly')}</th>
              <th data-sort="season" class="${key==='season'?'sorted':''}" style="text-align:right;">Season${arrow('season')}</th>
            </tr>
          </thead>
          <tbody>${rows || `<tr><td colspan="12" style="padding:40px; text-align:center; color: var(--text-dim);">No racers match this filter.</td></tr>`}</tbody>
        </table>
      </div>
    `;
  }

  // ----- RACER PROFILE -----
  function renderRacerProfile() {
    const params = new URLSearchParams(location.search);
    const username = params.get("u") || params.get("user") || "";
    const t = state.team;
    if (!t || !Array.isArray(t.racers)) return emptyState("No roster data yet", "Sync the team to load racer profiles.");
    const racer = t.racers.find(r => r.username === username);
    if (!racer) {
      return emptyState("Racer not found", `No one on the roster matches "${username}".`) +
        `<p style="text-align:center;"><a href="${PAGES.racers}">← Back to Racers</a></p>`;
    }
    document.title = `${TEAM_TAG} · ${racer.displayName || racer.username}`;

    const now = Date.now();
    const DAY_MS = 86400000;
    const DAILY_REQ = 20, WEEKLY_REQ = 100;

    const weeklyMap = {};
    if (state.weekly && Array.isArray(state.weekly.racers)) state.weekly.racers.forEach(r => { weeklyMap[r.username] = r; });
    const dailyMap = {};
    if (state.daily && Array.isArray(state.daily.racers)) state.daily.racers.forEach(r => { dailyMap[r.username] = r; });
    const weekly = weeklyMap[username];
    const daily = dailyMap[username];

    const curSeasonKey = state.seasons && state.seasons.currentValue;
    const curSeasonRacers = (state.seasons && state.seasons.seasons && curSeasonKey && state.seasons.seasons[curSeasonKey] && state.seasons.seasons[curSeasonKey].racers) || [];
    const seasonRow = curSeasonRacers.find(r => r.username === username);

    const rosterEntry = state.roster && Array.isArray(state.roster.racers) ? state.roster.racers.find(r => r.username === username) : null;

    const lastSeenMs = racer.lastLogin ? now - racer.lastLogin * 1000 : null;
    const activePill = lastSeenMs == null ? ""
      : lastSeenMs < DAY_MS ? `<span class="pill pill-green">Active today</span>`
      : lastSeenMs < 7 * DAY_MS ? `<span class="pill pill-yellow">${Math.floor(lastSeenMs/DAY_MS)}d ago</span>`
      : `<span class="pill pill-gray">${Math.floor(lastSeenMs/DAY_MS)}d away</span>`;
    const joinedTxt = racer.joinStamp ? new Date(racer.joinStamp * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";

    const goalBar = (count, req) => {
      const pct = Math.min(100, Math.round((count / req) * 100));
      const cls = count >= req ? "weekly-bar-met" : count >= req * 0.6 ? "weekly-bar-ok" : "weekly-bar-low";
      return `
        <div class="weekly-cell" style="align-items:flex-start;">
          <div class="weekly-num">${fmt(count)}<span class="weekly-of">/${req}</span></div>
          <div class="weekly-bar-wrap"><div class="weekly-bar ${cls}" style="width:${pct}%;"></div></div>
        </div>`;
    };

    const statGrid = `
      <div class="stat-grid">
        <div class="stat"><div class="stat-label">Avg WPM</div><div class="stat-value">${fmt(racer.wpm)}</div></div>
        <div class="stat"><div class="stat-label">Top WPM</div><div class="stat-value">${fmt(racer.highestWPM)}</div></div>
        <div class="stat"><div class="stat-label">Accuracy</div><div class="stat-value">${fmt(racer.acc)}%</div></div>
        <div class="stat"><div class="stat-label">Total races</div><div class="stat-value">${fmt(racer.allTimeRaces)}</div></div>
        <div class="stat"><div class="stat-label">Team races</div><div class="stat-value">${fmt(racer.teamRaces)}</div></div>
        ${seasonRow ? `<div class="stat highlight"><div class="stat-label">Season points</div><div class="stat-value">${fmt(seasonRow.points)}</div><div class="stat-sub">Rank #${fmt(seasonRow.rank)}</div></div>` : ""}
      </div>`;

    const goalsSection = `
      <div class="card">
        <div class="card-head"><h3 class="card-title">Goal progress</h3></div>
        <div class="compare-grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr));">
          <div><div class="compare-k">Today</div>${daily ? goalBar(daily.races, DAILY_REQ) : `<span class="text-muted" style="font-size:13px;">No Startrack data yet</span>`}</div>
          <div><div class="compare-k">This week</div>${weekly ? goalBar(weekly.races, WEEKLY_REQ) : `<span class="text-muted" style="font-size:13px;">No Startrack data yet</span>`}</div>
        </div>
      </div>`;

    // Competitions this racer has appeared in (any tracked event leaderboard)
    const compsEvents = (state.comps && Array.isArray(state.comps.events)) ? state.comps.events : [];
    const compRows = [];
    Object.entries(state.compLeaderboards || {}).forEach(([eventId, lb]) => {
      const lbRacers = (lb && Array.isArray(lb.racers)) ? lb.racers : (Array.isArray(lb) ? lb : []);
      const row = lbRacers.find(r => r.username === username);
      if (row) {
        const ev = compsEvents.find(c => String(c.id) === String(eventId));
        compRows.push({ eventId, title: (ev && ev.title) || `Event ${eventId}`, status: ev && ev.status, ...row });
      }
    });
    const compsSection = compRows.length ? `
      <div class="card">
        <div class="card-head"><h3 class="card-title">Competitions</h3></div>
        <div class="table-wrap">
          <table class="racers">
            <thead><tr><th>Event</th><th style="text-align:right;">Rank</th><th style="text-align:right;">Races</th><th style="text-align:right;">WPM</th><th style="text-align:right;">Accuracy</th><th style="text-align:right;">Points</th><th>Tier</th></tr></thead>
            <tbody>${compRows.map(r => `
              <tr>
                <td>${esc(r.title)}${r.status ? ` <span class="text-muted" style="font-size:11px;">(${esc(r.status)})</span>` : ""}</td>
                <td class="num rank-cell">${fmt(r.rank)}</td>
                <td class="num">${fmt(r.races)}</td>
                <td class="num">${fmt(r.wpm)}</td>
                <td class="num">${r.accuracy != null ? fmt(r.accuracy) + "%" : "—"}</td>
                <td class="num num-primary">${fmt(r.points)}</td>
                <td>${r.tier ? `<span class="pill pill-gray">${esc(r.tier)}</span>` : "—"}</td>
              </tr>`).join("")}</tbody>
          </table>
        </div>
      </div>` : "";

    // Tournament match history — across every tournament on file, not just one.
    const allTournaments = (state.tournament && Array.isArray(state.tournament.tournaments)) ? state.tournament.tournaments : [];
    const tourMatches = [];
    allTournaments.forEach(tour => {
      if (!Array.isArray(tour.rounds)) return;
      tour.rounds.forEach(round => {
        (round.matches || []).forEach(m => {
          const players = m.players || [];
          const myIdx = players.findIndex(p => p && p.racer === username);
          if (myIdx === -1) return;
          const opp = players[1 - myIdx];
          const decided = players.length === 2 && players.every(p => p && !p.placeholder);
          tourMatches.push({ tournament: tour.name, round: round.label, me: players[myIdx], opp, won: decided && m.winner === myIdx, decided });
        });
      });
    });
    const tourSection = tourMatches.length ? `
      <div class="card">
        <div class="card-head"><h3 class="card-title">Tournament history</h3></div>
        <div class="table-wrap">
          <table class="racers">
            <thead><tr><th>Tournament</th><th>Round</th><th>Opponent</th><th style="text-align:right;">Score</th><th style="text-align:right;">Opp. score</th><th>Result</th></tr></thead>
            <tbody>${tourMatches.map(tm => `
              <tr>
                <td>${esc(tm.tournament || "")}</td>
                <td>${esc(tm.round)}</td>
                <td>${tm.opp && !tm.opp.placeholder ? esc(tm.opp.racer) + (tm.opp.teamTag ? ` <span class="text-muted" style="font-size:11px;">[${esc(tm.opp.teamTag)}]</span>` : "") : "TBD"}</td>
                <td class="num">${fmt(tm.me.score)}</td>
                <td class="num">${tm.opp ? fmt(tm.opp.score) : "—"}</td>
                <td>${!tm.decided ? `<span class="pill pill-gray">Pending</span>` : tm.won ? `<span class="pill pill-green">Won</span>` : `<span class="pill pill-yellow">Lost</span>`}</td>
              </tr>`).join("")}</tbody>
          </table>
        </div>
      </div>` : "";

    const note = state.notes[username];
    const noteSection = state.isAdmin ? `
      <div class="card">
        <div class="card-head"><h3 class="card-title">Admin note</h3></div>
        ${note && note.text ? `<p class="racer-note" style="font-size:14px; max-width:none;">💬 ${esc(note.text)}</p>` : `<p class="text-dim" style="margin:0 0 6px;">No note yet.</p>`}
        <button class="note-edit-btn" data-note-user="${esc(username)}">${note && note.text ? "Edit note" : "+ Add note"}</button>
      </div>` : "";

    return `
      <div class="page-head">
        <div>
          <div class="page-eyebrow"><a href="${PAGES.racers}">← Racers</a></div>
          <h1 class="page-title">${esc(racer.displayName || racer.username)}</h1>
          <p class="page-sub">@${esc(racer.username)} ${rolePill(resolveRole(racer.username, racer.role))} ${activePill} · Joined ${esc(joinedTxt)} · <a href="${NT_RACER_URL(racer.username)}" target="_blank" rel="noopener">View on Nitro Type →</a></p>
          ${rosterEntry && (rosterEntry.squad || rosterEntry.tier) ? `<p style="margin:8px 0 0;">${rosterEntry.squad ? `<span class="squad-pill">${esc(rosterEntry.squad)}</span>` : ""} ${rosterEntry.tier ? `<span class="pill pill-tier-${rosterEntry.tier.toLowerCase()}" style="margin-left:6px;">Tier ${esc(rosterEntry.tier)}</span>` : ""}</p>` : ""}
        </div>
      </div>

      <div class="card" style="margin-bottom:20px;">${statGrid}</div>
      ${goalsSection}
      ${compsSection}
      ${tourSection}

      <div class="card">
        <div class="card-head"><h3 class="card-title">React</h3></div>
        ${renderReactionBar("racer-" + username)}
      </div>
      ${noteSection}
    `;
  }

  // ----- ACTIVITY -----
  const ACTIVITY_PALETTE = ["#7C3AED","#22C55E","#F97316","#3B82F6","#EC4899","#EAB308","#14B8A6","#A855F7","#EF4444","#64748B"];

  function renderActivity() {
    const act = state.activity;
    const hours = act && Array.isArray(act.hours) ? act.hours : [];
    if (!hours.length) return emptyState("No activity data yet", "Startrack's hourly activity feed appears here once synced.");

    // Resolve racer display name → username (for profile links), via roster.json first (it's the freshest display-name map) then team.json.
    const byDisplay = {};
    const rosterRacers = (state.roster && Array.isArray(state.roster.racers)) ? state.roster.racers : [];
    rosterRacers.forEach(r => { if (r.displayName) byDisplay[r.displayName] = r.username; });
    if (state.team && Array.isArray(state.team.racers)) {
      state.team.racers.forEach(r => { if (r.displayName && !byDisplay[r.displayName]) byDisplay[r.displayName] = r.username; });
    }

    // Aggregate by hour bucket, preserving chronological order, and by racer total.
    const byHour = new Map();
    const totalsByRacer = new Map();
    hours.forEach(h => {
      if (!h.hour || !h.racer) return;
      if (!byHour.has(h.hour)) byHour.set(h.hour, new Map());
      const bucket = byHour.get(h.hour);
      bucket.set(h.racer, (bucket.get(h.racer) || 0) + (h.races || 0));
      totalsByRacer.set(h.racer, (totalsByRacer.get(h.racer) || 0) + (h.races || 0));
    });
    const orderedHours = [...byHour.keys()].sort();

    const rankedTotals = [...totalsByRacer.entries()].sort((a, b) => b[1] - a[1]);
    const topRacers = rankedTotals.slice(0, 10).map(([name]) => name);
    const colorOf = {};
    topRacers.forEach((name, i) => { colorOf[name] = ACTIVITY_PALETTE[i % ACTIVITY_PALETTE.length]; });
    const OTHER_COLOR = "var(--surface-3)";

    const totalRaces = rankedTotals.reduce((s, [, v]) => s + v, 0);
    const activeRacers = totalsByRacer.size;
    const topRacerEntry = rankedTotals[0];

    const hourLabel = (h) => {
      const d = new Date(h.replace(" ", "T") + "Z");
      if (isNaN(d.getTime())) return h;
      return d.toLocaleTimeString(undefined, { hour: "numeric", hour12: true });
    };

    const bucketTotals = [...byHour.values()].map(bucket => [...bucket.values()].reduce((s, v) => s + v, 0));
    const maxBucketTotal = Math.max(1, ...bucketTotals);

    const chartCols = orderedHours.map(h => {
      const bucket = byHour.get(h);
      const entries = [...bucket.entries()].sort((a, b) => b[1] - a[1]);
      const bucketTotal = entries.reduce((s, [, v]) => s + v, 0);
      const heightPct = Math.max(bucketTotal > 0 ? 3 : 0, Math.round((bucketTotal / maxBucketTotal) * 100));
      const segs = entries.filter(([, races]) => races > 0).map(([name, races]) => {
        const pct = Math.max(1, Math.round((races / Math.max(bucketTotal, 1)) * 100));
        const color = colorOf[name] || OTHER_COLOR;
        return `<div class="activity-bar-seg" style="height:${pct}%; background:${color};" title="${esc(name)}: ${fmt(races)} races"></div>`;
      }).join("");
      return `
        <div class="activity-bar-col">
          <div class="activity-bar-total">${bucketTotal ? fmt(bucketTotal) : ""}</div>
          <div class="activity-bar-track"><div class="activity-bar-fill" style="height:${heightPct}%;">${segs}</div></div>
          <div class="activity-bar-label">${esc(hourLabel(h))}</div>
        </div>`;
    }).join("");

    const legend = topRacers.map(name => {
      const uname = byDisplay[name];
      const label = uname ? `<a href="racer.html?u=${encodeURIComponent(uname)}">${esc(name)}</a>` : esc(name);
      return `<div class="activity-legend-item"><span class="activity-legend-swatch" style="background:${colorOf[name]};"></span>${label} <span class="text-muted">· ${fmt(totalsByRacer.get(name))}</span></div>`;
    }).join("");
    const legendMore = rankedTotals.length > topRacers.length ? `<div class="activity-legend-item"><span class="activity-legend-swatch" style="background:${OTHER_COLOR};"></span>+${rankedTotals.length - topRacers.length} more</div>` : "";

    const rows = rankedTotals.map(([name, races], i) => {
      const uname = byDisplay[name];
      const pct = totalRaces ? ((races / totalRaces) * 100).toFixed(1) : "0.0";
      return `
        <tr>
          <td class="rank-cell">${i + 1}</td>
          <td class="name">${uname ? `<a href="racer.html?u=${encodeURIComponent(uname)}">${esc(name)}</a>` : esc(name)}</td>
          <td class="num num-primary">${fmt(races)}</td>
          <td class="num">${pct}%</td>
        </tr>`;
    }).join("");

    return `
      <div class="page-head"><div>
        <div class="page-eyebrow">Last 24 hours</div>
        <h1 class="page-title">Activity</h1>
        <p class="page-sub">Hourly race activity across the team, from ntstartrack.org. Bar heights are relative to the busiest hour.</p>
      </div></div>

      <div class="stat-grid">
        <div class="stat highlight"><div class="stat-label">Races (24h)</div><div class="stat-value">${fmt(totalRaces)}</div></div>
        <div class="stat"><div class="stat-label">Active racers</div><div class="stat-value">${fmt(activeRacers)}</div></div>
        <div class="stat"><div class="stat-label">Top racer</div><div class="stat-value" style="font-size:18px;">${topRacerEntry ? esc(topRacerEntry[0]) : "—"}</div><div class="stat-sub">${topRacerEntry ? fmt(topRacerEntry[1]) + " races" : ""}</div></div>
      </div>

      <div class="card" style="margin-top:20px;">
        <div class="card-head"><h3 class="card-title">Races by hour</h3></div>
        <div class="activity-chart-wrap"><div class="activity-chart">${chartCols}</div></div>
        <div class="activity-legend">${legend}${legendMore}</div>
      </div>

      <div class="card" style="margin-top:20px;">
        <div class="card-head"><h3 class="card-title">Racer totals (24h)</h3></div>
        <div class="table-wrap">
          <table class="racers">
            <thead><tr><th>#</th><th>Racer</th><th style="text-align:right;">Races</th><th style="text-align:right;">Share</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ----- NOTIFICATIONS -----
  const NOTIF_ICONS = {
    "new-member": "🆕",
    "milestone": "🏁",
    "comp-live": "💰",
    "tournament-win": "🏆",
    "tournament-loss": "💔",
  };

  function unreadNotifCount() {
    if (!state.notifications || !Array.isArray(state.notifications.items)) return 0;
    let lastSeen = 0;
    try { lastSeen = Number(localStorage.getItem("imt-notif-last-seen")) || 0; } catch (_) {}
    return state.notifications.items.filter(n => n.createdAt > lastSeen).length;
  }

  function updateNotifDot() {
    const tab = document.querySelector('nav.tabs a[data-tab="notifications"]');
    if (!tab) return;
    const existing = tab.querySelector(".nav-tab-dot");
    const count = unreadNotifCount();
    if (count > 0 && !existing) {
      const dot = document.createElement("span");
      dot.className = "nav-tab-dot";
      tab.appendChild(dot);
    } else if (count === 0 && existing) {
      existing.remove();
    }
  }

  function renderNotifications() {
    const items = (state.notifications && Array.isArray(state.notifications.items)) ? state.notifications.items : [];
    // Mark as read as soon as the page is viewed.
    try { localStorage.setItem("imt-notif-last-seen", String(Date.now())); } catch (_) {}

    if (!items.length) return emptyState("No notifications yet", "New members, race milestones, live comps, and tournament results will show up here as they happen.");

    // Resolve a username for a profile link: team-sourced events already carry
    // the real username in meta.username; tournament events carry a display
    // name instead, so fall back to resolving it the same way Activity does.
    const byDisplay = {};
    const rosterRacers = (state.roster && Array.isArray(state.roster.racers)) ? state.roster.racers : [];
    rosterRacers.forEach(r => { if (r.displayName) byDisplay[r.displayName] = r.username; });
    if (state.team && Array.isArray(state.team.racers)) {
      state.team.racers.forEach(r => { if (r.displayName && !byDisplay[r.displayName]) byDisplay[r.displayName] = r.username; });
    }
    const allUsernames = new Set();
    if (state.team && Array.isArray(state.team.racers)) state.team.racers.forEach(r => allUsernames.add(r.username));

    const rows = items.map(n => {
      const icon = NOTIF_ICONS[n.type] || "🔔";
      const metaUser = n.meta && n.meta.username;
      const uname = metaUser && allUsernames.has(metaUser) ? metaUser : (metaUser && byDisplay[metaUser]) || null;
      const text = esc(n.text);
      return `
        <div class="notif-item">
          <div class="notif-icon">${icon}</div>
          <div class="notif-body">
            <div class="notif-text">${uname ? `<a href="racer.html?u=${encodeURIComponent(uname)}">${text}</a>` : text}</div>
            <div class="notif-time">${esc(timeAgo(n.createdAt))}</div>
          </div>
        </div>`;
    }).join("");

    return `
      <div class="page-head"><div>
        <div class="page-eyebrow">${esc(TEAM_TAG)} · Feed</div>
        <h1 class="page-title">Notifications</h1>
        <p class="page-sub">New members, race milestones, live comps, and tournament results, detected automatically every sync.</p>
      </div></div>
      <div class="card">
        <div class="notif-list">${rows}</div>
      </div>
    `;
  }

  // ----- COMPETITIONS -----
  function renderCompetitions() {
    const st = state.startrack;
    const t = state.team;
    if (!st && !t) return emptyState("No competition data", "Sync the team to see what's live.");

    const tf = (st && st.timeframes) || {};
    const season = tf.season;
    const day = tf["24h"];
    const week = tf.weekly;
    const seven = tf.week;
    const alltime = tf.alltime;

    const topGrid = season ? `
      <div class="stat-grid">
        <div class="stat gold">
          <div class="stat-label">Season rank</div>
          <div class="stat-value">#${fmt(season.rank)}</div>
          <div class="stat-sub">Among all tracked teams</div>
        </div>
        <div class="stat highlight">
          <div class="stat-label">Season points</div>
          <div class="stat-value">${fmt(season.points)}</div>
          <div class="stat-sub">${fmt(season.ppr)} points per race</div>
        </div>
        <div class="stat">
          <div class="stat-label">Season races</div>
          <div class="stat-value">${fmt(season.races)}</div>
          <div class="stat-sub">Team total this season</div>
        </div>
        <div class="stat">
          <div class="stat-label">Season WPM</div>
          <div class="stat-value">${fmt(season.wpm)}<span class="stat-unit">wpm</span></div>
          <div class="stat-sub">${fmt(season.accuracy)}% accuracy</div>
        </div>
      </div>` : "";

    const periodRow = (label, p, highlight) => {
      if (!p) return "";
      return `
        <div class="progress-row">
          <div style="min-width:0;">
            <div class="progress-name">${esc(label)}</div>
            <div class="progress-sub">Rank #${fmt(p.rank)} · ${fmt(p.races)} races · ${fmt(p.wpm)} WPM · ${fmt(p.accuracy)}% acc</div>
          </div>
          <div class="progress-num">
            <div class="big">${fmt(p.points)}</div>
            <div class="small">points</div>
          </div>
        </div>`;
    };

    const periods = `
      <div class="card" style="margin-top:24px;">
        <div class="card-head">
          <h3 class="card-title">All competitions</h3>
          <span class="text-muted" style="font-size:11px;">Via ntstartrack.org · updated every 10 min</span>
        </div>
        <div class="progress-list">
          ${periodRow("Last 24 hours", day)}
          ${periodRow("Last 7 days", seven)}
          ${periodRow("Weekly", week)}
          ${periodRow("Season", season)}
          ${periodRow("All-time", alltime)}
        </div>
      </div>`;

    // Season racer leaderboard — from Startrack seasons collection
    const seasonsDoc = state.seasons || {};
    const seasonsMap = seasonsDoc.seasons || {};
    const seasonOrder = seasonsDoc.order || Object.keys(seasonsMap);
    const currentKey = seasonsDoc.currentValue;
    const selectedKey = state.selectedSeason || currentKey || seasonOrder[0];
    const selected = selectedKey ? seasonsMap[selectedKey] : null;
    const seasonOptions = seasonOrder.map(k => seasonsMap[k]).filter(Boolean);
    const seasonSwitcher = seasonOptions.length > 1 ? `
      <select id="season-switcher" style="background: var(--surface-2); border: 1px solid var(--border); color: var(--text); padding: 6px 10px; border-radius: 999px; font-size: 12px; font-family: var(--font-display); font-weight: 600; cursor: pointer;">
        ${seasonOptions.map(s => `<option value="${esc(s.value)}" ${s.value === selectedKey ? "selected" : ""}>${esc(s.label)}${s.value === currentKey ? " · Live" : ""}</option>`).join("")}
      </select>` : "";
    const seasonRacers = (selected && Array.isArray(selected.racers)) ? selected.racers.slice().sort((a,b)=> (b.points||0) - (a.points||0)) : [];
    const seasonTotals = seasonRacers.length ? {
      members: seasonRacers.length,
      races: seasonRacers.reduce((s,r)=>s+(r.races||0),0),
      points: seasonRacers.reduce((s,r)=>s+(r.points||0),0),
    } : null;
    const seasonTable = seasonRacers.length ? `
      <div class="table-wrap" style="margin-top:16px;">
        <table class="racers">
          <thead>
            <tr>
              <th>#</th>
              <th>Racer</th>
              <th style="text-align:right;">Races</th>
              <th style="text-align:right;">WPM</th>
              <th style="text-align:right;">Accuracy</th>
              <th style="text-align:right;">Points</th>
              <th style="text-align:right;">PPR</th>
            </tr>
          </thead>
          <tbody>
            ${seasonRacers.map((r, i) => {
              const rankCls = i === 0 ? "top1" : i === 1 ? "top2" : i === 2 ? "top3" : "";
              return `
                <tr>
                  <td class="rank-cell ${rankCls}">${i+1}</td>
                  <td class="name">
                    <a href="${NT_RACER_URL(r.username)}" target="_blank" rel="noopener">${esc(r.displayName || r.username || "")}</a>
                    ${r.rank ? `<div class="name-sub">Startrack #${fmt(r.rank)}</div>` : ""}
                  </td>
                  <td class="num num-primary">${fmt(r.races)}</td>
                  <td class="num">${fmt(r.wpm)}</td>
                  <td class="num">${fmt(r.accuracy)}%</td>
                  <td class="num">${fmt(r.points)}</td>
                  <td class="num">${fmt(r.ppr)}</td>
                </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>` : "";
    const seasonTotalsGrid = seasonTotals ? `
      <div class="stat-grid" style="margin-top:16px;">
        <div class="stat"><div class="stat-label">Participating</div><div class="stat-value">${fmt(seasonTotals.members)}</div><div class="stat-sub">TCHE racers</div></div>
        <div class="stat"><div class="stat-label">Combined races</div><div class="stat-value">${fmt(seasonTotals.races)}</div><div class="stat-sub">Across all members</div></div>
        <div class="stat gold"><div class="stat-label">Combined points</div><div class="stat-value">${fmt(seasonTotals.points)}</div><div class="stat-sub">Season total</div></div>
      </div>` : "";

    // Cash Comps section
    const comps = (state.comps && Array.isArray(state.comps.events)) ? state.comps.events : [];
    const statusWeight = { Upcoming: 0, Active: 1, Live: 1, Ongoing: 1, Concluded: 2, Ended: 2 };
    const sortedComps = comps.slice().sort((a,b) => (statusWeight[a.status] ?? 3) - (statusWeight[b.status] ?? 3));
    const activeOrUpcoming = sortedComps.filter(c => /active|live|ongoing|upcoming/i.test(c.status || ""));
    const concluded = sortedComps.filter(c => /concluded|ended/i.test(c.status || ""));

    // Full standings for whatever comp is live right now — the "large portion
    // of the page" with everyone who's raced in it, mirroring Startrack's own
    // event viewer table (rank, racer, squad, races, WPM, accuracy, points, tier).
    const liveComps = sortedComps.filter(c => /active|live|ongoing/i.test(c.status || ""));
    const liveEventSection = liveComps.map(c => {
      const lb = state.compLeaderboards[c.id];
      const racers = (lb && Array.isArray(lb.racers)) ? lb.racers.slice().sort((a, b) => (b.points || 0) - (a.points || 0)) : [];
      return `
        <div class="card" id="comp-card-${esc(c.id || "")}" style="margin-top:24px;">
          <div class="card-head">
            <div style="min-width:0;">
              <h3 class="card-title">🔴 Live now · ${esc(c.title || "Event")}</h3>
              ${c.desc ? `<p class="text-dim" style="margin:4px 0 0; font-size:12.5px;">${esc(c.desc)}</p>` : ""}
            </div>
            <a href="https://ntstartrack.org/eventviewer?tag=${esc(TEAM_TAG)}&event=${esc(c.id || "")}" target="_blank" rel="noopener" class="btn btn-sm ghost">View on Startrack →</a>
          </div>
          <div class="comp-times" style="border-top:none; padding-top:0; margin:0 0 16px;">
            <span><strong>Start</strong> ${esc(c.start || "—")}</span>
            <span><strong>End</strong> ${esc(c.end || "—")}</span>
            ${lb && lb._syncedAt ? `<span><strong>Updated</strong> ${timeAgo(lb._syncedAt)}</span>` : ""}
          </div>
          ${racers.length ? `
            <div class="table-wrap">
              <table class="racers">
                <thead>
                  <tr>
                    <th>#</th><th>Racer</th><th>Squad</th>
                    <th style="text-align:right;">Races</th>
                    <th style="text-align:right;">WPM</th>
                    <th style="text-align:right;">Accuracy</th>
                    <th style="text-align:right;">Points</th>
                    <th>Tier</th>
                  </tr>
                </thead>
                <tbody>
                  ${racers.map((r, i) => {
                    const rankCls = i === 0 ? "top1" : i === 1 ? "top2" : i === 2 ? "top3" : "";
                    return `
                    <tr>
                      <td class="rank-cell ${rankCls}">${r.rank || i + 1}</td>
                      <td class="name">
                        ${esc(r.displayName || r.username || "")}${r.tag ? ` <span class="text-muted" style="font-weight:500; font-size:11px;">[${esc(r.tag)}]</span>` : ""}
                        ${r.nickname ? `<div class="name-sub">"${esc(r.nickname)}"</div>` : ""}
                      </td>
                      <td class="text-dim">${esc(r.squad || "—")}</td>
                      <td class="num num-primary">${fmt(r.races)}</td>
                      <td class="num">${fmt(r.wpm)}</td>
                      <td class="num">${r.accuracy != null ? fmt(r.accuracy) + "%" : "—"}</td>
                      <td class="num">${fmt(r.points)}</td>
                      <td>${r.tier ? `<span class="pill pill-gray">${esc(r.tier)}</span>` : "—"}</td>
                    </tr>`;
                  }).join("")}
                </tbody>
              </table>
            </div>` : emptyState("No standings yet", "Standings sync in on the next pull (every 15 minutes while the event is live).")}
        </div>`;
    }).join("");

    const compCard = (c, showLeaderboard) => {
      const pillCls = /active|live|ongoing/i.test(c.status || "") ? "status-live" : /upcoming/i.test(c.status || "") ? "status-upcoming" : "status-done";
      const leaderboard = showLeaderboard ? state.compLeaderboards[c.id] : null;
      const hasLb = leaderboard && Array.isArray(leaderboard.racers) && leaderboard.racers.length;
      return `
        <div class="comp-card ${pillCls}" id="comp-card-${esc(c.id || "")}">
          <div class="comp-head">
            <span class="comp-status ${pillCls}">${esc(c.status || "")}</span>
            <a href="https://ntstartrack.org/eventviewer?tag=${esc(TEAM_TAG)}&event=${esc(c.id || "")}" target="_blank" rel="noopener" class="comp-id">#${esc(c.id || "")}</a>
          </div>
          <div class="comp-title">${esc(c.title || "Untitled comp")}</div>
          ${c.desc ? `<div class="comp-desc">${esc(c.desc)}</div>` : ""}
          <div class="comp-times">
            <span><strong>Start</strong> ${esc(c.start || "—")}</span>
            <span><strong>End</strong> ${esc(c.end || "—")}</span>
          </div>
          ${hasLb ? `
            <div class="comp-leaderboard">
              <div class="comp-leaderboard-title">Team standings · ${leaderboard.racers.length} racers</div>
              <ol class="comp-lb-list">
                ${leaderboard.racers.slice(0, 10).map((r, i) => `
                  <li>
                    <span class="comp-lb-rank">${i+1}</span>
                    <span class="comp-lb-name">${esc(r.displayName || r.username || "")}</span>
                    <span class="comp-lb-tier">${esc(r.tier || "")}</span>
                    <span class="comp-lb-points">${fmt(r.points)} <span class="text-muted">pts</span></span>
                  </li>`).join("")}
              </ol>
              ${leaderboard.racers.length > 10 ? `<a href="https://ntstartrack.org/eventviewer?tag=${esc(TEAM_TAG)}&event=${esc(c.id || "")}" target="_blank" rel="noopener" class="comp-lb-more">+ ${leaderboard.racers.length - 10} more on Startrack →</a>` : ""}
            </div>` : (showLeaderboard ? `<div class="comp-leaderboard-empty">Per-racer standings sync in on the next pull.</div>` : "")}
        </div>`;
    };

    const eventJumper = sortedComps.length > 1 ? `
      <select id="event-jumper" class="input-select">
        <option value="">Jump to event…</option>
        ${sortedComps.map(c => `<option value="${esc(c.id || "")}">${esc(c.title || "Untitled comp")}${c.status ? ` · ${esc(c.status)}` : ""}</option>`).join("")}
      </select>` : "";

    const compsSection = `
      <div class="card" style="margin-top:24px;">
        <div class="card-head">
          <div style="min-width:0;">
            <h3 class="card-title">Cash comps</h3>
            <span class="text-muted" style="font-size:11px;">Via Startrack · ${state.comps && state.comps._syncedAt ? "updated " + timeAgo(state.comps._syncedAt) : "not synced"}</span>
          </div>
          ${eventJumper}
        </div>
        ${activeOrUpcoming.length ? `
          <h4 class="section-head" style="font-size:12px; letter-spacing: 1px; text-transform: uppercase; color: var(--gold-strong); margin-bottom: 10px;">Active & upcoming</h4>
          <div class="comp-grid">${activeOrUpcoming.map(c => compCard(c, true)).join("")}</div>
        ` : `
          <div style="padding: 16px; background: var(--surface-2); border-radius: 14px; color: var(--text-dim); font-size: 13.5px; margin-bottom: ${concluded.length ? '20px' : '0'};">
            No active or upcoming cash comps right now. New comps you create in Startrack will appear here automatically within 10 minutes.
          </div>
        `}
        ${concluded.length ? `
          <h4 class="section-head" style="font-size:12px; letter-spacing: 1px; text-transform: uppercase; color: var(--text-muted); margin-top: 20px; margin-bottom: 10px;">Recent concluded</h4>
          <div class="comp-grid">${concluded.slice(0, 6).map(c => compCard(c, false)).join("")}</div>
        ` : ""}
      </div>`;

    return `
      <div class="page-head"><div>
        <div class="page-eyebrow">Season tracker</div>
        <h1 class="page-title">Competitions</h1>
        <p class="page-sub">Live season standings and cash comps for ${esc(t ? t.name : "TCHE")}, pulled from Nitro Type and ntstartrack.org.</p>
      </div></div>
      ${topGrid || emptyState("No season data yet", "Season stats appear once Startrack has data for TCHE.")}
      ${liveEventSection}
      ${compsSection}
      ${periods}
      ${seasonOptions.length ? `
        <div class="card" style="margin-top:24px;">
          <div class="card-head">
            <h3 class="card-title">Season racer leaderboard</h3>
            ${seasonSwitcher}
          </div>
          <p class="text-dim" style="margin:0 0 4px; font-size:13px;">${selected ? esc(selected.label) : ""}${selectedKey === currentKey ? ' · updating every sync' : ' · final results'}</p>
          ${seasonTotalsGrid}
          ${seasonTable || `<p class="text-dim" style="margin-top:14px;">No TCHE racers participated in this season.</p>`}
        </div>` : ""}
    `;
  }

  // ----- TOURNAMENT -----
  function renderTournament() {
    const allTours = (state.tournament && Array.isArray(state.tournament.tournaments)) ? state.tournament.tournaments : [];
    if (!allTours.length) return emptyState("No tournament data yet", "Create a tournament on Startrack and it'll show up here within 15 minutes of the next sync.");

    if (state.selectedTournamentId == null || !allTours.some(t => t.id === state.selectedTournamentId)) {
      const active = allTours.find(t => /active/i.test(t.status || ""));
      state.selectedTournamentId = (active || allTours[0]).id;
    }
    const tour = allTours.find(t => t.id === state.selectedTournamentId) || allTours[0];

    const tournamentSwitcher = allTours.length > 1 ? `
      <select id="tournament-switcher" class="input-select">
        ${allTours.map(t => `<option value="${esc(t.id)}" ${t.id === tour.id ? "selected" : ""}>${esc(t.name || "Tournament " + t.id)}${t.status ? ` · ${esc(t.status)}` : ""}</option>`).join("")}
      </select>` : "";

    const statusCls = /active/i.test(tour.status || "") ? "status-live" : /pending/i.test(tour.status || "") ? "status-upcoming" : "";

    const header = `
      <div class="card" style="margin-bottom:24px;">
        <div class="flex-between">
          <div style="min-width:0;">
            <div class="page-eyebrow">Startrack tournament</div>
            <h2 style="font-family:var(--font-display); font-weight:700; font-size:22px; letter-spacing:-0.3px; margin:4px 0 8px; word-break:break-word;">${esc(tour.name || "Tournament")}</h2>
          </div>
          ${tour.status ? `<span class="comp-status ${statusCls}">${esc(tour.status)}</span>` : ""}
        </div>
        ${tour.description ? `<p class="text-dim" style="margin:0 0 14px;">${esc(tour.description)}</p>` : ""}
        <div class="comp-times" style="border-top:none; padding-top:0; margin-top:0;">
          <span><strong>Start</strong> ${esc(tour.start || "—")}</span>
          <span><strong>End</strong> ${esc(tour.end || "—")}</span>
        </div>
        ${tour.teams && tour.teams.length ? `
          <div class="flex" style="margin-top:14px;">
            ${tour.teams.map(t => `<span class="pill ${t === TEAM_TAG ? "pill-gold" : "pill-gray"}">${esc(t)}</span>`).join("")}
          </div>` : ""}
        ${tour.format ? `<div class="text-muted" style="font-size:12px; margin-top:14px;">${esc(tour.format)}</div>` : ""}
        <div class="text-muted" style="font-size:11px; margin-top:10px;">Via ntstartrack.org${tour._syncedAt ? " · updated " + timeAgo(tour._syncedAt) : ""}</div>
      </div>`;

    const rounds = Array.isArray(tour.rounds) ? tour.rounds : [];

    if (state.tournamentRoundIdx == null) {
      let idx = 0;
      for (let i = rounds.length - 1; i >= 0; i--) {
        if (rounds[i].matches && rounds[i].matches.some(m => m.players && m.players.some(p => !p.placeholder))) { idx = i; break; }
      }
      state.tournamentRoundIdx = idx;
    }
    const selectedRoundIdx = rounds.length ? Math.min(state.tournamentRoundIdx, rounds.length - 1) : 0;
    const selRound = rounds[selectedRoundIdx];

    const roundTabs = rounds.length ? `
      <div class="filter-chips">
        ${rounds.map((r, i) => `<button class="filter-chip ${i === selectedRoundIdx ? "active" : ""}" data-tour-round="${i}">${esc(r.label)}${r.prize ? ` · ${fmt(r.prize)}` : ""}</button>`).join("")}
      </div>` : "";

    const matchCard = (m) => {
      const players = m.players || [];
      const teamRow = (p, idx) => {
        if (!p) return `<div class="bracket-team placeholder"><span class="bracket-name">TBD</span></div>`;
        const isWinner = m.winner === idx;
        const nameTxt = p.placeholder ? (p.racer || "TBD") : (p.racer || "TBD");
        return `
          <div class="bracket-team ${isWinner ? "is-winner" : ""} ${p.placeholder ? "placeholder" : ""}">
            <span class="bracket-seed">${p.seed && p.seed !== "–" && p.seed !== "-" ? "#" + esc(p.seed) : ""}</span>
            <span class="bracket-name">${esc(nameTxt)}${p.teamTag ? ` <span class="bracket-tag">[${esc(p.teamTag)}]</span>` : ""}${p.gold ? " 🏆" : ""}</span>
            <span class="bracket-score">${p.score != null ? fmt(p.score) : "—"}</span>
          </div>`;
      };
      return `
        <div class="bracket-match">
          <div class="bracket-match-id">${esc(m.id || "")}</div>
          ${teamRow(players[0], 0)}
          <div class="bracket-vs">vs</div>
          ${teamRow(players[1], 1)}
        </div>`;
    };

    const hasRealMatches = selRound && selRound.matches && selRound.matches.some(m => m.players && m.players.some(p => !p.placeholder));
    const bracketSection = selRound ? `
      <div class="card">
        <div class="card-head">
          <h3 class="card-title">${esc(selRound.label)}${selRound.prize ? ` <span class="text-muted" style="font-weight:500;">· ${fmt(selRound.prize)} prize</span>` : ""}</h3>
          <span class="text-muted" style="font-size:11px;">${selRound.matches.length} match${selRound.matches.length === 1 ? "" : "es"}</span>
        </div>
        ${roundTabs}
        ${hasRealMatches ? `
          <div class="bracket-grid">
            ${selRound.matches.map(matchCard).join("")}
          </div>` : emptyState("No results yet for this round", "Matches fill in here as races are tracked for this round.")}
      </div>` : emptyState("Bracket not available yet", "Check back once the tournament starts.");

    const seeding = tour.seeding && Array.isArray(tour.seeding.racers) ? tour.seeding.racers : [];
    const seedingSection = seeding.length ? `
      <div class="card" style="margin-top:24px;">
        <div class="card-head">
          <h3 class="card-title">Seeding standings</h3>
          ${tour.seedingHref ? `<a href="https://ntstartrack.org${tour.seedingHref}" target="_blank" rel="noopener" class="btn btn-sm ghost">View on Startrack →</a>` : ""}
        </div>
        <div class="table-wrap">
          <table class="racers">
            <thead><tr><th>#</th><th>Racer</th><th>Squad</th><th style="text-align:right;">Races</th><th style="text-align:right;">WPM</th><th style="text-align:right;">Accuracy</th><th style="text-align:right;">Points</th><th>Tier</th></tr></thead>
            <tbody>
              ${seeding.map((r, i) => `
                <tr>
                  <td class="rank-cell">${r.rank || i + 1}</td>
                  <td class="name">
                    ${esc(r.displayName || r.username || r.racer || "")}${r.tag ? ` <span class="text-muted" style="font-weight:500; font-size:11px;">[${esc(r.tag)}]</span>` : ""}
                    ${r.nickname ? `<div class="name-sub">"${esc(r.nickname)}"</div>` : ""}
                  </td>
                  <td class="text-dim">${esc(r.squad || "—")}</td>
                  <td class="num">${fmt(r.races)}</td>
                  <td class="num">${fmt(r.wpm)}</td>
                  <td class="num">${r.accuracy != null ? fmt(r.accuracy) + "%" : "—"}</td>
                  <td class="num num-primary">${fmt(r.points)}</td>
                  <td>${r.tier ? `<span class="pill pill-gray">${esc(r.tier)}</span>` : "—"}</td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>
      </div>` : (tour.seedingHref ? `
      <div class="card" style="margin-top:24px;">
        <div class="card-head"><h3 class="card-title">Seeding standings</h3></div>
        ${emptyState("No seeding results yet", "Seeding standings appear here once racing starts.")}
      </div>` : "");

    return `
      <div class="page-head">
        <div>
          <div class="page-eyebrow">Bracket</div>
          <h1 class="page-title">Tournament</h1>
          <p class="page-sub">Live bracket for ${esc(tour.name || "the current tournament")}, mirrored from ntstartrack.org.${allTours.length > 1 ? ` ${allTours.length} tournaments on file.` : ""}</p>
        </div>
        ${tournamentSwitcher}
      </div>
      ${header}
      ${bracketSection}
      ${seedingSection}
    `;
  }

  // ----- ALLIES -----
  function renderAllies() {
    const cards = state.allies.map(tag => {
      const d = state.allyData[tag];
      const season = state.allySeason[tag];
      if (!d) return `
        <div class="ally">
          <div class="ally-head">
            <div><div class="ally-tag">${esc(tag)}</div><div class="ally-name">Not synced yet</div></div>
            ${state.isAdmin ? `<button class="btn btn-sm ghost" data-remove-ally="${esc(tag)}">Remove</button>` : ""}
          </div>
          <div class="ally-foot"><span>—</span><a href="${NT_TEAM_URL(tag)}" target="_blank" rel="noopener">View on NT →</a></div>
        </div>`;
      if (d && d.error === "noTeam") return `
        <div class="ally">
          <div class="ally-head">
            <div><div class="ally-tag">${esc(tag)}</div><div class="ally-name" style="color: var(--danger, #c0392b);">Team not found on Nitro Type</div></div>
            ${state.isAdmin ? `<button class="btn btn-sm ghost" data-remove-ally="${esc(tag)}">Remove</button>` : ""}
          </div>
          <div class="text-dim" style="font-size:12.5px; margin-top:4px;">The tag <strong>${esc(tag)}</strong> doesn't match any current Nitro Type team. Check the tag spelling or remove it.</div>
        </div>`;
      const a = (d.aggregates && d.aggregates.alltime) || {};
      const tf = season && season.timeframes;
      const tfRow = (label, data) => data ? `
        <tr>
          <td class="ally-tf-label">${esc(label)}</td>
          <td class="num">${data.rank ? "#" + fmt(data.rank) : "—"}</td>
          <td class="num">${fmt(data.races)}</td>
          <td class="num">${fmt(data.wpm)}</td>
          <td class="num">${fmt(data.accuracy)}%</td>
          <td class="num num-primary">${fmt(data.points)}</td>
          <td class="num">${fmt(data.ppr)}</td>
        </tr>` : "";
      return `
        <div class="ally ally-rich">
          <div class="ally-head">
            <div style="min-width:0;"><div class="ally-tag">${esc(d.tag || tag)}</div><div class="ally-name">${esc(d.name || "")}</div></div>
            ${state.isAdmin ? `<button class="btn btn-sm ghost" data-remove-ally="${esc(tag)}">Remove</button>` : ""}
          </div>
          <div class="ally-stats">
            <div class="ally-stat"><div class="ally-stat-k">Members</div><div class="ally-stat-v">${fmt(d.members)}</div></div>
            <div class="ally-stat"><div class="ally-stat-k">Avg WPM</div><div class="ally-stat-v">${fmt(a.avgWPM)}</div></div>
            <div class="ally-stat"><div class="ally-stat-k">Avg acc</div><div class="ally-stat-v">${fmt(a.avgAcc)}%</div></div>
          </div>
          ${tf ? `
          <div class="ally-tf-wrap">
            <div class="ally-tf-head">
              <span>Startrack performance</span>
              <a href="https://ntstartrack.org/roster?tag=${esc(tag)}" target="_blank" rel="noopener">Roster →</a>
            </div>
            <table class="ally-tf-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Rank</th>
                  <th>Races</th>
                  <th>WPM</th>
                  <th>Acc</th>
                  <th>Points</th>
                  <th>PPR</th>
                </tr>
              </thead>
              <tbody>
                ${tfRow("24 hours", tf["24h"])}
                ${tfRow("7 days", tf.week)}
                ${tfRow("Weekly", tf.weekly)}
                ${tfRow("Season", tf.season)}
                ${tfRow("All-time", tf.alltime)}
              </tbody>
            </table>
          </div>` : (season && season.rank ? `
          <div class="ally-stats" style="border-top:0; padding-top: 0;">
            <div class="ally-stat"><div class="ally-stat-k">Season rank</div><div class="ally-stat-v">#${fmt(season.rank)}</div></div>
            <div class="ally-stat"><div class="ally-stat-k">Season points</div><div class="ally-stat-v">${fmt(season.points)}</div></div>
            <div class="ally-stat"><div class="ally-stat-k">Season races</div><div class="ally-stat-v">${fmt(season.races)}</div></div>
          </div>` : "")}
          <div class="ally-foot"><span>${d._syncedAt ? "Synced " + timeAgo(d._syncedAt) : "—"}</span><a href="${NT_TEAM_URL(tag)}" target="_blank" rel="noopener">View on NT →</a></div>
        </div>`;
    }).join("");

    const addForm = state.isAdmin ? `
      <div class="card" style="margin-bottom:20px;">
        <div class="card-head"><h3 class="card-title">Add an ally</h3></div>
        <form id="add-ally" class="flex" style="gap:12px;">
          <input id="ally-input" placeholder="Team tag — e.g. NTA" maxlength="12" style="flex:1; min-width:200px; text-transform:uppercase; letter-spacing:0.5px;" />
          <button type="submit" class="btn primary">Add ally</button>
        </form>
      </div>` : (state.allies.length === 0 ? `
      <div class="card" style="margin-bottom:20px; background: var(--yellow-wash); border-color: var(--yellow);">
        <p class="text-dim" style="margin:0;">Sign in as admin to add allies.</p>
      </div>` : "");

    // TCHE vs allies comparison table
    const tcheData = state.team ? (state.team.aggregates && state.team.aggregates.alltime) || {} : {};
    const tcheSeason = state.startrack && state.startrack.timeframes && state.startrack.timeframes.season;
    const comparisonTable = state.allies.length && state.team ? `
      <div class="card" style="margin-bottom: 20px;">
        <div class="card-head">
          <h3 class="card-title">Head-to-head comparison</h3>
          <span class="text-muted" style="font-size:11px;">TCHE vs each ally</span>
        </div>
        <div class="table-wrap" style="box-shadow:none; border:0;">
          <table class="racers">
            <thead>
              <tr>
                <th>Team</th>
                <th style="text-align:right;">Members</th>
                <th style="text-align:right;">Alltime races</th>
                <th style="text-align:right;">Avg WPM</th>
                <th style="text-align:right;">Avg acc</th>
                <th style="text-align:right;">Season rank</th>
                <th style="text-align:right;">Season pts</th>
              </tr>
            </thead>
            <tbody>
              <tr style="background: var(--yellow-wash);">
                <td class="name"><strong>[TCHE]</strong> ${esc(state.team.name || "")}</td>
                <td class="num num-primary">${fmt(state.team.members || 0)}</td>
                <td class="num">${fmt(tcheData.races || 0)}</td>
                <td class="num">${fmt(tcheData.avgWPM || 0)}</td>
                <td class="num">${fmt(tcheData.avgAcc || 0)}%</td>
                <td class="num">${tcheSeason ? "#" + fmt(tcheSeason.rank) : "—"}</td>
                <td class="num">${tcheSeason ? fmt(tcheSeason.points) : "—"}</td>
              </tr>
              ${state.allies.map(tag => {
                const d = state.allyData[tag];
                const season = state.allySeason[tag];
                if (!d) return `<tr><td class="name">[${esc(tag)}]</td><td colspan="6" class="num text-muted">Not synced</td></tr>`;
                const a = (d.aggregates && d.aggregates.alltime) || {};
                return `
                  <tr>
                    <td class="name"><strong>[${esc(tag)}]</strong> ${esc(d.name || "")}</td>
                    <td class="num">${fmt(d.members || 0)}</td>
                    <td class="num">${fmt(a.races || 0)}</td>
                    <td class="num">${fmt(a.avgWPM || 0)}</td>
                    <td class="num">${fmt(a.avgAcc || 0)}%</td>
                    <td class="num">${season ? "#" + fmt(season.rank) : "—"}</td>
                    <td class="num">${season ? fmt(season.points) : "—"}</td>
                  </tr>`;
              }).join("")}
            </tbody>
          </table>
        </div>
      </div>` : "";

    return `
      <div class="page-head"><div>
        <div class="page-eyebrow">Partnerships</div>
        <h1 class="page-title">Allies</h1>
        <p class="page-sub">Teams you've allied with. Each ally re-syncs every 10 minutes alongside TCHE.</p>
      </div></div>
      ${addForm}
      ${comparisonTable}
      ${state.allies.length ? `<div class="ally-grid">${cards}</div>` : emptyState("No allies yet", state.isAdmin ? "Add a team tag above to start tracking an ally." : "No allies have been added yet.")}
    `;
  }

  // ----- SHOWDOWN (team vs. team head-to-head) -----
  const SHOWDOWN_TIMEFRAMES = [
    { key: "24h", label: "Last 24h" },
    { key: "week", label: "Last 7 days" },
    { key: "weekly", label: "Weekly" },
    { key: "season", label: "Season" },
    { key: "alltime", label: "All-time" },
  ];
  function renderShowdown() {
    const tags = state.allies.filter(tag => state.allyData[tag] && !state.allyData[tag].error);
    if (!tags.length) return emptyState("No rival to show down with yet", "Add an ally team on the Allies page — Showdown compares TCHE head-to-head against any of your tracked teams.");

    if (state.selectedRivalTag == null || !tags.includes(state.selectedRivalTag)) {
      state.selectedRivalTag = tags[0];
    }
    const rival = state.selectedRivalTag;
    const rivalData = state.allyData[rival];
    const rivalSeason = state.allySeason[rival] || {};
    const rivalTf = rivalSeason.timeframes || {};
    const meTf = (state.startrack && state.startrack.timeframes) || {};

    const rivalSwitcher = tags.length > 1 ? `
      <select id="rival-switcher" class="input-select">
        ${tags.map(t => `<option value="${esc(t)}" ${t === rival ? "selected" : ""}>vs ${esc(t)}</option>`).join("")}
      </select>` : "";

    // Duel score for the "Weekly" timeframe — 1 point to whichever team leads
    // in each of races / WPM / accuracy / points; ties score nobody.
    const weeklyMe = meTf.weekly || {};
    const weeklyRival = rivalTf.weekly || {};
    const duelMetrics = ["races", "wpm", "accuracy", "points"];
    let meScore = 0, rivalScore = 0;
    duelMetrics.forEach(k => {
      const a = weeklyMe[k], b = weeklyRival[k];
      if (a == null || b == null || a === b) return;
      if (a > b) meScore++; else rivalScore++;
    });
    const meLeading = meScore > rivalScore, rivalLeading = rivalScore > meScore;

    const duelHeader = `
      <div class="card" style="margin-bottom:24px; text-align:center;">
        <div class="text-muted" style="font-size:12px; letter-spacing:1px; text-transform:uppercase; margin-bottom:4px;">🏆 Weekly showdown</div>
        <div class="text-dim" style="font-size:12.5px; margin-bottom:18px;">Who's leading this week, scored 1 point per category: races, WPM, accuracy, points.</div>
        <div class="flex-between" style="align-items:center; gap:18px; max-width:480px; margin:0 auto;">
          <div style="flex:1; min-width:0;">
            <div style="font-family:var(--font-display); font-weight:700; font-size:15px; color:${meLeading ? "var(--gold-strong)" : "var(--text)"};">[${esc(TEAM_TAG)}]</div>
            <div class="text-muted" style="font-size:11.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc((state.team && state.team.name) || "")}</div>
          </div>
          <div style="display:flex; align-items:baseline; gap:10px; font-family:var(--font-display); font-weight:800; font-size:40px;">
            <span style="color:${meLeading ? "var(--gold-strong)" : "var(--text-dim)"};">${meScore}</span>
            <span class="text-muted" style="font-size:18px;">–</span>
            <span style="color:${rivalLeading ? "var(--gold-strong)" : "var(--text-dim)"};">${rivalScore}</span>
          </div>
          <div style="flex:1; min-width:0;">
            <div style="font-family:var(--font-display); font-weight:700; font-size:15px; color:${rivalLeading ? "var(--gold-strong)" : "var(--text)"};">[${esc(rival)}]</div>
            <div class="text-muted" style="font-size:11.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc((rivalData && rivalData.name) || "")}</div>
          </div>
        </div>
        ${meScore === rivalScore ? `<div class="text-muted" style="font-size:12px; margin-top:16px;">Dead even this week.</div>` : `<div class="text-muted" style="font-size:12px; margin-top:16px;">${meLeading ? `[${esc(TEAM_TAG)}]` : `[${esc(rival)}]`} leads ${Math.max(meScore, rivalScore)}–${Math.min(meScore, rivalScore)} this week.</div>`}
      </div>`;

    const metricRow = (label, a, b, fmtFn, unit, lowerIsBetter) => {
      if (a == null && b == null) return "";
      const better = (x, y) => lowerIsBetter ? x < y : x > y;
      const aWins = a != null && b != null && better(a, b);
      const bWins = a != null && b != null && better(b, a);
      return `
        <tr>
          <td class="text-dim">${esc(label)}</td>
          <td class="num ${aWins ? "num-primary" : ""}" style="${aWins ? "color: var(--gold-strong); font-weight:700;" : ""}">${a != null ? fmtFn(a) + (unit || "") : "—"}</td>
          <td class="num ${bWins ? "num-primary" : ""}" style="${bWins ? "color: var(--gold-strong); font-weight:700;" : ""}">${b != null ? fmtFn(b) + (unit || "") : "—"}</td>
        </tr>`;
    };

    const tfBreakdown = `
      <div class="card" style="margin-bottom:24px;">
        <div class="card-head">
          <h3 class="card-title">Timeframe breakdown</h3>
          ${rivalSwitcher}
        </div>
        <div class="table-wrap" style="box-shadow:none; border:0;">
          <table class="racers">
            <thead>
              <tr><th></th><th style="text-align:right;">[${esc(TEAM_TAG)}]</th><th style="text-align:right;">[${esc(rival)}]</th></tr>
            </thead>
            <tbody>
              ${SHOWDOWN_TIMEFRAMES.map(({ key, label }) => {
                const a = meTf[key], b = rivalTf[key];
                if (!a && !b) return "";
                return `
                  <tr style="background: var(--surface-2);"><td colspan="3" style="font-weight:700; font-size:12px; letter-spacing:0.5px; text-transform:uppercase; padding-top:14px;">${esc(label)}</td></tr>
                  ${metricRow("Rank", a && a.rank, b && b.rank, v => "#" + fmt(v), "", true)}
                  ${metricRow("Races", a && a.races, b && b.races, fmt)}
                  ${metricRow("WPM", a && a.wpm, b && b.wpm, fmt)}
                  ${metricRow("Accuracy", a && a.accuracy, b && b.accuracy, fmt, "%")}
                  ${metricRow("Points", a && a.points, b && b.points, fmt)}
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      </div>`;

    const meAgg = (state.team && state.team.aggregates && state.team.aggregates.alltime) || {};
    const rivalAgg = (rivalData && rivalData.aggregates && rivalData.aggregates.alltime) || {};
    const teamTotals = `
      <div class="card">
        <div class="card-head"><h3 class="card-title">Team totals</h3></div>
        <div class="table-wrap" style="box-shadow:none; border:0;">
          <table class="racers">
            <thead><tr><th></th><th style="text-align:right;">[${esc(TEAM_TAG)}]</th><th style="text-align:right;">[${esc(rival)}]</th></tr></thead>
            <tbody>
              ${metricRow("Members", state.team && state.team.members, rivalData && rivalData.members, fmt)}
              ${metricRow("All-time races", meAgg.races, rivalAgg.races, fmt)}
              ${metricRow("Avg WPM", meAgg.avgWPM, rivalAgg.avgWPM, fmt)}
              ${metricRow("Avg accuracy", meAgg.avgAcc, rivalAgg.avgAcc, fmt, "%")}
            </tbody>
          </table>
        </div>
      </div>`;

    return `
      <div class="page-head"><div>
        <div class="page-eyebrow">Showdown</div>
        <h1 class="page-title">Head-to-Head</h1>
        <p class="page-sub">A weekly, duel-style matchup between ${esc(TEAM_TAG)} and whichever ally you pick.</p>
      </div></div>
      ${duelHeader}
      ${tfBreakdown}
      ${teamTotals}
    `;
  }

  // ----- INFO (admin-editable feed of posts) -----
  // data/info.json shape: { posts: [{ id, title, content, createdAt, updatedAt }, ...] }
  // normalizeInfo() upgrades the old single-blob {content, updatedAt} shape
  // (from before posts existed) into a one-post feed, so old data keeps working.
  function normalizeInfo(info) {
    if (info && Array.isArray(info.posts)) return info;
    if (info && typeof info.content === "string" && info.content) {
      return { posts: [{ id: "legacy", title: null, content: info.content, createdAt: info.updatedAt || Date.now(), updatedAt: info.updatedAt || Date.now() }] };
    }
    return { posts: [] };
  }
  function newPostId() { return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function renderInfo() {
    const posts = (state.info && Array.isArray(state.info.posts) ? state.info.posts.slice() : [])
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const editingPostId = state._editingInfo || null; // null | "new" | <post id>
    const editing = editingPostId != null;
    const editingPinned = state._editingPinned === true;
    const pinned = state.pinnedNotice && state.pinnedNotice.content ? state.pinnedNotice : null;
    const editingPost = editingPostId && editingPostId !== "new" ? posts.find(p => p.id === editingPostId) : null;
    const latestUpdate = posts.reduce((m, p) => Math.max(m, p.updatedAt || p.createdAt || 0), 0);

    const head = `
      <div class="page-head">
        <div>
          <div class="page-eyebrow">Team information</div>
          <h1 class="page-title">Info</h1>
          <p class="page-sub">${posts.length ? `${fmt(posts.length)} post${posts.length === 1 ? "" : "s"}${latestUpdate ? " · latest " + timeAgo(latestUpdate) : ""}.` : "Nothing posted yet."}</p>
        </div>
        ${state.isAdmin && !editing && !editingPinned ? `
          <div class="flex">
            <button class="btn ghost btn-sm" id="change-pw-btn">Change password</button>
            <button class="btn ghost btn-sm" id="edit-pinned-btn">${pinned ? "Edit pin" : "+ Pin notice"}</button>
            <button class="btn primary" id="edit-info-btn">+ New post</button>
          </div>` : ""}
      </div>`;

    // Pinned notice editor
    if (editingPinned && state.isAdmin) {
      return `
        ${head}
        <div class="card">
          <form id="pinned-form">
            <div class="form-row">
              <label for="pinned-body">Pinned notice <span class="text-muted">(shows at top of Home and Info pages)</span></label>
              <textarea id="pinned-body" placeholder="Short reminder for your team — a race target, event starting soon, important deadline…">${pinned ? esc(pinned.content) : ""}</textarea>
            </div>
            <div class="flex" style="gap:10px;">
              <button type="submit" class="btn primary">Save pin</button>
              <button type="button" class="btn ghost" id="pinned-cancel">Cancel</button>
              ${pinned ? `<button type="button" class="btn danger" id="pinned-remove" style="margin-left:auto;">Remove pin</button>` : ""}
            </div>
          </form>
        </div>`;
    }

    if (editing && state.isAdmin) {
      return `
        ${head}
        <div class="card">
          <form id="info-form">
            <input type="hidden" id="info-post-id" value="${esc(editingPostId)}">
            <div class="form-row">
              <label for="info-title">Title <span class="text-muted">(optional)</span></label>
              <input type="text" id="info-title" placeholder="e.g. Season kickoff, Roster update…" value="${esc(editingPost ? (editingPost.title || "") : "")}">
            </div>
            <div class="form-row">
              <label for="info-body">Post</label>
              <textarea id="info-body" placeholder="Write team rules, meeting times, event dates, roster notes…">${esc(editingPost ? editingPost.content : "")}</textarea>
              <div class="help">Supports simple formatting: <code>## Heading</code>, <code>**bold**</code>, <code>*italic*</code>, <code>- bullet</code>, and <code>[link text](https://url)</code>.</div>
            </div>
            <div class="flex" style="gap:10px;">
              <button type="submit" class="btn primary">${editingPost ? "Save post" : "Publish post"}</button>
              <button type="button" class="btn ghost" id="info-cancel">Cancel</button>
            </div>
          </form>
        </div>`;
    }

    const pinnedCard = pinned ? `
      <div class="pinned-notice">
        <div class="pinned-notice-head">
          <span class="pinned-notice-icon">📌</span>
          <span class="pinned-notice-label">Pinned by Admin</span>
          ${pinned.updatedAt ? `<span class="pinned-notice-time">${timeAgo(pinned.updatedAt)}</span>` : ""}
        </div>
        <div class="info-content">${renderMarkdownLite(pinned.content)}</div>
      </div>` : "";

    if (!posts.length) {
      return `
        ${head}
        ${pinnedCard}
        ${emptyState("No team info yet", state.isAdmin ? "Click + New post above to write team rules, meeting times, event dates and whatever else your team needs." : "The team admin hasn't posted anything yet.")}`;
    }

    const postCard = (p) => `
      <div class="card" style="margin-bottom:16px;">
        <div class="card-head">
          <div style="min-width:0;">
            ${p.title ? `<h3 class="card-title">${esc(p.title)}</h3>` : ""}
            <div class="text-muted" style="font-size:11.5px; margin-top:${p.title ? "4px" : "0"};">
              ${p.createdAt ? timeAgo(p.createdAt) : ""}${p.updatedAt && p.updatedAt !== p.createdAt ? " · edited " + timeAgo(p.updatedAt) : ""}
            </div>
          </div>
          ${state.isAdmin ? `
            <div class="flex" style="gap:6px;">
              <button class="btn btn-sm ghost" data-edit-post="${esc(p.id)}">Edit</button>
              <button class="btn btn-sm danger" data-delete-post="${esc(p.id)}">Delete</button>
            </div>` : ""}
        </div>
        <div class="info-content">${renderMarkdownLite(p.content)}</div>
        ${renderReactionBar("info-" + p.id)}
      </div>`;

    return `
      ${head}
      ${pinnedCard}
      ${posts.map(postCard).join("")}
    `;
  }

  // Lightweight markdown renderer — safe (escapes first), supports:
  // ## heading, ### subheading, **bold**, *italic*, - bullets, 1. ordered,
  // [text](url) links, ---  horizontal rule, blank-line paragraphs, line breaks.
  function renderMarkdownLite(src) {
    const lines = String(src || "").replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let i = 0;
    const inline = (s) => {
      let t = esc(s);
      // links
      t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      // bold then italic
      t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
      // inline code
      t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
      return t;
    };
    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed === "") { i++; continue; }
      if (/^---+$/.test(trimmed)) { out.push("<hr>"); i++; continue; }
      let m;
      if ((m = /^###\s+(.+)$/.exec(trimmed))) { out.push(`<h3>${inline(m[1])}</h3>`); i++; continue; }
      if ((m = /^##\s+(.+)$/.exec(trimmed)))  { out.push(`<h2>${inline(m[1])}</h2>`); i++; continue; }
      if ((m = /^#\s+(.+)$/.exec(trimmed)))   { out.push(`<h2>${inline(m[1])}</h2>`); i++; continue; }
      if (/^[-*]\s+/.test(trimmed)) {
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          items.push(`<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ""))}</li>`);
          i++;
        }
        out.push(`<ul>${items.join("")}</ul>`);
        continue;
      }
      if (/^\d+\.\s+/.test(trimmed)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          items.push(`<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ""))}</li>`);
          i++;
        }
        out.push(`<ol>${items.join("")}</ol>`);
        continue;
      }
      // paragraph — collect until blank line
      const buf = [];
      while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,3}\s|---+$|[-*]\s|\d+\.\s)/.test(lines[i].trim())) {
        buf.push(inline(lines[i]));
        i++;
      }
      out.push(`<p>${buf.join("<br>")}</p>`);
    }
    return out.join("\n");
  }

  function emptyState(h, p) {
    return `<div class="empty"><h3>${esc(h)}</h3><p>${esc(p)}</p></div>`;
  }

  // ========== HANDLERS ==========
  function wireHandlers() {
    // Emoji reactions (any page that includes a reaction bar)
    wireReactions();

    // Season switcher
    const sw = document.getElementById("season-switcher");
    if (sw) sw.addEventListener("change", (e)=>{ state.selectedSeason = e.target.value; render(); });

    // Tournament round switcher
    document.querySelectorAll("[data-tour-round]").forEach(btn => {
      btn.addEventListener("click", () => { state.tournamentRoundIdx = Number(btn.dataset.tourRound); render(); });
    });

    // Jump to a specific cash comp event
    const jumper = document.getElementById("event-jumper");
    if (jumper) jumper.addEventListener("change", (e) => {
      const id = e.target.value;
      if (!id) return;
      const target = document.getElementById(`comp-card-${id}`);
      if (target) {
        if (typeof target.scrollIntoView === "function") target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.classList.add("jump-highlight");
        setTimeout(() => target.classList.remove("jump-highlight"), 1600);
      }
      jumper.value = "";
    });

    // Showdown rival switcher
    const rivalSw = document.getElementById("rival-switcher");
    if (rivalSw) rivalSw.addEventListener("change", (e) => { state.selectedRivalTag = e.target.value; render(); });

    // Tournament switcher (pick which tournament to view)
    const tourSw = document.getElementById("tournament-switcher");
    if (tourSw) tourSw.addEventListener("change", (e) => {
      state.selectedTournamentId = e.target.value;
      state.tournamentRoundIdx = null; // recompute default round for the newly selected tournament
      render();
    });

    // Racer sort
    document.querySelectorAll("table.racers thead th[data-sort]").forEach(th=>{
      th.addEventListener("click", ()=>{
        const key = th.dataset.sort;
        if (state.racerSort.key === key) {
          state.racerSort.dir = state.racerSort.dir === "desc" ? "asc" : "desc";
        } else {
          state.racerSort.key = key;
          state.racerSort.dir = key === "name" ? "asc" : "desc";
        }
        render();
      });
    });

    // Info: posts feed
    const editBtn = document.getElementById("edit-info-btn");
    if (editBtn) editBtn.addEventListener("click", ()=>{ state._editingInfo = "new"; render(); });
    const cpBtn = document.getElementById("change-pw-btn");
    if (cpBtn) cpBtn.addEventListener("click", openChangePwModal);
    const infoCancel = document.getElementById("info-cancel");
    if (infoCancel) infoCancel.addEventListener("click", ()=>{ state._editingInfo = null; render(); });
    document.querySelectorAll("[data-edit-post]").forEach(btn => {
      btn.addEventListener("click", ()=>{ state._editingInfo = btn.dataset.editPost; render(); });
    });
    document.querySelectorAll("[data-delete-post]").forEach(btn => {
      btn.addEventListener("click", async ()=>{
        if (!state.isAdmin) return;
        const id = btn.dataset.deletePost;
        if (!window.confirm("Delete this post? This can't be undone once committed.")) return;
        const posts = (state.info && Array.isArray(state.info.posts) ? state.info.posts : []).filter(p => p.id !== id);
        const payload = { posts };
        try {
          await writeDoc("settings/info", payload);
          state.info = payload;
          render();
        } catch(err) { toast("Could not delete: " + (err.message || err), 4000); }
      });
    });
    const infoForm = document.getElementById("info-form");
    if (infoForm) infoForm.addEventListener("submit", async (e)=>{
      e.preventDefault();
      if (!state.isAdmin) return;
      const editingId = document.getElementById("info-post-id").value;
      const title = document.getElementById("info-title").value.trim();
      const body = document.getElementById("info-body").value;
      if (!body.trim()) { toast("Post can't be empty."); return; }
      const now = Date.now();
      const posts = (state.info && Array.isArray(state.info.posts) ? state.info.posts.slice() : []);
      if (editingId && editingId !== "new") {
        const idx = posts.findIndex(p => p.id === editingId);
        if (idx >= 0) posts[idx] = { ...posts[idx], title: title || null, content: body, updatedAt: now };
      } else {
        posts.unshift({ id: newPostId(), title: title || null, content: body, createdAt: now, updatedAt: now });
      }
      const payload = { posts };
      try {
        await writeDoc("settings/info", payload);
        state.info = payload;
        state._editingInfo = null;
        render();
        toast("Saved ✓");
      } catch(err) {
        toast("Could not save: " + (err.message || err), 4000);
      }
    });

    // Pinned notice edit
    const editPinnedBtn = document.getElementById("edit-pinned-btn");
    if (editPinnedBtn) editPinnedBtn.addEventListener("click", ()=>{ state._editingPinned = true; render(); });
    const pinnedCancel = document.getElementById("pinned-cancel");
    if (pinnedCancel) pinnedCancel.addEventListener("click", ()=>{ state._editingPinned = false; render(); });
    const pinnedForm = document.getElementById("pinned-form");
    if (pinnedForm) pinnedForm.addEventListener("submit", async (e)=>{
      e.preventDefault();
      if (!state.isAdmin) return;
      const body = document.getElementById("pinned-body").value.trim();
      if (!body) { toast("Pinned notice can't be empty."); return; }
      const payload = { content: body, updatedAt: Date.now() };
      try {
        await writeDoc("settings/pinnedNotice", payload);
        state.pinnedNotice = payload;
        state._editingPinned = false;
        render();
        toast("Pinned ✓");
      } catch(err) { toast("Could not save: " + (err.message || err), 4000); }
    });
    const pinnedRemove = document.getElementById("pinned-remove");
    if (pinnedRemove) pinnedRemove.addEventListener("click", async ()=>{
      if (!state.isAdmin) return;
      try {
        await state.db.doc("settings/pinnedNotice").delete();
        state.pinnedNotice = null;
        state._editingPinned = false;
        render();
        toast("Pin removed");
      } catch(err) { toast("Could not remove: " + (err.message || err), 4000); }
    });

    // Racer filter chips
    document.querySelectorAll(".filter-chip[data-filter]").forEach(btn => {
      btn.addEventListener("click", ()=>{ state.racerFilter = btn.dataset.filter; render(); });
    });

    // Racer squad filter
    const squadFilterSel = document.getElementById("squad-filter");
    if (squadFilterSel) squadFilterSel.addEventListener("change", () => {
      state.racerSquadFilter = squadFilterSel.value;
      render();
    });

    // Compare checkboxes
    document.querySelectorAll(".compare-check[data-compare]").forEach(cb => {
      cb.addEventListener("change", ()=>{
        const u = cb.dataset.compare;
        state.compareIds = state.compareIds || [];
        if (cb.checked) {
          if (!state.compareIds.includes(u)) state.compareIds.push(u);
        } else {
          state.compareIds = state.compareIds.filter(x => x !== u);
        }
        render();
      });
    });
    const compareClear = document.getElementById("compare-clear");
    if (compareClear) compareClear.addEventListener("click", (e)=>{ e.preventDefault(); state.compareIds = []; render(); });

    // Notes
    document.querySelectorAll(".note-edit-btn[data-note-user]").forEach(btn=>{
      btn.addEventListener("click", ()=>openNoteModal(btn.dataset.noteUser));
    });

    // CSV export
    const csvBtn = document.getElementById("export-csv");
    if (csvBtn) csvBtn.addEventListener("click", exportRacersCSV);

    // Allies
    const addAlly = document.getElementById("add-ally");
    if (addAlly) addAlly.addEventListener("submit", async (e)=>{
      e.preventDefault();
      if (!state.isAdmin) { toast("Admin only."); return; }
      const inp = document.getElementById("ally-input");
      const tag = inp.value.trim().toUpperCase().replace(/[^A-Z0-9]/g,"");
      if (!tag) return;
      if (tag === TEAM_TAG) { toast("That's your own team."); return; }
      if (state.allies.includes(tag)) { toast("Already added"); return; }
      state.allies.push(tag);
      if (state.db) await writeDoc("settings/allies", { tags: state.allies });
      inp.value = "";
      render();
      if (state.mcp) {
        try {
          const a = await fetchTeamViaBrowser(tag);
          const ap = normalizeTeam(a);
          ap._syncedAt = Date.now();
          state.allyData[tag] = ap;
          if (state.db) await writeDoc(`snapshot/allies/data/${tag}`, ap);
          render();
          toast(`Synced ally ${tag} ✓`);
        } catch(err) { toast(`Ally added, sync failed: ${err.message}`, 4000); }
      } else {
        toast(`Ally ${tag} added. Click Sync now to fetch.`);
      }
    });

    document.querySelectorAll("[data-remove-ally]").forEach(btn=>{
      btn.addEventListener("click", async ()=>{
        if (!state.isAdmin) return;
        const tag = btn.dataset.removeAlly;
        state.allies = state.allies.filter(t=>t !== tag);
        delete state.allyData[tag];
        if (state.db) {
          await writeDoc("settings/allies", { tags: state.allies });
          try { await state.db.doc(`snapshot/allies/data/${tag}`).delete(); } catch(_){}
        }
        render();
      });
    });
  }

  // ========== UTILS ==========
  function esc(s) {
    if (s == null) return "";
    return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  }
  function stripHtml(s) { return String(s||"").replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim(); }
  function fmt(n) {
    if (n == null || n === "") return "—";
    if (typeof n === "string" && isNaN(Number(n))) return esc(n);
    const num = Number(n);
    if (isNaN(num)) return esc(String(n));
    return num.toLocaleString();
  }
  function timeAgo(ms) {
    const s = Math.floor((Date.now()-ms)/1000);
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.floor(s/60) + "m ago";
    if (s < 86400) return Math.floor(s/3600) + "h ago";
    return Math.floor(s/86400) + "d ago";
  }

  // ========== BOOT ==========
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
