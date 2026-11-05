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

The targeted corrected branch completed through move 8 with zero unfinished positions and zero engine failures. All 171 regression tests, type checking and the production build pass. The complete corrected seed was resumed from its captured 22-node failure checkpoint and advanced to **101 nodes**, then stopped deliberately after passing the requested 97-node boundary. It completed **512 local searches**, with **zero new engine timeouts or failures**; the one cancellation was the active search interrupted by the deliberate stop. This does not claim completion of the 500-node budget. The running five seed paths were checked for equality against paths parsed directly from `exact-user-seed.pgn`.

Artifacts: `browser/correct-seed-timeout-events.jsonl`, `browser/correct-seed-timeout-tree.json`, `browser/correct-fen-fresh-comparison.jsonl`, `browser/correct-fen-isolated-generation.jsonl`, and `browser/correct-fen-through-move8-tree.json`.


The repeated failing-position search in the full resumed seed run completed depth 25 in **11.413 seconds**, with 4,326,986 nodes and 379,127 NPS. The fix therefore passed both a targeted tree-build test through move 8 and the longer correct-seed regression. Some other positions still take substantially longer than 20 seconds; generation also searches multiple candidates and replies per recommended move.

Final corrected-run artifacts: `browser/correct-seed-fixed-events.jsonl`, `browser/correct-seed-fixed-tree.json`, `correct-seed-fixed-verification.png`, and `correct-seed-fixed-101.pgn`. Earlier wrong-seed results are archived separately in `PRELIMINARY_SUPERSEDED_REPORT.md` and must not be used to validate this seed.

Changes remain local and are not deployed. `npm test`: 171 passing; `npx tsc --noEmit`: passed; production build: passed.
