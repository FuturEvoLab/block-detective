"""核心纯函数和本地接口的测试：不联网，数据写在临时目录。
用法：python3 -m unittest discover tests"""
import http.client, http.server, importlib.util, io, json, os, shutil, tempfile, threading, unittest, zipfile

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server.py")


def load_server(tmp):
    spec = importlib.util.spec_from_file_location("srv_core", SRC)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    m.DATA = tmp
    m.RESEARCH_DB = os.path.join(tmp, "research.db")
    m.CACHE_DIR = os.path.join(tmp, "cache")
    return m


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="bd-core-")
        cls.m = load_server(cls.tmp)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)


class AddressTests(Base):
    def test_tron_base58(self):
        # USDT-TRC20 合约：hex 41a614f803b6fd780986a42c78ec9c7f77e6ded13c ↔ TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
        self.assertEqual(self.m.tron_hex_to_base58("41a614f803b6fd780986a42c78ec9c7f77e6ded13c"), "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t")
        self.assertEqual(self.m.tron_hex_to_base58(""), "")

    def test_norm_addr(self):
        a = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01"
        self.assertEqual(self.m.norm_addr("eth", "  " + a + " "), a.lower())
        with self.assertRaises(self.m.ApiError):
            self.m.norm_addr("eth", "0x123")
        with self.assertRaises(self.m.ApiError):
            self.m.norm_addr("nochain", a)


class TradeReconstructionTests(Base):
    def setUp(self):
        self.m.native_history = lambda sym: {}  # 不联网：原生币按“现价”计
        self.usdc = next(k for k, v in self.m.KNOWN_TOKENS["eth"].items() if v[1] == "USD")

    def leg(self, h, d, token, amount, symbol, ts=1_700_000_000):
        return {"hash": h, "dir": d, "token": token, "amount": amount, "symbol": symbol, "ts": ts}

    def test_buy_sell_and_skips(self):
        data = {"prices": {"ETH": 2000}, "transfers": [
            # 1 ETH 买入 1000 PEPE → 价值 $2000 的买入
            self.leg("b", "out", "native", 1, "ETH"), self.leg("b", "in", "0xpepe", 1000, "PEPE"),
            # 卖出 500 PEPE 换 1500 USDC
            self.leg("s", "out", "0xpepe", 500, "PEPE", ts=1_700_000_100), self.leg("s", "in", self.usdc, 1500, "USDC", ts=1_700_000_100),
            # 代币换代币：无法定价，计入 swaps
            self.leg("x", "out", "0xpepe", 1, "PEPE"), self.leg("x", "in", "0xdoge", 1, "DOGE"),
            # 稳定币之间互换不算交易
            self.leg("u", "out", self.usdc, 100, "USDC"), self.leg("u", "in", "0xcrvusd", 100, "crvUSD"),
            # 纯转入（空投）不算买入
            self.leg("a", "in", "0xair", 5, "AIR"),
        ]}
        trades, swaps = self.m.evm_trades("eth", data)
        self.assertEqual(swaps, 1)
        self.assertEqual([(t["side"], t["symbol"], t["usd"]) for t in trades], [("buy", "PEPE", 2000), ("sell", "PEPE", 1500)])


class HelperTests(Base):
    def test_median(self):
        self.assertIsNone(self.m._median([]))
        self.assertEqual(self.m._median([3, 1, 2]), 2)
        self.assertEqual(self.m._median([4, 1, 3, 2]), 2.5)

    def test_req_num(self):
        self.assertEqual(self.m.req_num("5", "x", 1, 3), 3)
        self.assertEqual(self.m.req_num(None, "x"), 0)
        self.assertEqual(self.m.req_num("2.7", "x", integer=True), 2)
        for bad in ("abc", "nan", "inf", [1]):
            with self.assertRaises(self.m.ApiError):
                self.m.req_num(bad, "x")


