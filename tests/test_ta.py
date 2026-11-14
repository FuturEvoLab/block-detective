"""涨跌分析的指标和解读测试：只用构造的数据，不联网。
用法：python3 -m unittest discover tests"""
import importlib.util, os, tempfile, unittest

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server.py")
spec = importlib.util.spec_from_file_location("srv_ta", SRC)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.DATA = tempfile.mkdtemp(prefix="bd-ta-")
m.CACHE_DIR = os.path.join(m.DATA, "cache")

# StockCharts 的 RSI 示例数据（Wilder 平滑）。手算：前 14 个涨跌的平均涨幅 3.34/14、平均跌幅 1.40/14
# → RSI = 100 − 100/(1 + 2.3857) ≈ 70.46；下一根跌 0.28 → 平均涨幅 ×13/14、平均跌幅 (1.30+0.28)/14 → ≈ 66.25
WILDER = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00]


def candles(closes, vol=1000.0):
    return [[i * 86400, c, c * 1.01, c * 0.99, c, vol] for i, c in enumerate(closes)]


def indicators(closes):
    c = candles(closes)
    line, signal, hist = m.macd(closes)
    mid, up, lo = m.bollinger(closes)
    return c, {"ma20": m.sma(closes, 20), "ma50": m.sma(closes, 50), "ma200": m.sma(closes, 200), "bb_mid": mid, "bb_up": up,
               "bb_lo": lo, "rsi": m.rsi(closes), "macd": line, "signal": signal, "hist": hist,
               "atr": m.atr([x[2] for x in c], [x[3] for x in c], closes)}


class Indicators(unittest.TestCase):
    def test_sma_ema(self):
        self.assertEqual(m.sma([1, 2, 3, 4, 5], 3), [None, None, 2, 3, 4])
        e = m.ema([1, 2, 3, 4, 5], 3)
        self.assertEqual(e[:3], [None, None, 2])  # 种子 = 前 3 个的平均
        self.assertAlmostEqual(e[3], 3.0)  # 4 × 0.5 + 2 × 0.5
        self.assertEqual(m.ema([None, None, 1, 1, 1], 2)[:4], [None, None, None, 1])  # 跳过前面的 None

    def test_rsi_reference_values(self):
        r = m.rsi(WILDER)
        self.assertIsNone(r[13])
        self.assertAlmostEqual(r[14], 70.46, delta=0.01)
        self.assertAlmostEqual(r[15], 66.25, delta=0.01)

    def test_rsi_extremes(self):
        self.assertEqual(m.rsi(list(range(1, 30)))[-1], 100.0)
        self.assertEqual(m.rsi(list(range(30, 1, -1)))[-1], 0.0)
        self.assertEqual(m.rsi([5.0] * 20)[-1], 50.0)

    def test_macd_relations(self):
        closes = [100 + i * 0.5 + (i % 7) for i in range(80)]
        line, signal, hist = m.macd(closes)
        self.assertIsNone(line[24]); self.assertIsNotNone(line[25])  # 慢线 26 根后才有值
        self.assertIsNone(signal[32]); self.assertIsNotNone(signal[33])  # 信号线再要 9 个 MACD 值
        for a, b, h in zip(line, signal, hist):
            if h is not None:
                self.assertAlmostEqual(h, a - b)
        self.assertGreater(line[-1], 0)  # 上升趋势里快线在慢线之上

    def test_bollinger_and_atr(self):
        mid, up, lo = m.bollinger([10.0] * 25)
        self.assertEqual((mid[-1], up[-1], lo[-1]), (10.0, 10.0, 10.0))
        mid, up, lo = m.bollinger([1, 3] * 10, n=20)
        self.assertAlmostEqual(up[-1] - mid[-1], 2.0)  # 标准差 1 × 2
        a = m.atr([11.0] * 20, [9.0] * 20, [10.0] * 20)
        self.assertAlmostEqual(a[-1], 2.0)

    def test_corr_beta(self):
        b = [0.01, -0.02, 0.03, 0.0, -0.01, 0.02]
        self.assertAlmostEqual(m.corr([x * 2 for x in b], b), 1.0)
        self.assertAlmostEqual(m.corr([-x for x in b], b), -1.0)
        self.assertAlmostEqual(m.beta([x * 2 for x in b], b), 2.0)
        self.assertIsNone(m.corr([1, 1, 1], [1, 2, 3]))  # 没有波动就没有相关性
        for got, want in zip(m.pct_returns([100, 110, 99]), [0.1, -0.1]):
            self.assertAlmostEqual(got, want)


