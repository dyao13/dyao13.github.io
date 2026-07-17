/*
 * Tests for the ranking/scoring logic (spec sections 19-20).
 * Run with:  node ranking-app/tests/ranking-logic.test.mjs
 */

import assert from "node:assert/strict";
import {
  getBucketRange,
  scoreForPosition,
  formatScore,
  createInsertionState,
  isInsertionDone,
  nextComparisonIndex,
  applyComparison,
  insertAt,
  compareRatings,
  groupTies,
  buildRankedOrder,
  bucketOffsets,
  overallRank,
} from "../ranking-logic.js";

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

/* Compute displayed scores for a bucket of n movies, best to worst. */
function bucketScores(n, bucket) {
  return Array.from({ length: n }, (_, i) => formatScore(scoreForPosition(i, n, bucket)));
}

/*
 * Simulate the full binary-insertion flow: `existing` is ordered best to
 * worst, and `betterThan(a, b)` is the user's true preference. Returns the
 * insertion index the comparison flow arrives at.
 */
function simulateInsertion(existing, newMovie, betterThan) {
  let state = createInsertionState(existing.length);
  while (!isInsertionDone(state)) {
    const compared = existing[nextComparisonIndex(state)];
    state = applyComparison(state, betterThan(newMovie, compared));
  }
  return state.low;
}

/*
 * Same, but over tie groups with a three-way compare returning "new",
 * "existing", or "same". Returns the final insertion state.
 */
function simulateGroupInsertion(groups, newMovie, cmp) {
  let state = createInsertionState(groups.length);
  while (!isInsertionDone(state)) {
    const compared = groups[nextComparisonIndex(state)][0];
    state = applyComparison(state, cmp(newMovie, compared));
  }
  return state;
}

/* Three-way compare over numbers where smaller = better-liked. */
const cmp3 = (a, b) => (a === b ? "same" : a < b ? "new" : "existing");

/* ---- Exact score tables (spec section 20, amended: a lone movie sits at
        the top of its bucket instead of the midpoint) ---- */

test("green bucket with 1 movie", () => {
  assert.deepEqual(bucketScores(1, "green"), ["10.0"]);
});

test("green bucket with 2 movies", () => {
  assert.deepEqual(bucketScores(2, "green"), ["10.0", "6.7"]);
});

test("green bucket with 4 movies", () => {
  assert.deepEqual(bucketScores(4, "green"), ["10.0", "8.9", "7.8", "6.7"]);
});

test("yellow bucket with 1 movie", () => {
  assert.deepEqual(bucketScores(1, "yellow"), ["6.6"]);
});

test("yellow bucket with 3 movies", () => {
  assert.deepEqual(bucketScores(3, "yellow"), ["6.6", "5.0", "3.4"]);
});

test("red bucket with 1 movie", () => {
  assert.deepEqual(bucketScores(1, "red"), ["3.3"]);
});

test("a lone movie always sits at the top of its bucket", () => {
  for (const bucket of ["green", "yellow", "red"]) {
    assert.equal(scoreForPosition(0, 1, bucket), getBucketRange(bucket).max);
  }
});

test("red bucket with 4 movies", () => {
  assert.deepEqual(bucketScores(4, "red"), ["3.3", "2.2", "1.1", "0.0"]);
});

/* ---- Scores always display with exactly one decimal place ---- */

test("scores always format with one decimal place", () => {
  for (const bucket of ["green", "yellow", "red"]) {
    for (let n = 1; n <= 40; n++) {
      for (let i = 0; i < n; i++) {
        const s = formatScore(scoreForPosition(i, n, bucket));
        assert.match(s, /^\d+\.\d$/, `bucket=${bucket} n=${n} i=${i} -> ${s}`);
      }
    }
  }
});

test("scores stay within the bucket range and best/worst hit the bounds", () => {
  for (const bucket of ["green", "yellow", "red"]) {
    const { min, max } = getBucketRange(bucket);
    for (let n = 2; n <= 30; n++) {
      assert.equal(scoreForPosition(0, n, bucket), max);
      assert.equal(scoreForPosition(n - 1, n, bucket), min);
      for (let i = 0; i < n; i++) {
        const s = scoreForPosition(i, n, bucket);
        assert.ok(s >= min && s <= max);
      }
    }
  }
});

test("a crowded bucket produces duplicate displayed scores but rank order is preserved", () => {
  const n = 100; // green range spans 3.3, so 100 movies must collide
  const scores = bucketScores(n, "green");
  assert.ok(new Set(scores).size < n, "expected duplicate one-decimal scores");
  // Raw (unformatted) scores must still be non-increasing best to worst.
  for (let i = 1; i < n; i++) {
    assert.ok(
      scoreForPosition(i, n, "green") <= scoreForPosition(i - 1, n, "green"),
      `score should not increase at position ${i}`
    );
  }
});

