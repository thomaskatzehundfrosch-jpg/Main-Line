# Corrected-seed reproduction and isolation fix

The original full-seed test below used the wrong early d6 branch and is superseded. The exact user seed includes `1.e4 e5 2.Nf3 Nc6 3.Bc4 Nf6 4.d4 d6`, alongside the four alternatives after `4...exd4 5.O-O`.

With this corrected input, a real 180-second timeout was reproduced after `4...d6 5.Ng5 Be6`:

`r2qkb1r/ppp2ppp/2npbn2/4p1N1/2BPP3/8/PPP2PPP/RNBQK2R w KQkq - 2 6`

| Depth 25, MultiPV 1 | Wall time | Reported nodes | Outcome |
| --- | ---: | ---: | --- |
| Reused generation worker | 180.004 s | last report 40,066,808 | Timed out; completed scored PV reached depth 24 |
| Fresh browser worker | 13.195 s | 4,326,986 | Depth 25 complete |
| Second fresh worker through generation services | 15.506 s | 4,326,986 | Depth 25 complete |
| Fresh control during isolation-fix test | 11.310 s | 4,326,986 | Depth 25 complete |
| Actual tree builder with isolated verification | 11.342 s | 4,326,986 | Depth 25 complete |

The reused worker's last engine time was 109.877 seconds at 364,651 NPS, before the unfinished final iteration consumed the rest of the wall-clock budget. Its diagnostic depth field reflected an attempted depth 25; the analyzer's scored-PV depth was 24. Thus those last counters must not be interpreted as final completed-depth counters.

The evidence points to accumulated search state changing the search tree, rather than a general 10x reduction in CPU speed. It does not establish a particular corrupted hash entry or Stockfish heuristic as the cause. Final verification now requests a clean worker for depth 22 and above, while shallow candidate searches continue to reuse healthy workers. Old workers are terminated before their replacements are allocated. Search depth and timeout budgets are not increased.

The targeted corrected branch completed through move 8 with zero unfinished positions and zero engine failures. All 171 regression tests, type checking and the production build pass. The complete corrected seed is being retested from its captured failure checkpoint; results below from the earlier wrong seed do not validate that run.

Artifacts: `browser/correct-seed-timeout-events.jsonl`, `browser/correct-seed-timeout-tree.json`, `browser/correct-fen-fresh-comparison.jsonl`, `browser/correct-fen-isolated-generation.jsonl`, and `browser/correct-fen-through-move8-tree.json`.

---

> Correction: the earlier full-seed test used 3...d6 instead of the user’s 4...d6 alternative. Its no-timeout result does not validate the exact supplied seed. A corrected test is required.

# Generator timeout investigation — 23 October 2026

The generator had a UCI stop race and discarded usable cloud results. Fixes are local to this checkout; they have not been deployed.

## Position and controlled comparison

The original timeout log was no longer available. The open production tab contained a different stopped 40-node run. The user confirmed they did not have the earlier log. Consequently this is a reconstructed position from the failed screenshot branch, not a recovered historical timeout FEN:

`1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d4 exd4 5. O-O d6 6. Ng5 Ne5 7. Qxd4 Be7`

```text
r1bqk2r/ppp1bppp/3p1n2/4n1N1/2BQP3/8/PPP2PPP/RNB2RK1 w kq - 1 8
```

All comparisons used fresh engine instances, MultiPV 1, depth 25, one thread and Hash 32 MB. The generator-path comparison used the same cloud/local gateway, retry helper and worker session as generation, with a forced cloud miss so both searches were local.

| Environment | Direct engine time | Generator-path engine time | Nodes in each search | Direct NPS | Generator-path NPS |
| --- | ---: | ---: | ---: | ---: | ---: |
| Isolated Node processes, identical WASM | 5.207 s | 4.798 s | 2,083,231 | 400,082 | 434,187 |
| Chrome browser workers, first comparison | 25.288 s | 5.100 s | 2,083,231 | 82,380 | 408,476 |
| Chrome browser workers, repeated comparison | 25.994 s | 6.255 s | 2,083,231 | 80,142 | 333,050 |

Every search in this first table reached depth 25 and returned `Be2` (`c4e2`), White score −0.08. Engine and wall times differed by only a few milliseconds. The first browser search being slower with identical nodes suggests WASM warm-up/tiering; this is an inference, not a proven cause of the historical timeout. The 180-second failure was not reproduced on this reconstructed position. Chess.com's engine build, threads and hash configuration were not independently verified.

The distributed JavaScript and WASM files were compared byte-for-byte with the installed Stockfish 19.0.1 package. WASM SHA-256: `991bede2f253ebb08ff01fcc48270f4b9c8e66b12d5bd5f8d6f52eb3e3b3a740`.

## Fixes

- Track whether each worker still owes a `bestmove`. After timeout, keep a lightweight acknowledgement listener; discard old PV output until the old search ends. Send the next `isready` only after that `bestmove`, then start the next search after `readyok`.
- Bound stop/readiness acknowledgements to three seconds. Terminate an unresponsive worker and retry the pending generation request once with a fresh worker. Healthy workers continue to retain their search hash.
- Log exact FEN, requested/reached depth, MultiPV, engine time, wall time, nodes, NPS and outcome per local search. Cancellation is distinguished from failure. Log worker replacement and cloud fallback reasons.
- Queue closely spaced cloud requests instead of skipping them. Hold the queue and shared browser Web Lock through body parsing. Keep the existing rate-limit/service cooldowns and explain them. Ordinary 404 cache misses no longer trigger a global 30-second blackout after four misses.
- Normalize legal cloud castling from king-to-rook notation to the king destination used by chess.js. The live authenticated test exposed a valid depth-30 cloud hit rejected solely because its best move was `e1h1` rather than `e1g1`:
  `r2qkbnr/ppp3pp/2np4/4pb2/2B5/2P2N2/PP1P1PPP/RNBQK2R w KQkq - 0 6`.
  Illegal and duplicate moves remain rejected.

