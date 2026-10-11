# tche-sync

Automated TCHE team data sync. Runs every 15 minutes on GitHub Actions, scrapes
Nitro Type + Startrack, commits JSON files to `data/`. The dashboard reads from
`https://raw.githubusercontent.com/<YOU>/tche-sync/main/data/*.json`.

**No Claude credits. No Mac dependency. Free.**

## One-time setup (5 minutes)

1. **Create the repo on GitHub.** Any name is fine but `tche-sync` matches the
   defaults. Private or public — doesn't matter.

2. **Push these files to the repo** (the folder you got from Claude). Example:
   ```
   cd tche-sync
   git init
   git add .
   git commit -m "initial"
   git branch -M main
   git remote add origin https://github.com/<YOUR_USERNAME>/tche-sync.git
   git push -u origin main
   ```

3. **Enable Actions.** On GitHub, go to your repo → **Actions** tab → click
   "I understand, enable Actions". The sync will start running every 15 minutes.

4. **Trigger the first run manually** to verify it works: Actions tab →
   "TCHE sync" workflow → **Run workflow** button. Takes ~2 minutes. When it
   finishes, you should see new JSON files in the `data/` folder (committed by
   `tche-sync-bot`).

5. **Tell Claude the repo URL** so the dashboard knows where to read from.
   Message Claude: *"Point the dashboard at https://github.com/<YOU>/tche-sync"*.

That's it. Once Claude points the dashboard at your repo, you can delete the
old Claude scheduled task.

## What it syncs

Same data as the old scheduled task — team members, Startrack timeframes
(24h, Season, Week, Weekly, All-Time), cash comps, season leaderboard, weekly
leaderboard, daily leaderboard, per-comp standings, allies, history.

## Changing settings

Edit `.github/workflows/sync.yml`:

- **Change frequency** — the `cron` line. GitHub minimum is every 5 minutes
  (`*/5 * * * *`). Default is every 15.
- **Change ally tags** — the `ALLY_TAGS` env line. Comma-separated, e.g.
  `KEYCAT,SVC,TCHE2,FOOBAR`.
- **Change team tag** — the `TCHE_TAG` env line.

## Troubleshooting

- **Action didn't run on its own** — GitHub Actions scheduled runs can be
  delayed up to 10 min under heavy load. If a run gets skipped entirely,
  it'll pick up on the next tick. Hit "Run workflow" to force one.
- **Scrape failed** — check the Actions run log. Most likely Startrack
  changed its UI; tell Claude and they'll update the selectors.
- **No commits even though action ran** — means nothing changed since last
  sync. Normal when the team's been idle.

## Costs

GitHub free tier includes 2,000 Action minutes/month for private repos (or
unlimited for public). Each sync run uses ~1-2 minutes. At every 15 min that's
~2,880 minutes/month — slightly over. If you're on a private repo, either
make it public (no risk — the data's already public via the dashboard) or
drop frequency to every 30 min (`*/30 * * * *` = ~1,440 min/mo, well under).