class HttpTests(Base):
    """起一个真的本地服务（随机端口），检查安全防护和错误请求的处理"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.m.Handler.log_message = lambda self, *a: None  # 测试时不刷屏
        cls.srv = cls.m.ThreadingHTTPServer(("127.0.0.1", 0), cls.m.Handler)
        cls.m.PORT = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        super().tearDownClass()

    def call(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.m.PORT, timeout=10)
        h = {"Host": f"127.0.0.1:{self.m.PORT}", **(headers or {})}
        data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
        if data is not None:
            h["Content-Type"] = "application/json"
        c.request(method, path, body=data, headers=h)
        r = c.getresponse()
        raw = r.read()
        c.close()
        try:
            return r.status, json.loads(raw)
        except ValueError:
            return r.status, raw

    def test_blocks_rebinding_and_csrf(self):
        self.assertEqual(self.call("GET", "/api/labels", headers={"Host": f"evil.com:{self.m.PORT}"})[0], 403)
        self.assertEqual(self.call("POST", "/api/labels", {"key": "k"}, {"Origin": "https://evil.com"})[0], 403)
        self.assertEqual(self.call("POST", "/api/labels", {"key": "k"}, {"Origin": "null"})[0], 403)
        self.assertEqual(self.call("POST", "/api/labels", {"key": "k"}, {"Sec-Fetch-Site": "cross-site"})[0], 403)
        self.assertEqual(self.call("GET", "/api/labels", headers={"Origin": f"http://localhost:{self.m.PORT}"})[0], 200)

    def test_security_headers(self):
        c = http.client.HTTPConnection("127.0.0.1", self.m.PORT, timeout=10)
        c.request("GET", "/", headers={"Host": f"127.0.0.1:{self.m.PORT}"})
        r = c.getresponse()
        r.read()
        c.close()
        self.assertIn("script-src 'self'", r.getheader("Content-Security-Policy"))
        self.assertEqual(r.getheader("X-Frame-Options"), "DENY")

    def test_bad_requests_are_400(self):
        for path, body in [("/api/labels", {}), ("/api/labels", {"key": 5}), ("/api/watchlist", {"chain": "eth"}),
                           ("/api/watchlist", {"chain": "eth", "address": "0x" + "1" * 40, "threshold_usd": "nan"}),
                           ("/api/alerts", {"interval": "soon"}), ("/api/copy", {"size": "Infinity"}),
                           ("/api/labels", b"{not json"), ("/api/labels", b"[1, 2]")]:
            with self.subTest(path=path, body=body):
                code, resp = self.call("POST", path, body)
                self.assertEqual(code, 400, resp)
                self.assertIn("error", resp)

    def test_ofac_import(self):
        m = self.m
        evm, evm2, trx, btc = "0x" + "A" * 40, "0x" + "b" * 40, "T" + "A" * 33, "bc1q" + "a" * 30
        lists = {"ETH": f"{evm}\n{evm2}\nnot-an-address\n", "USDT": f"{evm}\n{trx}\n", "XBT": f"{btc}\n"}
        def fake_fetch(url, timeout=20):
            asset = url.rsplit("_", 1)[1].split(".")[0]
            if asset in lists:
                return lists[asset]
            raise m.urllib.error.URLError("404")
        m.fetch_text = fake_fetch
        m.save_json("labels.json", {"evm:0x" + "b" * 40: {"label": "我的标签", "category": "交易所"}})
        code, r = self.call("POST", "/api/labels/ofac")
        self.assertEqual(code, 200, r)
        self.assertEqual((r["added"], r["skipped_existing"], r["total"]), (3, 1, 4))
        self.assertEqual(r["assets"], {"ETH": 2, "USDT": 2, "XBT": 1})
        self.assertEqual(len(r["errors"]), len(m.OFAC_ASSETS) - 3)
        labels = m.load_json("labels.json", {})
        self.assertEqual(labels["evm:0x" + "a" * 40]["category"], "风险")  # EVM 地址小写
        self.assertIn("ETH/USDT", labels["evm:0x" + "a" * 40]["note"])
        self.assertIn("OFAC", labels["evm:0x" + "a" * 40]["note"])
        self.assertEqual(labels["tron:" + trx]["source"], "OFAC")
        self.assertIn("btc:" + btc, labels)
        self.assertEqual(labels["evm:0x" + "b" * 40]["label"], "我的标签")  # 已有的不覆盖
        m.fetch_text = lambda url, timeout=20: (_ for _ in ()).throw(m.urllib.error.URLError("offline"))
        self.assertEqual(self.call("POST", "/api/labels/ofac")[0], 400)  # 全部失败 → 400
        self.assertIsNone(m.ofac_key("0x123"))
        m.save_json("labels.json", {})

    def test_labels_roundtrip_and_import_sanitized(self):
        code, labels = self.call("POST", "/api/labels", {"key": " 0xabc ", "label": " Hot wallet ", "category": "cex"})
        self.assertEqual(code, 200)
        self.assertEqual(labels["0xabc"]["label"], "Hot wallet")
        self.assertEqual(labels["0xabc"]["source"], "手动添加")
        code, labels = self.call("POST", "/api/labels", {"import": {"0xdef": {"label": "X", "junk": [1]}, "0xbad": "not-a-dict"}})
        self.assertEqual(code, 200)
        self.assertEqual(labels["0xdef"], {"label": "X"})
        self.assertNotIn("0xbad", labels)
        self.assertEqual(self.call("DELETE", "/api/labels?key=0xabc")[1].get("0xabc"), None)

    def test_unknown_api_and_no_ext(self):
        self.assertEqual(self.call("GET", "/api/nope")[0], 400)
        self.assertEqual(self.call("GET", "/api/ext"), (200, []))
        self.assertEqual(self.call("GET", "/ext/none/x.js")[0], 404)

    def test_backup_zip_download(self):
        m = self.m
        m.save_json("labels.json", {"evm:0xabc": {"label": "x"}})
        m.save_json("config.json", {"alert_interval": 5, "etherscan_key": "SECRET-KEY", "webhook_url": "https://hooks.slack.com/x"})
        os.makedirs(os.path.join(m.DATA, "cache"), exist_ok=True)
        with open(os.path.join(m.DATA, "cache", "junk.gz"), "wb") as f:
            f.write(b"x")
        con = m.sqlite3.connect(os.path.join(m.DATA, "research.db"))
        con.execute("create table t (a)"); con.execute("insert into t values (1)"); con.commit(); con.close()
        try:
            code, raw = self.call("GET", "/api/backup/export.zip")
            self.assertEqual(code, 200)
            z = zipfile.ZipFile(io.BytesIO(raw))
            names = set(z.namelist())
            self.assertTrue({"labels.json", "config.json", "research.db", "README.txt"} <= names, names)
            self.assertFalse(any(n.startswith("cache") for n in names))
            cfg = json.loads(z.read("config.json"))
            self.assertEqual(cfg, {"alert_interval": 5})  # 密钥去掉了
            with open(os.path.join(m.DATA, "x.db"), "wb") as f:
                f.write(z.read("research.db"))
            self.assertEqual(m.sqlite3.connect(os.path.join(m.DATA, "x.db")).execute("select a from t").fetchone()[0], 1)
            code, raw = self.call("GET", "/api/backup/export.zip?secrets=1")
            self.assertEqual(json.loads(zipfile.ZipFile(io.BytesIO(raw)).read("config.json"))["etherscan_key"], "SECRET-KEY")
            self.assertFalse(os.path.exists(os.path.join(m.DATA, "research.db.export.tmp")))
        finally:
            m.save_json("config.json", {})
            m._secrets.clear()

    def test_net_flow_and_endpoint(self):
        m = self.m
        now = int(__import__("time").time())  # compute_flow 用真实时钟，桩数据也得按它算年龄
        tr = lambda d, usd, age, ok=True: {"dir": d, "usd": usd, "ts": now - age, "verified": ok}
        f = m.net_flow([tr("in", 1000, 3600), tr("out", 300, 7200), tr("in", 5000, 3 * 86400), tr("out", 50, 10 * 86400),
                        tr("in", 999, 60, ok=False), {"dir": "in", "usd": None, "ts": now, "verified": True}], now)
        self.assertEqual((f["in_24h"], f["out_24h"], f["net_24h"], f["n_24h"]), (1000, 300, 700, 2))
        self.assertEqual((f["in_7d"], f["out_7d"], f["net_7d"], f["n_7d"]), (6000, 300, 5700, 3))
        # 接口：后台统计，转账来源打桩
        a, b = "0x" + "c" * 40, "0x" + "d" * 40
        m.save_json("watchlist.json", [{"chain": "eth", "address": a, "label": "A"}, {"chain": "eth", "address": b, "label": "B"}, {"chain": "eth", "address": "0x" + "e" * 40, "label": "E"}])
        def fake(chain, addr, limit, kind="all", max_age=600):
            if addr.startswith("0xe"):
                raise m.ApiError("no key")
            return {"transfers": [tr("in", 2000 if addr == a else 100, 600), tr("out", 500, 86400 * 2)]}
        m.get_transfers = fake
        m._flow.update(ts=0, running=False)
        code, r = self.call("GET", "/api/watchlist/flow")
        self.assertEqual(code, 200)
        for _ in range(100):
            if not m._flow["running"]:
                break
            __import__("time").sleep(0.02)
        code, r = self.call("GET", "/api/watchlist/flow")
        self.assertEqual([x["label"] for x in r["rows"]], ["A", "B"])  # 按 |24h 净流| 排序
        self.assertEqual(r["totals"]["net_24h"], 2100)
        self.assertEqual(r["totals"]["net_7d"], 2100 - 1000)
        self.assertEqual(len(r["errors"]), 1)
        self.assertEqual(r["wallets"], 3)
        m.save_json("watchlist.json", [])

    def test_watch_rules(self):
        m = self.m
        row = lambda usd, d="in", sym="USDT": {"usd": usd, "dir": d, "symbol": sym}
        self.assertTrue(m.alert_match({"threshold_usd": 1000}, row(1000)))
        self.assertFalse(m.alert_match({"threshold_usd": 1000}, row(999)))
        self.assertFalse(m.alert_match({"threshold_usd": 0}, row(1e9)))  # 阈值 0 = 不提醒
        self.assertFalse(m.alert_match({"threshold_usd": 1000, "direction": "out"}, row(5000, "in")))
        self.assertTrue(m.alert_match({"threshold_usd": 1000, "direction": "out"}, row(5000, "out")))
        self.assertTrue(m.alert_match({"threshold_usd": 1000, "tokens": ["ETH", "USDT"]}, row(5000, sym="usdt")))
        self.assertFalse(m.alert_match({"threshold_usd": 1000, "tokens": ["ETH"]}, row(5000, sym="USDT")))
        self.assertFalse(m.alert_match({"threshold_usd": 1000}, {"usd": None, "dir": "in", "symbol": "X"}))
        # 接口：规则规范化、校验、更新已有条目
        a = "0x" + "a" * 40
        code, items = self.call("POST", "/api/watchlist", {"chain": "eth", "address": a, "threshold_usd": 500, "direction": "out", "tokens": " usdt, eth，usdt ,"})
        self.assertEqual(code, 200, items)
        w = next(i for i in items if i["address"] == a)
        self.assertEqual((w["direction"], w["tokens"]), ("out", ["USDT", "ETH"]))
        code, items = self.call("POST", "/api/watchlist", {"chain": "eth", "address": a, "threshold_usd": 500})
        self.assertEqual(next(i for i in items if i["address"] == a)["direction"], "all")  # 再次提交同一地址 = 更新规则
        self.assertEqual(self.call("POST", "/api/watchlist", {"chain": "eth", "address": a, "direction": "sideways"})[0], 400)
        self.assertEqual(self.call("POST", "/api/watchlist", {"chain": "eth", "address": a, "tokens": ",".join(f"T{i}" for i in range(21))})[0], 400)
        self.call("DELETE", f"/api/watchlist?chain=eth&address={a}")

    def test_restore_from_zip(self):
        m = self.m
        m.BACKUP_DIR = os.path.join(self.tmp, "backups")
        m.save_json("labels.json", {"evm:0xold": {"label": "old"}})
        m.save_json("config.json", {"etherscan_key": "KEEP-ME", "alert_interval": 15, "secrets_in": "file"})
        con = m.sqlite3.connect(os.path.join(m.DATA, "research.db"))
        con.execute("create table if not exists t (a)"); con.commit(); con.close()
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("labels.json", json.dumps({"evm:0xnew": {"label": "new"}}))
            z.writestr("watchlist.json", "[]")
            z.writestr("config.json", json.dumps({"alert_interval": 7, "webhook_url": "https://hooks.slack.com/x"}))
            z.writestr("research.db", b"SQLite format 3\x00" + b"\x00" * 100)
            z.writestr("../evil.json", "{}")
            z.writestr("cache/x.json", "{}")
            z.writestr("README.txt", "hi")
            z.writestr("notes.txt", "x")
        try:
            code, resp = self.call("POST", "/api/backup/import", buf.getvalue(), {"Content-Type": "application/zip"})
            self.assertEqual(code, 200, resp)
            self.assertEqual(resp["restored"], ["config.json", "labels.json", "research.db", "watchlist.json"])
            self.assertEqual(m.load_json("labels.json", {}), {"evm:0xnew": {"label": "new"}})
            cfg = m.load_json("config.json", {})
            self.assertEqual((cfg["alert_interval"], cfg["etherscan_key"], cfg["webhook_url"], cfg["secrets_in"]),
                             (7, "KEEP-ME", "https://hooks.slack.com/x", "file"))  # 合并：zip 里没有的密钥保留
            self.assertFalse(os.path.exists(os.path.join(m.DATA, "evil.json")))
            self.assertTrue(os.path.isdir(resp["safety_backup"]))
            self.assertEqual(m.load_json_path(os.path.join(resp["safety_backup"], "labels.json")), {"evm:0xold": {"label": "old"}})
            self.assertFalse(any(n.endswith(".tmp") for n in os.listdir(m.DATA)))
            # 坏文件
            self.assertEqual(self.call("POST", "/api/backup/import", b"not a zip", {"Content-Type": "application/zip"})[0], 400)
            bad = io.BytesIO()
            with zipfile.ZipFile(bad, "w") as z:
                z.writestr("labels.json", "{broken")
            self.assertEqual(self.call("POST", "/api/backup/import", bad.getvalue(), {"Content-Type": "application/zip"})[0], 400)
            empty = io.BytesIO()
            with zipfile.ZipFile(empty, "w") as z:
                z.writestr("notes.txt", "x")
            self.assertEqual(self.call("POST", "/api/backup/import", empty.getvalue(), {"Content-Type": "application/zip"})[0], 400)
            self.assertEqual(m.load_json("labels.json", {}), {"evm:0xnew": {"label": "new"}})  # 失败的恢复不改动数据
        finally:
            m.save_json("config.json", {})
            m._secrets.clear()

    def test_health(self):
        code, h = self.call("GET", "/api/health")
        self.assertEqual(code, 200)
        self.assertEqual((h["ok"], h["version"], h["extensions"], h["ext_errors"]), (True, self.m.VERSION, [], []))
        self.assertFalse(h["alerts"]["stuck"])
        self.assertIsInstance(h["uptime"], int)

    def test_version(self):
        code, v = self.call("GET", "/api/version")
        self.assertEqual(code, 200)
        self.assertEqual(v["version"], self.m.VERSION)
        self.assertEqual((v["extensions"], v["ext_errors"]), ([], []))
        self.assertIsInstance(v["started"], int)

    def test_webhook_url_validation_over_http(self):
        for bad in ("http://evil.example/hook", "ftp://x", "https://api.telegram.org/bot1:a/sendMessage"):
            with self.subTest(bad):
                code, resp = self.call("POST", "/api/config", {"webhook_url": bad})
                self.assertEqual(code, 400, resp)
        code, resp = self.call("POST", "/api/config", {"webhook_url": "https://hooks.slack.com/services/T/B/x"})
        self.assertEqual((code, resp["webhook_url"]), (200, True))
        code, resp = self.call("POST", "/api/config", {"webhook_url": ""})
        self.assertEqual((code, resp["webhook_url"]), (200, False))


class CliTests(Base):
    def run_cli(self, *args):
        import contextlib
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = self.m.cli(list(args))
        return code, out.getvalue(), err.getvalue()

    def test_flags(self):
        code, out, _ = self.run_cli("--version")
        self.assertEqual((code, out.strip()), (0, f"block-detective {self.m.VERSION}"))
        self.assertEqual(self.run_cli()[0], None)  # 没有参数 → 正常启动
        code, _, err = self.run_cli("--bogus")
        self.assertEqual(code, 2)
        self.assertIn("--bogus", err)
        self.assertEqual(self.run_cli("--port", "abc")[0], 2)
        old = self.m.PORT
        self.assertIsNone(self.run_cli("--port", "9123")[0])
        self.assertEqual(self.m.PORT, 9123)
        self.m.PORT = old

    def test_check(self):
        self.m.EXT_DIR = os.path.join(self.tmp, "no-ext")
        code, out, err = self.run_cli("--check")
        self.assertEqual(code, 0, err)
        self.assertIn("检查通过", out)
        os.makedirs(os.path.join(self.m.EXT_DIR, "bad"))
        with open(os.path.join(self.m.EXT_DIR, "bad", "__init__.py"), "w") as f:
            f.write("raise RuntimeError('nope')\n")
        code, out, err = self.run_cli("--check")
        self.assertEqual(code, 1)
        self.assertIn("nope", err)
        self.m.load_extensions.__globals__["EXT_DIR"] = self.m.EXT_DIR  # no-op: 明确 EXT_DIR 是模块级变量
        shutil.rmtree(self.m.EXT_DIR, ignore_errors=True)
        self.m.load_extensions()


class WebhookTests(Base):
    """Webhook 通知：消息格式按目标服务区分，真的发到本机的一个接收端上"""

    def test_payload_kinds(self):
        m = self.m
        tg = "https://api.telegram.org/bot123:abc/sendMessage?chat_id=42"
        self.assertEqual(m.webhook_kind(tg), "telegram")
        self.assertEqual(m.webhook_payload(tg, "T", "x")["text"], "T\nx")
        dc = "https://discord.com/api/webhooks/1/abc"
        self.assertEqual((m.webhook_kind(dc), m.webhook_payload(dc, "T", "x")["content"]), ("discord", "**T**\nx"))
        sl = "https://hooks.slack.com/services/T/B/x"
        self.assertEqual((m.webhook_kind(sl), m.webhook_payload(sl, "T", "x")["text"]), ("slack", "*T*\nx"))
        g = m.webhook_payload("https://example.com/hook", "T", "x")
        self.assertEqual((m.webhook_kind("https://example.com/hook"), g["title"], g["text"], g["source"]), ("generic", "T", "x", "block-detective"))

    def test_url_check(self):
        m = self.m
        self.assertEqual(m.check_webhook_url("http://127.0.0.1:9/x"), "http://127.0.0.1:9/x")
        for bad in ("http://example.com/x", "https://", "api.telegram.org/bot1/sendMessage?chat_id=1",
                    "https://api.telegram.org/bot1/sendMessage"):
            with self.subTest(bad):
                with self.assertRaises(m.ApiError):
                    m.check_webhook_url(bad)

    def test_send_to_local_receiver(self):
        got = []

        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                got.append((self.path, self.headers.get("Content-Type"), json.loads(self.rfile.read(n))))
                flaky = self.path.endswith("/flaky") and sum(p == "/flaky" for p, _, _ in got) == 1
                self.send_response(500 if self.path.endswith("/fail") or flaky else 404 if self.path.endswith("/gone") else 200)
                self.end_headers()

            def log_message(self, *a):
                pass

        srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            base = f"http://127.0.0.1:{srv.server_address[1]}"
            self.m.save_json("config.json", {"webhook_url": base + "/hook"})
            self.m._secrets.clear()
            self.m.notify("标题", "正文", sound=False)
            self.m._webhook["thread"].join(5)
            self.assertEqual(got[-1][0], "/hook")
            self.assertEqual(got[-1][1], "application/json")
            self.assertEqual((got[-1][2]["title"], got[-1][2]["text"]), ("标题", "正文"))
            self.assertEqual(self.m._webhook["sent"], 1)
            self.assertIsNone(self.m._webhook["last_error"])
            self.assertFalse(self.m.webhook_send(base + "/fail", "t", "x", retry=False))
            self.assertIn("HTTP 500", self.m._webhook["last_error"])
            self.assertFalse(self.m.webhook_send("http://127.0.0.1:1/x", "t", "x", retry=False))  # 没人监听
            self.assertTrue(self.m._webhook["last_error"])
            # 5xx 后 30 秒（测试里 0.1 秒）重试一次；4xx 不重试
            self.m.WEBHOOK_RETRY_DELAY = 0.1
            before = self.m._webhook["sent"]
            self.assertFalse(self.m.webhook_send(base + "/flaky", "t", "x"))
            self.m._webhook["thread"].join(5)
            self.assertEqual((self.m._webhook["sent"], self.m._webhook["retries"], self.m._webhook["last_error"]), (before + 1, 1, None))
            self.assertEqual([p for p, _, _ in got if p == "/flaky"], ["/flaky", "/flaky"])
            self.assertFalse(self.m.webhook_send(base + "/gone", "t", "x"))
            self.assertEqual(self.m._webhook["retries"], 1)  # 404 不重试
        finally:
            srv.shutdown()
            srv.server_close()
            self.m.save_json("config.json", {})
            self.m._secrets.clear()


DUMMY_EXT = '''
VERSION = "0.1"
CALLS = []

def register(core, ext):
    ext.route("/api/demo/hello", lambda m, q, r: {"hi": q.get("name", "x"), "method": m})
    ext.route("/api/demo/file", lambda m, q, r: core.Raw(b"a,b", "text/csv", filename="d.csv"))
    ext.on("smart_events", lambda ev: CALLS.append(("events", len(ev))))
    ext.on("background_wanted", lambda: True)
    ext.on("smart_wallets", lambda out, board: out.append({"chain": "eth", "address": "0xext", "label": "", "labeled": False}))
    ext.page(id="demo", title="演示页", sub="DEMO", icon="<svg/>", html="page.html", js=["page.js"], css=["page.css"])
'''


class ExtensionTests(Base):
    """ext/<名字>/ 目录里的扩展：接口、钩子、页面清单、静态文件；坏掉的扩展不影响核心"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.m.EXT_DIR = os.path.join(cls.tmp, "ext")
        d = os.path.join(cls.m.EXT_DIR, "demo", "static")
        os.makedirs(d)
        with open(os.path.join(cls.m.EXT_DIR, "demo", "__init__.py"), "w") as f:
            f.write(DUMMY_EXT)
        for name in ("page.html", "page.js", "page.css"):
            with open(os.path.join(d, name), "w") as f:
                f.write(f"<!-- {name} -->")
        os.makedirs(os.path.join(cls.m.EXT_DIR, "broken"))
        with open(os.path.join(cls.m.EXT_DIR, "broken", "__init__.py"), "w") as f:
            f.write("raise RuntimeError('boom')\n")
        os.makedirs(os.path.join(cls.m.EXT_DIR, "no_init"))
        os.makedirs(os.path.join(cls.m.EXT_DIR, "future"))
        with open(os.path.join(cls.m.EXT_DIR, "future", "__init__.py"), "w") as f:
            f.write("REQUIRES_CORE = '99.0'\ndef register(core, ext): raise AssertionError('must not run')\n")
        cls.m.Handler.log_message = lambda self, *a: None
        cls.m.load_extensions()
        cls.srv = cls.m.ThreadingHTTPServer(("127.0.0.1", 0), cls.m.Handler)
        cls.m.PORT = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        super().tearDownClass()

    def get(self, path):
        c = http.client.HTTPConnection("127.0.0.1", self.m.PORT, timeout=10)
        c.request("GET", path, headers={"Host": f"127.0.0.1:{self.m.PORT}"})
        r = c.getresponse()
        raw = r.read()
        c.close()
        return r.status, raw, r

    def test_loaded_only_valid(self):
        self.assertEqual([e["name"] for e in self.m.EXTENSIONS], ["demo"])
        self.assertEqual(self.m.EXTENSIONS[0]["version"], "0.1")
        errs = {e["name"]: e["error"] for e in self.m.EXT_ERRORS}
        self.assertIn("boom", errs["broken"])
        self.assertIn("99.0", errs["future"])  # 要求更新核心的扩展不加载，但说明原因
        code, raw, _ = self.get("/api/version")
        v = json.loads(raw)
        self.assertEqual([e["name"] for e in v["extensions"]], ["demo"])
        self.assertEqual(sorted(e["name"] for e in v["ext_errors"]), ["broken", "future"])

    def test_version_tuple(self):
        vt = self.m.version_tuple
        self.assertEqual(vt("1.10.2"), (1, 10, 2))
        self.assertTrue(vt("1.10") > vt("1.9.9"))
        self.assertEqual(vt("garbage"), (0,))

    def test_manifest_and_static(self):
        code, raw, _ = self.get("/api/ext")
        self.assertEqual(code, 200)
        man = json.loads(raw)
        page = man[0]["pages"][0]
        self.assertEqual((page["id"], page["title"]), ("demo", "演示页"))
        self.assertTrue(page["html"].startswith("/ext/demo/page.html?v="))
        self.assertEqual(self.get(page["html"])[1], b"<!-- page.html -->")
        self.assertEqual(self.get(page["js"][0])[1], b"<!-- page.js -->")
        self.assertEqual(self.get("/ext/demo/missing.js")[0], 404)
        self.assertEqual(self.get("/ext/broken/x")[0], 404)
        # 不能借 /ext/ 读到 static 目录之外的文件
        for p in ("/ext/demo/../__init__.py", "/ext/demo/%2e%2e/__init__.py", "/ext/demo/..%2f..%2f..%2fserver.py"):
            with self.subTest(p):
                self.assertEqual(self.get(p)[0], 404)

    def test_routes(self):
        code, raw, _ = self.get("/api/demo/hello?name=bob")
        self.assertEqual((code, json.loads(raw)), (200, {"hi": "bob", "method": "GET"}))
        code, raw, r = self.get("/api/demo/file")
        self.assertEqual((code, raw), (200, b"a,b"))
        self.assertEqual(r.getheader("Content-Type"), "text/csv")
        self.assertIn("d.csv", r.getheader("Content-Disposition"))

    def test_hooks(self):
        mod = self.m.EXTENSIONS[0]["module"]
        self.assertTrue(self.m.hook_any("background_wanted"))
        self.m.hook("smart_events", [1, 2, 3])
        self.assertEqual(mod.CALLS[-1], ("events", 3))
        self.assertIn("0xext", {w["address"] for w in self.m.smart_wallets()})
        self.assertEqual(self.m.hook("no_such_hook"), [])

    def test_bad_registration(self):
        api = self.m.ExtApi("x", self.tmp)
        with self.assertRaises(ValueError):
            api.on("nope", lambda: None)
        with self.assertRaises(ValueError):
            api.route("/not-api", lambda *a: None)
        with self.assertRaises(ValueError):
            api.route("/api/demo/hello", lambda *a: None)  # 已被占用


if __name__ == "__main__":
    unittest.main()
