"""网页版（demo/live.js）和本地版（server.py）的计算结果必须一致：同一份构造的行情数据两边各算一遍，逐项对照。
需要 Node.js（GitHub Actions 的运行环境自带）；本机没有 node 时跳过。不联网。"""
import importlib.util, json, math, os, random, shutil, subprocess, tempfile, unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
spec = importlib.util.spec_from_file_location("srv_parity", os.path.join(ROOT, "server.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.DATA = tempfile.mkdtemp(prefix="bd-parity-")
m.CACHE_DIR = os.path.join(m.DATA, "cache")
NODE = shutil.which("node")

# 在 node 里加载 live.js，把 fetch 换成按 URL 返回构造数据，然后调用指定接口
JS = r"""
const fs = require("fs");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
globalThis.sessionStorage = { getItem: () => null, setItem: () => {} };
globalThis.fetch = async (url) => {
  const hit = input.routes.find(([part]) => url.includes(part));
  if (!hit) return { ok: false, status: 400, text: async () => "no route " + url };
  return { ok: true, status: 200, json: async () => hit[1], text: async () => "" };
};
require(input.live);
(async () => {
  const out = {};
  for (const [name, path, q] of input.calls) {
    try { out[name] = await BD_LIVE[path](q); } catch (e) { out[name] = { error: e.message }; }
  }
  process.stdout.write(JSON.stringify(out));
})();
"""


def fake_klines(n, seed, start=100.0):
    """Binance 原始格式的 K 线：随机游走 + 趋势，成交额随机"""
    rnd, px, out = random.Random(seed), start, []
    for i in range(n):
        o = px
        px = max(0.01, px * (1 + rnd.gauss(0.0015, 0.03)))
        hi, lo = max(o, px) * (1 + abs(rnd.gauss(0, 0.01))), min(o, px) * (1 - abs(rnd.gauss(0, 0.01)))
        out.append([(1700000000 + i * 86400) * 1000, str(o), str(hi), str(lo), str(px), "0", 0, str(rnd.uniform(1e6, 5e7))])
    return out


def futures(seed):
    rnd = random.Random(seed)
    oi = [{"timestamp": (1700000000 + i * 3600) * 1000, "sumOpenInterestValue": str(1e9 * (1 + 0.004 * i + rnd.uniform(-0.01, 0.01)))} for i in range(30)]
    fund = [{"fundingTime": (1700000000 + i * 28800) * 1000, "fundingRate": str(rnd.uniform(-0.0002, 0.0006))} for i in range(30)]
    return oi, fund, [{"longAccount": "0.68", "longShortRatio": "2.1"}]


def cg_markets():
    rnd, rows = random.Random(7), []
    names = [("btc", "Bitcoin"), ("eth", "Ethereum"), ("usdt", "Tether"), ("sol", "Solana"), ("wbtc", "Wrapped Bitcoin"), ("xrp", "XRP"),
             ("nvdax", "NVIDIA xStock"), ("doge", "Dogecoin"), ("ada", "Cardano"), ("link", "Chainlink"), ("paxg", "PAX Gold"), ("avax", "Avalanche")]
    names += [(f"c{i}", f"Coin {i}") for i in range(40)]
    for i, (s, n) in enumerate(names):
        rows.append({"symbol": s, "name": n, "current_price": 1.0 if s == "usdt" else rnd.uniform(0.1, 500), "market_cap": 1e10 / (i + 1),
                     "market_cap_rank": i + 1, "total_volume": rnd.uniform(1e6, 5e9),
                     "price_change_percentage_24h_in_currency": rnd.uniform(-15, 15), "price_change_percentage_7d_in_currency": rnd.uniform(-30, 30)})
    return rows


@unittest.skipUnless(NODE, "需要 Node.js")
class LiveParity(unittest.TestCase):
    def run_js(self, routes, calls):
        inp = {"live": os.path.join(ROOT, "demo", "live.js"), "routes": routes, "calls": calls}
        r = subprocess.run([NODE, "-e", JS], input=json.dumps(inp), capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def assertSeriesClose(self, a, b, name):
        self.assertEqual(len(a), len(b), name)
        for i, (x, y) in enumerate(zip(a, b)):
            if x is None or y is None:
                self.assertEqual(x, y, f"{name}[{i}]")
            else:
                self.assertTrue(math.isclose(x, y, rel_tol=1e-7, abs_tol=1e-9), f"{name}[{i}]: {x} != {y}")

    def test_ta_matches_server(self):
        for seed in (1, 2, 3, 4):
            kl = fake_klines(300, seed)
            oi, fund, ls = futures(seed)
            routes = [["/api/v3/klines", kl], ["openInterestHist", oi], ["fundingRate", fund], ["globalLongShortAccountRatio", ls]]
            js = self.run_js(routes, [["d", "/api/ta", {"sym": "abc", "tf": tf}] for tf in ["1d"]] +
                             [[tf, "/api/ta", {"sym": "ABC", "tf": tf}] for tf in ("1h", "4h", "1w")])

            def fake_http(url, headers=None, ttl=120):
                for part, data in routes:
                    if part in url:
                        return data
                raise m.ApiError("HTTP 400: no route")
            orig = m.http_json
            m.http_json = fake_http
            try:
                for name, tf in (("d", "1d"), ("1h", "1h"), ("4h", "4h"), ("1w", "1w")):
                    py, j = m.ta("ABC", tf), js[name]
                    for k in ("ma20", "ma50", "ma200", "bb_mid", "bb_up", "bb_lo", "rsi", "macd", "signal", "hist", "atr"):
                        self.assertSeriesClose(py[k], j[k], f"seed {seed} {tf} {k}")
                    self.assertEqual(py["readings"], j["readings"], f"seed {seed} {tf} readings")
                    self.assertEqual(py["deriv"]["readings"], j["deriv"]["readings"], f"seed {seed} {tf} deriv")
                    self.assertEqual(py["deriv"]["window"], j["deriv"]["window"])
                    for k in ("price", "hi30", "lo30", "atr_pct", "rsi"):
                        self.assertTrue(math.isclose(py["stats"][k], j["stats"][k], rel_tol=1e-9), f"stats {k}")
            finally:
                m.http_json = orig

    def test_ta_errors_match(self):
        js = self.run_js([], [["bad", "/api/ta", {"sym": "BTC/USDT"}], ["stable", "/api/ta", {"sym": "usdt"}],
                              ["tf", "/api/ta", {"sym": "BTC", "tf": "5m"}], ["missing", "/api/ta", {"sym": "NOPE", "tf": "1d"}]])
        for name, sym, tf in (("bad", "BTC/USDT", "1d"), ("stable", "usdt", "1d"), ("tf", "BTC", "5m")):
            with self.assertRaises(m.ApiError) as cm:
                m.ta(sym, tf)
            self.assertEqual(js[name]["error"], str(cm.exception))
        self.assertEqual(js["missing"]["error"], "Binance 现货没有 NOPE/USDT 交易对")

    def test_movers_and_corr_match(self):
        data = cg_markets()
        routes = [["/coins/markets", data]] + [[f"symbol={c['symbol'].upper()}USDT", fake_klines(91, i + 10, 50)] for i, c in enumerate(data)]
        js = self.run_js(routes, [["mv", "/api/movers", {}], ["corr", "/api/corr", {}]])
        orig = m.http_json

        def fake_http(url, headers=None, ttl=120):
            for part, d in routes:
                if part in url:
                    return d
            raise m.ApiError("HTTP 400: no route")
        m.http_json = fake_http
        try:
            py = m.movers()
            for k in ("gainers24", "losers24", "gainers7", "losers7", "turnover"):
                self.assertEqual([r["sym"] for r in py[k]], [r["sym"] for r in js["mv"][k]], k)
            pb, jb = py["breadth"], js["mv"]["breadth"]
            for k in ("n", "up", "down", "flat", "up7", "n7", "tone", "text"):
                self.assertEqual(pb[k], jb[k], k)
            self.assertEqual(py["symbols"], js["mv"]["symbols"])
            pc = m.btc_corr()
        finally:
            m.http_json = orig
        jc = js["corr"]
        self.assertEqual([r["sym"] for r in pc["rows"]], [r["sym"] for r in jc["rows"]])
        for a, b in zip(pc["rows"], jc["rows"]):
            for k in ("corr30", "corr90", "beta30", "rel7", "rel30", "vol30"):
                self.assertTrue(math.isclose(a[k], b[k], rel_tol=1e-9, abs_tol=1e-12), f"{a['sym']} {k}: {a[k]} != {b[k]}")
        self.assertEqual(pc["readings"], jc["readings"])


if __name__ == "__main__":
    unittest.main()
