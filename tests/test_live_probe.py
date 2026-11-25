import importlib
import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
probe = importlib.import_module("live-probe")

PLUGIN = "balge.jying"
URL = "https://www.jying.top/api/csrf/"


class LiveProbeTests(unittest.TestCase):
    def test_quickjs_has_sync_fetch_and_private_cross_call_storage(self):
        entry = '''
          let firstCall = true;
          function search(args) {
            const response = mv.fetch({url: args.url, follow_redirects: false, proxy: false});
            mv.storage.set("fixture", response.set_cookies);
            firstCall = false;
            return {
              status: response.status, url: response.url, body: response.body,
              header: response.headers.location, proxied: response.proxied
            };
          }
          function resolve(args) {
            const cookie = mv.storage.get("fixture");
            mv.storage.remove("fixture");
            return {
              cookie, firstCall, missing: mv.storage.get("fixture"), remaining: mv.time.remainingMs(),
              roundtrip: mv.crypto.base64Decode(mv.crypto.base64Encode(args.text)),
              hash: mv.crypto.sha256("abc")
            };
          }
        '''
        store = {}
        calls = []

        def send(url, method, headers, body, timeout, proxy):
            calls.append((url, method, headers, body, timeout, proxy))
            return 302, [("Location", "/next"), ("Set-Cookie", "fixture=a"),
                         ("Set-Cookie", "cookie=b")], b"redirect", False

        result, stats = probe.run_entry(entry, PLUGIN, {}, store, "search", {"url": URL},
                                        time.monotonic() + 2, send)
        self.assertEqual(result, {
            "status": 302, "url": URL, "body": "redirect", "header": "/next", "proxied": False,
        })
        self.assertEqual(stats["http_statuses"], {"302": 1})
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][:2], (URL, "GET"))
        self.assertGreater(calls[0][4], 0)
        self.assertLessEqual(calls[0][4], 2)
        self.assertFalse(calls[0][5])
        result, stats = probe.run_entry(entry, PLUGIN, {}, store, "resolve", {"text": "测试"},
                                        time.monotonic() + 2, send)
        self.assertEqual(result["cookie"], ["fixture=a", "cookie=b"])
        self.assertEqual(result["roundtrip"], "测试")
        self.assertEqual(result["hash"], "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        self.assertTrue(result["firstCall"])
        self.assertIsNone(result["missing"])
        self.assertGreater(result["remaining"], 0)
        self.assertEqual(stats["requests"], 0)
        self.assertEqual(store, {})

    def test_allowlist_and_per_call_request_cap(self):
        entry = '''
          function search(args) {
            let blocked = 0;
            for (const url of args.urls) {
              try { mv.fetch({ url, follow_redirects: false }); }
              catch (_) { blocked++; }
            }
            return { blocked };
          }
        '''
        sends = []

        def send(url, *_):
            sends.append(url)
            return 200, [], b"", False

        args = {"urls": ["https://115.com/s/fixture", "https://www.jying.top/api/purchase/"] + [URL] * 31}
        result, stats = probe.run_entry(entry, PLUGIN, {}, {}, "search", args, time.monotonic() + 2, send)
        self.assertEqual(result, {"blocked": 3})
        self.assertEqual(stats["requests"], 30)
        self.assertEqual(sends, [URL] * 30)

    def test_proxy_and_deadline_are_applied_at_dispatch(self):
        sends = []

        def send(url, method, headers, body, timeout, proxy):
            sends.append((timeout, proxy))
            return 200, [], b"", proxy

        deadline = time.monotonic() + 0.5
        entry = 'function search(q) { return mv.fetch({url: q.url, proxy: true, timeout: 10}); }'
        result, _ = probe.run_entry(entry, PLUGIN, {}, {}, "search", {"url": URL}, deadline, send)
        self.assertTrue(result["proxied"])
        self.assertEqual(len(sends), 1)
        self.assertGreater(sends[0][0], 0)
        self.assertLessEqual(sends[0][0], 0.5)
        self.assertTrue(sends[0][1])
        result, stats = probe.run_entry(entry, PLUGIN, {}, {}, "search", {"url": URL},
                                        time.monotonic() - 0.1, send)
        self.assertIsNone(result)
        self.assertEqual(stats["requests"], 0)
        self.assertEqual(len(sends), 1)
        with patch.object(probe.request, "getproxies", return_value={"https": "http://proxy.example:80"}):
            with patch.object(probe.request, "proxy_bypass", return_value=False):
                self.assertEqual(probe.proxy_for(URL, True), {"https": "http://proxy.example:80"})
                self.assertEqual(probe.proxy_for(URL, False), {})

    def test_cli_prints_only_sanitized_selected_result(self):
        entry = """
          let cleanContext = true;
          function search() {
            mv.storage.set('session', 'fixture-private-session');
            cleanContext = false;
            return {items: [
              {link_type: '115', resolve_token: 'first-fixture-selection'},
              {link_type: 'magnet', resolve_token: 'second-fixture-selection'}
            ]};
          }
          function resolve(args) {
            if (args.token !== 'first-fixture-selection' || !cleanContext ||
                mv.storage.get('session') !== 'fixture-private-session' ||
                mv.config.password !== 'fixture-private-password') throw new Error('invalid state');
            return {share_link: 'https://115.com/s/fixture-private-share', share_code: 'a2BC'};
          }
        """
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Path(temporary)
            folder = fixture / "dist" / PLUGIN
            folder.mkdir(parents=True)
            (folder / "main.js").write_text(entry, encoding="utf-8")
            accounts = fixture / "accounts.json"
            accounts.write_text(json.dumps({PLUGIN: {
                "username": "fixture-private-user", "password": "fixture-private-password",
            }}), encoding="utf-8")
            run = subprocess.run([sys.executable, str(Path(probe.__file__)),
                                  "--dist", str(fixture / "dist"), "--accounts", str(accounts),
                                  "--plugin", PLUGIN, "--keyword", "fixture-private-keyword"],
                                 capture_output=True, text=True, timeout=10)
        self.assertEqual(run.returncode, 0)
        self.assertEqual(run.stderr, "")
        self.assertNotIn("fixture-private", run.stdout)
        self.assertNotIn("first-fixture", run.stdout)
        self.assertNotIn("a2BC", run.stdout)
        result = json.loads(run.stdout)
        self.assertEqual(result["search"]["count"], 2)
        self.assertEqual(result["search"]["types"], {"115": 1, "magnet": 1})
        self.assertEqual(result["selected"], {
            "link_type": "115", "status": "ok", "requests": 0, "http_statuses": {},
            "bridge_errors": 0, "resolved": True, "has_passcode": True,
        })

    def test_call_watchdog_stops_nonterminating_quickjs(self):
        store = {"initial": True}
        start = time.monotonic()
        result, stats, state = probe.run_call(
            'function search() { mv.storage.set("fixture", true); while (true) {} }',
            PLUGIN, {}, store, "search", {}, seconds=0.3)
        self.assertIsNone(result)
        self.assertEqual(state, "timeout")
        self.assertEqual(store, {"initial": True})
        self.assertEqual(stats["requests"], 0)
        self.assertLess(time.monotonic() - start, 3)


if __name__ == "__main__":
    unittest.main()