test("unknown bucket throws", () => {
  assert.throws(() => getBucketRange("blue"));
  assert.throws(() => scoreForPosition(0, 1, "blue"));
});

/* ---- Binary insertion (spec sections 8-9, 19) ---- */

// "Movies" are numbers where a smaller number means better-liked.
const better = (a, b) => a < b;

test("empty bucket needs no comparisons", () => {
  const state = createInsertionState(0);
  assert.ok(isInsertionDone(state));
  assert.equal(state.low, 0);
  assert.deepEqual(insertAt([], 0, 5), [5]);
});

test("single movie in bucket takes one comparison", () => {
  assert.equal(simulateInsertion([10], 5, better), 0);
  assert.equal(simulateInsertion([10], 20, better), 1);
});

test("insert at top", () => {
  assert.equal(simulateInsertion([10, 20, 30, 40], 1, better), 0);
});

test("insert at bottom", () => {
  assert.equal(simulateInsertion([10, 20, 30, 40], 99, better), 4);
});

test("insert in middle", () => {
  assert.equal(simulateInsertion([10, 20, 30, 40], 25, better), 2);
});

test("insertion is correct for every position in lists of many sizes", () => {
  for (let size = 0; size <= 25; size++) {
    const existing = Array.from({ length: size }, (_, i) => (i + 1) * 10);
    for (let target = 0; target <= size; target++) {
      const newMovie = target * 10 + 5; // lands between neighbors
      const idx = simulateInsertion(existing, newMovie, better);
      assert.equal(idx, target, `size=${size} target=${target}`);
      const merged = insertAt(existing, idx, newMovie);
      for (let i = 1; i < merged.length; i++) {
        assert.ok(merged[i - 1] < merged[i], "merged list must stay sorted");
      }
    }
  }
});

test("binary insertion uses at most ceil(log2(n+1)) comparisons", () => {
  for (const size of [1, 2, 3, 7, 8, 15, 16, 100]) {
    const existing = Array.from({ length: size }, (_, i) => (i + 1) * 10);
    let comparisons = 0;
    let state = createInsertionState(size);
    while (!isInsertionDone(state)) {
      comparisons += 1;
      state = applyComparison(state, better(5, existing[nextComparisonIndex(state)]));
    }
    assert.ok(comparisons <= Math.ceil(Math.log2(size + 1)), `size=${size} took ${comparisons}`);
  }
});

test("insertAt does not mutate the original list", () => {
  const original = [1, 2, 3];
  insertAt(original, 1, 99);
  assert.deepEqual(original, [1, 2, 3]);
});

/* ---- Ties ("About the same") ---- */

test("compareRatings sorts by rank, then alphabetically within a tie", () => {
  const rows = [
    { rank_position: 1, movies: { title: "Whiplash" } },
    { rank_position: 0, title: "Parasite" }, // title directly, like the views
    { rank_position: 1, movies: { title: "arrival" } }, // case-insensitive
    { rank_position: 1, movies: { title: "Heat" } },
  ];
  const sorted = rows.slice().sort(compareRatings);
  assert.deepEqual(
    sorted.map((r) => r.movies?.title ?? r.title),
    ["Parasite", "arrival", "Heat", "Whiplash"]
  );
});

test("groupTies groups consecutive rows sharing a rank_position", () => {
  const list = [
    { movie_id: "a", rank_position: 0 },
    { movie_id: "b", rank_position: 1 },
    { movie_id: "c", rank_position: 1 },
    { movie_id: "d", rank_position: 2 },
  ];
  const groups = groupTies(list);
  assert.deepEqual(groups.map((g) => g.map((r) => r.movie_id)), [["a"], ["b", "c"], ["d"]]);
  assert.deepEqual(groupTies([]), []);
});

test('"about the same" ends the search and joins the compared group', () => {
  // Groups are [10], [20], [30], [40]; the new movie equals 30.
  const groups = [[10], [20], [30], [40]].map((g) => g.map((n) => n));
  const state = simulateGroupInsertion(groups, 30, cmp3);
  assert.ok(state.tie);
  assert.equal(state.low, 2);
});

test("a tie can land on every group", () => {
  for (let size = 1; size <= 15; size++) {
    const groups = Array.from({ length: size }, (_, i) => [(i + 1) * 10]);
    for (let target = 0; target < size; target++) {
      const state = simulateGroupInsertion(groups, (target + 1) * 10, cmp3);
      assert.ok(state.tie, `size=${size} target=${target} should tie`);
      assert.equal(state.low, target, `size=${size} target=${target}`);
    }
  }
});

