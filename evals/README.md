# Evals

Golden questions per design-partner shop, with the expected answer and its source.
Run on every release to catch regressions in the agent and the engines.

Format (one file per shop): `evals/<shop>.jsonl`

```json
{"question": "Can we take 500 x P-1001 by 2026-11-13?", "expect": {"can_take": true}, "sources": ["routings:P-1001"]}
```
