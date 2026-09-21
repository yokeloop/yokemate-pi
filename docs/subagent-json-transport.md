# Subagent JSON transport

Yokemate launches detached children with the repository-pinned `@earendil-works/pi-coding-agent` 0.85.1 CLI at `node_modules/@earendil-works/pi-coding-agent/dist/cli.js`. The child sets `YOKEMATE_SUBAGENT_JSON_CONTRACT=1`; normal Pi JSON and RPC processes without that opt-in retain upstream behavior.

## Wire contract

Every stdout record is UTF-8 JSON terminated by LF. A record may contain at most 1,048,576 bytes excluding LF or CRLF. The consumer hashes all stdout bytes, including separators, and records parser errors by the zero-based byte offset of the record start. A complete JSON object at EOF without LF is a `partial_record`. Parser faults are cumulative and cannot be cleared by a later valid final message.

The authoritative final answer remains the assistant `message_end`. For an `agent_end` whose serialized event would exceed the record bound, the pinned producer replaces only its duplicate `messages` array with:

```json
{
  "messagesSummary": {
    "version": 1,
    "count": 0,
    "bytes": 0,
    "sha256": "64 lowercase hexadecimal characters"
  }
}
```

`count`, `bytes`, and `sha256` describe the original `JSON.stringify(event.messages)` bytes. Other `agent_end` fields remain unchanged, including `willRetry`. A malformed summary, an event containing both `messages` and `messagesSummary`, or an oversized authoritative event is a protocol error.

## Results and delivery

A child result is finalized after local artifact acceptance and best-effort publication. Settlement freezes process, parser, final-content, artifact, and publication facts. Batch budgeting may trim only the payload preview; it does not rewrite those facts or recolor the outcome.

Delivery is a separate monotonic lifecycle bound to `deliveryId` and `envelopeHash`: `pending`, `enqueued`, then `observed`, `delivery_failed`, or `delivery_unknown`. The patched send hook reports asynchronous rejection by send ID without exposing the error text. A context acknowledgement wins over a late callback. An old parent without the hook leaves an unacknowledged send pending until shutdown, when it becomes unknown.

## Private diagnostics

Snapshots are allowlisted JSON under `<ENGINE_ROOT>/sessions/subagent-runs/`. The directory is mode 0700 and files, temporary files, and the lock are mode 0600. Snapshots contain hashes, bounded counters, lifecycle timestamps, safe state codes, and fixed provenance roles. They exclude raw stdout/stderr, prompts, task text, results, thinking, arguments, credentials, tracker payloads, arbitrary metadata names, and tool IDs.

Snapshot storage is best effort and grants no workflow authority. A storage fault records `snapshotStorage.state=unavailable` in memory and the next normal checkpoint retries. Running processes and unconfirmed deliveries are not eviction candidates.

## Plan-writer admission

A `plan-writer` requires the current settled local `plan-scout` for the same ticket. The scout must have a matching task hash and an accepted artifact whose full bytes still match its stored hash and acceptance identity. Starting a newer scout immediately revokes prior writer and record permission. Remote publication may remain pending; it is not an admission gate. Transport, parser, artifact, or binding faults block writer admission and plan recording.