Stockfish explicitly documents that `readyok` can be returned while a search is running; it is not an acknowledgement of search completion. See [Stockfish UCI commands](https://github.com/official-stockfish/Stockfish/wiki/UCI-Protocol-and-Stockfish-Commands#isready). Lichess asks clients to issue only one request at a time and back off after rate limiting; see [Lichess API rate limiting](https://lichess-org.github.io/api/#section/Introduction/Rate-limiting).

## CPU isolation and regression checks

The application already calls `useEngine(generator.isGenerating)` and terminates its interactive worker while generation owns a dedicated engine. Regression tests verify suspended startup, cleanup and late-worker cancellation. Other test engines were stopped before the authenticated run; the normal local application was unloaded before starting the dedicated harness. Process snapshots showed the test renderer as the active engine process, without another busy chess engine.

`npm test`: 170 passing tests. `npx tsc --noEmit`: passed. `npm run build`: passed, with existing bundle-size/Browserslist advisories.

Coverage includes `readyok` arriving before a delayed `bestmove`, stale MultiPV output during single-PV recovery, missing stop/readiness acknowledgements, bounded worker replacement, cloud pacing/cancellation/body serialization, ordinary misses followed by a hit, and legal/blocked/duplicate cloud castling.

## Full seed input

The five seed lines were recovered from the visible production tree:

```pgn
1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d4 exd4 5. O-O Bc5 *
1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d4 exd4 5. O-O Nxe4 *
1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d4 exd4 5. O-O d6 *
1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d4 exd4 5. O-O Be7 *
1. e4 e5 2. Nf3 Nc6 3. Bc4 d6 *
```

Settings match the visible run: White, Opening Lab Gen, trusted supplied moves, depth 25, maximum move 15, standard 500-move budget, Online players, ratings 2000–2200, rapid/classical, High trickiness, sacrifice 0–0.7, evaluation floor −0.5, balanced branch decay.

The first long Chrome run lacked the local Lichess connection and was stopped; it is preliminary engine-fallback evidence only. After the user connected Lichess in the in-app browser, the authenticated run was restarted there. The pre-castling run was also saved separately; `browser/full-seed-events.jsonl` and `browser/full-seed-tree.json` contain the authenticated run using every fix. The separate targeted comparison is in `browser/position-events.jsonl` and `browser/position-tree.json`.

## Results beyond the reported 97-node boundary

The authenticated run reached **121 nodes** (14 supplied nodes plus 107 generated nodes), then was stopped deliberately after the requested boundary check. It ran from 13:51:28 to 14:16:14 Vienna time.

- **547 completed local searches**, including **51 completed depth-25 searches**.
- **Zero engine failures and zero engine timeouts**. The one cancellation was the active search interrupted by the deliberate stop.
- Median reported NPS: **434,488.5**. The slowest search was depth 25, MultiPV 1: **50.374 s**, **18,698,792 nodes**, **371,199 NPS**, wall time **50.374 s**.
- Lichess cloud returned 20 rate limits during this run. The log records the one-minute cooldowns and local fallback. A 429 can persist longer than a minute; availability of the remote cloud service is not guaranteed by pacing.
- The exported `full-seed-121.pgn` and JSON snapshot preserve the regression tree. The 18 unfinished continuations in the final snapshot are from the deliberate stop. This was **not** a completed 500-node generation. Branch decay/budget reservations also limited recorded-reply coverage.

Branch decay selected `h6` rather than preserving `Be7` at the screenshot branch in this full seed run. The reconstructed `...Be7` position was screened locally at depth 18, but was therefore not visited as a full-depth continuation. A separate targeted tree-generation control retained the full screenshot line as its seed, kept the original human profile and High trickiness, and capped the continuation at move 8 without tactical extensions. Cloud hits were forced to miss in this control so local search could be measured directly.

| Same reconstructed FEN, depth 25, MultiPV 1 | Engine time | Wall time | Nodes | NPS |
| --- | ---: | ---: | ---: | ---: |
| Fresh browser worker | 5.184 s | 5.185 s | 2,083,231 | 401,857 |
| Inside the actual tree builder, after its candidate/reply work | 4.874 s | 4.876 s | 1,960,061 | 402,146 |

The small node-count difference is consistent with the generation worker retaining its search hash. The targeted tree reached its move target with zero unfinished positions; its partial outcome concerns a human reply coverage gap, not engine analysis failure. No historical 180-second timeout was reproduced. The exact original timeout FEN remains unavailable; the new production-path diagnostics capture it if it happens again.

## Reproduce

From `chess-repertoire`, run `node scripts/investigation-server.mjs`, open `http://127.0.0.1:5177/` and connect Lichess in that same browser. Open `/scripts/engine-investigation.html` to compare fresh workers, run the five seed lines, or compare the screenshot branch inside the actual tree builder. The harness saves diagnostics and tree snapshots under `investigation-results/browser/` and never exports credentials.

For an engine-only CLI benchmark using identical WASM: `node scripts/investigate-generator.cjs benchmark`. Its generation mode intentionally uses anonymous Explorer access, so it cannot reproduce the authenticated human profile.
