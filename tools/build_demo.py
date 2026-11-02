"""生成 GitHub Pages 在线演示版（静态网页，没有后端）。

用法（需要本地服务在运行，并已填好 Etherscan Key）：
    python3 tools/build_demo.py 输出目录          # 例如 ../block-detective/docs

做的事：
1. 把 static/ 复制到输出目录，在 index.html 里插入 demo.js（拦截 /api/ 请求，用录好的数据回答）
2. 从本地服务录一个示例案例（以太坊基金会公开钱包 + 两个主要收款地址）的转账和档案，以及行情 / 链上遥测
3. 标签库和监控列表用 seed/ 里的公开预置数据；跟单账本、研究数据、排行榜一律留空 —— 不带任何个人数据
"""
import json
import os
import re
import shutil
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "http://127.0.0.1:8765"
CASE = {"chain": "eth", "address": "0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae"}  # 以太坊基金会（公开机构钱包，中性示例）
LIMIT = 300  # 和网页默认的“最近 300 笔”一致


def get(path):
    with urllib.request.urlopen(API + path, timeout=180) as r:
        return json.load(r)


def transfers(chain, addr, kind):
    d = get(f"/api/transfers?chain={chain}&address={addr}&limit={LIMIT}&kind={kind}")
    d["warnings"] = [w for w in d.get("warnings", []) if "缓存" not in w]  # 去掉“使用了本地缓存”之类只对本机有意义的提示
    d.pop("cached_at", None)
    return d


def main(out):
    out = os.path.abspath(out)
    shutil.rmtree(out, ignore_errors=True)
    shutil.copytree(os.path.join(ROOT, "static"), out, ignore=shutil.ignore_patterns("._*", ".DS_Store"))
    for f in ("demo.js", "demo.css"):
        shutil.copy(os.path.join(ROOT, "demo", f), out)
    html = open(os.path.join(out, "index.html"), encoding="utf-8").read()
    html = re.sub(r'(<script src="theme\.js[^"]*"></script>)', r'\1\n<script src="demo.js"></script>', html, count=1)
    html = html.replace("<title>区块侦探</title>", "<title>区块侦探 · Block Detective — Demo</title>")
    open(os.path.join(out, "index.html"), "w", encoding="utf-8").write(html)
    open(os.path.join(out, ".nojekyll"), "w").close()  # 让 GitHub Pages 原样发布，不经过 Jekyll

    seed = lambda n: json.load(open(os.path.join(ROOT, "seed", n), encoding="utf-8"))
    data = {"case": CASE, "generated": int(time.time())}
    for p in ("/api/chains", "/api/prices", "/api/chainstat", "/api/market"):
        data[p] = get(p)
    data["/api/labels"] = seed("labels.json")
    data["/api/watchlist"] = seed("watchlist.json")
    data["/api/config"] = {"etherscan_key": False, "trongrid_key": False, "blockscout_key": False, "storage": "file", "keychain_available": False}
    data["/api/alerts"] = {"enabled": False, "interval": 15, "lang": "ja", "sound": True, "smart_enabled": True, "smart_min": 1000,
                           "smart_first_only": False, "last_run": None, "last_error": None, "running": False, "next_run": None,
                           "history": [], "smart_wallets": 0}
    copy = get("/api/copy")
    data["/api/copy"] = {"settings": {**copy["settings"], "enabled": False}, "positions": [], "skipped": [], "alerts_on": False,
                         "interval": 15, "copy_wallets": 0, "next_run": None, "last_run": None, "last_error": None,
                         "started": int(time.time()), "discover_log": [], "discovering": False, "gas_now": copy.get("gas_now", 1),
                         "smart_wallets": 0, "labeled_wallets": 0}
    data["/api/research"] = {"sources": {"live": 0, "backtest": 0}, "total": 0, "buys": 0, "sells": 0, "open": 0, "with_24h": 0,
                             "target": "r24h", "horizons": {k: {"n": 0, "avg": None, "median": None, "win": None}
                                                             for k in ("r1h", "r6h", "r24h", "r3d", "r7d")},
                             "factors": [], "recent": []}
    data["/api/backtest"] = {}
    data["/api/smart/board"] = []
    data["/api/backup"] = {"dir": "—", "count": 0, "latest": None, "latest_ts": None, "files": [], "keep": 14}

    # 示例案例：中心地址 + 收到它资金最多的两个地址（演示“双击展开”和“资金路径”）
    c, a = CASE["chain"], CASE["address"]
    parts = {k: transfers(c, a, k) for k in ("token", "native")}
    out_to = {}
    for d in parts.values():
        for t in d["transfers"]:
            if t["dir"] == "out" and t.get("usd"):
                out_to[t["to"]] = out_to.get(t["to"], 0) + t["usd"]
    expand = [x for x, _ in sorted(out_to.items(), key=lambda kv: -kv[1])[:2]]
    for addr in [a] + expand:
        for k in ("token", "native"):
            data[f"transfers|{c}|{addr}|{k}"] = parts[k] if addr == a else transfers(c, addr, k)
        data[f"profile|{c}|{addr}"] = get(f"/api/profile?chain={c}&address={addr}")
    json.dump(data, open(os.path.join(out, "demo-data.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    n = sum(len(v["transfers"]) for k, v in data.items() if k.startswith("transfers|"))
    print(f"演示版已生成：{out}（{len(expand) + 1} 个地址，{n} 笔转账，demo-data.json {os.path.getsize(os.path.join(out, 'demo-data.json')) // 1024} KB）")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
