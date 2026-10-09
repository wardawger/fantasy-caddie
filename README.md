# Fantasy Caddie

A static, dependency-free web app for analyzing your Sleeper fantasy football leagues. Open the site root and enter your Sleeper username, or try the sample league.

## What it does

| Tab | What you get |
|---|---|
| **Overview** | Power rank, this week's projection, rest-of-season (ROS) strength, FAB left, your best moves, and positional strength vs. the league median |
| **Start / Sit** | Your optimal lineup compared with the lineup saved in Sleeper, with swaps, a plain-English reason for each, and a per-player breakdown of every adjustment |
| **Waivers** | Free agents ranked by how much they improve your lineup (ROS and this week), a suggested drop, and blind-bid ranges for FAB leagues |
| **Trades** | Suggested trades scanned across every roster (1-for-1 and 2-for-1), plus a trade builder that grades any trade: ROS points gained, points per week, the other team's change, and the odds they accept |
| **Roster** | Your players' ROS value and value over replacement, plus full league power rankings |

## How the numbers work (`js/engine.js`, `js/signals.js`)

Each player's projection for the week starts from Sleeper's weekly projection (scored with your league's `scoring_settings`) and passes through these steps, in order. The Start / Sit screen shows every step per player (tap the chevron).

| Step | Source | Effect |
|---|---|---|
| Bye / injury | Sleeper player data | Bye or Out/IR → 0, Doubtful ×0.2, Questionable ×0.85 |
| Matchup | Points each defense has allowed to each position this season (from box scores), shrunk toward neutral | up to roughly ±15% |
| Recent usage | Snap share, target share (and rush share for RBs) over the last 3 games vs. the season, from Sleeper weekly stats. Needs 4+ games | ±10% max |
| Game script | ESPN betting line: team implied total (O/U ± spread), weighted 60% because Sleeper's projection already prices in part of it | ±12% max |
| Weather | Open-Meteo forecast for outdoor stadiums | wind, heavy rain/snow and cold hurt passing and kickers |
| Expert consensus | Rankings from FantasyPros, CBS Sports, Draft Sharks and Fantasy Football Calculator (ADP), fetched by a Netlify Function and chosen to match your league (scoring, superflex, teams); optional CSV import too. Each source's positional rank is averaged (weighted), translated into the points that rank is worth in your league, and blended in (Off / 15 / 25 / 40%) | never lifts Out or bye players |

**Kickoff checks.** Kickoff time and game state come from ESPN. A player whose game has started (or finished) is locked in Sleeper, so the optimizer keeps locked starters where they are and won't recommend starting a locked bench player.

**News** (ESPN headlines matched to players by ESPN id) is shown for context only. It does not change any number.

Beyond the weekly number:

- **ROS.** Rate × remaining games through week 17, minus a bye if one is still ahead and expected games lost to injury.
- **Team value.** A greedy optimal lineup over your league's `roster_positions`, plus 15% credit for the top four bench players as depth.
- **Trades.** Each side's team value before and after. Acceptance odds weigh each side's value over replacement and the other team's lineup change.
- **FAB.** Bid % of remaining budget scales with ROS gain relative to an average starter, how many other rosters would also start the player, and weeks remaining (capped at 60%).

All multiplier sizes are my own estimates, not fitted to historical data.

## Data sources

- Sleeper public API (`api.sleeper.app/v1`): read-only, no auth. Projections, stats and schedule come from the endpoints the Sleeper app itself uses (`api.sleeper.com`). Those endpoints are undocumented, so the app degrades gracefully if one is missing.
- ESPN's public site API (`site.api.espn.com`) for betting lines, kickoff times/state and player news (keyless, undocumented). If it fails, those signals are dropped and shown as unavailable.
- Open-Meteo for stadium forecasts (keyless).
- Expert rankings: `netlify/functions/rankings.mjs` fetches them server-side (those sites don't allow browser CORS) and returns each source's rows plus per-URL status. Pages are picked from your league settings: Sleeper `rec` scoring → standard / half-PPR / PPR; `SUPER_FLEX` or two QB slots → superflex pages; team count → FFC ADP size. The sources' terms of use may restrict automated access, and their markup can change, so each source reports Loaded/Failed in the app. Sources can be switched off, and a CSV import is always available.
  - FantasyPros: reads the `ecrData` JSON embedded in the rankings page. CBS: parses the rankings table. Draft Sharks: looks for embedded app data (mostly premium, so it will often fail). FFC: uses its public ADP JSON API (draft-position value, so weighted 0.5).
  - Responses are cached for 30 minutes at Netlify's CDN and in your browser.

## Develop

```sh
python3 -m http.server   # then open http://localhost:8000/
node --test test/engine.test.mjs
```
