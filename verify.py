#!/usr/bin/env python3
"""One-shot acceptance verifier for the ground calibration library.

Phases (any failure aborts with a non-zero exit code):

  1. BUILD  - byte-compile every module and import the server package.
  2. RULES  - run the immutable-history rule suite (unittest).
  3. ENGINE - restart/reopen durability: verdict replay after reopening the
              backing file, different-payload id reuse rejected.
  4. HTTP   - live API/HTTP smoke against BASE_URL:
                * health response and static page/assets
                * exercise with initial keys
                * disjoint commits from one snapshot both accepted
                * prefix insert after snapshot -> phantom rejection
                * point read rewrite -> point conflict
                * write skew -> second commit stopped at read checks
                * identical retransmit -> original verdict echoed (replay)
                * same id, different payload -> rejected

Scenarios use a unique run-id prefix and learn snapshot generations at
runtime, so repeated runs against a persistent volume stay deterministic.

Usage:  python3 verify.py [BASE_URL]
Exit 0 = accepted, non-zero = rejected acceptance.
"""

from __future__ import annotations

import json
import os
import py_compile
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

BASE_URL = (sys.argv[1] if len(sys.argv) > 1
            else os.environ.get("BASE_URL", "http://127.0.0.1:8080")).rstrip("/")

PASS = "PASS"
FAIL = "FAIL"
results: list[tuple[str, str, str]] = []


def record(phase: str, ok: bool, detail: str) -> bool:
    results.append((phase, PASS if ok else FAIL, detail))
    mark = "✓" if ok else "✗"
    print(f"  [{mark}] {detail}", flush=True)
    return ok


# ------------------------------------------------------------------------ HTTP
def http(method: str, path: str, body=None, timeout: int = 10,
         expect_status: int | None = None):
    url = f"{BASE_URL}{path}"
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            status = resp.status
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8")
        status = exc.code
    parsed = None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        pass
    if expect_status is not None and status != expect_status:
        raise AssertionError(
            f"{method} {path}: expected HTTP {expect_status}, got {status}: {raw[:200]}"
        )
    return status, parsed, raw


def wait_for_health(deadline_s: float = 60.0) -> bool:
    print(f"\n[4/4] HTTP smoke against {BASE_URL}", flush=True)
    start = time.time()
    last = None
    while time.time() - start < deadline_s:
        try:
            status, body, _ = http("GET", "/healthz", timeout=3)
            if status == 200 and body and body.get("status") == "ok":
                return record("HTTP", True,
                              f"healthz reports ok, current_generation="
                              f"{body.get('current_generation')}")
        except Exception as exc:  # noqa: BLE001
            last = exc
        time.sleep(1)
    return record("HTTP", False, f"service never became healthy: {last}")


# --------------------------------------------------------------------- phases
def phase_build() -> bool:
    print("\n[1/4] Build checks", flush=True)
    ok = True
    targets = []
    for root, _dirs, files in os.walk(os.path.join(HERE, "app")):
        for f in files:
            if f.endswith(".py"):
                targets.append(os.path.join(root, f))
    targets.append(os.path.join(HERE, "verify.py"))
    for t in targets:
        try:
            py_compile.compile(t, doraise=True)
        except py_compile.PyCompileError as exc:
            ok &= record("BUILD", False, f"compile {os.path.relpath(t, HERE)}: {exc}")
    ok &= record("BUILD", os.path.exists(targets[0]),
                 f"byte-compiled {len(targets)} python files")
    try:
        import app.server  # noqa: F401
        import app.engine  # noqa: F401
        ok &= record("BUILD", True, "server/engine modules import cleanly")
    except Exception as exc:  # noqa: BLE001
        ok &= record("BUILD", False, f"import failed: {exc}")
    for required in ("Dockerfile", "docker-compose.yml"):
        ok &= record("BUILD", os.path.isfile(os.path.join(HERE, required)),
                     f"{required} present")
    return ok


