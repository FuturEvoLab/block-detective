"""核心纯函数和本地接口的测试：不联网，数据写在临时目录。
用法：python3 -m unittest discover tests"""
import http.client, importlib.util, json, os, shutil, tempfile, threading, unittest

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
