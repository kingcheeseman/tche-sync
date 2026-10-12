// TCHE sync — pulls team data from Nitro Type and ntstartrack.org,
// writes JSON files to data/ which the dashboard reads over raw.githubusercontent.com.
//
// Runs on GitHub Actions every 15 minutes. No Claude credits, no Mac needed.

import { chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";

const TEAM_TAG = process.env.TCHE_TAG || "TCHE";
const ALLY_TAGS = (process.env.ALLY_TAGS || "").split(",").map(s => s.trim()).filter(Boolean);
const DATA_DIR = "data";

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function writeJSON(path, obj) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(`${DATA_DIR}/${path}`, JSON.stringify(obj, null, 2));
  console.log(`  wrote data/${path}`);
}

// ---- helpers ----
const wpmCalc = (t, s) => (!s || !t) ? 0 : Math.round((t / 5) / (s / 60));
const accCalc = (t, e) => {
  if (!t) return 0;
  const T = t + e;
  return T ? +((t / T) * 100).toFixed(2) : 0;
};

function normalizeTeamJSON(raw, tag) {
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
    const sb = sm && sm.played != null ? { races: sm.played, typed: sm.typed || 0, errs: sm.errs || 0, secs: sm.secs || 0 } : null;
    return {
      username: m.username,
      displayName: m.displayName || m.username,
      role: m.role || "member",
      joinStamp: m.joinStamp,
      allTimeRaces: m.racesPlayed || 0,
      wpm: m.avgSpeed || 0,
      highestWPM: m.highestSpeed || 0,
      teamRaces: m.played || 0,
      acc: accCalc(m.typed || 0, m.errs || 0),
      season: sb ? { races: sb.races, wpm: wpmCalc(sb.typed, sb.secs), acc: accCalc(sb.typed, sb.errs) } : null,
      status: m.status,
      lastLogin: m.lastLogin,
    };
  });
  const alltime = teamBoards.alltime ? {
    races: teamBoards.alltime.races,
    avgWPM: wpmCalc(teamBoards.alltime.typed, teamBoards.alltime.secs),
    avgAcc: accCalc(teamBoards.alltime.typed, teamBoards.alltime.errs),
    members: members.length,
  } : null;
  const daily = teamBoards.daily ? {
    races: teamBoards.daily.races,
    avgWPM: wpmCalc(teamBoards.daily.typed, teamBoards.daily.secs),
    avgAcc: accCalc(teamBoards.daily.typed, teamBoards.daily.errs),
    members: members.length,
  } : null;
  const sm2 = racers.filter(x => x.season);
  const seasonAgg = sm2.length ? {
    races: sm2.reduce((s, x) => s + x.season.races, 0),
    avgWPM: Math.round(sm2.reduce((s, x) => s + x.season.wpm, 0) / sm2.length),
    avgAcc: +(sm2.reduce((s, x) => s + x.season.acc, 0) / sm2.length).toFixed(2),
    members: sm2.length,
  } : null;
  return {
    tag: info.tag || tag,
    name: info.name || info.tag || tag,
    members: members.length,
    activePercent: info.activePercent,
    createdStamp: info.createdStamp,
    otherInfo: info.otherRequirements || info.otherInfo,
    profileViews: info.profileViews,
    leagueTier: info.leagueTier,
    racers,
    aggregates: { alltime, daily, season: seasonAgg },
    season: null,
    _syncedAt: Date.now(),
  };
}

