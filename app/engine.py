"""Core commit-arbitration engine for the calibration library.

The engine is deliberately storage-agnostic: it holds all durable state as
plain Python data and is driven by :class:`Store`, which persists every
accepted verdict to a single JSON file inside one lock-protected critical
section (the "persistence verdict" / 持久化裁决).

Concurrency-control model (first-committer-wins validation against an
immutable version history):

* Every accepted commit freezes a new, strictly increasing **generation**.
  Each generation records the writes it installed and is append-only.
* A transaction submits its *first canonical payload* once: a stable
  transaction id, the snapshot generation it read from, its point reads
  (key -> expected value), its prefix scans (prefix -> the exact set of
  keys seen), and the values it wants to write.
* A point read is valid iff the key's current value equals the read value.
  A key added *after* the snapshot with no value at snapshot time therefore
  rejects as a point conflict; a key deleted after the snapshot likewise
  rejects (``None`` is never a storable value).
* A scan is valid iff the set of keys under its prefix is *identical* to
  the set seen at snapshot time. Any key inserted, deleted or rewritten
  under the prefix after the snapshot invalidates it. A *new* key under a
  scanned prefix is the phantom case (幻读).
* Writes are applied as a whole; they never execute before validation, so
  disjoint commits both succeed and write-skew commits are stopped at the
  read checks rather than overwriting one another.
* A transaction id is bound to its first canonical payload forever.
  Re-transmitting the *same* payload (including after a crash/restart)
  replays the original verdict; a *different* payload under the same id is
  rejected with a stable reason.

Rejection reasons are stable strings so tests and the UI can key on them.
"""

from __future__ import annotations

import json
import os
import threading
from typing import Any, Optional

# --- Stable rejection reasons -------------------------------------------------
REJECT_POINT_READ = "point_read_conflict"
REJECT_PHANTOM = "phantom_read"
REJECT_STALE_GENERATION = "stale_generation"
REJECT_ID_CONFLICT = "transaction_id_conflict"
REJECT_INVALID = "invalid_payload"

ACCEPTED = "accepted"
REJECTED = "rejected"


class EngineError(ValueError):
    """Payload/usage error (bad request, never a concurrency conflict)."""


