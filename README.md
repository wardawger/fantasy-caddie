# Fantasy Caddie

A static, dependency-free web app for analyzing your Sleeper fantasy football leagues. Open the site root and enter your Sleeper username, or try the sample league.

## What it does

| Tab | What you get |
|---|---|
| **Overview** | Power rank, this week's projection, rest-of-season (ROS) strength, FAB left, your best moves, and positional strength vs. the league median |
| **Start / Sit** | Your optimal lineup compared with the lineup saved in Sleeper, with start/sit swaps. Projections are adjusted for injuries, byes, defense-vs-position and game-day weather |
| **Waivers** | Free agents ranked by how much they improve your lineup (ROS and this week), a suggested drop, and blind-bid ranges for FAB leagues |
| **Trades** | Suggested trades scanned across every roster (1-for-1 and 2-for-1), plus a trade builder that grades any trade: ROS points gained, points per week, the other team's change, and the odds they accept |
| **Roster** | Your players' ROS value and value over replacement, plus full league power rankings |

## How the numbers work (`js/engine.js`)

- **Player rate.** Sleeper's season projection per game, blended with actual points per game as games accumulate (up to 50% weight). Everything is scored with your league's `scoring_settings`.
- **This week.** Sleeper's weekly projection × injury factor (Out/IR 0, Doubtful 0.2, Questionable 0.85) × defense-vs-position factor (from box scores so far, shrunk toward neutral) × weather factor (wind above 15 mph, heavy precipitation, or extreme cold hurts passing and kicking; domes are neutral). On a bye, it's 0.
- **ROS.** Rate × remaining games through week 17, minus a bye if one is still ahead and expected games lost to injury.
- **Team value.** A greedy optimal lineup over your league's `roster_positions` (FLEX, SUPER_FLEX, WRRB_FLEX, REC_FLEX supported), plus 15% credit for the top four bench players as depth.
- **Trades.** Each side's team value is computed before and after the trade. If a team ends up with too many players, it drops its lowest-value one. Acceptance odds weigh the value-over-replacement each side receives and the other team's lineup change. The grade is based on ROS points gained per remaining week.
- **FAB.** Bid % of remaining budget ≈ (ROS gain ÷ an average starter's ROS) × competition (how many other rosters he'd also improve) × season remaining, capped at 60%. Streamers are capped at a few percent.

## Data sources

- Sleeper public API (`api.sleeper.app/v1`): read-only, no auth. Projections, stats and schedule come from the endpoints the Sleeper app itself uses (`api.sleeper.com`). Those endpoints are undocumented, so the app degrades gracefully if one is missing.
- Open-Meteo for stadium forecasts (keyless).

## Develop

```sh
python3 -m http.server   # then open http://localhost:8000/
node --test test/engine.test.mjs
```