// ---- scrapers ----
async function fetchTeamAPI(context, tag) {
  const page = await context.newPage();
  try {
    const res = await page.goto(`https://www.nitrotype.com/api/v2/teams/${encodeURIComponent(tag)}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    const body = await page.evaluate(() => document.body.innerText);
    const start = body.indexOf("{"), end = body.lastIndexOf("}");
    if (start < 0 || end < 0) throw new Error("NT didn't return JSON");
    const json = JSON.parse(body.slice(start, end + 1));
    if (json && json.status && !/^ok$/i.test(json.status)) {
      return { error: json.status, tag, _syncedAt: Date.now(), aggregates: { alltime: null, daily: null, season: null }, members: 0, racers: [] };
    }
    return normalizeTeamJSON(json, tag);
  } finally { await page.close(); }
}

async function startrackTimeframes(context, tag) {
  const page = await context.newPage();
  try {
    // Use /leaderboards (Team Leaderboards tab) so even low-ranked allies are reachable
    await page.goto("https://ntstartrack.org/leaderboards", { waitUntil: "networkidle", timeout: 60000 });
    await sleep(2500);
    const result = await page.evaluate(async (TAG) => {
      const sleepIn = ms => new Promise(r => setTimeout(r, ms));
      const clickText = (texts) => {
        const want = Array.isArray(texts) ? texts : [texts];
        const els = [...document.querySelectorAll("button, [role='button'], a, .tab, li")];
        for (const t of want) {
          const b = els.find(x => x.textContent.trim() === t);
          if (b) { b.click(); return t; }
        }
        return null;
      };
      // Try to switch to Team Leaderboards tab (names vary)
      clickText(["Team Leaderboards", "Teams", "Team"]);
      await sleepIn(1500);

      const needle = `[${TAG}]`;
      function findRow() {
        return [...document.querySelectorAll("tr")].find(r => r.textContent.includes(needle));
      }
      async function selectTagFromDropdown() {
        // Startrack uses a .tag-dropdown select; try that first
        const sels = [...document.querySelectorAll("select")];
        for (const s of sels) {
          try {
            if ([...s.options].some(o => o.value === TAG)) {
              s.value = TAG;
              s.dispatchEvent(new Event("change", { bubbles: true }));
              for (let i = 0; i < 20; i++) { await sleepIn(400); if (findRow()) return true; }
              return !!findRow();
            }
          } catch(_){}
        }
        return false;
      }
      async function typeIntoSearch() {
        const inputs = [...document.querySelectorAll("input")].filter(i => {
          const t = (i.type || "").toLowerCase();
          return !t || t === "text" || t === "search";
        });
        for (const inp of inputs) {
          try {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
            const prev = inp.value;
            setter.call(inp, TAG);
            inp.dispatchEvent(new Event("input", { bubbles: true }));
            inp.dispatchEvent(new Event("change", { bubbles: true }));
            await sleepIn(900);
            if (findRow()) return true;
            setter.call(inp, prev || "");
            inp.dispatchEvent(new Event("input", { bubbles: true }));
          } catch(_){}
        }
        return false;
      }
      async function scrollFind() {
        const containers = [document.scrollingElement, ...document.querySelectorAll("div, section, main, table, tbody")].filter(el => {
          try { const s = getComputedStyle(el); return (s.overflowY === "auto" || s.overflowY === "scroll") && el.scrollHeight > el.clientHeight; } catch(_){ return false; }
        });
        const scrollables = [window, ...containers];
        for (let i = 0; i < 100; i++) {
          if (findRow()) return true;
          for (const s of scrollables) {
            try {
              if (s === window) window.scrollBy(0, 2000);
              else s.scrollTop = s.scrollTop + 2000;
            } catch(_){}
          }
          await sleepIn(300);
        }
        return !!findRow();
      }
      async function cap() {
        await sleepIn(1200);
        if (!findRow()) { if (!(await selectTagFromDropdown())) { if (!(await typeIntoSearch())) { await scrollFind(); } } }
        const row = findRow();
        if (!row) return null;
        const c = [...row.querySelectorAll("td")].map(td => td.textContent.replace(/\s+/g, " ").trim());
        const rm = c[0] && c[0].match(/^(\d+)/);
        const pn = s => { if (!s) return 0; const n = Number(String(s).replace(/[,%]/g, "")); return isNaN(n) ? 0 : n; };
        return { rank: rm ? Number(rm[1]) : null, races: pn(c[1]), accuracy: pn(c[2]), wpm: pn(c[3]), points: pn(c[4]), ppr: pn(c[5]) };
      }
      const out = {};
      const map = { "24h": "24 Hour", "season": "Season", "week": "7 Day", "weekly": "Weekly", "alltime": "All-Time" };
      for (const [k, label] of Object.entries(map)) {
        clickText(label);
        await sleepIn(1500);
        // Reset page-scroll before each capture so sticky-filtered table loads fresh
        try { window.scrollTo(0, 0); } catch(_){}
        out[k] = await cap();
      }
      return out;
    }, tag);
    const season = result.season;
    return {
      timeframes: result,
      rank: season && season.rank,
      races: season && season.races,
      accuracy: season && season.accuracy,
      wpm: season && season.wpm,
      points: season && season.points,
      ppr: season && season.ppr,
      source: "ntstartrack.org",
      _syncedAt: Date.now(),
    };
  } finally { await page.close(); }
}

async function fetchComps(context) {
  const page = await context.newPage();
  try {
    await page.goto(`https://ntstartrack.org/events?tag=${TEAM_TAG}`, { waitUntil: "networkidle", timeout: 60000 });
    await sleep(2500);
    const events = await page.evaluate(() => {
      return [...document.querySelectorAll(".m-event")].map(e => {
        const id = [...e.querySelectorAll("span")].find(s => /^#\d+$/.test(s.textContent.trim()))?.textContent.trim().replace("#", "") || null;
        const status = e.querySelector(".m-status")?.textContent?.trim() || null;
        const title = e.querySelector(".m-event__title")?.textContent?.trim() || null;
        const desc = e.querySelector(".m-event__desc")?.textContent?.trim() || null;
        const times = [...e.querySelectorAll(".m-event__times span")].map(s => s.textContent.replace(/\s+/g, " ").trim());
        return { id, status, title, desc, start: times[0] ? times[0].replace(/^▶\s*Start\s*/, "") : null, end: times[1] ? times[1].replace(/^■\s*End\s*/, "") : null };
      });
    });
    return { events, source: "ntstartrack.org", _syncedAt: Date.now() };
  } finally { await page.close(); }
}

async function fetchSeasonRacers(context, timeframeLabel) {
  const page = await context.newPage();
  try {
    await page.goto("https://ntstartrack.org/leaderboards", { waitUntil: "networkidle", timeout: 60000 });
    await sleep(2500);
    return await page.evaluate(async (label) => {
      const sleepIn = ms => new Promise(r => setTimeout(r, ms));
      const bb = [...document.querySelectorAll("button, a")].find(x => x.textContent.trim() === "Individual Leaderboards");
      if (bb) bb.click();
      await sleepIn(1500);
      const s = [...document.querySelectorAll("button, [role='button']")].find(x => x.textContent.trim() === label);
      if (s) s.click();
      await sleepIn(2500);
      const ts = [...document.querySelectorAll("select")].find(se => se.classList.contains("tag-dropdown"));
      if (ts) {
        for (let i = 0; i < 20; i++) { if ([...ts.options].some(o => o.value === "TCHE")) break; await sleepIn(400); }
        ts.value = "TCHE";
        ts.dispatchEvent(new Event("change", { bubbles: true }));
        for (let i = 0; i < 25; i++) { await sleepIn(500); if ([...document.querySelectorAll("tr")].some(r => /\[TCHE\]/.test(r.textContent))) break; }
        await sleepIn(800);
      }
      const ss = [...document.querySelectorAll("select")].find(se => [...se.options].some(o => /\d{1,2}\/\d{1,2}\/\d{4}/.test(o.textContent)));
      const op = ss && ss.options[ss.selectedIndex];
      const value = op ? op.value : null;
      const seasonLabel = op ? op.textContent.trim() : null;
      const rows = [...document.querySelectorAll("tr")].filter(r => /\[TCHE\]/.test(r.textContent)).map(r => {
        const c = [...r.querySelectorAll("td")].map(td => td.textContent.replace(/\s+/g, " ").trim());
        const link = r.querySelector("a[href*='/racer/']");
        const u = link ? link.href.split("/racer/")[1].split(/[?#]/)[0] : null;
        const f = c[0] || "";
        const m = f.match(/^(\d+)\[TCHE\](.+?)"(.*)"$/);
        return {
          rank: m ? Number(m[1]) : null,
          username: u,
          displayName: m ? m[2].trim() : f,
          races: Number((c[3] || "").replace(/,/g, "")) || 0,
          accuracy: parseFloat((c[4] || "").replace("%", "")) || 0,
          wpm: parseFloat(c[5]) || 0,
          points: Number((c[6] || "").replace(/,/g, "")) || 0,
          ppr: Number((c[7] || "").replace(/,/g, "")) || 0,
        };
      });
      return { value, label: seasonLabel, racers: rows };
    }, timeframeLabel);
  } finally { await page.close(); }
}

async function fetchCompLeaderboard(context, eventId) {
  const page = await context.newPage();
  try {
    await page.goto(`https://ntstartrack.org/eventviewer?tag=${TEAM_TAG}&event=${eventId}`, { waitUntil: "networkidle", timeout: 60000 });
    await sleep(2500);
    return await page.evaluate(() => {
      const racers = [...document.querySelectorAll(".m-card")].map(c => {
        const name = c.querySelector(".m-card__name, .m-name, h3, h4")?.textContent?.trim() || null;
        const points = Number((c.querySelector(".m-card__points, .m-points")?.textContent || "").replace(/[^\d.-]/g, "")) || 0;
        const tier = c.querySelector(".m-card__tier, .m-tier")?.textContent?.trim() || null;
        return { name, points, tier };
      });
      return racers;
    });
  } finally { await page.close(); }
}

// ---- main ----
async function main() {
  const started = Date.now();
  console.log(`TCHE sync started at ${new Date().toISOString()}`);
  console.log(`Team: ${TEAM_TAG}; allies: ${ALLY_TAGS.join(", ") || "(none)"}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 900 },
  });

  const results = { ok: [], failed: [] };
  const safe = async (label, fn) => {
    try { const r = await fn(); results.ok.push(label); return r; }
    catch (e) { results.failed.push(`${label}: ${e.message}`); console.error(`FAIL ${label}:`, e.message); return null; }
  };

  // Team (NT)
  const team = await safe("team", () => fetchTeamAPI(context, TEAM_TAG));
  if (team) await writeJSON("team.json", team);

  // Startrack timeframes (all 5)
  const startrack = await safe("startrack", () => startrackTimeframes(context, TEAM_TAG));
  if (startrack) await writeJSON("startrack.json", startrack);

  // Comps
  const comps = await safe("comps", () => fetchComps(context));
  if (comps) await writeJSON("comps.json", comps);

  // Seasons
  const season = await safe("season", () => fetchSeasonRacers(context, "Season"));
  if (season && season.value && season.racers.length) {
    // Merge with existing seasons.json if present
    let existing = { seasons: {}, order: [], currentValue: null };
    try { const prev = await import("node:fs").then(fs => fs.readFileSync(`${DATA_DIR}/seasons.json`, "utf8")); existing = JSON.parse(prev); } catch (_) {}
    existing.seasons = existing.seasons || {};
    existing.order = existing.order || [];
    existing.seasons[season.value] = { value: season.value, label: season.label, racers: season.racers, isCurrent: true, _syncedAt: Date.now() };
    // Mark others as not current
    for (const k of Object.keys(existing.seasons)) { if (k !== season.value) existing.seasons[k].isCurrent = false; }
    if (!existing.order.includes(season.value)) existing.order.unshift(season.value);
    existing.currentValue = season.value;
    existing._syncedAt = Date.now();
    await writeJSON("seasons.json", existing);
  }

  // Weekly
  const weekly = await safe("weekly", () => fetchSeasonRacers(context, "Weekly"));
  if (weekly) await writeJSON("weekly.json", { racers: weekly.racers || [], _syncedAt: Date.now() });

  // Daily (24h)
  const daily = await safe("daily", () => fetchSeasonRacers(context, "24 Hour"));
  if (daily) await writeJSON("daily.json", { racers: daily.racers || [], _syncedAt: Date.now() });

  // Comp leaderboards for active comps
  if (comps && comps.events) {
    const active = comps.events.filter(e => /active|live|ongoing|open/i.test(e.status || ""));
    const compLbs = {};
    for (const c of active) {
      if (!c.id) continue;
      const racers = await safe(`comp-lb-${c.id}`, () => fetchCompLeaderboard(context, c.id));
      if (racers) compLbs[c.id] = { eventId: c.id, racers, _syncedAt: Date.now() };
    }
    if (Object.keys(compLbs).length) await writeJSON("compLeaderboards.json", compLbs);
  }

  // Allies: NT team + Startrack timeframes
  const allyTeams = {};
  const allySeason = {};
  for (const tag of ALLY_TAGS) {
    const at = await safe(`ally-${tag}`, () => fetchTeamAPI(context, tag));
    if (at) allyTeams[tag] = at;
    const as = await safe(`ally-sr-${tag}`, () => startrackTimeframes(context, tag));
    if (as) allySeason[tag] = as;
  }
  if (Object.keys(allyTeams).length) await writeJSON("allies.json", allyTeams);
  if (Object.keys(allySeason).length) await writeJSON("allySeason.json", allySeason);

  // History row (one per UTC day — merges with existing history.json)
  const today = new Date().toISOString().slice(0, 10);
  let history = {};
  try { const prev = await import("node:fs").then(fs => fs.readFileSync(`${DATA_DIR}/history.json`, "utf8")); history = JSON.parse(prev); } catch (_) {}
  const dailyRaces = (team && team.aggregates && team.aggregates.daily && team.aggregates.daily.races) || 0;
  const allTimeRaces = (team && team.aggregates && team.aggregates.alltime && team.aggregates.alltime.races) || 0;
  const seasonPoints = (startrack && startrack.timeframes && startrack.timeframes.season && startrack.timeframes.season.points) || 0;
  const seasonRank = (startrack && startrack.timeframes && startrack.timeframes.season && startrack.timeframes.season.rank) || null;
  history[today] = { dailyRaces, allTimeRaces, seasonPoints, seasonRank, _syncedAt: Date.now() };
  await writeJSON("history.json", history);

  // Index — tells the dashboard what's here and when
  await writeJSON("index.json", {
    _syncedAt: Date.now(),
    team: team ? team._syncedAt : null,
    startrack: startrack ? startrack._syncedAt : null,
    comps: comps ? comps._syncedAt : null,
    seasons: season ? Date.now() : null,
    weekly: weekly ? Date.now() : null,
    daily: daily ? Date.now() : null,
    allies: Object.keys(allyTeams),
    took: Date.now() - started,
    ok: results.ok,
    failed: results.failed,
  });

  await browser.close();
  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`OK: ${results.ok.join(", ")}`);
  if (results.failed.length) {
    console.log(`FAILED: ${results.failed.join(" | ")}`);
  }
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
