/*
 * Tests for the MovieRank ranking/scoring logic (spec sections 19-20).
 * Run with:  node tests/movies-ranking.test.mjs
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
  bucketOffsets,
  overallRank,
} from "../assets/js/movies-ranking.js";

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
  assert.deepEqual(bucketScores(1, "yellow"), ["6.7"]);
});

test("yellow bucket with 3 movies", () => {
  assert.deepEqual(bucketScores(3, "yellow"), ["6.7", "5.1", "3.4"]);
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

/* ---- Deletion / bucket-change recomputation (spec 19) ---- */

test("recomputing after deletion re-spaces the remaining movies", () => {
  // 4 green movies -> delete one -> the remaining 3 use the 3-movie spacing.
  assert.deepEqual(bucketScores(3, "green"), ["10.0", "8.4", "6.7"]);
});

test("moving a movie between buckets rescores both buckets", () => {
  // green 4 -> 3 after the move; yellow 2 -> 3 after the move.
  assert.deepEqual(bucketScores(3, "green"), ["10.0", "8.4", "6.7"]);
  assert.deepEqual(bucketScores(3, "yellow"), ["6.7", "5.1", "3.4"]);
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
  const offsets = bucketOffsets(ratings);
  assert.deepEqual(offsets, { green: 0, yellow: 3, red: 5 });
  assert.deepEqual(ratings.map((r) => overallRank(r, offsets)), [1, 2, 3, 4, 5, 6]);
});

test("unified numbering with empty buckets", () => {
  // Only red movies: numbering still starts at 1.
  const onlyRed = [{ bucket: "red", rank_position: 0 }, { bucket: "red", rank_position: 1 }];
  const redOffsets = bucketOffsets(onlyRed);
  assert.deepEqual(onlyRed.map((r) => overallRank(r, redOffsets)), [1, 2]);

  // Green and red but no yellow: red picks up right after green.
  const noYellow = [
    { bucket: "green", rank_position: 0 },
    { bucket: "red", rank_position: 0 },
  ];
  const offsets = bucketOffsets(noYellow);
  assert.equal(overallRank(noYellow[0], offsets), 1);
  assert.equal(overallRank(noYellow[1], offsets), 2);
});

test("bucketOffsets rejects unknown buckets", () => {
  assert.throws(() => bucketOffsets([{ bucket: "blue", rank_position: 0 }]));
});

console.log(`\n${passed} tests passed.`);
