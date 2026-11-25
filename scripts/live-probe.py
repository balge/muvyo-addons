#!/usr/bin/env python3
"""Manually probe one built add-on with native QuickJS. Results contain counts only."""

import argparse
import base64
import hashlib
import json
import math
import multiprocessing
import re
import signal
import time
import urllib.error
import urllib.parse
import zlib
from contextlib import contextmanager
from pathlib import Path
from urllib import request

import quickjs


ROOT = Path(__file__).resolve().parents[1]
SOURCES = {
    "balge.miniyingshi": ("mini", "www.miniyingshi.com", {
        "GET": r"/api/(?:search/titles|titles/[a-zA-Z0-9]{1,32}/(?:torrents|netdisk-shares)|"
               r"torrent-groups/[a-zA-Z0-9]{1,32}|torrents/[a-zA-Z0-9]{1,32}|"
               r"netdisk-shares/[a-zA-Z0-9]{1,32}/credential)",
        "POST": r"/api/(?:auth/login|gate)",
    }),
    "balge.woniu": ("woniu", "www.wn4k.com", {
        "GET": r"/(?:vodsearch/[^/]+|voddetail/[1-9][0-9]{0,11})/",
        "POST": r"/user/login\.html",
    }),
    "balge.jying": ("jying", "www.jying.top", {
        "GET": r"/api/(?:csrf/|app/(?:movies/|movie/[1-9][0-9]*/resources/))",
        "POST": r"/api/app/(?:login/|resource/[1-9][0-9]*/access/)",
    }),
}
LINK_TYPES = ("115", "magnet")
MAX_REQUESTS = 30
MAX_BODY = 4 * 1024 * 1024
MAX_RESULT = 256 * 1024


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


@contextmanager
def request_alarm(seconds):
    def on_timeout(_signal, _frame):
        raise TimeoutError("HTTP deadline exceeded")

    previous = signal.signal(signal.SIGALRM, on_timeout)
    signal.setitimer(signal.ITIMER_REAL, max(0.000001, seconds))
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def proxy_for(url, enabled):
    if not enabled:
        return {}
    parsed = urllib.parse.urlsplit(url)
    if request.proxy_bypass(parsed.hostname):
        return {}
    proxy = request.getproxies().get(parsed.scheme)
    return {parsed.scheme: proxy} if proxy else {}


def send_http(url, method, headers, body, timeout, proxy_enabled):
    end = time.monotonic() + timeout
    with request_alarm(timeout):
        proxies = proxy_for(url, proxy_enabled)
        opener = request.build_opener(NoRedirect, request.ProxyHandler(proxies))
        outgoing = request.Request(url, data=body, headers=headers, method=method)
        remaining = end - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("HTTP deadline exhausted")
        try:
            response = opener.open(outgoing, timeout=remaining)
        except urllib.error.HTTPError as response_error:
            response = response_error
        with response:
            return response.status, list(response.headers.items()), response.read(MAX_BODY + 1), bool(proxies)


def decode_body(body, encoding):
    if len(body) > MAX_BODY:
        raise ValueError("HTTP response exceeds the size limit")
    if encoding not in ("gzip", "deflate"):
        return body
    headers = (31,) if encoding == "gzip" else (zlib.MAX_WBITS, -zlib.MAX_WBITS)
    for header in headers:
        decoder = zlib.decompressobj(header)
        try:
            decoded = decoder.decompress(body, MAX_BODY + 1)
        except zlib.error:
            continue
        if decoder.eof and not decoder.unused_data and len(decoded) <= MAX_BODY:
            return decoded
    raise ValueError("Invalid compressed HTTP response")


def allowed_url(plugin_id, url, method):
    _, domain, routes = SOURCES[plugin_id]
    if not isinstance(url, str) or re.search(r"[\x00-\x20\x7f\\]", url):
        return False
    parsed = urllib.parse.urlsplit(url)
    route = routes.get("GET" if method == "HEAD" else method)
    return (parsed.scheme == "https" and parsed.netloc == domain and not parsed.fragment and
            route is not None and re.fullmatch(route, parsed.path) is not None)


