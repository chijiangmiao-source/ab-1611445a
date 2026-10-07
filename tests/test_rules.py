"""Rule tests for the commit-arbitration engine.

Run with: python3 -m unittest discover -s tests -v
No third-party dependencies.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.engine import (  # noqa: E402
    ACCEPTED,
    REJECTED,
    REJECT_PHANTOM,
    REJECT_POINT_READ,
    REJECT_ID_CONFLICT,
    EngineError,
    Store,
)


def fresh_store() -> tuple[Store, str]:
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".json")
    tmp.close()
    os.unlink(tmp.name)
    return Store(tmp.name), tmp.name


def seeded_store(initial=None) -> Store:
    store, _ = fresh_store()
    store.seed(
        initial
        if initial is not None
        else {
            "calib.sensorA.offset": "0.012",
            "calib.sensorA.gain": "1.001",
            "calib.sensorB.offset": "-0.030",
        }
    )
    return store


def payload(txn_id, gen, points=None, scans=None, writes=None):
    return {
        "transaction_id": txn_id,
        "snapshot_generation": gen,
        "point_reads": points or {},
        "prefix_scans": scans or [],
        "writes": writes or {},
    }


class SeedTests(unittest.TestCase):
    def test_seed_freezes_generation_zero(self):
        s = seeded_store()
        ex = s.export_exercise()
        self.assertEqual(ex["current_generation"], 0)
        self.assertEqual(ex["keys"]["calib.sensorA.offset"]["value"], "0.012")
        self.assertEqual(ex["keys"]["calib.sensorA.offset"]["generation"], 0)

    def test_double_seed_rejected(self):
        s = seeded_store()
        with self.assertRaises(EngineError):
            s.seed({"x": 1})


class BasicCommitTests(unittest.TestCase):
    def test_accepted_commit_freezes_new_generation_and_writes(self):
        s = seeded_store()
        r = s.commit(
            payload(
                "t1",
                0,
                points={"calib.sensorA.offset": "0.012"},
                scans=[{"prefix": "calib.sensorA.",
                        "seen_keys": ["calib.sensorA.gain",
                                      "calib.sensorA.offset"]}],
                writes={"calib.sensorA.offset": "0.015"},
            )
        )
        self.assertEqual(r["status"], ACCEPTED)
        self.assertEqual(r["new_generation"], 1)
        self.assertEqual(s.current_generation(), 1)
        # Writes frozen in the verdict
        self.assertEqual(r["writes"], {"calib.sensorA.offset": "0.015"})
        # Read/scan summaries frozen in the same verdict
        self.assertEqual(
            r["read_summary"]["point_reads"],
            [{"key": "calib.sensorA.offset", "value": "0.012"}],
        )
        scan = r["read_summary"]["prefix_scans"][0]
        self.assertEqual(scan["prefix"], "calib.sensorA.")
        self.assertEqual(
            scan["seen_at_snapshot"],
            ["calib.sensorA.gain", "calib.sensorA.offset"],
        )
        # Live state reflects the write with the installing generation.
        ex = s.export_exercise()
        self.assertEqual(ex["keys"]["calib.sensorA.offset"]["value"], "0.015")
        self.assertEqual(ex["keys"]["calib.sensorA.offset"]["generation"], 1)

    def test_chain_of_commits_advances_generations(self):
        s = seeded_store()
        r1 = s.commit(payload("c1", 0, writes={"k1": "v1"}))
        r2 = s.commit(payload(
            "c2", 1,
            points={"k1": "v1"},
            writes={"k2": "v2"},
        ))
        self.assertEqual(r1["new_generation"], 1)
        self.assertEqual(r2["new_generation"], 2)
        self.assertEqual([g["generation"] for g in s.history()], [0, 1, 2])


class PointReadTests(unittest.TestCase):
    def test_rewritten_point_read_rejects_with_stable_reason(self):
        s = seeded_store()
        s.commit(payload("writer", 0, writes={"calib.sensorA.offset": "0.099"}))
        r = s.commit(payload(
            "stale-reader", 0,
            points={"calib.sensorA.offset": "0.012"},
            writes={"calib.sensorB.offset": "0.000"},
        ))
        self.assertEqual(r["status"], REJECTED)
        self.assertEqual(r["reason"], REJECT_POINT_READ)
        self.assertEqual(r["current_generation"], 1)
        conflict = r["point_conflicts"][0]
        self.assertEqual(conflict["key"], "calib.sensorA.offset")
        self.assertEqual(conflict["read_value"], "0.012")
        self.assertEqual(conflict["current_value"], "0.099")
        self.assertEqual(conflict["changed_at_generation"], 1)
        # Rejected commit must not advance the generation or install writes.
        self.assertEqual(s.current_generation(), 1)
        self.assertEqual(
            s.export_exercise()["keys"]["calib.sensorB.offset"]["value"],
            "-0.030",
        )

    def test_point_read_of_key_absent_at_snapshot_then_added_conflicts(self):
        s = seeded_store()
        s.commit(payload("adder", 0, writes={"calib.sensorC.offset": "0.5"}))
        r = s.commit(payload(
            "expected-absent", 0,
            points={"calib.sensorC.offset": None},
            writes={"calib.sensorD.offset": "1"},
        ))
        self.assertEqual(r["status"], REJECTED)
        self.assertEqual(r["reason"], REJECT_POINT_READ)
        self.assertEqual(r["point_conflicts"][0]["current_value"], "0.5")

    def test_point_read_of_deleted_key_conflicts(self):
        s = seeded_store()
        # Delete via explicit null write.
        s.commit(payload("deleter", 0,
                         points={"calib.sensorA.gain": "1.001"},
                         writes={"calib.sensorA.gain": None}))
        r = s.commit(payload(
            "late", 0,
            points={"calib.sensorA.gain": "1.001"},
            writes={"x": "y"},
        ))
        self.assertEqual(r["reason"], REJECT_POINT_READ)
        self.assertIsNone(r["point_conflicts"][0]["current_value"])

    def test_rewrite_to_same_value_still_conflicts(self):
        # Validation is against the immutable version history, not value
        # equality: a new version installed after the snapshot invalidates the
        # point read even when the bytes happen to be identical.
        s = seeded_store()
        s.commit(payload(
            "noop-rewriter", 0,
            points={"calib.sensorA.offset": "0.012"},
            writes={"calib.sensorA.offset": "0.012"},
        ))
        r = s.commit(payload(
            "stale", 0,
            points={"calib.sensorA.offset": "0.012"},
            writes={"other": "v"},
        ))
        self.assertEqual(r["status"], REJECTED)
        self.assertEqual(r["reason"], REJECT_POINT_READ)
        self.assertEqual(r["point_conflicts"][0]["changed_at_generation"], 1)

    def test_current_reader_with_fresh_snapshot_succeeds(self):
        s = seeded_store()
        s.commit(payload("writer", 0, writes={"calib.sensorA.offset": "0.099"}))
        r = s.commit(payload(
            "fresh", 1,
            points={"calib.sensorA.offset": "0.099"},
            writes={"calib.sensorA.offset": "0.100"},
        ))
        self.assertEqual(r["status"], ACCEPTED)
        self.assertEqual(r["new_generation"], 2)


class PrefixScanTests(unittest.TestCase):
    PREFIX_A = "calib.sensorA."
    SEEN_A = ["calib.sensorA.gain", "calib.sensorA.offset"]

    def test_new_key_under_scanned_prefix_is_phantom(self):
        s = seeded_store()
        s.commit(payload(
            "inserter", 0,
            writes={"calib.sensorA.temp": "36.6"},
        ))
        r = s.commit(payload(
            "scanner", 0,
            scans=[{"prefix": self.PREFIX_A, "seen_keys": self.SEEN_A}],
            writes={"calib.sensorB.offset": "1"},
        ))
        self.assertEqual(r["status"], REJECTED)
        self.assertEqual(r["reason"], REJECT_PHANTOM)
        ph = r["phantom_conflicts"][0]
        self.assertEqual(ph["keys_added_after_snapshot"],
                         ["calib.sensorA.temp"])
        self.assertEqual(ph["keys_deleted_after_snapshot"], [])
        self.assertEqual(ph["keys_rewritten_after_snapshot"], [])
        self.assertEqual(s.current_generation(), 1)

    def test_deleted_key_under_scanned_prefix_is_phantom(self):
        s = seeded_store()
        s.commit(payload(
            "deleter", 0,
            points={"calib.sensorA.gain": "1.001"},
            writes={"calib.sensorA.gain": None},
        ))
        r = s.commit(payload(
            "scanner", 0,
            scans=[{"prefix": self.PREFIX_A, "seen_keys": self.SEEN_A}],
            writes={"other": "v"},
        ))
        self.assertEqual(r["reason"], REJECT_PHANTOM)
        self.assertEqual(
            r["phantom_conflicts"][0]["keys_deleted_after_snapshot"],
            ["calib.sensorA.gain"],
        )

    def test_rewritten_key_under_scanned_prefix_is_phantom(self):
        s = seeded_store()
        s.commit(payload(
            "rewriter", 0,
            points={"calib.sensorA.gain": "1.001"},
            writes={"calib.sensorA.gain": "1.002"},
        ))
        r = s.commit(payload(
            "scanner", 0,
            scans=[{"prefix": self.PREFIX_A, "seen_keys": self.SEEN_A}],
            writes={"other": "v"},
        ))
        self.assertEqual(r["reason"], REJECT_PHANTOM)
        rewritten = r["phantom_conflicts"][0]["keys_rewritten_after_snapshot"]
        self.assertEqual(rewritten, [{"key": "calib.sensorA.gain",
                                      "changed_at_generation": 1}])

    def test_insert_then_delete_under_prefix_is_still_phantom(self):
        # History-based validation: even though the current key set matches the
        # snapshot again, a key that briefly appeared under the prefix must
        # invalidate a scan that saw the prefix without it.
        s = seeded_store()
        s.commit(payload("inserter", 0,
                         writes={"calib.sensorA.flash": "1"}))
        s.commit(payload("cleaner", 1,
                         points={"calib.sensorA.flash": "1"},
                         writes={"calib.sensorA.flash": None}))
        r = s.commit(payload(
            "scanner", 0,
            scans=[{"prefix": self.PREFIX_A, "seen_keys": self.SEEN_A}],
            writes={"other": "v"},
        ))
        self.assertEqual(r["status"], REJECTED)
        self.assertEqual(r["reason"], REJECT_PHANTOM)
        self.assertEqual(
            r["phantom_conflicts"][0]["keys_added_after_snapshot"],
            ["calib.sensorA.flash"],
        )

    def test_delete_then_readd_under_prefix_is_still_phantom(self):
        s = seeded_store()
        s.commit(payload("deleter", 0,
                         points={"calib.sensorA.gain": "1.001"},
                         writes={"calib.sensorA.gain": None}))
        s.commit(payload("readder", 1,
                         points={"calib.sensorA.gain": None},
                         writes={"calib.sensorA.gain": "1.001"}))
        r = s.commit(payload(
            "scanner", 0,
            scans=[{"prefix": self.PREFIX_A, "seen_keys": self.SEEN_A}],
            writes={"other": "v"},
        ))
        self.assertEqual(r["reason"], REJECT_PHANTOM)
        rewritten = r["phantom_conflicts"][0]["keys_rewritten_after_snapshot"]
        self.assertEqual(rewritten, [{"key": "calib.sensorA.gain",
                                      "changed_at_generation": 2}])

    def test_unchanged_prefix_scan_passes(self):
        s = seeded_store()
        # A write outside the scanned prefix must not disturb the scan.
        s.commit(payload("elsewhere", 0,
                         writes={"calib.sensorZ.offset": "9"}))
        r = s.commit(payload(
            "scanner", 1,
            scans=[{"prefix": self.PREFIX_A, "seen_keys": self.SEEN_A}],
            writes={"calib.sensorA.note": "ok"},
        ))
        self.assertEqual(r["status"], ACCEPTED)
        self.assertEqual(r["new_generation"], 2)

    def test_empty_prefix_then_insert_is_phantom(self):
        s = seeded_store({"keep": "1"})
        s.commit(payload("inserter", 0, writes={"new.thing": 1}))
        r = s.commit(payload(
            "saw-empty", 0,
            scans=[{"prefix": "new.", "seen_keys": []}],
            writes={"unrelated": 2},
        ))
        self.assertEqual(r["reason"], REJECT_PHANTOM)
        self.assertEqual(
            r["phantom_conflicts"][0]["keys_added_after_snapshot"],
            ["new.thing"],
        )


class DisjointAndWriteSkewTests(unittest.TestCase):
    def test_disjoint_commits_both_succeed_from_same_snapshot(self):
        s = seeded_store()
        r1 = s.commit(payload(
            "engineer-A", 0,
            points={"calib.sensorA.offset": "0.012"},
            writes={"calib.sensorA.offset": "0.020"},
        ))
        r2 = s.commit(payload(
            "engineer-B", 0,
            points={"calib.sensorB.offset": "-0.030"},
            writes={"calib.sensorB.offset": "-0.025"},
        ))
        self.assertEqual(r1["status"], ACCEPTED)
        self.assertEqual(r2["status"], ACCEPTED)
        self.assertEqual(r1["new_generation"], 1)
        self.assertEqual(r2["new_generation"], 2)
        ex = s.export_exercise()
        self.assertEqual(ex["keys"]["calib.sensorA.offset"]["value"], "0.020")
        self.assertEqual(ex["keys"]["calib.sensorB.offset"]["value"], "-0.025")

    def test_write_skew_second_commit_cannot_pass_read_checks(self):
        # Classic write skew: A reads x and writes y; B reads y and writes x.
        # Both reason from gen 0. Whichever lands first freezes a generation;
        # the second must be stopped at its point read, never overwrite.
        s = seeded_store({"x": "100", "y": "200"})
        a = payload("skew-A", 0, points={"x": "100"}, writes={"y": "201"})
        b = payload("skew-B", 0, points={"y": "200"}, writes={"x": "101"})
        ra = s.commit(a)
        rb = s.commit(b)
        self.assertEqual(ra["status"], ACCEPTED)
        self.assertEqual(rb["status"], REJECTED)
        self.assertEqual(rb["reason"], REJECT_POINT_READ)
        ex = s.export_exercise()
        self.assertEqual(ex["keys"]["x"]["value"], "100")  # B's write not installed
        self.assertEqual(ex["keys"]["y"]["value"], "201")

    def test_write_skew_order_reversed(self):
        s = seeded_store({"x": "100", "y": "200"})
        rb = s.commit(payload("skew-B", 0, points={"y": "200"},
                              writes={"x": "101"}))
        ra = s.commit(payload("skew-A", 0, points={"x": "100"},
                              writes={"y": "201"}))
        self.assertEqual(rb["status"], ACCEPTED)
        self.assertEqual(ra["status"], REJECTED)
        self.assertEqual(ra["reason"], REJECT_POINT_READ)


class IdBindingAndRetransmitTests(unittest.TestCase):
    def test_same_payload_retransmit_replays_original_verdict(self):
        s = seeded_store()
        p = payload("once", 0, points={"calib.sensorA.offset": "0.012"},
                    writes={"calib.sensorA.offset": "0.020"})
        r1 = s.commit(p)
        r2 = s.commit(dict(p))
        self.assertEqual(r1["status"], ACCEPTED)
        self.assertTrue(r2["replay"])
        self.assertEqual(r2["new_generation"], 1)
        self.assertEqual(s.current_generation(), 1)  # no extra generation
        self.assertEqual(len(s.history()), 2)

    def test_rejected_verdict_is_also_replayed(self):
        s = seeded_store()
        s.commit(payload("writer", 0,
                         writes={"calib.sensorA.offset": "x"}))
        p = payload("rejected-once", 0,
                    points={"calib.sensorA.offset": "0.012"},
                    writes={"q": "v"})
        r1 = s.commit(p)
        r2 = s.commit(dict(p))
        self.assertEqual(r1["reason"], REJECT_POINT_READ)
        self.assertTrue(r2["replay"])
        self.assertEqual(r2["reason"], REJECT_POINT_READ)

    def test_same_id_different_payload_rejected(self):
        s = seeded_store()
        r1 = s.commit(payload("dup-id", 0, writes={"a": "1"}))
        self.assertEqual(r1["status"], ACCEPTED)
        r2 = s.commit(payload("dup-id", 0, writes={"b": "2"}))
        self.assertEqual(r2["status"], REJECTED)
        self.assertEqual(r2["reason"], REJECT_ID_CONFLICT)
        # Even a same-id payload that only changes reads (same writes) is a
        # different canonical payload and must be refused.
        r3 = s.commit(payload("dup-id", 0, points={"z": None},
                              writes={"a": "1"}))
        self.assertEqual(r3["reason"], REJECT_ID_CONFLICT)
        self.assertEqual(s.current_generation(), 1)

    def test_canonical_binding_ignores_key_order_and_whitespace(self):
        s = seeded_store({"a": "1", "b": "2", "p.1": "x", "p.2": "y"})
        p1 = payload("order", 0, points={"a": "1", "b": "2"},
                     scans=[{"prefix": "p.", "seen_keys": ["p.1", "p.2"]}],
                     writes={"w": "x"})
        r1 = s.commit(json.loads(json.dumps(p1)))
        p2 = {
            "writes": {"w": "x"},
            "transaction_id": "order",
            "prefix_scans": [{"seen_keys": ["p.2", "p.1"],
                              "prefix": "p."}],
            "snapshot_generation": 0,
            "point_reads": {"b": "2", "a": "1"},
        }
        r2 = s.commit(p2)
        self.assertEqual(r1["status"], ACCEPTED)
        self.assertTrue(r2["replay"])


class RestartPersistenceTests(unittest.TestCase):
    def test_verdict_survives_reopen_and_retransmit_echoes(self):
        store, path = fresh_store()
        store.seed({"a": "1", "p.1": "x"})
        p = payload("durable", 0, points={"a": "1"},
                    scans=[{"prefix": "p.", "seen_keys": ["p.1"]}],
                    writes={"a": "2", "p.2": "y"})
        r1 = store.commit(p)
        self.assertEqual(r1["status"], ACCEPTED)

        # Simulate service restart: reopen the same backing file.
        reopened = Store(path)
        self.assertEqual(reopened.current_generation(), 1)
        ex = reopened.export_exercise()
        self.assertEqual(ex["keys"]["a"]["value"], "2")
        self.assertEqual(ex["keys"]["p.2"]["value"], "y")
        # Retransmit after reopen only echoes the original verdict.
        r2 = reopened.commit(dict(p))
        self.assertTrue(r2["replay"])
        self.assertEqual(r2["new_generation"], 1)
        self.assertEqual(reopened.current_generation(), 1)
        # Different payload reuse still rejected after reopen.
        r3 = reopened.commit(payload("durable", 0, writes={"a": "9"}))
        self.assertEqual(r3["reason"], REJECT_ID_CONFLICT)

    def test_rejected_verdict_survives_reopen(self):
        store, path = fresh_store()
        store.seed({"a": "1"})
        store.commit(payload("winner", 0, writes={"a": "2"}))
        p = payload("loser", 0, points={"a": "1"}, writes={"a": "3"})
        self.assertEqual(store.commit(p)["reason"], REJECT_POINT_READ)
        reopened = Store(path)
        r = reopened.commit(dict(p))
        self.assertTrue(r["replay"])
        self.assertEqual(r["reason"], REJECT_POINT_READ)
        self.assertEqual(reopened.export_exercise()["keys"]["a"]["value"], "2")

    def test_on_disk_file_is_valid_json_log(self):
        store, path = fresh_store()
        store.seed({"a": "1"})
        store.commit(payload("t", 0, points={"a": "1"}, writes={"a": "2"}))
        with open(path, encoding="utf-8") as fh:
            blob = json.load(fh)
        self.assertEqual(blob["current_generation"], 1)
        self.assertEqual(len(blob["generations"]), 2)
        self.assertIn("t", blob["transactions"])


class ConcurrencyTests(unittest.TestCase):
    def test_parallel_disjoint_commits_all_accepted(self):
        s = seeded_store()
        results = []
        errors = []

        def worker(i):
            try:
                results.append(s.commit(payload(
                    f"par-{i}", 0,
                    points={f"k{i}": None},
                    writes={f"k{i}": f"v{i}"},
                )))
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertFalse(errors)
        self.assertEqual(sum(r["status"] == ACCEPTED for r in results), 10)
        self.assertEqual(s.current_generation(), 10)
        gens = sorted(r["new_generation"] for r in results)
        self.assertEqual(gens, list(range(1, 11)))

    def test_parallel_competing_writes_single_winner(self):
        s = seeded_store({"hot": "v0"})
        outcomes = []

        def worker(i):
            outcomes.append(s.commit(payload(
                f"race-{i}", 0, points={"hot": "v0"},
                writes={"hot": f"v{i}"},
            )))

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        accepted = [o for o in outcomes if o["status"] == ACCEPTED]
        rejected = [o for o in outcomes if o["status"] == REJECTED]
        self.assertEqual(len(accepted), 1)
        self.assertEqual(len(rejected), 7)
        self.assertTrue(all(o["reason"] == REJECT_POINT_READ for o in rejected))
        self.assertEqual(s.current_generation(), 1)


class InvalidPayloadTests(unittest.TestCase):
    def test_bad_payloads_raise_engine_error(self):
        s = seeded_store()
        bad = [
            {},
            {"transaction_id": "", "snapshot_generation": 0},
            {"transaction_id": "x"},
            {"transaction_id": "x", "snapshot_generation": -1},
            {"transaction_id": "x", "snapshot_generation": "0"},
            {"transaction_id": "x", "snapshot_generation": 0,
             "point_reads": []},
            {"transaction_id": "x", "snapshot_generation": 0,
             "prefix_scans": {}},
            {"transaction_id": "x", "snapshot_generation": 0,
             "prefix_scans": [{"prefix": "p"}]},
            {"transaction_id": "x", "snapshot_generation": 0,
             "prefix_scans": [{"prefix": "p", "seen_keys": ["a", "a"]}]},
            {"transaction_id": "x", "snapshot_generation": 999,
             "writes": {}},
        ]
        for p in bad:
            with self.subTest(p=p):
                with self.assertRaises(EngineError):
                    s.commit(p)


if __name__ == "__main__":
    unittest.main(verbosity=2)
