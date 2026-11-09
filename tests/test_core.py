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


class BacktestTests(Base):
    P = {"sl": 30, "tp": 100, "max_days": 7, "follow_sell": True}

    @staticmethod
    def candle(ts, o, h, l, c):
        return [ts, o, h, l, c, 0]

    def test_stop_loss_and_gap(self):
        cs = [self.candle(0, 1, 1, 1, 1), self.candle(3600, 1, 1, 0.65, 0.7)]
        px, _, why = self.m.bt_simulate(0, cs, [], self.P, 0)
        self.assertEqual(why, "止损")
        self.assertAlmostEqual(px, 0.7)  # 正常碰到止损价
        gap = [self.candle(0, 1, 1, 1, 1), self.candle(3600, 0.2, 0.25, 0.1, 0.15)]
        px, _, _ = self.m.bt_simulate(0, gap, [], self.P, 0)
        self.assertAlmostEqual(px, 0.2)  # 跳空低开：只能按开盘价卖，不是止损价 0.7

    def test_both_hit_is_stop_loss(self):
        cs = [self.candle(0, 1, 1, 1, 1), self.candle(3600, 1, 2.5, 0.5, 1)]
        self.assertEqual(self.m.bt_simulate(0, cs, [], self.P, 0)[2], "止损")

    def test_take_profit_follow_sell_expiry_open(self):
        cs = [self.candle(i * 3600, 1, 1.1, 0.95, 1) for i in range(5)] + [self.candle(5 * 3600, 1, 2.2, 1, 2)]
        px, _, why = self.m.bt_simulate(0, cs, [], self.P, 0.01)
        self.assertEqual(why, "止盈")
        self.assertAlmostEqual(px, 1.01 * 2 * 0.99)
        px, ts, why = self.m.bt_simulate(0, cs, [2 * 3600 + 100], self.P, 0)
        self.assertEqual((why, ts), ("聪明钱卖出", 2 * 3600))
        self.assertEqual(self.m.bt_simulate(0, cs, [], {**self.P, "tp": 0, "max_days": 0}, 0)[2], "持仓中")
        long = [self.candle(i * 86400, 1, 1, 1, 1) for i in range(3)]
        self.assertEqual(self.m.bt_simulate(0, long, [], {**self.P, "max_days": 1}, 0)[1:], (86400, "到期平仓"))

    def test_candles_keyed_by_chain(self):
        # 同一个合约地址在两条链上：只有 eth 有 K 线时，base 上的买入不能拿 eth 的价格回测
        trades = {"w1": [{"side": "buy", "token": "0xt", "symbol": "T", "usd": 500, "ts": 0, "hash": "a"}],
                  "w2": [{"side": "buy", "token": "0xt", "symbol": "T", "usd": 500, "ts": 0, "hash": "b"}]}
        cands = {("eth", "0xt"): [self.candle(3600, 1, 1, 1, 1)]}
        prep = self.m.bt_prepare(trades, {"w1": "eth", "w2": "base"}, cands, 100)
        self.assertEqual([x["wallet"] for x in prep], ["w1"])

    def test_stats(self):
        mk = lambda r, ts, why="止盈": {"ret": r, "exit_ts": ts, "reason": why}
        st = self.m.bt_stats([mk(0.5, 1), mk(-0.3, 2), mk(-0.4, 3), mk(0.2, 4, "持仓中")])
        self.assertEqual((st["n"], st["closed"]), (4, 3))
        self.assertAlmostEqual(st["win"], 0.5)
        self.assertAlmostEqual(st["max_dd"], -0.7)
        self.assertAlmostEqual(st["pf"], 0.7 / 0.7)
        self.assertIsNone(self.m.bt_stats([])["win"])


class ResearchHelperTests(Base):
    def test_median_and_bucket(self):
        self.assertIsNone(self.m._median([]))
        self.assertEqual(self.m._median([3, 1, 2]), 2)
        self.assertEqual(self.m._median([4, 1, 3, 2]), 2.5)
        self.assertEqual(self.m._bucket(0.5, (0.4, 0.6), ("a", "b", "c")), "b")
        self.assertEqual(self.m._bucket(0.9, (0.4, 0.6), ("a", "b", "c")), "c")
        self.assertIsNone(self.m._bucket(None, (1,), ("a", "b")))

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

    def test_csv_formula_injection(self):
        self.m.research_rows = lambda source="all": [{"id": "1", "symbol": "=HYPERLINK(\"x\")", "usd": -5}]
        code, raw = self.call("GET", "/api/research/export.csv")
        self.assertEqual(code, 200)
        text = raw.decode("utf-8-sig")
        self.assertIn("'=HYPERLINK", text)
        self.assertIn(",-5", text)  # 负数不是文字，不加引号


if __name__ == "__main__":
    unittest.main()