def phase_rules() -> bool:
    print("\n[2/4] Rule tests (immutable version history)", flush=True)
    loader = unittest.TestLoader()
    suite = loader.discover(os.path.join(HERE, "tests"), top_level_dir=HERE)
    runner = unittest.TextTestRunner(verbosity=1, stream=sys.stderr)
    ok = runner.run(suite).wasSuccessful()
    n = suite.countTestCases()
    return record("RULES", ok, f"{n} arbitration rule tests "
                               f"{'passed' if ok else 'FAILED'}")


def phase_engine_restart() -> bool:
    print("\n[3/4] Engine: reopen durability & id binding", flush=True)
    from app.engine import Store, ACCEPTED, REJECTED
    ok = True
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".json")
    tmp.close()
    os.unlink(tmp.name)
    try:
        store = Store(tmp.name)
        store.seed({"a": "1", "p.1": "x"})
        p = {
            "transaction_id": "verify-durable",
            "snapshot_generation": 0,
            "point_reads": {"a": "1"},
            "prefix_scans": [{"prefix": "p.", "seen_keys": ["p.1"]}],
            "writes": {"a": "2", "p.2": "y"},
        }
        r1 = store.commit(p)
        ok &= record("ENGINE", r1["status"] == ACCEPTED,
                     "accepted commit frozen at generation 1")

        reopened = Store(tmp.name)
        ex = reopened.export_exercise()
        ok &= record(
            "ENGINE",
            reopened.current_generation() == 1
            and ex["keys"]["a"]["value"] == "2"
            and ex["keys"]["p.2"]["value"] == "y",
            "after reopen: generation and writes recovered from disk",
        )
        r2 = reopened.commit(dict(p))
        ok &= record(
            "ENGINE",
            bool(r2.get("replay")) and r2.get("new_generation") == 1,
            "after reopen retransmit of same id echoes original verdict",
        )
        r3 = reopened.commit({**p, "writes": {"a": "9"}})
        ok &= record(
            "ENGINE",
            r3["status"] == REJECTED and r3["reason"] == "transaction_id_conflict",
            "after reopen reuse of id with different payload is rejected",
        )
    finally:
        if os.path.exists(tmp.name):
            os.unlink(tmp.name)
    return ok


