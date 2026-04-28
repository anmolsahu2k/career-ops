# Pre-Interview Checklist

A 30-minute daily warm-up rotation across the topic list flagged in HANDOFF-now-phase-execution.md. The goal is not to grind LeetCode; the goal is to keep every named topic warm enough that nothing surprises you on a phone screen.

## How to use

- 30 minutes per day, ideally morning before the work block.
- One topic per day on a rolling 14-day cycle (12 core topics plus 2 weekend revisit slots).
- For each daily topic, do all three drills: the LeetCode reference problem, the system-design lens, and the "what they will ask" probe.
- Track completion below. If you skip a day, do the missed topic on the next available slot rather than doubling up.

## Cycle structure

- **Mon-Fri (Days 1, 2, 3, 4, 5, 8, 9, 10, 11, 12):** core topics, one per day.
- **Sat (Days 6, 13):** revisit the two weakest topics of the past week.
- **Sun (Days 7, 14):** mock-loop simulation -- pick two random topics from the cycle, time-box one 25-minute coding problem and one 15-minute system-design conversation.

## Hard rules

- Do not look at the answer until you have spent 15 minutes on the problem. Stuck after 15 minutes is fine; that is signal.
- After each problem, write a one-line lesson (e.g., "two-pointer trap: I forgot to advance the slow pointer on equal values").
- After each system-design lens, write a one-line tradeoff (e.g., "hash map versus tree: O(1) lookup but no order").
- No skipping the "what they will ask" probe. That is the actual interview surface.

## 14-day topic rotation

| Day | Topic | LeetCode reference | System-design lens | What they will ask |
|---|---|---|---|---|
| 1 | Data types and primitives | 7. Reverse Integer | "How would you represent a 256-bit integer in a language without native bigint" | Overflow handling, signed vs unsigned, float precision pitfalls (0.1 + 0.2 != 0.3) |
| 2 | Bitwise operations | 191. Number of 1 Bits | "Bloom filter: which bit operations and why" | XOR for swap, AND for masking, count set bits without loop, parity check |
| 3 | Strings | 5. Longest Palindromic Substring | "URL shortener: encoding scheme tradeoffs (base62 vs hash truncation)" | Substring vs subsequence, immutability cost in Java/Python, Unicode normalization |
| 4 | Arrays | 11. Container With Most Water | "In-memory cache: array-backed ring buffer vs linked-list LRU" | Two-pointer technique, sliding window invariants, off-by-one in boundaries |
| 5 | Linked lists | 206. Reverse Linked List | "When does a linked list beat an array (e.g., O(1) middle insert in a stable iterator)" | In-place reverse, cycle detection (Floyd), merge two sorted, dummy-head pattern |
| 6 | Weekend revisit (week 1) | Pick the 2 weakest topics from days 1-5 | Re-do the system-design lens for each | -- |
| 7 | Mock-loop simulation (week 1) | Pick 2 random topic days, do 1 coding problem (25 min) and 1 system-design conversation (15 min) | -- | -- |
| 8 | Queues and stacks | 20. Valid Parentheses + 232. Implement Queue using Stacks | "Job-queue service: SQS-style at-least-once delivery, idempotency" | Monotonic stack, two-stack queue, BFS with queue, DFS with stack |
| 9 | Heaps and priority queues | 215. Kth Largest Element in an Array | "Top-K trending hashtags: bounded heap vs count-min sketch" | Min-heap vs max-heap, k-way merge, median in stream (two heaps) |
| 10 | Trees | 102. Binary Tree Level Order Traversal | "B-tree vs LSM: when does each win, and why does Postgres pick B-tree" | DFS vs BFS, recursion vs iterative with stack, balanced (AVL, red-black), traversal orders |
| 11 | Graph algorithms | 207. Course Schedule (topological sort) | "Build-system dependency graph: cycle detection plus rebuild minimization" | BFS shortest path, Dijkstra, Union-Find for connectivity, topo sort with Kahn vs DFS |
| 12 | Hash maps | 1. Two Sum + 146. LRU Cache | "Distributed cache: consistent hashing, hot keys, cache stampede" | Open vs chained collision, load factor, hash flooding (algorithmic complexity attack) |
| 13 | Weekend revisit (week 2) | Pick the 2 weakest topics from days 8-12 | Re-do the system-design lens for each | -- |
| 14 | Mock-loop simulation (week 2) | Pick 2 random topic days, do 1 coding problem (25 min) and 1 system-design conversation (15 min) | -- | -- |

## Bonus topics (rotate in if you finish a day early)

| Topic | LeetCode reference | System-design lens | What they will ask |
|---|---|---|---|
| Sorting | 912. Sort an Array | "External merge sort: when memory is smaller than the dataset" | Stable vs unstable, in-place vs not, Quick vs Merge vs Heap tradeoffs, when O(n^2) wins (small n, low overhead) |
| Time and space complexity | 53. Maximum Subarray (Kadane's) | "Why does Big-O analysis sometimes lie (constant factors, cache locality)" | Master theorem, amortized analysis, time vs space tradeoff, what is "average case" really |
| Dynamic programming | 322. Coin Change | "Memoization in a request handler: when is it worth caching" | Top-down vs bottom-up, state-space minimization, when DP becomes greedy |
| OOP paradigms | 146. LRU Cache (force OOP solution) | "Service interface design: composition vs inheritance, dependency injection" | SOLID principles, Liskov violations, when to break encapsulation, factory vs builder |
| Async paradigms | 1242. Web Crawler Multithreaded | "Backpressure in a streaming pipeline: where does the queue belong" | Promise vs async/await, blocking vs non-blocking I/O, race conditions, deadlock detection |
| Functional paradigms | 39. Combination Sum (force pure recursion, no mutable state) | "Stateless service: pure functions all the way down, where does state actually live" | map-reduce-filter, immutability cost, currying and partial application, side-effect isolation |

## Completion log

Mark each day done with a single line:

```
Day 1, 2026-04-28, topic: data types, problem solved: yes, lesson: int overflow in Java requires explicit cast on left operand
Day 2, 2026-04-29, topic: bitwise, problem solved: no (stuck on bit-count without loop), lesson: Brian Kernighan's algorithm clears lowest set bit per iteration
```

Keep the log in a personal scratch file, not in the repo. The point is honest tracking, not commit history.

## Day-of-interview warm-up (separate from the 14-day cycle)

The morning of an actual interview, run this 20-minute warm-up:

1. **5 minutes:** review the company's recent eng blog posts (last 6 months). Skim the architecture pieces. You want one fresh reference to drop if asked.
2. **5 minutes:** re-read the relevant story from `career-ops/templates/5ws-storytelling.md` for the role match. Speak the deep-dive Q and A pairs out loud.
3. **5 minutes:** one easy LeetCode warm-up (Easy tier, problem you have solved before). Goal is finger-warming, not learning.
4. **5 minutes:** review the company's eval report (`career-ops/reports/{NN}-{slug}-{date}.md`) Block A and Block B. You want the JD-to-CV mapping fresh.

Do NOT cram the morning of. Cramming raises cortisol and tanks recall. The 14-day rotation above is the actual prep; the day-of warm-up is just unsticking.

## Cross-reference

- STAR plus R framework: `career-ops/templates/star-plus-r-framework.md`
- 5 Ws storytelling with deep-dive prep per work-experience bullet: `career-ops/templates/5ws-storytelling.md`
- Accumulated stories from past evaluations: `career-ops/interview-prep/story-bank.md`
