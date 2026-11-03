"""跟单机器人的边界情况测试：在临时目录里跑，不会碰真实账本。
用法：python3 -m unittest discover tests   （或 python3 tests/test_copybot.py）；任何一项不通过时退出码非零"""
import importlib.util, os, shutil, tempfile, time, json, sys, unittest
SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server.py")


def scenario(ok):
    """按顺序跑一遍完整场景（后面的检查依赖前面的账本状态），每个检查点调用 ok(条件, 说明)"""
    TMP = tempfile.mkdtemp(prefix="bd-test-")
    try:
        spec = importlib.util.spec_from_file_location("srv", SRC); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
        m.DATA = TMP; m.RESEARCH_DB = os.path.join(TMP, "research.db"); m.CACHE_DIR = os.path.join(TMP, "cache")
        m.save_json("config.json", {"copy_enabled": True, "copy_min_signal": 500})
        now = time.time()
        PRICES = {}
        m.dex_prices = lambda chain, toks: {t: PRICES[t] for t in toks if t in PRICES}
        SEC = {}
        m.token_security = lambda chain, t: SEC.get(t)
        m.wallet_features = lambda c, a, b: {}
        m.fng_now = lambda: 50
        m.gas_usd = lambda chain: 0.0
        NOTES = []
        m.notify = lambda title, text, sound=True: NOTES.append(text)
        W = "0xw"
        def ev(side, tok, usd, qty, ago_min=5, h=None):
            return {"side": side, "token": tok, "symbol": tok.upper(), "usd": usd, "qty": qty, "ts": now - ago_min * 60,
                    "hash": h or f"h{side}{tok}{usd}{qty}", "chain": "eth", "address": W, "label": "", "first": True, "copy": True}
        P = lambda price, liq=100000, b=50, s=50: {"price": price, "liq": liq, "buys24": b, "sells24": s, "chg": {}}
        def book(): return m.load_json("copytrade.json", {"positions": [], "skipped": []})
        def reason(tok): return next((x["reason"] for x in book()["skipped"] if x["token"] == tok), None)
        def pos(tok): return next((p for p in book()["positions"] if p["token"] == tok), None)

        PRICES.update({"stale": P(1), "chase": P(1.5), "dump": P(0.4), "honey": P(1, b=30, s=0), "sec": P(1), "zero": P(0), "good": P(1.0), "lowliq": P(1, liq=1000)})
        SEC["sec"] = "安全检测：貔貅盘（买了卖不掉）"
        m.copy_step([ev("buy", "stale", 1000, 1000, ago_min=300), ev("buy", "chase", 1000, 1000), ev("buy", "dump", 1000, 1000),
                     ev("buy", "honey", 1000, 1000), ev("buy", "sec", 1000, 1000), ev("buy", "zero", 1000, 1000),
                     ev("buy", "lowliq", 1000, 1000), ev("buy", "small", 100, 100), ev("buy", "good", 1000, 1000)])
        ok("过时" in (reason("stale") or ""), f"stale signal -> {reason('stale')}")
        ok("不追高" in (reason("chase") or ""), f"chase -> {reason('chase')}")
        ok("价格异常" in (reason("dump") or ""), f"dump -> {reason('dump')}")
        ok("貔貅" in (reason("honey") or ""), f"no-sells honeypot -> {reason('honey')}")
        ok("安全检测" in (reason("sec") or ""), f"goplus -> {reason('sec')}")
        ok("现价" in (reason("zero") or ""), f"zero price -> {reason('zero')}")
        ok("流动性" in (reason("lowliq") or ""), f"low liquidity -> {reason('lowliq')}")
        ok(pos("small") is None and reason("small") is None, "small signal ignored")
        # 入场价 = 现价 ×（1 + 基础滑点 1% + 价格冲击 2×100/100000 = 0.2%）
        g = pos("good"); ok(g and g["status"] == "open" and abs(g["entry_price"] - 1.012) < 1e-9, f"good opened at {g and g['entry_price']} (slip + impact)")
        # 重复同一笔信号不重复开仓；加仓计入 w_qty
        m.copy_step([ev("buy", "good", 1000, 1000), ev("buy", "good", 600, 600, h="addon")])
        ok(sum(p["token"] == "good" for p in book()["positions"]) == 1, "no duplicate position")
        ok(abs(pos("good")["w_qty"] - 2600) < 1e-9, f"add-on tracked w_qty={pos('good')['w_qty']}")
        # 分批卖出：卖 30% 不平仓，再卖到过半才平仓
        m.copy_step([ev("sell", "good", 300, 780, h="s1")])
        ok(pos("good")["status"] == "open" and "减仓" in pos("good").get("note", ""), f"partial sell keeps open ({pos('good').get('note')})")
        PRICES["good"] = P(1.2)
        m.copy_step([ev("sell", "good", 600, 600, h="s2")])
        g = pos("good"); ok(g["status"] == "closed" and g["exit_reason"] == "聪明钱卖出" and g["pnl"] > 0, f"closed after >50% sold pnl={g['pnl']:.2f}")
        # 持仓上限
        m.save_json("config.json", {"copy_enabled": True, "copy_min_signal": 500, "copy_max_open": 1})
        PRICES.update({"a1": P(1), "a2": P(1)})
        m.copy_step([ev("buy", "a1", 1000, 1000), ev("buy", "a2", 1000, 1000)])
        ok(pos("a1") and "持仓已满" in (reason("a2") or ""), f"max open -> {reason('a2')}")
        # 撤池：价格消失超过 6 小时按归零平仓
        b = book(); [p.update(last_ts=int(now - 7 * 3600)) for p in b["positions"] if p["token"] == "a1"]; m.save_json("copytrade.json", b)
        del PRICES["a1"]
        m.copy_step([])
        a1 = pos("a1"); ok(a1["status"] == "closed" and a1["pnl_pct"] == -100 and "撤池" in a1["exit_reason"], f"rug -> {a1['exit_reason']} {a1['pnl_pct']}")
        # 流动性枯竭
        m.save_json("config.json", {"copy_enabled": True, "copy_min_signal": 500})
        PRICES["liq"] = P(1)
        m.copy_step([ev("buy", "liq", 1000, 1000)])
        PRICES["liq"] = P(0.9, liq=2000)
        m.copy_step([])
        ok(pos("liq")["exit_reason"] == "流动性枯竭", f"liquidity drain -> {pos('liq')['exit_reason']}")
        # 止损按现价成交
        PRICES["sl"] = P(1)
        m.copy_step([ev("buy", "sl", 1000, 1000)])
        PRICES["sl"] = P(0.5)
        m.copy_step([])
        ok(pos("sl")["exit_reason"] == "止损", f"stop loss -> {pos('sl')['exit_reason']} {pos('sl')['pnl_pct']:.1f}%")
        # check_smart_buys 去重 + 回看 + 内部交易失败不推进
        TR = []
        SW = m.smart_wallets
        m.smart_wallets = lambda: [{"chain": "eth", "address": W, "label": "", "labeled": True}]
        m.get_transfers = lambda c, a, n, max_age=600: {"transfers": [{"ts": t["ts"]} for t in TR] or [{"ts": now}], "warnings": WARN}
        m.evm_trades = lambda c, d: (sorted(TR, key=lambda t: t["ts"]), 0)
        WARN = []
        st = m.alert_settings()
        TR = [{"side": "buy", "token": "x", "symbol": "X", "usd": 1000, "qty": 1, "ts": now - 3000, "hash": "t1"}]
        f, e = m.check_smart_buys(st, []); ok(len(e) == 0, "first run only records position")
        TR.append({"side": "sell", "token": "x", "symbol": "X", "usd": 900, "qty": 1, "ts": now - 600, "hash": "t2"})
        f, e = m.check_smart_buys(st, []); ok([x["hash"] for x in e] == ["t2"], f"new sell picked up {[x['hash'] for x in e]}")
        f, e = m.check_smart_buys(st, []); ok(e == [], "no duplicate on re-run")
        # 内部交易晚到：同一笔卖出 20 分钟前的，在位置之后才出现
        TR.append({"side": "sell", "token": "y", "symbol": "Y", "usd": 500, "qty": 1, "ts": now - 1200, "hash": "late"})
        f, e = m.check_smart_buys(st, []); ok([x["hash"] for x in e] == ["late"], f"late-indexed trade within 30 min caught {[x['hash'] for x in e]}")
        WARN = ["内部交易获取失败: timeout"]
        mark_before = m.load_json("smart_alerts.json", {})[f"eth:{W}"]["ts"]
        TR.append({"side": "buy", "token": "z", "symbol": "Z", "usd": 700, "qty": 1, "ts": now + 10, "hash": "z1"})
        f, e = m.check_smart_buys(st, [])
        ok(m.load_json("smart_alerts.json", {})[f"eth:{W}"]["ts"] == mark_before, "mark not advanced when internal txs failed")
        WARN = []
        f, e = m.check_smart_buys(st, []); ok(e == [], "z1 not repeated after mark held (deduped)")

        # Gas：两边各 $2 应从盈亏里扣掉
        m.gas_usd = lambda chain: 2.0
        m.save_json("config.json", {"copy_enabled": True, "copy_min_signal": 500, "copy_notify": True})
        PRICES["gas"] = P(1, liq=1e9)
        m.copy_step([ev("buy", "gas", 1000, 1000)])
        PRICES["gas"] = P(1, liq=1e9)
        m.copy_step([ev("sell", "gas", 1000, 1000, h="gs")])
        gp = pos("gas"); ok(gp["status"] == "closed" and abs(gp["pnl"] - (100 / 1.01 * 0.99 - 100 - 4)) < 1e-3 and gp["gas"] == 4, f"gas deducted pnl={gp['pnl']:.3f} gas={gp['gas']}")
        ok(any("GAS" in n for n in NOTES) and len(NOTES) >= 2 and not any("聪明钱" in n for n in NOTES if "ja" == m.alert_settings()["lang"]), f"notifications sent {NOTES[-2:]}")
        # 价格冲击：流动性越小滑点越大
        cs = m.copy_settings(); ok(abs(m.slip_pct(cs, 100, 10000) - 3.0) < 1e-9 and m.slip_pct(cs, 100, 0) == 1.0, "price impact from liquidity")
        # 30 天没交易的排行榜钱包不再跟踪
        m.save_json("labels.json", {})
        m.save_json("smart.json", {"eth:0xold": {"chain": "eth", "address": "0xold", "score": 70, "smart": True, "last_trade": now - 40 * 86400},
                                   "eth:0xnew": {"chain": "eth", "address": "0xnew", "score": 70, "smart": True, "last_trade": now - 86400}})
        m.smart_wallets = SW
        got = {w["address"] for w in m.smart_wallets()}
        ok(got == {"0xnew"}, f"inactive wallets pruned {got}")

    finally:
        shutil.rmtree(TMP, ignore_errors=True)


class CopyBotTest(unittest.TestCase):
    def test_copybot_rules(self):
        def ok(cond, msg):
            with self.subTest(msg):
                self.assertTrue(cond, msg)
        scenario(ok)


if __name__ == "__main__":
    unittest.main()