def phase_http() -> bool:
    if not wait_for_health():
        return False
    ok = True
    run_id = uuid.uuid4().hex[:8]

    # --- static page and assets
    for path, needle in (("/", "地面标定库"), ("/app.js", "REASON_LABELS"),
                         ("/styles.css", ".txn")):
        try:
            status, _body, raw = http("GET", path)
            ok &= record("HTTP", status == 200 and needle in raw,
                         f"GET {path} serves page asset ({needle!r} present)")
        except Exception as exc:  # noqa: BLE001
            ok &= record("HTTP", False, f"GET {path}: {exc}")

    # --- exercise with initial keys (idempotent if volume pre-seeded)
    initial = {f"seed.{run_id}.a": "0.012", f"seed.{run_id}.b": "-0.030"}
    status, body, _ = http("POST", "/api/exercise", {"initial": initial})
    if status == 201:
        ok &= record("HTTP", body["generation"] == 0,
                     "exercise created with initial keys at generation 0")
    elif status == 400 and "already initialized" in str(body):
        ok &= record("HTTP", True,
                     "exercise already initialized on persistent volume "
                     "(scenarios use unique run-id keys)")
    else:
        ok &= record("HTTP", False, f"unexpected seed response {status}: {body}")

    status, state, _ = http("GET", "/api/state")
    gen0 = state["current_generation"]
    ok &= record("HTTP", status == 200 and isinstance(gen0, int),
                 f"state endpoint reports current generation {gen0}")

    # --- setup unique scenario keys in one accepted commit
    setup_writes = {
        f"vf.{run_id}.dx": "100",
        f"vf.{run_id}.dy": "200",
        f"vf.{run_id}.sx": "100",
        f"vf.{run_id}.sy": "200",
        f"vf.{run_id}.A.off": "1",
        f"vf.{run_id}.A.gain": "2",
        f"vf.{run_id}.hot": "v0",
    }
    setup = {
        "transaction_id": f"verify-{run_id}-setup",
        "snapshot_generation": gen0,
        "point_reads": {},
        "prefix_scans": [],
        "writes": setup_writes,
    }
    _, rsetup, _ = http("POST", "/api/commit", setup)
    gsetup = rsetup.get("new_generation")
    ok &= record("HTTP", rsetup.get("status") == "accepted",
                 f"setup commit accepted, frozen generation {gsetup}")
    if not gsetup:
        return False

    # --- disjoint commits from the SAME snapshot both succeed
    d1 = {
        "transaction_id": f"verify-{run_id}-disjoint-A",
        "snapshot_generation": gsetup,
        "point_reads": {f"vf.{run_id}.dx": "100"},
        "prefix_scans": [],
        "writes": {f"vf.{run_id}.dx": "101"},
    }
    d2 = {
        "transaction_id": f"verify-{run_id}-disjoint-B",
        "snapshot_generation": gsetup,
        "point_reads": {f"vf.{run_id}.dy": "200"},
        "prefix_scans": [],
        "writes": {f"vf.{run_id}.dy": "201"},
    }
    _, rd1, _ = http("POST", "/api/commit", d1)
    _, rd2, _ = http("POST", "/api/commit", d2)
    ok &= record(
        "HTTP",
        rd1.get("status") == "accepted" and rd2.get("status") == "accepted"
        and rd2.get("new_generation") == rd1.get("new_generation", 0) + 1,
        "disjoint commits from one snapshot both accepted "
        f"(gens {rd1.get('new_generation')}, {rd2.get('new_generation')})",
    )

    # --- prefix scan: new key inserted after snapshot -> phantom rejection
    prefix = f"vf.{run_id}.A."
    seen = [f"vf.{run_id}.A.gain", f"vf.{run_id}.A.off"]
    _, rins, _ = http("POST", "/api/commit", {
        "transaction_id": f"verify-{run_id}-phantom-inserter",
        "snapshot_generation": gsetup,
        "point_reads": {},
        "prefix_scans": [],
        "writes": {f"vf.{run_id}.A.new": "9"},
    })
    ok &= record("HTTP", rins.get("status") == "accepted",
                 "phantom scenario: inserter commit accepted")
    _, rscan, _ = http("POST", "/api/commit", {
        "transaction_id": f"verify-{run_id}-phantom-scanner",
        "snapshot_generation": gsetup,
        "point_reads": {},
        "prefix_scans": [{"prefix": prefix, "seen_keys": sorted(seen)}],
        "writes": {f"vf.{run_id}.phantom-sideeffect": "must-not-apply"},
    })
    added = (rscan.get("phantom_conflicts") or [{}])[0] \
        .get("keys_added_after_snapshot", [])
    ok &= record(
        "HTTP",
        rscan.get("status") == "rejected"
        and rscan.get("reason") == "phantom_read"
        and added == [f"vf.{run_id}.A.new"]
        and "must-not-apply" not in json.dumps(
            http("GET", "/api/state")[1].get("keys", {})),
        "prefix insert after snapshot rejected as phantom_read; no writes installed",
    )

    # --- point read: rewritten key -> point conflict
    _, rwrite, _ = http("POST", "/api/commit", {
        "transaction_id": f"verify-{run_id}-point-writer",
        "snapshot_generation": gsetup,
        "point_reads": {f"vf.{run_id}.hot": "v0"},
        "prefix_scans": [],
        "writes": {f"vf.{run_id}.hot": "v1"},
    })
    _, rpoint, _ = http("POST", "/api/commit", {
        "transaction_id": f"verify-{run_id}-point-reader",
        "snapshot_generation": gsetup,
        "point_reads": {f"vf.{run_id}.hot": "v0"},
        "prefix_scans": [],
        "writes": {f"vf.{run_id}.point-sideeffect": "must-not-apply"},
    })
    ok &= record(
        "HTTP",
        rwrite.get("status") == "accepted"
        and rpoint.get("status") == "rejected"
        and rpoint.get("reason") == "point_read_conflict"
        and rpoint["point_conflicts"][0]["current_value"] == "v1",
        "rewritten point read rejected as point_read_conflict",
    )

    # --- write skew from same snapshot: second commit stopped
    wa = {
        "transaction_id": f"verify-{run_id}-skew-A",
        "snapshot_generation": gsetup,
        "point_reads": {f"vf.{run_id}.sx": "100"},
        "prefix_scans": [],
        "writes": {f"vf.{run_id}.sy": "skew-y"},
    }
    wb = {
        "transaction_id": f"verify-{run_id}-skew-B",
        "snapshot_generation": gsetup,
        "point_reads": {f"vf.{run_id}.sy": "200"},
        "prefix_scans": [],
        "writes": {f"vf.{run_id}.sx": "skew-x"},
    }
    _, rwa, _ = http("POST", "/api/commit", wa)
    _, rwb, _ = http("POST", "/api/commit", wb)
    state_after = http("GET", "/api/state")[1]
    ok &= record(
        "HTTP",
        rwa.get("status") == "accepted"
        and rwb.get("status") == "rejected"
        and rwb.get("reason") == "point_read_conflict"
        and state_after["keys"][f"vf.{run_id}.sy"]["value"] == "skew-y"
        and state_after["keys"][f"vf.{run_id}.sx"]["value"] == "100",
        "write skew: second commit cannot pass read checks or install writes",
    )

    # --- retransmit identical payload echoes original verdict
    _, replay, _ = http("POST", "/api/commit", wa)
    ok &= record(
        "HTTP",
        replay.get("replay") is True
        and replay.get("status") == "accepted"
        and replay.get("new_generation") == rwa.get("new_generation"),
        "identical retransmit echoes original verdict (replay=true, "
        "same generation)",
    )

    # --- same id with different payload rejected
    _, reuse, _ = http("POST", "/api/commit", {**wa, "writes": {
        f"vf.{run_id}.y": "hijacked"}})
    ok &= record(
        "HTTP",
        reuse.get("status") == "rejected"
        and reuse.get("reason") == "transaction_id_conflict",
        "same transaction id with different payload rejected "
        "(transaction_id_conflict)",
    )

    # --- transactions listing + per-txn lookup expose verdict evidence
    _, listing, _ = http("GET", "/api/transactions")
    ids = [t["transaction_id"] for t in listing["transactions"]]
    _, one, _ = http("GET",
                     f"/api/transactions/verify-{run_id}-phantom-scanner")
    ok &= record(
        "HTTP",
        f"verify-{run_id}-phantom-scanner" in ids
        and one.get("read_summary", {}).get("prefix_scans")
        and one["read_summary"]["prefix_scans"][0]["seen_at_snapshot"]
        == sorted(seen),
        "transaction list and lookup expose frozen scan evidence "
        "(snapshot keys expandable)",
    )

    # --- snapshot helper endpoints
    _, scanview, _ = http("GET",
                          f"/api/snapshot/scan?generation={gsetup}"
                          f"&prefix=vf.{run_id}.A.")
    ok &= record(
        "HTTP",
        scanview.get("generation") == gsetup
        and {k["key"] for k in scanview.get("keys", [])} == set(seen),
        "snapshot prefix-scan endpoint returns the exact snapshot key set",
    )

    return ok


def main() -> int:
    print("=" * 68)
    print("Ground calibration library — one-shot acceptance verification")
    print(f"target service: {BASE_URL}")
    print("=" * 68)

    build_ok = phase_build()
    rules_ok = phase_rules()
    engine_ok = phase_engine_restart()
    http_ok = phase_http()

    print("\n" + "=" * 68)
    print("SUMMARY")
    print("-" * 68)
    for phase, mark, detail in results:
        print(f"  {phase:7s} [{mark}] {detail}")
    print("-" * 68)
    overall = build_ok and rules_ok and engine_ok and http_ok
    verdict = "ACCEPTED ✓ — all build, rule and API/HTTP checks passed" \
        if overall else "REJECTED ✗ — acceptance checks failed (see above)"
    print(verdict)
    print("=" * 68)
    return 0 if overall else 1


if __name__ == "__main__":
    raise SystemExit(main())