class Invocation:
    def __init__(self, plugin_id, deadline, send):
        self.plugin_id = plugin_id
        self.deadline = deadline
        self.send = send
        self.stats = {"requests": 0, "http_statuses": {}, "bridge_errors": 0}

    def remaining_ms(self):
        return max(0, int((self.deadline - time.monotonic()) * 1000))

    def fetch(self, query):
        params = json.loads(query)
        if isinstance(params, str):
            params = {"url": params}
        url = params["url"]
        method = params.get("method", "GET").upper()
        blocked = {"host", "content-length", "connection", "transfer-encoding", "proxy-authorization",
                   "proxy-connection", "expect", "upgrade"}
        headers = {key.lower(): value for key, value in params.get("headers", {}).items()
                   if key.lower() not in blocked}
        headers.setdefault("user-agent", "Muvyo-Addon/1")
        headers.setdefault("accept-encoding", "gzip, deflate")
        body = params["body"].encode("utf-8") if "body" in params else None
        if body is not None and len(body) > 1024 * 1024:
            raise ValueError("HTTP request body exceeds the size limit")
        requested_timeout = params.get("timeout", 20)
        if type(requested_timeout) not in (int, float) or not math.isfinite(requested_timeout) or requested_timeout <= 0:
            raise ValueError("Invalid HTTP timeout")
        request_end = min(self.deadline, time.monotonic() + min(20, requested_timeout))
        for redirect_count in range(4):
            if not allowed_url(self.plugin_id, url, method):
                raise ValueError("HTTP destination outside the source route allowlist")
            if self.stats["requests"] >= MAX_REQUESTS:
                raise ValueError("HTTP request cap exhausted")
            timeout = request_end - time.monotonic()
            if timeout <= 0:
                raise TimeoutError("Invocation or HTTP deadline exhausted")
            self.stats["requests"] += 1
            status, fields, response_body, proxied = self.send(
                url, method, headers, body, timeout, params.get("proxy") is True)
            statuses = self.stats["http_statuses"]
            statuses[str(status)] = statuses.get(str(status), 0) + 1
            response_headers = {key.lower(): value for key, value in fields}
            if (params.get("follow_redirects") is not False and status in (301, 302, 303, 307, 308)
                    and response_headers.get("location")):
                if redirect_count == 3:
                    raise ValueError("HTTP redirect cap exhausted")
                url = urllib.parse.urljoin(url, response_headers["location"])
                if status in (301, 302, 303) and method == "POST":
                    method, body = "GET", None
                continue

            encoding = response_headers.get("content-encoding", "").lower()
            response_body = decode_body(response_body, encoding)
            if encoding in ("gzip", "deflate"):
                response_headers.pop("content-encoding")
            binary = params.get("binary") is True
            response = {
                "status": status,
                "headers": response_headers,
                "set_cookies": [value for key, value in fields if key.lower() == "set-cookie"][:50],
                "body": "" if binary else response_body.decode("utf-8", "replace"),
                "url": url,
                "proxied": proxied,
            }
            if binary:
                response["body_base64"] = base64.b64encode(response_body).decode("ascii")
            return response

    def fetch_json(self, query):
        try:
            return json.dumps(self.fetch(query))
        except Exception:
            self.stats["bridge_errors"] += 1
            return None


def run_entry(entry, plugin_id, settings, store, call, args, deadline, send=send_http):
    invocation = Invocation(plugin_id, deadline, send)
    context = quickjs.Context()
    context.set_memory_limit(32 * 1024 * 1024)

    def storage_set(key, value):
        updated = {**store, key: json.loads(value)}
        if len(json.dumps(updated, ensure_ascii=False).encode("utf-8")) > 64 * 1024:
            raise ValueError("Storage exceeds the size limit")
        store.update(updated)

    context.add_callable("_muvyo_fetch", invocation.fetch_json)
    context.add_callable("_muvyo_get", lambda key: json.dumps(store.get(key)))
    context.add_callable("_muvyo_set", storage_set)
    context.add_callable("_muvyo_remove", lambda key: store.pop(key, None) is not None)
    context.add_callable("_muvyo_remaining", invocation.remaining_ms)
    context.add_callable("_muvyo_sha256", lambda value: hashlib.sha256(value.encode("utf-8")).hexdigest())
    context.add_callable("_muvyo_encode", lambda value: base64.b64encode(value.encode("utf-8")).decode("ascii"))
    context.add_callable("_muvyo_decode", lambda value: base64.b64decode(value, validate=True).decode("utf-8"))

    context.eval("""
      globalThis.mv = ((fetch, get, set, remove, remainingMs, sha256, base64Encode, base64Decode) => ({
        config: """ + json.dumps(settings) + """,
        fetch: request => {
          const raw = fetch(JSON.stringify(request));
          if (raw === null) throw new Error('Live bridge HTTP request failed');
          return JSON.parse(raw);
        },
        storage: {
          get: key => JSON.parse(get(key)),
          set: (key, value) => { set(key, JSON.stringify(value)); },
          remove: key => { remove(key); },
        },
        time: { remainingMs },
        crypto: { sha256, base64Encode, base64Decode },
      }))(_muvyo_fetch, _muvyo_get, _muvyo_set, _muvyo_remove, _muvyo_remaining,
          _muvyo_sha256, _muvyo_encode, _muvyo_decode);
      for (const key of Object.keys(globalThis)) {
        if (key.startsWith('_muvyo_')) delete globalThis[key];
      }
    """)
    try:
        context.eval(entry)
        payload = context.eval("JSON.stringify(globalThis[" + json.dumps(call) + "](" + json.dumps(args) + "))")
        if payload is None or len(payload.encode("utf-8")) > MAX_RESULT:
            return None, invocation.stats
        return json.loads(payload), invocation.stats
    except quickjs.JSException:
        return None, invocation.stats