class Readings(unittest.TestCase):
    def texts(self, rs):
        return {r["title"]: r["text"] for r in rs}

    def test_uptrend(self):
        closes = [100 * 1.004 ** i for i in range(260)]
        c, ind = indicators(closes)
        t = self.texts(m.ta_read(c, ind))
        self.assertEqual(t["均线趋势"], "价格在 50 / 200 均线之上，多头排列")
        self.assertEqual(t["RSI(14)"], "RSI 在 70 以上，处于超买区")
        self.assertIn("零轴上方", t["MACD"])

    def test_downtrend_and_cross(self):
        closes = [300 * 0.996 ** i for i in range(260)]
        c, ind = indicators(closes)
        t = self.texts(m.ta_read(c, ind))
        self.assertEqual(t["均线趋势"], "价格在 50 / 200 均线之下，空头排列")
        self.assertEqual(t["RSI(14)"], "RSI 在 30 以下，处于超卖区")
        # 先跌后急涨：50 均线刚上穿 200 均线
        closes = [100.0] * 200 + [100 - i * 0.2 for i in range(30)] + [94 + i * 3 for i in range(40)]
        c, ind = indicators(closes)
        self.assertEqual(m._crossed(ind["ma50"], ind["ma200"], 40), 1)

    def test_volume_uses_last_closed_candle(self):
        closes = [100.0 + (i % 3) for i in range(60)]
        c, ind = indicators(closes)
        c[-2][5] = 5000.0  # 上一根已收盘的 K 线放量
        c[-1][5] = 10.0    # 正在走的 K 线成交量很小，不应影响判断
        c[-2][4], c[-3][4] = 105.0, 100.0
        self.assertIn("放量上涨", self.texts(m.ta_read(c, ind))["量价"])

    def test_derivatives_quadrants(self):
        t = lambda *a: self.texts(m.deriv_read(*a))["价格 × 持仓"]
        self.assertIn("新多单进场", t(5, 10, None, None))
        self.assertIn("空头平仓", t(5, -10, None, None))
        self.assertIn("新空单进场", t(-5, 10, None, None))
        self.assertIn("多头平仓", t(-5, -10, None, None))
        self.assertIn("变化都不大", t(0.2, 1, None, None))
        self.assertIn("空头可能被挤压", self.texts(m.deriv_read(5, 1, -0.0002, None))["资金费率"])
        self.assertEqual(self.texts(m.deriv_read(None, None, 0.0005, 0.7)),
                         {"资金费率": "资金费率偏高，多头拥挤", "多空账户": "多数账户做多，散户偏多"})


class Endpoints(unittest.TestCase):
    def setUp(self):
        self.orig = (m.binance_klines, m.http_json)

    def tearDown(self):
        m.binance_klines, m.http_json = self.orig

    def test_ta_without_futures(self):
        m.binance_klines = lambda sym, tf, limit=300: candles([50 + i * 0.1 for i in range(300)])
        def no_futures(url, **k):
            raise m.ApiError("HTTP 400: invalid symbol")
        m.http_json = no_futures
        d = m.ta("abc", "4h")
        self.assertEqual(d["sym"], "ABC")
        self.assertEqual(len(d["candles"]), m.TA_SHOW)
        self.assertEqual(len(d["rsi"]), m.TA_SHOW)
        self.assertIsNone(d["deriv"])
        self.assertEqual(d["deriv_error"], "ABC 没有 Binance USDT 永续合约")
        self.assertTrue(d["readings"])

    def test_ta_validates_input(self):
        for sym, tf in (("BTC/USDT", "1d"), ("USDT", "1d"), ("BTC", "5m")):
            with self.assertRaises(m.ApiError):
                m.ta(sym, tf)

    def test_movers_filters_and_ranks(self):
        def coin(sym, name, chg24, price=2.0, chg7=1.0, mcap=1e9, vol=1e8):
            return {"symbol": sym, "name": name, "current_price": price, "price_change_percentage_24h_in_currency": chg24,
                    "price_change_percentage_7d_in_currency": chg7, "market_cap": mcap, "total_volume": vol, "market_cap_rank": 1}
        data = [coin("aaa", "Alpha", 12), coin("bbb", "Beta", -9), coin("usdt", "Tether", 0, 1.0, 0.0),
                coin("wbtc", "Wrapped Bitcoin", 3), coin("nvdax", "NVIDIA xStock", 20), coin("ccc", "Gamma", 1, vol=5e9),
                coin("xyz", "Some USD", 0.1, 1.001, 0.2)]
        m.http_json = lambda url, **k: data
        d = m.movers()
        syms = lambda k: [r["sym"] for r in d[k]]
        self.assertEqual(syms("gainers24"), ["AAA", "CCC", "BBB"])
        self.assertEqual(syms("losers24")[0], "BBB")
        self.assertEqual(syms("turnover")[0], "CCC")
        self.assertEqual(d["breadth"]["n"], 3)  # 稳定币、包装币、代币化股票都排除


if __name__ == "__main__":
    unittest.main()