def _canonical(value: Any) -> str:
    """Deterministic serialization used to bind txn id -> payload."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def normalize_payload(data: Any) -> dict:
    """Validate and normalize a client payload into canonical fields.

    Raises :class:`EngineError` for anything structurally invalid.
    """
    if not isinstance(data, dict):
        raise EngineError("payload must be an object")

    txn_id = data.get("transaction_id")
    if not isinstance(txn_id, str) or not txn_id.strip():
        raise EngineError("transaction_id must be a non-empty string")

    gen = data.get("snapshot_generation")
    # generation 0 is valid (the seeded exercise); must be an int, not bool.
    if not isinstance(gen, int) or isinstance(gen, bool) or gen < 0:
        raise EngineError("snapshot_generation must be a non-negative integer")

    point_reads = data.get("point_reads", {})
    if not isinstance(point_reads, dict) or not all(
        isinstance(k, str) for k in point_reads
    ):
        raise EngineError("point_reads must be an object mapping string keys to values")

    scans = data.get("prefix_scans", [])
    if not isinstance(scans, list):
        raise EngineError("prefix_scans must be a list")
    norm_scans: list[dict] = []
    for s in scans:
        if not isinstance(s, dict):
            raise EngineError("each prefix_scans entry must be an object")
        prefix = s.get("prefix")
        if not isinstance(prefix, str):
            raise EngineError("scan prefix must be a string")
        seen = s.get("seen_keys")
        if seen is None:
            raise EngineError("each scan entry requires seen_keys")
        if not isinstance(seen, list) or not all(isinstance(k, str) for k in seen):
            raise EngineError("seen_keys must be a list of strings")
        if len(set(seen)) != len(seen):
            raise EngineError(f"seen_keys for prefix {prefix!r} contains duplicates")
        norm_scans.append({"prefix": prefix, "seen_keys": sorted(seen)})
    # Deterministic scan order for the canonical binding.
    norm_scans.sort(key=lambda s: s["prefix"])

    writes = data.get("writes", {})
    if not isinstance(writes, dict) or not all(isinstance(k, str) for k in writes):
        raise EngineError("writes must be an object mapping string keys to values")

    # JSON values only (the wire/storage format); reject bytes/set/etc.
    _canonical(
        {
            "snapshot_generation": gen,
            "point_reads": point_reads,
            "prefix_scans": norm_scans,
            "writes": writes,
        }
    )

    return {
        "transaction_id": txn_id,
        "snapshot_generation": gen,
        "point_reads": dict(point_reads),
        "prefix_scans": norm_scans,
        "writes": dict(writes),
    }


class Store:
    """Persistent append-only version store with in-process locking."""

    def __init__(self, path: str):
        self.path = path
        self._lock = threading.RLock()
        self._state = self._load()

    # ------------------------------------------------------------------ state
    def _empty_state(self) -> dict:
        return {
            "current_generation": 0,
            # generations[g] = verdict installed at gen g; gen 0 is the seed
            "generations": [
                {
                    "generation": 0,
                    "transaction_id": None,
                    "writes": {},  # filled by seed
                    "point_reads": [],
                    "scan_summaries": [],
                }
            ],
            # live key -> {"value": ..., "generation": installed_at}
            "keys": {},
            # txn_id -> {"payload_hash": str, "result": verdict dict}
            "transactions": {},
            "seeded": False,
        }

    def _load(self) -> dict:
        if os.path.exists(self.path):
            with open(self.path, "r", encoding="utf-8") as fh:
                state = json.load(fh)
            # Rebuild the live index from immutable history so the on-disk
            # format stays a pure audit log of generations + verdicts.
            keys: dict[str, dict] = {}
            for gen in state["generations"]:
                for k, v in gen.get("writes", {}).items():
                    if v is None:
                        keys.pop(k, None)
                    else:
                        keys[k] = {"value": v, "generation": gen["generation"]}
            state["keys"] = keys
            return state
        state = self._empty_state()
        self._persist(state)
        return state

    def _persist(self, state: Optional[dict] = None) -> None:
        """Atomically write the full verdict log.

        Write to a temp file and fsync+os.replace so a verdict is either fully
        on disk or not at all; no torn result can survive an interruption.
        """
        state = state if state is not None else self._state
        directory = os.path.dirname(os.path.abspath(self.path)) or "."
        os.makedirs(directory, exist_ok=True)
        tmp = f"{self.path}.tmp.{os.getpid()}.{id(state)}"
        payload = {k: v for k, v in state.items() if k != "keys"}
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2, sort_keys=True)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, self.path)
        dir_fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)

    # ------------------------------------------------------------------ views
    def snapshot(self, generation: Optional[int] = None) -> "Snapshot":
        with self._lock:
            cur = self._state["current_generation"]
            if generation is None:
                generation = cur
            if generation > cur:
                raise EngineError(
                    f"snapshot_generation {generation} is ahead of current {cur}"
                )
            return Snapshot(self, generation)

    def current_generation(self) -> int:
        with self._lock:
            return self._state["current_generation"]

    def list_transactions(self) -> list[dict]:
        with self._lock:
            return [
                rec["result"] for rec in self._state["transactions"].values()
            ]

    def get_transaction(self, txn_id: str) -> Optional[dict]:
        with self._lock:
            rec = self._state["transactions"].get(txn_id)
            return rec["result"] if rec else None

    def export_exercise(self) -> dict:
        """Current materialized KV plus generation, for the UI."""
        with self._lock:
            return {
                "current_generation": self._state["current_generation"],
                "keys": {
                    k: {"value": meta["value"], "generation": meta["generation"]}
                    for k, meta in sorted(self._state["keys"].items())
                },
            }

    def history(self) -> list[dict]:
        with self._lock:
            return [
                {
                    "generation": g["generation"],
                    "transaction_id": g.get("transaction_id"),
                    "writes": g.get("writes", {}),
                }
                for g in self._state["generations"]
            ]

    def seed(self, initial: dict) -> dict:
        """Create the exercise with initial key/values (generation 0)."""
        with self._lock:
            if self._state["seeded"]:
                raise EngineError("exercise already initialized")
            if not isinstance(initial, dict) or not all(
                isinstance(k, str) for k in initial
            ):
                raise EngineError("initial keys must be an object with string keys")
            _canonical(initial)
            gen0 = self._state["generations"][0]
            gen0["writes"] = dict(initial)
            self._state["keys"] = {
                k: {"value": v, "generation": 0} for k, v in initial.items()
            }
            self._state["seeded"] = True
            self._persist()
            return {
                "seeded": True,
                "generation": 0,
                "keys": dict(initial),
            }

    # ------------------------------------------------------------------ commit
    def commit(self, raw_payload: Any) -> dict:
        """Validate and arbitrate one transaction; idempotent by txn id."""
        norm = normalize_payload(raw_payload)
        payload_hash = _canonical(
            {
                "snapshot_generation": norm["snapshot_generation"],
                "point_reads": norm["point_reads"],
                "prefix_scans": norm["prefix_scans"],
                "writes": norm["writes"],
            }
        )

        with self._lock:
            state = self._state
            txn_id = norm["transaction_id"]

            # 1) Stable id binding: same id must carry the same first payload.
            existing = state["transactions"].get(txn_id)
            if existing is not None:
                if existing["payload_hash"] != payload_hash:
                    return {
                        "transaction_id": txn_id,
                        "status": REJECTED,
                        "reason": REJECT_ID_CONFLICT,
                        "detail": (
                            "transaction_id was already committed with a different "
                            "canonical payload"
                        ),
                        "snapshot_generation": norm["snapshot_generation"],
                        "current_generation": state["current_generation"],
                        "replay": False,
                    }
                # Exactly-once replay (post-crash retransmit included).
                result = dict(existing["result"])
                result["replay"] = True
                return result

            # 2) Snapshot must not be from the future.
            snap_gen = norm["snapshot_generation"]
            if snap_gen > state["current_generation"]:
                raise EngineError(
                    f"snapshot_generation {snap_gen} is ahead of current "
                    f"{state['current_generation']}"
                )

            # 3) Validate point reads against the immutable version history.
            #    A read is valid iff the key's value still equals the value
            #    read AND no version was installed for it after the snapshot.
            #    Comparing values alone would miss a delete-then-restore or a
            #    rewrite to the same value; the generation check closes that.
            point_conflicts = []
            for key in sorted(norm["point_reads"]):
                observed = norm["point_reads"][key]
                live = state["keys"].get(key)
                current_value = None if live is None else live["value"]
                changed_after = live is not None and live["generation"] > snap_gen
                if current_value != observed or changed_after:
                    point_conflicts.append(
                        {
                            "key": key,
                            "read_value": observed,
                            "current_value": current_value,
                            "changed_at_generation": None
                            if live is None
                            else live["generation"],
                        }
                    )

            # 4) Validate prefix scans against the immutable version history.
            #    Every generation after the snapshot contributes its writes; a
            #    key touched under the prefix invalidates the scan even if a
            #    later generation cancels it out (e.g. inserted then deleted,
            #    or deleted then re-added) — the current key set alone would
            #    miss those phantoms.
            phantom_conflicts = []
            scan_evidence = []
            post_snapshot_writes: dict[str, int] = {}
            for g in state["generations"][snap_gen + 1:]:
                for k in g.get("writes", {}):
                    post_snapshot_writes.setdefault(k, g["generation"])

            for scan in norm["prefix_scans"]:
                prefix = scan["prefix"]
                seen_at_snapshot = scan["seen_keys"]
                current_under = sorted(
                    k for k in state["keys"] if k.startswith(prefix)
                )
                seen_set = set(seen_at_snapshot)
                current_set = set(current_under)
                # Touched under the prefix by any post-snapshot generation.
                touched = {
                    k: gen
                    for k, gen in post_snapshot_writes.items()
                    if k.startswith(prefix)
                }
                added = sorted(k for k in touched if k not in seen_set)
                missing = sorted(seen_set - current_set)
                rewritten = []
                for key in sorted(seen_set & current_set):
                    meta = state["keys"][key]
                    if meta["generation"] > snap_gen:
                        rewritten.append(
                            {"key": key, "changed_at_generation": meta["generation"]}
                        )
                if added or missing or rewritten:
                    phantom_conflicts.append(
                        {
                            "prefix": prefix,
                            "keys_added_after_snapshot": added,
                            "keys_deleted_after_snapshot": missing,
                            "keys_rewritten_after_snapshot": rewritten,
                        }
                    )
                scan_evidence.append(
                    {
                        "prefix": prefix,
                        "seen_at_snapshot": seen_at_snapshot,
                        "current_keys": current_under,
                    }
                )

            point_summary = [
                {"key": k, "value": v}
                for k, v in sorted(norm["point_reads"].items())
            ]

            # 5) Verdict. Point conflicts are reported first, then phantoms;
            #    each reason stays stable regardless of which else co-occurs.
            if point_conflicts:
                result = self._reject(
                    txn_id,
                    norm,
                    REJECT_POINT_READ,
                    "one or more point reads were rewritten after the snapshot",
                    point_summary,
                    scan_evidence,
                    extra={"point_conflicts": point_conflicts},
                )
                return self._bind_and_persist(txn_id, payload_hash, result)

            if phantom_conflicts:
                result = self._reject(
                    txn_id,
                    norm,
                    REJECT_PHANTOM,
                    "the key set inside a scanned prefix changed after the snapshot",
                    point_summary,
                    scan_evidence,
                    extra={"phantom_conflicts": phantom_conflicts},
                )
                return self._bind_and_persist(txn_id, payload_hash, result)

            # 6) Accept: freeze the new generation atomically with its evidence.
            new_generation = state["current_generation"] + 1
            writes = norm["writes"]
            for key, value in writes.items():
                if value is None:
                    state["keys"].pop(key, None)
                else:
                    state["keys"][key] = {
                        "value": value,
                        "generation": new_generation,
                    }

            gen_record = {
                "generation": new_generation,
                "transaction_id": txn_id,
                "writes": writes,
                "point_reads": point_summary,
                "scan_summaries": scan_evidence,
            }
            state["generations"].append(gen_record)
            state["current_generation"] = new_generation

            result = {
                "transaction_id": txn_id,
                "status": ACCEPTED,
                "reason": None,
                "detail": "commit accepted; new generation frozen",
                "snapshot_generation": snap_gen,
                "new_generation": new_generation,
                "current_generation": new_generation,
                "writes": writes,
                "read_summary": {
                    "point_reads": point_summary,
                    "prefix_scans": scan_evidence,
                },
                "replay": False,
            }
            # Persist before reporting success: crash before this returns means
            # the client may safely retransmit the same id and get this verdict.
            return self._bind_and_persist(txn_id, payload_hash, result)

    def _reject(
        self,
        txn_id: str,
        norm: dict,
        reason: str,
        detail: str,
        point_summary: list,
        scan_evidence: list,
        extra: dict,
    ) -> dict:
        result = {
            "transaction_id": txn_id,
            "status": REJECTED,
            "reason": reason,
            "detail": detail,
            "snapshot_generation": norm["snapshot_generation"],
            "current_generation": self._state["current_generation"],
            "read_summary": {
                "point_reads": point_summary,
                "prefix_scans": scan_evidence,
            },
            "replay": False,
        }
        result.update(extra)
        return result

    def _bind_and_persist(
        self, txn_id: str, payload_hash: str, result: dict
    ) -> dict:
        state = self._state
        state["transactions"][txn_id] = {
            "payload_hash": payload_hash,
            "result": {k: v for k, v in result.items() if k != "replay"},
        }
        self._persist()
        return result


class Snapshot:
    """Read view of the store at one immutable generation.

    The web app hands these views to clients so a transaction can discover
    point-read values and prefix key sets before building its commit.
    """

    def __init__(self, store: "Store", generation: int):
        self._store = store
        self.generation = generation

    def _materialized(self) -> dict:
        keys: dict[str, Any] = {}
        with self._store._lock:
            for gen in self._store._state["generations"][: self.generation + 1]:
                for k, v in gen.get("writes", {}).items():
                    if v is None:
                        keys.pop(k, None)
                    else:
                        keys[k] = v
        return keys

    def point_read(self, key: str) -> Any:
        return self._materialized().get(key)

    def prefix_scan(self, prefix: str) -> dict:
        keys = self._materialized()
        under = sorted(k for k in keys if k.startswith(prefix))
        return {
            "prefix": prefix,
            "generation": self.generation,
            "keys": [{"key": k, "value": keys[k]} for k in under],
        }