def worker(pipe, entry, plugin_id, settings, store, call, args, deadline):
    with pipe:
        try:
            result, stats = run_entry(entry, plugin_id, settings, store, call, args, deadline)
            pipe.send((result, stats, store, "ok" if result is not None else "error"))
        except Exception:
            # Never send exception strings, which could include URLs or the settings payload.
            return


def run_call(entry, plugin_id, settings, store, call, args, seconds=60):
    deadline = time.monotonic() + seconds
    context = multiprocessing.get_context("spawn")
    inbox, outbox = context.Pipe(duplex=False)
    child = context.Process(target=worker, args=(outbox, entry, plugin_id, settings, store, call, args, deadline))
    empty = {"requests": 0, "http_statuses": {}, "bridge_errors": 0}
    with inbox, outbox:
        child.start()
        outbox.close()
        try:
            if not inbox.poll(max(0, deadline - time.monotonic())):
                return None, empty, "timeout"
            try:
                result, stats, next_store, state = inbox.recv()
            except EOFError:
                return None, empty, "error"
            if time.monotonic() >= deadline:
                return None, stats, "timeout"
            store.clear()
            store.update(next_store)
            return result, stats, state
        finally:
            if child.is_alive():
                child.kill()
            child.join()
            child.close()


class SafeParser(argparse.ArgumentParser):
    def error(self, _message):
        self.exit(2, '{"status":"invalid_arguments"}\n')


def parse_limit(value):
    number = int(value)
    if not 1 <= number <= 20:
        raise ValueError("Limit must be 1–20")
    return number


def plugin_settings(file, plugin_id, limit):
    accounts = json.loads(Path(file).read_bytes())
    site_key = SOURCES[plugin_id][0]
    account = accounts.get(plugin_id, accounts.get(site_key))
    if isinstance(account, str):
        username, password = account.split("/", 1)
    else:
        username, password = account["username"], account["password"]
    if not isinstance(username, str) or not username or not isinstance(password, str) or not password:
        raise ValueError("Account settings are incomplete")
    return {"username": username, "password": password,
            "result_limit": limit, "resource_types": "both"}


def outcome(result, kind):
    if result is None:
        return {"resolved": False}
    if kind == "115":
        return {"resolved": bool(result.get("share_link")), "has_passcode": bool(result.get("share_code"))}
    return {"resolved": bool(result.get("magnets"))}


def main():
    parser = SafeParser(description=__doc__)
    parser.add_argument("--plugin", choices=SOURCES, required=True)
    parser.add_argument("--accounts", type=Path, required=True, help="Private account JSON file")
    parser.add_argument("--keyword", required=True)
    parser.add_argument("--dist", type=Path, default=ROOT / "dist")
    parser.add_argument("--limit", type=parse_limit, default=5)
    parser.add_argument("--query-limit", type=parse_limit)
    parser.add_argument("--link-type", choices=LINK_TYPES, help="Restrict search to one link type")
    args = parser.parse_args()
    entry = (args.dist / args.plugin / "main.js").read_text(encoding="utf-8")
    settings = plugin_settings(args.accounts, args.plugin, args.limit)
    query = {"keyword": args.keyword}
    if args.query_limit is not None:
        query["limit"] = args.query_limit
    if args.link_type:
        query["link_types"] = [args.link_type]
    store = {}
    result, stats, state = run_call(entry, args.plugin, settings, store, "search", query)
    report = {"plugin": args.plugin, "search": {"status": state, **stats}}
    if state != "ok":
        print(json.dumps(report))
        return 1

    items = result["items"]
    report["search"].update(count=len(items), partial=bool(result.get("partial")),
                            types={kind: sum(item.get("link_type") == kind for item in items) for kind in LINK_TYPES})
    selected = next((item for item in items if item.get("link_type") in LINK_TYPES), None)
    if selected is None:
        print(json.dumps(report))
        return 1

    kind = selected["link_type"]
    token = selected.get("resolve_token")
    if token:
        resolved, stats, state = run_call(entry, args.plugin, settings, store, "resolve", {"token": token})
        report["selected"] = {"link_type": kind, "status": state, **stats, **outcome(resolved, kind)}
    else:
        report["selected"] = {"link_type": kind, "status": "inline", **outcome(selected, kind)}
    print(json.dumps(report))
    return 0 if report["selected"]["resolved"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception:
        print('{"status":"probe_error"}')
        raise SystemExit(1)
