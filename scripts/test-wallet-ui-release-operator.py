"""Tests for the UI-release operator extension and the TEST identity bootstrap.

Run: python -m unittest discover -s scripts -p 'test-wallet-ui-release-operator.py' -v
"""
from __future__ import annotations

import hashlib
import http.server
import io
import json
import os
import stat
import sys
import tarfile
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUNDLE = ROOT / ".temp" / "vaydu-wallet-identity-ui-20261028"
sys.path.insert(0, str(BUNDLE))

import wallet_minimal_operator as reviewed  # noqa: E402
import wallet_ui_release_operator as ui  # noqa: E402
import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "bootstrap_flutterwave_test_identity",
    BUNDLE / "bootstrap-flutterwave-test-identity.py",
)
identity = importlib.util.module_from_spec(_spec)
assert _spec and _spec.loader
_spec.loader.exec_module(identity)
BINDING_NAME = identity.BINDING_NAME


class InjectEntryTests(unittest.TestCase):
    def test_inserts_exactly_once_before_body_close(self):
        out = ui.inject_entry("<html><body><app-root></app-root></body></html>")
        self.assertEqual(out.count(ui.ENTRY_SRC), 1)
        self.assertTrue(out.index(ui.ENTRY_SRC) < out.index("</body>"))

    def test_rejects_second_injection(self):
        already = "<html><body>" + ui.ENTRY_TAG + "</body></html>"
        with self.assertRaises(reviewed.Blocked):
            ui.inject_entry(already)

    def test_rejects_unexpected_layout(self):
        with self.assertRaises(reviewed.Blocked):
            ui.inject_entry("<html><body></body><body></body></html>")
        with self.assertRaises(reviewed.Blocked):
            ui.inject_entry("<html><app-root></app-root></html>")


class SafeExtractTests(unittest.TestCase):
    def _tar(self, names):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as handle:
            for name in names:
                data = b"x"
                info = tarfile.TarInfo(name)
                info.size = len(data)
                handle.addfile(info, io.BytesIO(data))
        return buffer.getvalue()

    def test_rejects_traversal_and_absolute(self):
        for name in ["../evil", "/etc/passwd", "a/../../b"]:
            with tempfile.TemporaryDirectory() as tmp:
                archive = Path(tmp) / "a.tar.gz"
                archive.write_bytes(self._tar([name]))
                with self.assertRaises(reviewed.Blocked):
                    ui.safe_extract(archive, Path(tmp) / "out")

    def test_extracts_normal_archive(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "a.tar.gz"
            archive.write_bytes(self._tar(["index.html", "assets/app.js"]))
            destination = Path(tmp) / "out"
            destination.mkdir()
            ui.safe_extract(archive, destination)
            self.assertTrue((destination / "index.html").is_file())


class LoopbackHttpTests(unittest.TestCase):
    def _serve(self, status):
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(status)
                self.end_headers()
                self.wfile.write(b"body")

            def log_message(self, *a):
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.shutdown)
        return server.server_address[1]

    def test_reads_body_without_redirects(self):
        port = self._serve(200)
        status, body = ui.http_get(port, "/")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"body")

    def test_bounded_readiness_fails_on_5xx(self):
        port = self._serve(500)
        started = time.time()
        with self.assertRaises(reviewed.Blocked):
            ui.wait_ready(port, "/", timeout=1.0)
        self.assertLess(time.time() - started, 5)

    def test_free_port_is_loopback_bound(self):
        import socket

        port = ui.free_loopback_port()
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", port))


class ReceiptAndOverrideTests(unittest.TestCase):
    def test_override_is_image_only(self):
        payload = ui.override_payload("web", "sha256:" + "a" * 64)
        self.assertEqual(payload, {"services": {"web": {"image": "sha256:" + "a" * 64}}})
        self.assertNotIn("build", json.dumps(payload))

    def test_original_image_must_match(self):
        record = {"image": "sha256:" + "b" * 64}
        ui._require_original(record, "sha256:" + "b" * 64)
        with self.assertRaises(reviewed.Blocked):
            ui._require_original(record, "sha256:" + "c" * 64)

    def test_reviewed_operator_is_unmodified(self):
        expected = {}
        for line in (BUNDLE / "SHA256SUMS").read_text().splitlines():
            digest, name = line.split("  ", 1)
            expected[name] = digest
        self.assertEqual(expected["wallet_minimal_operator.py"], reviewed.digest(BUNDLE / "wallet_minimal_operator.py"))


class IdentityBootstrapTests(unittest.TestCase):
    def test_binding_name_matches_operator_and_prompt(self):
        self.assertEqual(BINDING_NAME, "FLUTTERWAVE_PROVIDER_ACCOUNT_ID")
        prompt = (BUNDLE / "prompt-wallet-test-binding.py").read_text()
        self.assertIn("FLUTTERWAVE_PROVIDER_ACCOUNT_ID", prompt)
        self.assertNotIn("FLUTTERWAVE_ACCOUNT_ID'", prompt)

    def _result(self, **over):
        data = {
            "id": 288200108,
            "tx_ref": "vaydu-identity-abc",
            "account_id": 17321,
            "currency": "NGN",
            "payment_type": "card",
            "status": "successful",
            "amount": 100,
        }
        data.update(over)
        return {"status": "success", "data": data}

    def test_parses_documented_fields(self):
        evidence = identity.parse_evidence(self._result(), "288200108", "vaydu-identity-abc")
        self.assertEqual(evidence["providerAccountId"], "17321")
        self.assertEqual(evidence["bindingName"], "FLUTTERWAVE_PROVIDER_ACCOUNT_ID")
        self.assertEqual(evidence["currency"], "NGN")
        self.assertEqual(evidence["paymentType"], "card")
        self.assertTrue(evidence["transactionId"])

    def test_rejects_wrong_transaction_or_reference(self):
        with self.assertRaises(RuntimeError):
            identity.parse_evidence(self._result(), "1", "vaydu-identity-abc")
        with self.assertRaises(RuntimeError):
            identity.parse_evidence(self._result(), "288200108", "other")

    def test_rejects_missing_account_id(self):
        for value in [None, "", "0", "abc"]:
            with self.assertRaises(RuntimeError):
                identity.parse_evidence(self._result(account_id=value), "288200108", "vaydu-identity-abc")

    def test_timeout_payload_never_resubmits(self):
        payload = identity.timeout_payload("288200108", "vaydu-identity-abc")
        self.assertEqual(payload["outcome"], "timeout_no_resubmission")
        self.assertFalse(payload["resubmitted"])
        self.assertFalse(payload["walletFileWritten"])
        self.assertFalse(payload["walletLedgerMutation"])

    def test_pending_reference_is_durable_and_unique(self):
        with tempfile.TemporaryDirectory() as tmp:
            original_state, original_pending = identity.STATE, identity.PENDING
            try:
                state = Path(tmp) / "identity-bootstrap"
                identity.STATE = state
                identity.PENDING = state / "pending.json"
                first = identity.pending_reference("17321")
                self.assertEqual(first, identity.pending_reference("17321"))
                self.assertNotEqual(first, identity.pending_reference("99999"))
                self.assertNotEqual(first, identity.pending_reference("17321", force_new=True))
                self.assertRegex(first, r"^vaydu-identity-[0-9a-f]{24}$")
                receipt = json.loads(identity.PENDING.read_text())
                if os.name == "posix":
                    self.assertEqual(stat.S_IMODE(identity.PENDING.stat().st_mode), 0o600)
                self.assertIn("reference", receipt)
            finally:
                identity.STATE, identity.PENDING = original_state, original_pending


if __name__ == "__main__":
    unittest.main()