test("strict preferences still insert between groups when ties are possible", () => {
  const groups = [[10], [20, 21], [30]]; // middle group is a two-way tie
  const state = simulateGroupInsertion(groups, 25, cmp3);
  assert.ok(!state.tie);
  assert.equal(state.low, 2);
});

test("buildRankedOrder inserts a new group", () => {
  const { orderedIds, groupIndices } = buildRankedOrder(
    [["a"], ["b", "c"], ["d"]],
    { low: 1, high: 1, tie: false },
    "x"
  );
  assert.deepEqual(orderedIds, ["a", "x", "b", "c", "d"]);
  assert.deepEqual(groupIndices, [0, 1, 2, 2, 3]);
});

test("buildRankedOrder joins an existing group on a tie", () => {
  const { orderedIds, groupIndices } = buildRankedOrder(
    [["a"], ["b", "c"], ["d"]],
    { low: 1, high: 1, tie: true },
    "x"
  );
  assert.deepEqual(orderedIds, ["a", "b", "c", "x", "d"]);
  assert.deepEqual(groupIndices, [0, 1, 1, 1, 2]);
});

test("buildRankedOrder handles an empty bucket", () => {
  const { orderedIds, groupIndices } = buildRankedOrder([], createInsertionState(0), "x");
  assert.deepEqual(orderedIds, ["x"]);
  assert.deepEqual(groupIndices, [0]);
});

test("tied movies share a score and unique scores stay evenly spaced", () => {
  // 4 movies in 3 tie groups: scores come from the 3-group spacing.
  const groups = [0, 1, 1, 2];
  const totalGroups = 3;
  const scores = groups.map((g) => formatScore(scoreForPosition(g, totalGroups, "green")));
  assert.deepEqual(scores, ["10.0", "8.4", "8.4", "6.7"]);
});

/* ---- Deletion / bucket-change recomputation (spec 19) ---- */

test("recomputing after deletion re-spaces the remaining movies", () => {
  // 4 green movies -> delete one -> the remaining 3 use the 3-movie spacing.
  assert.deepEqual(bucketScores(3, "green"), ["10.0", "8.4", "6.7"]);
});

test("moving a movie between buckets rescores both buckets", () => {
  // green 4 -> 3 after the move; yellow 2 -> 3 after the move.
  assert.deepEqual(bucketScores(3, "green"), ["10.0", "8.4", "6.7"]);
  assert.deepEqual(bucketScores(3, "yellow"), ["6.6", "5.0", "3.4"]);
});

/* ---- Unified numbering across colors ---- */

test("numbering continues from green through yellow through red", () => {
  const ratings = [
    { bucket: "green", rank_position: 0 },
    { bucket: "green", rank_position: 1 },
    { bucket: "green", rank_position: 2 },
    { bucket: "yellow", rank_position: 0 },
    { bucket: "yellow", rank_position: 1 },
    { bucket: "red", rank_position: 0 },
  ];
  assert.deepEqual(bucketOffsets(ratings), { green: 0, yellow: 3, red: 5 });
  assert.deepEqual(ratings.map((r) => overallRank(r, ratings)), [1, 2, 3, 4, 5, 6]);
});

test("unified numbering with empty buckets", () => {
  // Only red movies: numbering still starts at 1.
  const onlyRed = [{ bucket: "red", rank_position: 0 }, { bucket: "red", rank_position: 1 }];
  assert.deepEqual(onlyRed.map((r) => overallRank(r, onlyRed)), [1, 2]);

  // Green and red but no yellow: red picks up right after green.
  const noYellow = [
    { bucket: "green", rank_position: 0 },
    { bucket: "red", rank_position: 0 },
  ];
  assert.equal(overallRank(noYellow[0], noYellow), 1);
  assert.equal(overallRank(noYellow[1], noYellow), 2);
});

test("tied movies share a competition rank and later movies skip past them", () => {
  const ratings = [
    { bucket: "green", rank_position: 0 },
    { bucket: "green", rank_position: 1 }, // tied pair
    { bucket: "green", rank_position: 1 },
    { bucket: "green", rank_position: 2 },
    { bucket: "yellow", rank_position: 0 },
  ];
  // 1, 2, 2, 4 — then yellow starts after all 4 green movies.
  assert.deepEqual(ratings.map((r) => overallRank(r, ratings)), [1, 2, 2, 4, 5]);
});

test("bucketOffsets rejects unknown buckets", () => {
  assert.throws(() => bucketOffsets([{ bucket: "blue", rank_position: 0 }]));
});

console.log(`\n${passed} tests passed.`);
