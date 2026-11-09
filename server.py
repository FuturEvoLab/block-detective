#!/usr/bin/env python3
"""区块侦探 — 本地多链地址资金流向分析工具（只用 Python 标准库）。

启动:  python3 server.py      然后浏览器打开 http://127.0.0.1:8765
数据源: Etherscan V2（EVM 链，需免费 API Key）、TronGrid（TRON）、mempool.space（BTC）、CoinGecko（价格）
"""

import gzip
import hashlib
import importlib.util
import io
import json
import math
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HOST, PORT = "127.0.0.1", int(os.environ.get("PORT", "8765"))
VERSION = "1.7.0"      # 核心版本；扩展用 REQUIRES_CORE 声明最低要求（见下方“扩展”一节），变更见 CHANGELOG.md
STARTED = time.time()  # 本次服务启动时间（网页据此判断机器人是不是真的停了）
ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "static")
DATA = os.path.join(ROOT, "data")
UA = "Mozilla/5.0 (block-detective local tool)"

# ---------------------------------------------------------------- 链配置

CHAINS = {
    "eth":      {"name": "Ethereum", "type": "evm", "chainid": 1,     "native": "ETH", "explorer": "https://etherscan.io"},
    "bsc":      {"name": "BSC",      "type": "evm", "chainid": 56,    "native": "BNB", "explorer": "https://bscscan.com"},
    "polygon":  {"name": "Polygon",  "type": "evm", "chainid": 137,   "native": "POL", "explorer": "https://polygonscan.com"},
    "arbitrum": {"name": "Arbitrum", "type": "evm", "chainid": 42161, "native": "ETH", "explorer": "https://arbiscan.io"},
    "base":     {"name": "Base",     "type": "evm", "chainid": 8453,  "native": "ETH", "explorer": "https://basescan.org"},
    # Optimism：免费 Etherscan Key 不支持，改用官方区块浏览器（Blockscout）的兼容接口，不需要 Key
    "optimism": {"name": "Optimism", "type": "evm", "chainid": 10,    "native": "ETH", "explorer": "https://optimistic.etherscan.io",
                 "free_api": "https://explorer.optimism.io/api"},
    "tron":     {"name": "TRON",     "type": "tron", "native": "TRX", "explorer": "https://tronscan.org/#"},
    "btc":      {"name": "Bitcoin",  "type": "btc",  "native": "BTC", "explorer": "https://mempool.space"},
}

# 可信代币合约（只有这些代币才计算美元价值，用来过滤假 USDT 等“地址投毒”垃圾币）
# 值为 (符号, 价格键)；价格键对应 PRICE_IDS 或稳定币 "USD"
KNOWN_TOKENS = {
    "eth": {
        "0xdac17f958d2ee523a2206206994597c13d831ec7": ("USDT", "USD"),
        "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": ("USDC", "USD"),
        "0x6b175474e89094c44da98b954eedeac495271d0f": ("DAI", "USD"),
        "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": ("WETH", "ETH"),
        "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": ("WBTC", "BTC"),
    },
    "bsc": {
        "0x55d398326f99059ff775485246999027b3197955": ("USDT", "USD"),
        "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": ("USDC", "USD"),
        "0xe9e7cea3dedca5984780bafc599bd69add087d56": ("BUSD", "USD"),
        "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": ("WBNB", "BNB"),
    },
    "polygon": {
        "0xc2132d05d31c914a87c6611c10748aeb04b58e8f": ("USDT", "USD"),
        "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": ("USDC", "USD"),
    },
    "arbitrum": {
        "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": ("USDT", "USD"),
        "0xaf88d065e77c8cc2239327c5edb3a432268e5831": ("USDC", "USD"),
    },
    "base": {
        "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": ("USDC", "USD"),
    },
    "optimism": {
        "0x0b2c639c533813f4aa9d7837caf62653d097ff85": ("USDC", "USD"),
        "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58": ("USDT", "USD"),
        "0x4200000000000000000000000000000000000006": ("WETH", "ETH"),
    },
    "tron": {
        "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t": ("USDT", "USD"),
        "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8": ("USDC", "USD"),
    },
}

PRICE_IDS = {"ETH": "ethereum", "BTC": "bitcoin", "TRX": "tron", "BNB": "binancecoin", "POL": "polygon-ecosystem-token"}

ADDR_RE = {
    "evm": re.compile(r"^0x[0-9a-fA-F]{40}$"),
    "tron": re.compile(r"^T[1-9A-HJ-NP-Za-km-z]{33}$"),
    "btc": re.compile(r"^(bc1[0-9a-z]{25,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$"),
}


# 同一地址的多个 API 请求并行发出；限速仍由各自的 RateLimiter 控制，这里省掉的是串行等网络的时间
POOL = ThreadPoolExecutor(max_workers=12)


class ApiError(Exception):
    pass


# ---------------------------------------------------------------- 本地 JSON 存储

_store_lock = threading.Lock()


def load_json(name, default):
    path = os.path.join(DATA, name)
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_json(name, value):
    os.makedirs(DATA, exist_ok=True)
    path = os.path.join(DATA, name)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


# ---------------- API Key 存放：默认在 config.json；用户在“设置”页点“移到钥匙串”后，Mac 上改存系统钥匙串
# （加密，登录后才能读），不再明文写在外接硬盘上。只在用户主动点击时才写钥匙串。Windows 没有钥匙串命令，仍存在 config.json

SECRET_KEYS = ("etherscan_key", "trongrid_key", "blockscout_key", "webhook_url")
SECRET_ENV = {"etherscan_key": "ETHERSCAN_API_KEY", "trongrid_key": "TRONGRID_API_KEY", "blockscout_key": "BLOCKSCOUT_API_KEY",
              "webhook_url": "BD_WEBHOOK_URL"}
KEYCHAIN_SERVICE = "BlockDetective"
_secrets = {}  # 内存里的副本，避免每次都去问钥匙串


def keychain_ok():
    return sys.platform == "darwin" and os.path.exists("/usr/bin/security")


def keychain_mode():
    """用户是否已经选择把 Key 放进钥匙串"""
    return keychain_ok() and load_json("config.json", {}).get("secrets_in") == "keychain"


def keychain_get(name):
    r = subprocess.run(["/usr/bin/security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name, "-w"],
                       capture_output=True, text=True, timeout=10)
    return r.stdout.strip() if r.returncode == 0 else ""


def keychain_set(name, value):
    if value:
        r = subprocess.run(["/usr/bin/security", "add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", name, "-w", value,
                            "-l", f"区块侦探 {name}"], capture_output=True, text=True, timeout=10)
        if r.returncode != 0 or keychain_get(name) != value:
            raise ApiError("写入 macOS 钥匙串失败：" + (r.stderr.strip() or "读回的值不一致"))
    else:
        subprocess.run(["/usr/bin/security", "delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name],
                       capture_output=True, timeout=10)
    _secrets[name] = value


def set_secret(name, value):
    if keychain_mode():
        keychain_set(name, value)
        with _store_lock:  # 确保文件里不再留明文
            cfg = load_json("config.json", {})
            if cfg.pop(name, None) is not None:
                save_json("config.json", cfg)
    else:
        with _store_lock:
            cfg = load_json("config.json", {})
            cfg[name] = value
            save_json("config.json", cfg)
        _secrets[name] = value


def migrate_secrets():
    """用户点击“移到钥匙串”时：把 config.json 里的明文 Key 搬进钥匙串（读回校验成功才从文件删除），并清理旧备份里的明文"""
    if not keychain_ok():
        raise ApiError("只有 macOS 支持钥匙串；Windows 上 Key 仍保存在 data/config.json")
    with _store_lock:
        cfg = load_json("config.json", {})
    for k in SECRET_KEYS:
        if cfg.get(k):
            keychain_set(k, cfg[k])  # 写入后会读回校验，失败直接报错、文件不动
    with _store_lock:
        cfg = load_json("config.json", {})
        for k in SECRET_KEYS:
            cfg.pop(k, None)
        cfg["secrets_in"] = "keychain"
        save_json("config.json", cfg)
    try:
        for d in os.listdir(BACKUP_DIR):
            fn = os.path.join(BACKUP_DIR, d, "config.json")
            if os.path.isfile(fn):
                b = load_json_path(fn)
                if any(k in b for k in SECRET_KEYS):
                    for k in SECRET_KEYS:
                        b.pop(k, None)
                    with open(fn, "w", encoding="utf-8") as f:
                        json.dump(b, f, ensure_ascii=False, indent=2)
    except OSError:
        pass


def load_json_path(fn):
    try:
        with open(fn, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def config():
    cfg = load_json("config.json", {})
    kc = cfg.get("secrets_in") == "keychain" and keychain_ok()
    for k in SECRET_KEYS:
        if k not in _secrets and kc:
            _secrets[k] = keychain_get(k)
        # 环境变量优先，方便临时使用；其次钥匙串 / 内存；最后才是文件（Windows）
        cfg[k] = os.environ.get(SECRET_ENV[k]) or _secrets.get(k) or cfg.get(k, "")
    return cfg


# ---------------------------------------------------------------- HTTP 工具

_cache = {}
_cache_lock = threading.Lock()


def http_json(url, headers=None, ttl=120):
    now = time.time()
    with _cache_lock:
        hit = _cache.get(url)
        if hit and now - hit[0] < ttl:
            return hit[1]
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:200]
        raise ApiError(f"HTTP {e.code}: {body}")
    except urllib.error.URLError as e:
        raise ApiError(f"网络错误: {e.reason}")
    with _cache_lock:
        _cache[url] = (now, data)
        # 控制内存：超过 400 条时先清过期的，仍然太多就丢掉最旧的
        if len(_cache) > 400:
            for k in [k for k, (t, _) in _cache.items() if now - t > 600]:
                del _cache[k]
            for k, _ in sorted(_cache.items(), key=lambda kv: kv[1][0])[: max(0, len(_cache) - 300)]:
                del _cache[k]
    return data


CACHE_DIR = os.path.join(DATA, "cache")


def disk_cached(kind, key, max_age, fetch):
    """磁盘缓存（重启后仍有效）：max_age 秒内直接返回；过期就重新获取，失败时退回旧数据。
    返回 (数据, 缓存时间或 None, 是否为过期兜底)"""
    fn = os.path.join(CACHE_DIR, hashlib.sha1(f"{kind}|{key}".encode()).hexdigest()[:24] + ".json.gz")
    old = None
    try:
        with gzip.open(fn, "rt", encoding="utf-8") as f:
            old = json.load(f)
    except (OSError, ValueError):
        pass
    if old and time.time() - old["t"] < max_age:
        return old["v"], old["t"], False
    try:
        value = fetch()
    except ApiError:
        if old:
            return old["v"], old["t"], True
        raise
    os.makedirs(CACHE_DIR, exist_ok=True)
    tmp = f"{fn}.{threading.get_ident()}.tmp"
    with gzip.open(tmp, "wt", encoding="utf-8") as f:
        json.dump({"t": time.time(), "v": value}, f, ensure_ascii=False)
    os.replace(tmp, fn)
    if hash(fn) % 20 == 0:
        prune_disk_cache()
    return value, None, False


_swr_busy, _swr_lock = set(), threading.Lock()


def swr(kind, max_age, fetch, max_stale=86400):
    """先返回上次存下的结果（哪怕服务刚重启），过期就在后台刷新——首屏不用等外部接口。
    完全没有缓存或缓存太旧时才同步获取。返回 (数据, 获取时间)"""
    fn = os.path.join(CACHE_DIR, hashlib.sha1(f"{kind}|swr".encode()).hexdigest()[:24] + ".json.gz")
    try:
        with gzip.open(fn, "rt", encoding="utf-8") as f:
            old = json.load(f)
    except (OSError, ValueError):
        old = None

    def refresh():
        try:
            v = fetch()
            os.makedirs(CACHE_DIR, exist_ok=True)
            tmp = f"{fn}.{threading.get_ident()}.tmp"
            with gzip.open(tmp, "wt", encoding="utf-8") as f:
                json.dump({"t": time.time(), "v": v}, f, ensure_ascii=False)
            os.replace(tmp, fn)
            return v
        finally:
            with _swr_lock:
                _swr_busy.discard(kind)

    age = time.time() - old["t"] if old else None
    if old and age < max_stale:
        if age > max_age:
            with _swr_lock:
                start = kind not in _swr_busy
                _swr_busy.add(kind)
            if start:  # 同一类只开一个后台刷新
                threading.Thread(target=refresh, daemon=True).start()
        return old["v"], old["t"]
    with _swr_lock:
        _swr_busy.add(kind)
    return refresh(), time.time()


def disk_peek(kind, key, max_age):
    """只读磁盘缓存，不联网；没有或过期返回 None"""
    fn = os.path.join(CACHE_DIR, hashlib.sha1(f"{kind}|{key}".encode()).hexdigest()[:24] + ".json.gz")
    try:
        with gzip.open(fn, "rt", encoding="utf-8") as f:
            old = json.load(f)
        return old["v"] if time.time() - old["t"] < max_age else None
    except (OSError, ValueError, KeyError):
        return None


def prune_disk_cache(max_files=1500, max_days=7):
    try:
        files = [(e.stat().st_mtime, e.path) for e in os.scandir(CACHE_DIR) if e.name.endswith(".json.gz")]
    except OSError:
        return
    files.sort()
    cutoff = time.time() - max_days * 86400
    for i, (mt, path) in enumerate(files):
        if mt < cutoff or i < len(files) - max_files:
            try:
                os.remove(path)
            except OSError:
                pass


def is_cached(url, ttl=120):
    with _cache_lock:
        return url in _cache and time.time() - _cache[url][0] < ttl


class RateLimiter:
    def __init__(self, per_sec):
        self.interval = 1.0 / per_sec
        self.lock = threading.Lock()
        self.last = 0.0

    def wait(self):
        with self.lock:
            delay = self.last + self.interval - time.time()
            if delay > 0:
                time.sleep(delay)
            self.last = time.time()


etherscan_limiter = RateLimiter(3)  # 免费 Key 约 3~5 次/秒
_tron_limiters = {}  # 每个 TronGrid 接口一个限速器


# ---------------------------------------------------------------- 价格

def prices():
    try:
        ids = ",".join(PRICE_IDS.values())
        data = http_json(f"https://api.coingecko.com/api/v3/simple/price?ids={ids}&vs_currencies=usd&include_24hr_change=true", ttl=600)
        out = {sym: data.get(cid, {}).get("usd") for sym, cid in PRICE_IDS.items()}
        out["_chg"] = {sym: data.get(cid, {}).get("usd_24h_change") for sym, cid in PRICE_IDS.items()}
    except ApiError:
        out = {}
    out["USD"] = 1.0
    return out


def chain_stat():
    """HUD 遥测：各链最新区块高度和手续费，失败的项返回 None"""
    def eth():
        key = config()["etherscan_key"]
        if not key:
            return None
        base = "https://api.etherscan.io/v2/api?chainid=1&apikey=" + urllib.parse.quote(key)
        out = {}
        for action, url in (("height", base + "&module=proxy&action=eth_blockNumber"),
                            ("gas", base + "&module=gastracker&action=gasoracle")):
            if not is_cached(url, 10):
                etherscan_limiter.wait()
            r = http_json(url, ttl=10).get("result")
            if action == "height" and isinstance(r, str) and r.startswith("0x"):
                out["height"] = int(r, 16)
            elif action == "gas" and isinstance(r, dict):
                out["gas"] = float(r.get("ProposeGasPrice") or 0)
        return out or None

    def btc():
        return {"height": int(http_json("https://mempool.space/api/blocks/tip/height", ttl=20)),
                "fee": http_json("https://mempool.space/api/v1/fees/recommended", ttl=60).get("halfHourFee")}

    def tron():
        m = re.search(r"Num:(\d+)", str(trongrid("/wallet/getnodeinfo", {}, ttl=10).get("block", "")))
        return {"height": int(m.group(1))} if m else None

    jobs = {k: POOL.submit(f) for k, f in (("eth", eth), ("btc", btc), ("tron", tron))}
    out = {}
    for k, fut in jobs.items():
        try:
            out[k] = fut.result(timeout=15)
        except Exception:  # noqa: BLE001 — 遥测失败不影响主功能
            out[k] = None
    return out


def market():
    """市场监控：恐惧与贪婪指数、全市场概览、主流币、合约情绪、稳定币供应。各项独立获取，失败的返回 None"""
    def fng():
        d = http_json("https://api.alternative.me/fng/?limit=90", ttl=600).get("data") or []
        return [{"v": int(x["value"]), "ts": int(x["timestamp"])} for x in d]

    def overview():
        d = http_json("https://api.coingecko.com/api/v3/global", ttl=300)["data"]
        pct = d.get("market_cap_percentage", {})
        return {"mcap": d["total_market_cap"]["usd"], "vol": d["total_volume"]["usd"],
                "mcap_chg": d.get("market_cap_change_percentage_24h_usd"),
                "btc_dom": pct.get("btc"), "eth_dom": pct.get("eth")}

    def coins():
        d = http_json("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=15"
                      "&sparkline=true&price_change_percentage=24h,7d", ttl=300)
        out = []
        for c in d:
            spark = (c.get("sparkline_in_7d") or {}).get("price") or []
            step = max(1, len(spark) // 42)  # 7 天约 168 个点，抽稀到 40 个左右
            out.append({"sym": c["symbol"].upper(), "name": c["name"], "price": c["current_price"], "mcap": c["market_cap"],
                        "vol": c["total_volume"], "chg24": c.get("price_change_percentage_24h_in_currency"),
                        "chg7": c.get("price_change_percentage_7d_in_currency"), "spark": spark[::step]})
        return out

    def deriv(sym):
        base = "https://fapi.binance.com"
        prem = http_json(f"{base}/fapi/v1/premiumIndex?symbol={sym}USDT", ttl=120)
        mark = float(prem["markPrice"])
        oi = http_json(f"{base}/futures/data/openInterestHist?symbol={sym}USDT&period=1h&limit=25", ttl=300)
        ls = http_json(f"{base}/futures/data/globalLongShortAccountRatio?symbol={sym}USDT&period=1h&limit=1", ttl=300)
        oi_now = float(oi[-1]["sumOpenInterestValue"]) if oi else None
        oi_old = float(oi[0]["sumOpenInterestValue"]) if oi else None
        return {"sym": sym, "mark": mark, "funding": float(prem["lastFundingRate"]), "next_funding": prem["nextFundingTime"] // 1000,
                "oi": oi_now, "oi_chg": (oi_now / oi_old - 1) * 100 if oi_now and oi_old else None,
                "long_ratio": float(ls[0]["longAccount"]) if ls else None, "ls": float(ls[0]["longShortRatio"]) if ls else None}

    def stables():
        d = http_json("https://stablecoins.llama.fi/stablecoincharts/all", ttl=3600)[-31:]
        series = [{"ts": int(x["date"]), "v": (x.get("totalCirculatingUSD") or {}).get("peggedUSD")} for x in d]
        series = [x for x in series if x["v"]]
        now, wk = series[-1]["v"], series[-8]["v"] if len(series) >= 8 else None
        return {"total": now, "chg7": (now / wk - 1) * 100 if wk else None, "series": series}

    jobs = {"fng": POOL.submit(fng), "overview": POOL.submit(overview), "coins": POOL.submit(coins),
            "btc": POOL.submit(deriv, "BTC"), "eth": POOL.submit(deriv, "ETH"), "stables": POOL.submit(stables)}
    out, errors = {}, {}
    for k, fut in jobs.items():
        try:
            out[k] = fut.result(timeout=25)
        except Exception as e:  # noqa: BLE001 — 某个数据源失败不影响其他
            out[k] = None
            errors[k] = str(e)[:160]
    out["deriv"] = [x for x in (out.pop("btc"), out.pop("eth")) if x]
    out["errors"] = errors
    return out


def usd_value(amount, price_key, px):
    p = px.get(price_key)
    return amount * p if p is not None else None


# ---------------------------------------------------------------- 地址工具

def chain_type(chain):
    if chain not in CHAINS:
        raise ApiError(f"不支持的链: {chain}")
    return CHAINS[chain]["type"]


def norm_addr(chain, addr):
    addr = (addr or "").strip()
    t = chain_type(chain)
    if not ADDR_RE[t].match(addr):
        raise ApiError(f"地址格式不正确（{CHAINS[chain]['name']}）: {addr}")
    return addr.lower() if t == "evm" else addr


B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def tron_hex_to_base58(hex_addr):
    """TRON 原始交易里的 41 开头 hex 地址 → T 开头 base58check 地址。"""
    if not hex_addr:
        return ""
    raw = bytes.fromhex(hex_addr)
    check = hashlib.sha256(hashlib.sha256(raw).digest()).digest()[:4]
    n = int.from_bytes(raw + check, "big")
    s = ""
    while n:
        n, r = divmod(n, 58)
        s = B58[r] + s
    pad = len(raw + check) - len((raw + check).lstrip(b"\0"))
    return "1" * pad + s


# ---------------------------------------------------------------- EVM（Etherscan V2）

blockscout_limiter = RateLimiter(1)  # 公共区块浏览器的免费额度很小，每秒 1 次


def blockscout(chain, params):
    """Blockscout 的 Etherscan 兼容接口（免费、不需要 Key）"""
    key = config()["blockscout_key"]
    url = CHAINS[chain]["free_api"] + "?" + urllib.parse.urlencode({**params, **({"apikey": key} if key else {})})
    for attempt in range(3):
        if not is_cached(url):
            blockscout_limiter.wait()
        try:
            data = http_json(url)
        except ApiError as e:
            if "HTTP 429" not in str(e) or attempt == 2:
                if "HTTP 429" in str(e):
                    raise ApiError(f"{CHAINS[chain]['name']} 区块浏览器限流，请稍后再试" if key else
                                   f"{CHAINS[chain]['name']} 区块浏览器不填 Key 每小时只能查约 10 次，请在“设置”页填写免费的 Blockscout API Key（dev.blockscout.com）")
                raise
            time.sleep(5 * (attempt + 1))
            continue
        if "Too many requests" not in str(data.get("message", "")):
            break
        with _cache_lock:  # 被限流的回复不要缓存
            _cache.pop(url, None)
        time.sleep(3 * (attempt + 1))
    result, msg = data.get("result"), str(data.get("message", ""))
    if isinstance(result, list):  # status 2 =“部分内部交易还没处理完”，结果照样可用
        for r in result:  # Blockscout 的内部交易用 transactionHash，统一成 Etherscan 的 hash
            if "hash" not in r and "transactionHash" in r:
                r["hash"] = r["transactionHash"]
        return result
    if msg.startswith("No transactions found") or msg.startswith("No records found") or msg.startswith("No token transfers"):
        return []
    if str(data.get("status")) == "1":
        return result
    raise ApiError(f"{CHAINS[chain]['name']} 区块浏览器: {result or msg}")


def etherscan(chain, params):
    if CHAINS[chain].get("free_api"):
        return blockscout(chain, params)
    key = config()["etherscan_key"]
    if not key:
        raise ApiError("EVM 链需要 Etherscan API Key（免费注册：https://etherscan.io/apis ），请在“设置”页填写")
    q = {"chainid": CHAINS[chain]["chainid"], **params, "apikey": key}
    url = "https://api.etherscan.io/v2/api?" + urllib.parse.urlencode(q)
    if not is_cached(url):
        etherscan_limiter.wait()
    data = http_json(url)
    if str(data.get("status")) == "1":
        return data["result"]
    msg = str(data.get("message", ""))
    result = data.get("result")
    if msg.startswith("No transactions found") or msg.startswith("No records found") or result == []:
        return []
    if isinstance(result, str) and "rate limit" in result.lower():
        # 被限流时清缓存并重试一次
        with _cache_lock:
            _cache.pop(url, None)
        time.sleep(1.2)
        data = http_json(url)
        if str(data.get("status")) == "1":
            return data["result"]
    detail = str(data.get("result") or msg)
    if "Free API access is not supported" in detail:
        raise ApiError(f"Etherscan 免费 Key 不支持 {CHAINS[chain]['name']} 链（需付费套餐）。"
                       f"可先用 MetaSleuth / Arkham 等在线工具查这条链（见“工具导航”）")
    raise ApiError(f"Etherscan（{CHAINS[chain]['name']}）: {detail}")


def evm_transfers(chain, addr, limit, px, kind="all"):
    native = CHAINS[chain]["native"]
    base = {"module": "account", "address": addr, "page": 1, "offset": limit, "sort": "desc"}
    out, warnings = [], []
    actions = {"native": ("txlist", "txlistinternal"), "token": ("tokentx",)}.get(kind, ("txlist", "txlistinternal", "tokentx"))
    jobs = {a: POOL.submit(etherscan, chain, {**base, "action": a}) for a in actions}

    def native_rows(action):
        rows = jobs[action].result()
        for r in rows:
            if r.get("isError") == "1" or int(r.get("value") or 0) == 0:
                continue
            amt = int(r["value"]) / 1e18
            out.append({
                "hash": r["hash"], "ts": int(r["timeStamp"]),
                "from": r["from"].lower(), "to": (r.get("to") or r.get("contractAddress") or "").lower(),
                "amount": amt, "symbol": native, "token": "native", "verified": True,
                "usd": usd_value(amt, native, px), "kind": "internal" if action == "txlistinternal" else "tx",
            })

    if "txlist" in jobs:
        native_rows("txlist")
        try:
            native_rows("txlistinternal")
        except ApiError as e:
            warnings.append(f"内部交易获取失败: {e}")

    known = KNOWN_TOKENS.get(chain, {})
    for r in (jobs["tokentx"].result() if "tokentx" in jobs else []):
        contract = r["contractAddress"].lower()
        dec = int(r.get("tokenDecimal") or 0)
        amt = int(r["value"]) / (10 ** dec) if r.get("value") else 0
        if amt == 0:
            continue
        k = known.get(contract)
        out.append({
            "hash": r["hash"], "ts": int(r["timeStamp"]),
            "from": r["from"].lower(), "to": r["to"].lower(),
            "amount": amt, "symbol": k[0] if k else (r.get("tokenSymbol") or "?"), "token": contract,
            "verified": bool(k), "usd": usd_value(amt, k[1], px) if k else None, "kind": "token",
        })
    return out, warnings


def evm_profile(chain, addr, px):
    native = CHAINS[chain]["native"]
    bal_job = POOL.submit(etherscan, chain, {"module": "account", "action": "balance", "address": addr, "tag": "latest"})
    first_jobs = [POOL.submit(etherscan, chain, {"module": "account", "action": a, "address": addr,
                                                 "page": 1, "offset": 1, "sort": "asc"}) for a in ("txlist", "tokentx")]
    bal = int(bal_job.result() or 0) / 1e18
    first = None
    for job in first_jobs:
        rows = job.result()
        if rows and (first is None or int(rows[0]["timeStamp"]) < first["ts"]):
            r = rows[0]
            first = {"ts": int(r["timeStamp"]), "hash": r["hash"], "from": r["from"].lower(),
                     "to": (r.get("to") or "").lower()}
    return {
        "balances": [{"symbol": native, "amount": bal, "usd": usd_value(bal, native, px)}],
        "first_seen": first["ts"] if first else None,
        "first_tx": first,
        # 第一笔交易若是别人转进来的，发送方就是“资金来源 / 激活者”，是重要线索
        "funded_by": first["from"] if first and first["from"] != addr else None,
    }


# ---------------------------------------------------------------- TRON（TronGrid）

def trongrid(path, params, ttl=120):
    headers = {}
    key = config()["trongrid_key"]
    if key:
        headers["TRON-PRO-API-KEY"] = key
    # 无 Key 时 TronGrid 每个接口约 1 次/秒（按接口分别计数），超限会被暂停 5 秒
    endpoint = re.sub(r"T[1-9A-HJ-NP-Za-km-z]{33}", "*", path)
    limiter = _tron_limiters.setdefault(endpoint, RateLimiter(1))
    limiter.interval = 0.25 if key else 1.1
    url = "https://api.trongrid.io" + path + "?" + urllib.parse.urlencode(params)
    for attempt in range(3):
        if not is_cached(url, ttl):  # 命中缓存时不必排队限速
            limiter.wait()
        try:
            data = http_json(url, headers=headers, ttl=ttl)
            break
        except ApiError as e:
            if "HTTP 429" not in str(e) or attempt == 2:
                if "HTTP 429" in str(e):
                    raise ApiError("TronGrid 请求过于频繁，请稍后再试，或在“设置”里填写免费的 TronGrid API Key")
                raise
            time.sleep(5.5)
    if data.get("success") is False:
        raise ApiError(f"TronGrid: {data.get('error') or data}")
    return data


def tron_paged(path, limit, extra=None):
    rows, fingerprint = [], None
    page_size = min(200, limit)  # 翻页时 fingerprint 要求参数与第一页完全一致
    while len(rows) < limit:
        params = {"limit": page_size, "only_confirmed": "true", **(extra or {})}
        if fingerprint:
            params["fingerprint"] = fingerprint
        data = trongrid(path, params)
        rows.extend(data.get("data", []))
        fingerprint = data.get("meta", {}).get("fingerprint")
        if not fingerprint or not data.get("data"):
            break
    return rows[:limit]


def tron_transfers(addr, limit, px, kind="all"):
    out = []
    known = KNOWN_TOKENS["tron"]
    empty = POOL.submit(list)
    trc20_job = POOL.submit(tron_paged, f"/v1/accounts/{addr}/transactions/trc20", limit) if kind != "native" else empty
    native_job = POOL.submit(tron_paged, f"/v1/accounts/{addr}/transactions", limit) if kind != "token" else empty
    for r in trc20_job.result():
        if r.get("type") != "Transfer":  # 跳过 Approval（授权）等非转账事件
            continue
        info = r.get("token_info", {})
        contract = info.get("address", "")
        amt = int(r.get("value") or 0) / (10 ** int(info.get("decimals") or 0))
        if amt == 0:
            continue
        k = known.get(contract)
        out.append({
            "hash": r["transaction_id"], "ts": r["block_timestamp"] // 1000,
            "from": r["from"], "to": r["to"], "amount": amt,
            "symbol": k[0] if k else (info.get("symbol") or "?"), "token": contract,
            "verified": bool(k), "usd": usd_value(amt, k[1], px) if k else None, "kind": "token",
        })
    for r in native_job.result():
        try:
            c = r["raw_data"]["contract"][0]
        except (KeyError, IndexError):
            continue
        if c.get("type") != "TransferContract" or r.get("ret", [{}])[0].get("contractRet") not in (None, "SUCCESS"):
            continue
        v = c["parameter"]["value"]
        amt = int(v.get("amount") or 0) / 1e6
        if amt == 0:
            continue
        out.append({
            "hash": r["txID"], "ts": r["block_timestamp"] // 1000,
            "from": tron_hex_to_base58(v.get("owner_address")), "to": tron_hex_to_base58(v.get("to_address")),
            "amount": amt, "symbol": "TRX", "token": "native", "verified": True,
            "usd": usd_value(amt, "TRX", px), "kind": "tx",
        })
    return out, []


def tron_profile(addr, px):
    data = trongrid(f"/v1/accounts/{addr}", {})
    acct = (data.get("data") or [{}])[0]
    trx = int(acct.get("balance") or 0) / 1e6
    balances = [{"symbol": "TRX", "amount": trx, "usd": usd_value(trx, "TRX", px)}]
    known = KNOWN_TOKENS["tron"]
    decimals = {"USDT": 6, "USDC": 6}
    for item in acct.get("trc20", []):
        for contract, raw in item.items():
            if contract in known:
                sym, pk = known[contract]
                amt = int(raw) / 10 ** decimals.get(sym, 6)
                balances.append({"symbol": sym, "amount": amt, "usd": usd_value(amt, pk, px)})
    created = acct.get("create_time")
    return {"balances": balances, "first_seen": created // 1000 if created else None, "first_tx": None, "funded_by": None}


# ---------------------------------------------------------------- BTC（mempool.space）

MEMPOOL = "https://mempool.space/api"


def btc_transfers(addr, limit, px):
    txs = http_json(f"{MEMPOOL}/address/{addr}/txs")
    seen = {t["txid"] for t in txs}
    while len(txs) < limit:
        confirmed = [t for t in txs if t.get("status", {}).get("confirmed")]
        if not confirmed:
            break
        page = http_json(f"{MEMPOOL}/address/{addr}/txs/chain/{confirmed[-1]['txid']}")
        page = [t for t in page if t["txid"] not in seen]
        if not page:
            break
        seen.update(t["txid"] for t in page)
        txs.extend(page)

    out, now = [], int(time.time())
    for t in txs[:limit]:
        ts = t.get("status", {}).get("block_time") or now
        coinbase = any(v.get("is_coinbase") for v in t.get("vin", []))
        ins = {}
        for v in t.get("vin", []):
            p = v.get("prevout") or {}
            a = p.get("scriptpubkey_address") or ("coinbase" if coinbase else "unknown")
            ins[a] = ins.get(a, 0) + int(p.get("value") or 0)
        outs = {}
        for v in t.get("vout", []):
            a = v.get("scriptpubkey_address")
            if a:
                outs[a] = outs.get(a, 0) + int(v.get("value") or 0)

        def add(frm, to, sats):
            if sats <= 0:
                return
            amt = sats / 1e8
            out.append({"hash": t["txid"], "ts": ts, "from": frm, "to": to, "amount": amt, "symbol": "BTC",
                        "token": "native", "verified": True, "usd": usd_value(amt, "BTC", px), "kind": "tx"})

        if ins.get(addr, 0) > 0:
            # 本地址是付款方：给其他地址的输出都算流出（找零回到自己的不算）
            for a, sats in outs.items():
                if a != addr:
                    add(addr, a, sats)
        else:
            # 本地址是收款方：按各输入地址的出资比例分摊收到的金额
            received, total_in = outs.get(addr, 0), sum(ins.values()) or 1
            if coinbase:
                add("coinbase", addr, received)
            else:
                for a, sats in ins.items():
                    add(a, addr, round(received * sats / total_in))
    return out, []


def btc_profile(addr, px):
    d = http_json(f"{MEMPOOL}/address/{addr}")
    cs = d.get("chain_stats", {})
    bal = (int(cs.get("funded_txo_sum", 0)) - int(cs.get("spent_txo_sum", 0))) / 1e8
    return {"balances": [{"symbol": "BTC", "amount": bal, "usd": usd_value(bal, "BTC", px)}],
            "tx_count": cs.get("tx_count"), "first_seen": None, "first_tx": None, "funded_by": None}


# ---------------------------------------------------------------- 统一入口

def get_transfers(chain, address, limit=200, kind="all", max_age=600):
    """带磁盘缓存的 get_transfers：10 分钟内重复查询直接读本地；接口失败时用旧缓存兜底"""
    addr = norm_addr(chain, address)
    limit = max(10, min(int(limit), 2000))
    data, cached_at, stale = disk_cached("transfers", f"{chain}|{addr}|{limit}|{kind}", max_age,
                                         lambda: fetch_transfers(chain, addr, limit, kind))
    if cached_at:
        mins = max(1, round((time.time() - cached_at) / 60))
        data = {**data, "cached_at": int(cached_at), "warnings": data["warnings"] + [
            f"接口暂时不可用，显示的是 {mins} 分钟前的本地缓存" if stale else
            f"使用了 {mins} 分钟前的本地缓存（按住 Shift 点“开始分析”可强制刷新）"]}
    return data


def fetch_transfers(chain, addr, limit, kind="all"):
    """kind: all | native | token。前端分两批请求，先到先画，体感更快。"""
    px = prices()
    t = chain_type(chain)
    if t == "evm":
        rows, warnings = evm_transfers(chain, addr, limit, px, kind)
    elif t == "tron":
        rows, warnings = tron_transfers(addr, limit, px, kind)
    elif kind == "token":
        rows, warnings = [], []  # BTC 没有代币
    else:
        rows, warnings = btc_transfers(addr, limit, px)
    for r in rows:
        r["chain"] = chain
        r["dir"] = "self" if r["from"] == r["to"] else ("out" if r["from"] == addr else "in")
    rows.sort(key=lambda r: r["ts"], reverse=True)
    if t == "evm" and len(rows) >= limit:
        warnings.append(f"只取了最近 {limit} 笔左右，历史更早的记录可调大“获取笔数”")
    return {"chain": chain, "address": addr, "transfers": rows, "warnings": warnings, "prices": px}


def get_profile(chain, address):
    addr = norm_addr(chain, address)
    return disk_cached("profile", f"{chain}|{addr}", 1800, lambda: fetch_profile(chain, addr))[0]


def fetch_profile(chain, addr):
    px = prices()
    t = chain_type(chain)
    if t == "evm":
        p = evm_profile(chain, addr, px)
    elif t == "tron":
        p = tron_profile(addr, px)
    else:
        p = btc_profile(addr, px)
    return {"chain": chain, "address": addr, **p}


def watch_key(item):
    return f"{item['chain']}:{item['address']}"


FLOW_WINDOWS = (("24h", 86400), ("7d", 7 * 86400))
FLOW_TTL = 600
_flow = {"ts": 0, "rows": [], "totals": {}, "running": False, "errors": []}
_flow_lock = threading.Lock()


def net_flow(transfers, now):
    """一个地址最近 24 小时 / 7 天的美元流入、流出、净流入和笔数（只算已验证且能定价的转账）"""
    out = {}
    for name, secs in FLOW_WINDOWS:
        fi = fo = 0.0
        n = 0
        for r in transfers:
            if not r.get("verified") or r.get("usd") is None or r["ts"] < now - secs:
                continue
            n += 1
            if r["dir"] == "in":
                fi += r["usd"]
            elif r["dir"] == "out":
                fo += r["usd"]
        out[f"in_{name}"], out[f"out_{name}"], out[f"net_{name}"], out[f"n_{name}"] = fi, fo, fi - fo, n
    return out


def compute_flow():
    """监控列表里每个地址的净流向 + 全部合计。转账走缓存（10 分钟内不重复拉）"""
    with _store_lock:
        items = load_json("watchlist.json", [])
    now = time.time()
    rows, errors = [], []
    for item in items:
        try:
            data = get_transfers(item["chain"], item["address"], 200, max_age=FLOW_TTL)
        except ApiError as e:
            errors.append(f"{item.get('label') or item['address'][:10]}: {str(e)[:60]}")
            continue
        rows.append({"chain": item["chain"], "address": item["address"], "label": item.get("label") or "", **net_flow(data["transfers"], now)})
    totals = {k: sum(r[k] for r in rows) for k in rows[0] if k.startswith(("in_", "out_", "net_", "n_"))} if rows else {}
    rows.sort(key=lambda r: -abs(r["net_24h"]))
    return {"ts": int(now), "rows": rows, "totals": totals, "errors": errors[:5], "wallets": len(items)}


def _flow_job():
    try:
        out = compute_flow()
        with _flow_lock:
            _flow.update(out)
    except Exception as e:  # noqa: BLE001
        with _flow_lock:
            _flow.update(errors=[f"{type(e).__name__}: {e}"[:120]], ts=int(time.time()))
    finally:
        _flow["running"] = False


def start_flow():
    with _flow_lock:
        if _flow["running"]:
            return False
        _flow["running"] = True
        if not _flow["ts"]:
            with _store_lock:
                _flow["wallets"] = len(load_json("watchlist.json", []))  # 第一次先把地址数给页面看
    threading.Thread(target=_flow_job, daemon=True).start()
    return True


def refresh_watchlist(only_key=None):
    """刷新监控列表；传入 only_key（"链:地址"）时只刷新这一个，便于前端并行刷新并显示进度。"""
    with _store_lock:
        items = load_json("watchlist.json", [])
    if only_key:
        items = [i for i in items if watch_key(i) == only_key]
    events, results = [], []
    for item in items:
        res = {"key": watch_key(item), "error": None, "new_count": 0}
        try:
            data = get_transfers(item["chain"], item["address"], 50, max_age=60)
            last_ts = item.get("last_ts") or 0
            threshold = float(item.get("threshold_usd") or 0)
            for r in data["transfers"]:
                if not r["verified"]:
                    continue
                r["watch"] = {"label": item.get("label"), "address": item["address"], "chain": item["chain"]}
                r["is_new"] = r["ts"] > last_ts and last_ts > 0
                r["is_big"] = threshold > 0 and (r["usd"] or 0) >= threshold
                res["new_count"] += r["is_new"]
                events.append(r)
            if data["transfers"]:
                item["last_ts"] = max(last_ts, data["transfers"][0]["ts"])
        except ApiError as e:
            res["error"] = str(e)
        item["last_checked"] = int(time.time())
        results.append(res)
    with _store_lock:
        # 合并回去，避免覆盖刷新期间用户新增/删除的条目
        current = {watch_key(i): i for i in load_json("watchlist.json", [])}
        for item in items:
            if watch_key(item) in current:
                current[watch_key(item)].update({"last_ts": item.get("last_ts"), "last_checked": item["last_checked"]})
        save_json("watchlist.json", list(current.values()))
    events.sort(key=lambda r: r["ts"], reverse=True)
    return {"results": results, "events": events[:500]}


# ---------------------------------------------------------------- 聪明钱：交易表现分析（EVM）
# 思路：同一笔交易里“付出计价资产（原生币 / 稳定币 / WETH）+ 收到其他代币”= 买入，反过来 = 卖出。
# 计价资产按交易当天价格折算美元，再按平均成本法算每个代币的已实现 / 未实现盈亏和胜率。

DEX_CHAIN = {"eth": "ethereum", "bsc": "bsc", "polygon": "polygon", "arbitrum": "arbitrum", "base": "base", "optimism": "optimism"}
NATIVE_PRICE_ID = {"ETH": "ethereum", "BNB": "binancecoin", "POL": "polygon-ecosystem-token"}


def native_history(sym):
    """原生币近 365 天日线价格 {日期(UTC 天): 价格}"""
    cid = NATIVE_PRICE_ID.get(sym)
    if not cid:
        return {}
    # 存一份到磁盘：重启后不必重新请求；CoinGecko 免费接口限流时用旧数据（再不行就退回现价）
    with _store_lock:
        disk = load_json("price_history.json", {})
    old = disk.get(sym)
    if old and time.time() - old["t"] < 6 * 3600:
        return {int(k): v for k, v in old["p"].items()}
    try:
        d = http_json(f"https://api.coingecko.com/api/v3/coins/{cid}/market_chart?vs_currency=usd&days=365&interval=daily", ttl=6 * 3600)
    except ApiError:
        return {int(k): v for k, v in old["p"].items()} if old else {}
    hist = {int(ts // 86400000): p for ts, p in d.get("prices", [])}
    with _store_lock:
        disk = load_json("price_history.json", {})
        disk[sym] = {"t": time.time(), "p": hist}
        save_json("price_history.json", disk)
    return hist


def dex_prices(chain, contracts):
    """DexScreener 当前价格：每个代币取流动性最大的交易对 {合约: {price, liq, name}}"""
    cid, out = DEX_CHAIN.get(chain), {}
    if not cid:
        return out
    contracts = list(contracts)
    for i in range(0, len(contracts), 30):
        try:
            pairs = http_json(f"https://api.dexscreener.com/tokens/v1/{cid}/" + ",".join(contracts[i:i + 30]), ttl=300)
        except ApiError:
            continue
        for p in pairs if isinstance(pairs, list) else []:
            c = (p.get("baseToken") or {}).get("address", "").lower()
            liq = (p.get("liquidity") or {}).get("usd") or 0
            if c and p.get("priceUsd") and liq > out.get(c, {}).get("liq", -1):
                chg, txn = p.get("priceChange") or {}, (p.get("txns") or {}).get("h24") or {}
                out[c] = {"price": float(p["priceUsd"]), "liq": liq, "name": p["baseToken"].get("name"), "fdv": p.get("fdv"),
                          "created": (p.get("pairCreatedAt") or 0) // 1000 or None, "chg": {k: chg.get(k) for k in ("m5", "h1", "h6", "h24")},
                          "vol24": (p.get("volume") or {}).get("h24"), "buys24": txn.get("buys"), "sells24": txn.get("sells")}
    return out


def evm_trades(chain, data):
    """从一个地址的转账里还原 DEX 买卖：返回 (按时间排序的买卖列表, 跳过的代币互换笔数)"""
    native = CHAINS[chain]["native"]
    known = KNOWN_TOKENS.get(chain, {})
    hist = native_history(native)
    px_now = data["prices"]

    def native_px(ts):
        if not hist:
            return px_now.get(native) or 0
        day = ts // 86400
        return hist.get(day) or hist.get(day - 1) or hist[min(hist, key=lambda d: abs(d - day))]

    def quote_usd(r):
        """计价资产 → 交易时的美元价值；不是计价资产返回 None"""
        if r["token"] == "native":
            return r["amount"] * native_px(r["ts"])
        k = known.get(r["token"])
        if k and k[1] == "USD":
            return r["amount"]
        if k and k[1] == native:  # WETH / WBNB
            return r["amount"] * native_px(r["ts"])
        return None

    by_tx = {}
    for r in data["transfers"]:
        if r["dir"] in ("in", "out"):
            by_tx.setdefault(r["hash"], []).append(r)

    trades, swaps = [], 0
    for h, legs in by_tx.items():
        q_in = q_out = 0.0
        t_in, t_out = {}, {}
        for r in legs:
            q = quote_usd(r)
            if q is not None:
                if r["dir"] == "in":
                    q_in += q
                else:
                    q_out += q
            else:
                bucket = t_in if r["dir"] == "in" else t_out
                b = bucket.setdefault(r["token"], {"qty": 0.0, "symbol": r["symbol"]})
                b["qty"] += r["amount"]
        ts = legs[0]["ts"]
        if t_in and t_out:
            swaps += 1  # 代币换代币，无法直接定价，跳过
            continue
        if t_in and q_out >= 1 and not t_out:
            for tok, b in t_in.items():
                trades.append({"ts": ts, "side": "buy", "token": tok, "symbol": b["symbol"], "qty": b["qty"], "usd": (q_out - q_in) / len(t_in), "hash": h})
        elif t_out and q_in >= 1 and not t_in:
            for tok, b in t_out.items():
                trades.append({"ts": ts, "side": "sell", "token": tok, "symbol": b["symbol"], "qty": b["qty"], "usd": (q_in - q_out) / len(t_out), "hash": h})
    # 其他稳定币（crvUSD、USDe、GHO……）换来换去不算交易
    stable = re.compile(r"USD|^DAI$|^GHO$|^FRAX$|^LUSD$|EUR", re.I)
    trades = [t for t in trades if t["usd"] > 0 and not stable.search(t["symbol"] or "")]
    trades.sort(key=lambda t: t["ts"])

    return trades, swaps


def smart_analyze(chain, address, limit=1000, save=True):
    if chain_type(chain) != "evm":
        raise ApiError("交易表现分析目前只支持 EVM 链（Ethereum / Polygon / Arbitrum 等）")
    data = get_transfers(chain, address, limit)
    addr = data["address"]
    trades, swaps = evm_trades(chain, data)

    pos = {}
    for t in trades:
        p = pos.setdefault(t["token"], {"token": t["token"], "symbol": t["symbol"], "bq": 0.0, "cost": 0.0, "sq": 0.0, "proceeds": 0.0,
                                        "buys": 0, "sells": 0, "first": t["ts"], "last": t["ts"], "last_sell": None})
        p["last"] = t["ts"]
        if t["side"] == "buy":
            p["bq"] += t["qty"]; p["cost"] += t["usd"]; p["buys"] += 1
        else:
            p["sq"] += t["qty"]; p["proceeds"] += t["usd"]; p["sells"] += 1; p["last_sell"] = t["ts"]

    live = dex_prices(chain, [k for k, p in pos.items() if p["bq"] > p["sq"]])
    rows = []
    for k, p in pos.items():
        if p["bq"] <= 0:
            continue  # 只卖不买（空投、转入后卖出）不计入交易表现
        avg = p["cost"] / p["bq"]
        matched = min(p["sq"], p["bq"])
        proceeds = p["proceeds"] * (matched / p["sq"]) if p["sq"] else 0.0
        realized = proceeds - avg * matched
        remain = max(0.0, p["bq"] - p["sq"])
        lp = live.get(k)
        value = remain * lp["price"] if lp and remain else (0.0 if not remain else None)
        unreal = value - avg * remain if value is not None else None
        closed = p["sq"] >= p["bq"] * 0.95
        rows.append({"token": k, "symbol": p["symbol"], "name": (lp or {}).get("name"), "buys": p["buys"], "sells": p["sells"],
                     "cost": p["cost"], "proceeds": p["proceeds"], "realized": realized, "unrealized": unreal, "value": value,
                     "roi": ((realized + (unreal or 0)) / p["cost"] * 100) if p["cost"] else None,
                     "first": p["first"], "last_sell": p["last_sell"], "hold": (p["last_sell"] - p["first"]) if closed and p["last_sell"] else None,
                     "status": "closed" if closed else ("partial" if p["sq"] else "holding"), "price": (lp or {}).get("price")})
    rows.sort(key=lambda r: r["realized"] + (r["unrealized"] or 0), reverse=True)

    sold = [r for r in rows if r["sells"]]
    wins = [r for r in sold if r["realized"] > 0]
    invested = sum(r["cost"] for r in rows)
    realized = sum(r["realized"] for r in rows)
    unreal = sum(r["unrealized"] or 0 for r in rows)
    holds = [r["hold"] for r in rows if r["hold"]]
    win_rate = len(wins) / len(sold) if sold else None
    roi = (realized + unreal) / invested * 100 if invested else None

    # 综合评分：胜率 40 + 收益率 25 + 盈利规模 20 + 样本量 15；整体亏损时减半
    clamp = lambda x: max(0.0, min(1.0, x))
    score = (40 * (win_rate or 0) * clamp(len(sold) / 3) + 25 * clamp((roi or 0) / 100)
             + 20 * clamp(math.log10(max(realized, 1)) / 6) + 15 * clamp(len(sold) / 20))
    if realized + unreal <= 0:
        score *= 0.5
    score = round(score)
    grade = "S" if score >= 80 else "A" if score >= 65 else "B" if score >= 50 else "C" if score >= 35 else "D"
    bot = bot_signals(chain, addr, trades, holds)
    median_buy = _median([t["usd"] for t in trades if t["side"] == "buy"])
    summary = {"chain": chain, "address": addr, "score": score, "grade": grade, "win_rate": win_rate, "tokens": len(rows),
               "sold_tokens": len(sold), "wins": len(wins), "trades": len(trades), "swaps_skipped": swaps,
               "invested": invested, "realized": realized, "unrealized": unreal, "roi": roi,
               "avg_hold": sum(holds) / len(holds) if holds else None,
               "first_trade": trades[0]["ts"] if trades else None, "last_trade": trades[-1]["ts"] if trades else None,
               "median_buy": median_buy,
               # 聪明钱：评分 A 级以上、卖出样本够、不是机器人，而且是“真金白银”在交易（单笔中位数 ≥ $100、总投入 ≥ $2,000）
               "smart": score >= 65 and len(sold) >= 5 and not bot["likely"] and (median_buy or 0) >= 100 and invested >= 2000,
               "bot": bot, "analyzed": int(time.time())}
    with _store_lock:
        board = load_json("smart.json", {})
        if trades and save:
            board[f"{chain}:{addr}"] = summary
            save_json("smart.json", board)
    return {**summary, "positions": rows[:200], "recent": list(reversed(trades))[:60], "warnings": data["warnings"],
            "transfers": len(data["transfers"])}


def is_contract(chain, addr):
    if CHAINS[chain].get("free_api"):
        return False  # 区块浏览器接口没有 eth_getCode，跳过这一条特征
    key = config()["etherscan_key"]
    url = (f"https://api.etherscan.io/v2/api?chainid={CHAINS[chain]['chainid']}&module=proxy&action=eth_getCode"
           f"&address={addr}&tag=latest&apikey={urllib.parse.quote(key)}")
    if not is_cached(url, 86400):
        etherscan_limiter.wait()
    code = http_json(url, ttl=86400).get("result")
    return isinstance(code, str) and code.startswith("0x") and len(code) > 2  # 出错时 result 是一段说明文字，不能当成合约


def bot_signals(chain, addr, trades, holds):
    """机器人嫌疑：合约地址、持仓极短、交易极频繁、同一分钟内连续成交、同时追很多新币。满足 2 条及以上判为疑似机器人"""
    reasons, pts = [], 0
    try:
        if is_contract(chain, addr):
            pts += 1
            reasons.append("地址是合约（交易机器人常用；多签钱包也可能是合约）")
    except ApiError:
        pass
    if len(holds) >= 3:
        med = _median(holds)
        if med < 600:
            pts += 1
            reasons.append(f"已清仓代币的持仓时间中位数只有 {max(1, round(med / 60))} 分钟")
    if len(trades) >= 20:
        days = len({t["ts"] // 86400 for t in trades})
        per_day = len(trades) / max(1, days)
        if per_day >= 40:
            pts += 1
            reasons.append(f"活跃日平均每天 {per_day:.0f} 笔买卖")
        minutes = {}
        for t in trades:
            minutes[t["ts"] // 60] = minutes.get(t["ts"] // 60, 0) + 1
        burst = sum(c for c in minutes.values() if c >= 3) / len(trades)
        if burst >= 0.4:
            pts += 1
            reasons.append(f"{burst * 100:.0f}% 的买卖发生在同一分钟内连续成交")
    buys = [t["usd"] for t in trades if t["side"] == "buy"]
    if len(buys) >= 20 and _median(buys) < 20:
        pts += 1
        reasons.append(f"大量微额买入（单笔中位数只有 ${_median(buys):.0f}，像撸毛或狙击脚本）")
    tokens = {t["token"] for t in trades}
    if len(tokens) >= 30 and holds and sum(holds) / len(holds) < 3600:
        pts += 1
        reasons.append(f"交易过 {len(tokens)} 个代币且平均持仓不到 1 小时（狙击 / 刷单特征）")
    return {"likely": pts >= 2, "points": pts, "reasons": reasons}


# ---------------------------------------------------------------- 从代币发现聪明钱
# 拉一个代币最早（或最近）的 1000 笔转账，找出从交易池 / 路由买入的钱包，逐个做交易表现分析并排序。
# “市场方”= DexScreener 列出的交易对 + Uniswap v4 PoolManager + 在样本里转给很多不同地址的发送方（路由、热钱包）。

V4_POOL_MANAGER = {"eth": "0x000000000004444c5dc75cb358380d2e3de08a90"}
ZERO = "0x0000000000000000000000000000000000000000"
_jobs = {}


def token_info(chain, token):
    cid = DEX_CHAIN.get(chain)
    pairs = http_json(f"https://api.dexscreener.com/tokens/v1/{cid}/{token}", ttl=300) if cid else []
    pairs = pairs if isinstance(pairs, list) else []
    best = max(pairs, key=lambda p: (p.get("liquidity") or {}).get("usd") or 0, default=None)
    base = (best or {}).get("baseToken") or {}
    return {"name": base.get("name"), "symbol": base.get("symbol"), "price": float(best["priceUsd"]) if best and best.get("priceUsd") else None,
            "liquidity": ((best or {}).get("liquidity") or {}).get("usd"), "fdv": (best or {}).get("fdv"),
            "created": ((best or {}).get("pairCreatedAt") or 0) // 1000 or None, "dex": (best or {}).get("dexId"),
            "pairs": [p["pairAddress"].lower() for p in pairs if str(p.get("pairAddress", "")).startswith("0x") and len(p["pairAddress"]) == 42]}


def discover_job(job, chain, token, mode, n):
    try:
        job["stage"] = "token"
        info = token_info(chain, token)
        job["token"] = {k: v for k, v in info.items() if k != "pairs"}
        rows = etherscan(chain, {"module": "account", "action": "tokentx", "contractaddress": token, "page": 1, "offset": 1000,
                                 "sort": "asc" if mode == "early" else "desc"})
        if not rows:
            raise ApiError("没有找到这个代币的转账记录，请确认合约地址和所在链")
        if mode != "early":
            rows = list(reversed(rows))  # 统一按时间正序处理
        receivers = {}
        for r in rows:
            receivers.setdefault(r["from"].lower(), set()).add(r["to"].lower())
        market = set(info["pairs"]) | {V4_POOL_MANAGER.get(chain, ""), ZERO, token}
        market |= {a for a, tos in receivers.items() if len(tos) >= 15}
        with _store_lock:
            labels = load_json("labels.json", {})
        skip_cat = {"交易所", "合约", "做市商", "混币器"}
        buyers = {}
        for r in rows:
            f, t = r["from"].lower(), r["to"].lower()
            if f not in market or t in market or (labels.get(f"evm:{t}") or {}).get("category") in skip_cat:
                continue
            dec = int(r.get("tokenDecimal") or 0)
            b = buyers.setdefault(t, {"first": int(r["timeStamp"]), "rank": len(buyers) + 1, "buys": 0, "qty": 0.0})
            b["buys"] += 1
            b["qty"] += int(r["value"]) / 10 ** dec if r.get("value") else 0
        if mode == "early":
            cands = sorted(buyers.items(), key=lambda kv: kv[1]["rank"])[:n]
        else:
            cands = sorted(buyers.items(), key=lambda kv: (kv[1]["buys"], kv[1]["qty"]), reverse=True)[:n]
        job.update(stage="wallets", total=len(cands), sample=len(rows), buyers=len(buyers),
                   span=[int(rows[0]["timeStamp"]), int(rows[-1]["timeStamp"])])
        for addr, b in cands:
            if job.get("cancel"):
                break
            job["current"] = addr
            try:
                res = smart_analyze(chain, addr, 1000, save=False)
            except ApiError as e:
                job["results"].append({"address": addr, "error": str(e)[:160], **b})
                job["done"] += 1
                continue
            pos = next((p for p in res["positions"] if p["token"] == token), None)
            summary = {k: v for k, v in res.items() if k not in ("positions", "recent", "warnings", "transfers")}
            if res["trades"] and res["score"] >= 50 and not res["bot"]["likely"]:  # B 级以上、非机器人自动进排行榜
                with _store_lock:
                    board = load_json("smart.json", {})
                    board[f"{chain}:{res['address']}"] = summary
                    save_json("smart.json", board)
            job["results"].append({**summary, **b, "token_pnl": (pos["realized"] + (pos["unrealized"] or 0)) if pos else None,
                                   "token_roi": pos["roi"] if pos else None, "token_status": pos["status"] if pos else None})
            job["done"] += 1
        job["stage"] = "done"
    except ApiError as e:
        job.update(stage="error", error=str(e))
    except Exception as e:  # noqa: BLE001
        job.update(stage="error", error=f"{type(e).__name__}: {e}")


# ---------------- 批量导入：粘贴一段文字（排行榜网页、表格、地址列表都行），提取所有地址批量评分

IMPORT_MAX = 60


def import_job(job, chain, addrs):
    try:
        job.update(stage="wallets", total=len(addrs))
        for addr in addrs:
            if job.get("cancel"):
                break
            job["current"] = addr
            try:
                res = smart_analyze(chain, addr, 1000, save=False)
            except ApiError as e:
                job["results"].append({"address": addr, "chain": chain, "error": str(e)[:160]})
                job["done"] += 1
                continue
            summary = {k: v for k, v in res.items() if k not in ("positions", "recent", "warnings", "transfers")}
            if res["trades"] and res["score"] >= 50 and not res["bot"]["likely"]:  # 和“从代币发现”同一标准进排行榜
                with _store_lock:
                    board = load_json("smart.json", {})
                    board[f"{chain}:{res['address']}"] = summary
                    save_json("smart.json", board)
            job["results"].append(summary)
            job["done"] += 1
        job["stage"] = "done"
    except Exception as e:  # noqa: BLE001
        job.update(stage="error", error=f"{type(e).__name__}: {e}")


def start_import(chain, text):
    if chain_type(chain) != "evm":
        raise ApiError("交易表现分析目前只支持 EVM 链（Ethereum / Polygon / Arbitrum / Optimism 等）")
    found = list(dict.fromkeys(a.lower() for a in re.findall(r"0x[0-9a-fA-F]{40}", text or "")))
    if not found:
        raise ApiError("没有在粘贴的内容里找到 0x 开头的钱包地址")
    with _store_lock:
        labels = load_json("labels.json", {})
    skip_cat = {"交易所", "合约", "做市商", "混币器"}
    addrs = [a for a in found if (labels.get(f"evm:{a}") or {}).get("category") not in skip_cat][:IMPORT_MAX]
    for j in list(_jobs.values()):
        j["cancel"] = True
    jid = hashlib.sha1(f"import{time.time()}".encode()).hexdigest()[:10]
    job = {"id": jid, "chain": chain, "mode": "import", "stage": "start", "done": 0, "total": len(addrs), "results": [],
           "found": len(found), "skipped_known": len(found) - len(addrs) if len(found) <= IMPORT_MAX else None,
           "truncated": len(found) > IMPORT_MAX, "started": int(time.time())}
    _jobs.clear()
    _jobs[jid] = job
    threading.Thread(target=import_job, args=(job, chain, addrs), daemon=True).start()
    return job


def start_discover(chain, token, mode="early", n=20):
    if chain_type(chain) != "evm":
        raise ApiError("交易表现分析目前只支持 EVM 链（Ethereum / Polygon / Arbitrum 等）")
    token = token.strip().lower()
    if not ADDR_RE["evm"].match(token):
        raise ApiError("请输入代币的合约地址（0x 开头的 42 位）")
    for j in list(_jobs.values()):  # 同时只跑一个，旧的标记取消
        j["cancel"] = True
    jid = hashlib.sha1(f"{chain}{token}{time.time()}".encode()).hexdigest()[:10]
    job = {"id": jid, "chain": chain, "token_addr": token, "mode": mode, "stage": "start", "done": 0, "total": 0, "results": [], "started": int(time.time())}
    _jobs.clear()
    _jobs[jid] = job
    threading.Thread(target=discover_job, args=(job, chain, token, mode, max(5, min(int(n), 40))), daemon=True).start()
    return job


# ---------------------------------------------------------------- 后台巨鲸提醒
# 服务运行期间按设定间隔检查监控列表，发现新的大额转账就发 macOS 通知；网页不用开着。
# 用单独的 alert_ts 记录“已提醒到哪”，不影响网页里“新”标记的判断。

ALERT_TEXT = {
    "zh": {"title": "区块侦探 · 巨鲸大额", "in": "流入", "out": "流出", "more": "另有 {n} 笔大额，打开区块侦探查看", "test": "测试通知：后台提醒工作正常",
           "smart_title": "区块侦探 · 聪明钱买入", "buy": "买入", "first": "（首次）", "smart_more": "另有 {n} 笔聪明钱买入"},
    "ja": {"title": "ブロック探偵 · 大口検知", "in": "入金", "out": "出金", "more": "他に大口 {n} 件。ブロック探偵で確認してください", "test": "テスト通知：バックグラウンド通知は正常です",
           "smart_title": "ブロック探偵 · スマートマネー購入", "buy": "購入", "first": "（初回）", "smart_more": "他にスマートマネーの購入 {n} 件"},
    "en": {"title": "Block Detective · Whale alert", "in": "in", "out": "out", "more": "{n} more large transfers — open Block Detective", "test": "Test notification: background alerts are working",
           "smart_title": "Block Detective · Smart money buy", "buy": "bought", "first": " (first buy)", "smart_more": "{n} more smart money buys"},
}
_alert = {"last_run": None, "last_error": None, "next_run": 0, "running": False}
_alert_lock = threading.Lock()


def alert_settings():
    cfg = load_json("config.json", {})
    return {"enabled": bool(cfg.get("alert_enabled")), "interval": int(cfg.get("alert_interval") or 15),
            "lang": cfg.get("alert_lang") or "ja", "sound": cfg.get("alert_sound", True),
            "smart_enabled": cfg.get("smart_alert", True), "smart_min": float(cfg.get("smart_min") or 1000),
            "smart_first_only": bool(cfg.get("smart_first_only"))}


def smart_wallets():
    """标签分类为“聪明钱”的钱包；EVM 标签不分链，优先用排行榜里分析过的那条链，否则默认 Ethereum"""
    with _store_lock:
        labels = load_json("labels.json", {})
        board = load_json("smart.json", {})
    out = []
    for key, lbl in labels.items():
        if lbl.get("category") != "聪明钱" or not key.startswith("evm:"):
            continue
        addr = key[4:]
        chain = next((v["chain"] for v in board.values() if v["address"] == addr), "eth")
        out.append({"chain": chain, "address": addr, "label": lbl.get("label") or "", "labeled": True})
    hook("smart_wallets", out, board)  # 扩展可以往列表里追加钱包（例如排行榜里评级够高的）
    return out


def check_smart_buys(st, errors):
    """聪明钱：和上次检查相比新出现的买卖。返回 (要提醒的买入, 全部新买卖事件——给模拟跟单用)"""
    with _store_lock:
        marks = load_json("smart_alerts.json", {})
    found, events = [], []
    for w in smart_wallets():
        key = f"{w['chain']}:{w['address']}"
        try:
            data = get_transfers(w["chain"], w["address"], 200, max_age=60)
            trades, _ = evm_trades(w["chain"], data)
        except ApiError as e:
            errors.append(f"{w['label'] or w['address'][:10]}: {e}")
            continue
        if not data["transfers"]:
            continue
        mark = marks.get(key)
        legacy = isinstance(mark, (int, float))
        if legacy:  # 兼容旧格式（只有时间戳）：旧位置之前的交易都算已处理
            mark = {"ts": mark, "seen": {}}
        since = (mark or {}).get("ts")
        done_ids = dict((mark or {}).get("seen") or {})  # 交易 id -> 时间，只保留最近 1 小时内的
        if legacy:
            done_ids.update({f"{t['hash']}|{t['token']}|{t['side']}": t["ts"] for t in trades if t["ts"] <= since})
        partial = any("内部交易获取失败" in w for w in data["warnings"])
        if since:  # 第一次只记录位置
            seen = set()
            for t in trades:
                first = t["token"] not in seen
                if t["side"] == "buy":
                    seen.add(t["token"])
                tid = f"{t['hash']}|{t['token']}|{t['side']}"
                # Etherscan 的内部交易（卖出时收到的 ETH）常常晚几分钟才入库：每次回看 30 分钟，按交易去重
                if t["ts"] <= since - 1800 or tid in done_ids:
                    continue
                done_ids[tid] = t["ts"]
                events.append({**t, "chain": w["chain"], "address": w["address"], "label": w["label"], "first": first,
                               "copy": w.get("copy", True)})
                if not w["labeled"] or t["side"] != "buy" or t["usd"] < st["smart_min"] or (st["smart_first_only"] and not first):
                    continue
                found.append({"type": "smart_buy", "ts": t["ts"], "chain": w["chain"], "address": w["address"], "label": w["label"],
                              "dir": "in", "usd": t["usd"], "symbol": t["symbol"], "amount": t["qty"], "token": t["token"],
                              "hash": t["hash"], "first": first})
        new_ts = since if partial and since else max(since or 0, max(r["ts"] for r in data["transfers"]))
        if not since:  # 第一次：回看窗口里已有的交易都记为“已处理”，下次不会被当成新信号
            done_ids.update({f"{t['hash']}|{t['token']}|{t['side']}": t["ts"] for t in trades if t["ts"] > new_ts - 3600})
        # 这次内部交易没取到时不推进位置，下次重新看（已处理的交易靠 seen 去重）
        marks[key] = {"ts": new_ts, "seen": {k: v for k, v in done_ids.items() if v > new_ts - 3600}}
    with _store_lock:
        save_json("smart_alerts.json", marks)
    return found, events


def _median(xs):
    if not xs:
        return None
    s, n = sorted(xs), len(xs)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def notify(title, text, sound=True):
    """发通知：macOS 系统通知（osascript），以及设置里填了 Webhook 时推送到 Telegram / Discord / Slack / 自定义地址。
    Webhook 在后台线程里发，不拖慢提醒检查；结果记在 _webhook 里给设置页看"""
    if sys.platform == "darwin":
        q = lambda x: '"' + str(x).replace("\\", "\\\\").replace('"', '\\"') + '"'
        script = f"display notification {q(text)} with title {q(title)}" + (' sound name "Glass"' if sound else "")
        try:
            subprocess.run(["osascript", "-e", script], timeout=10, check=False, capture_output=True)
        except (OSError, subprocess.SubprocessError):
            pass
    url = config().get("webhook_url")
    if url:
        t = threading.Thread(target=webhook_send, args=(url, title, text), daemon=True)
        _webhook["thread"] = t
        t.start()


_webhook = {"sent": 0, "last_ok": None, "last_error": None, "thread": None, "retries": 0}
WEBHOOK_RETRY_DELAY = 30  # 第一次失败（网络抖动、对方 5xx）后过 30 秒再试一次


def webhook_kind(url):
    host = (urllib.parse.urlparse(url).netloc or "").lower()
    path = urllib.parse.urlparse(url).path
    if host == "api.telegram.org" and path.endswith("/sendMessage"):
        return "telegram"
    if host in ("discord.com", "discordapp.com") and "/api/webhooks/" in path:
        return "discord"
    if host == "hooks.slack.com":
        return "slack"
    return "generic"


def webhook_payload(url, title, text):
    """按目标服务的格式组装消息体（都是 JSON）"""
    kind = webhook_kind(url)
    if kind == "telegram":
        return {"text": f"{title}\n{text}", "disable_web_page_preview": True}
    if kind == "discord":
        return {"content": f"**{title}**\n{text}"}
    if kind == "slack":
        return {"text": f"*{title}*\n{text}"}
    return {"title": title, "text": text, "source": "block-detective", "ts": int(time.time())}


def check_webhook_url(url):
    """只接受 https://，本机地址（127.0.0.1 / localhost）允许 http:// 方便自建接收端；Telegram 地址必须带 chat_id"""
    u = urllib.parse.urlparse(url)
    host = (u.hostname or "").lower()
    if u.scheme == "http" and host in ("127.0.0.1", "localhost", "::1"):
        pass
    elif u.scheme != "https" or not host:
        raise ApiError("Webhook 地址必须以 https:// 开头")
    if webhook_kind(url) == "telegram" and "chat_id=" not in (u.query or ""):
        raise ApiError("Telegram 地址要带上 chat_id，例如 https://api.telegram.org/bot<token>/sendMessage?chat_id=<你的 chat_id>")
    return url


def webhook_send(url, title, text, retry=True):
    body = json.dumps(webhook_payload(url, title, text), ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json", "User-Agent": UA}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            r.read(1024)
        _webhook["sent"] += 1
        _webhook["last_ok"] = int(time.time())
        _webhook["last_error"] = None
        return True
    except (urllib.error.URLError, OSError, ValueError) as e:
        msg = str(getattr(e, "reason", None) or e)
        if isinstance(e, urllib.error.HTTPError):
            msg = f"HTTP {e.code}"
        _webhook["last_error"] = f"{time.strftime('%H:%M')} {msg}"[:160]
        if retry and not (isinstance(e, urllib.error.HTTPError) and 400 <= e.code < 500 and e.code != 429):
            # 4xx（除 429）是地址或格式问题，重试也没用；其他情况过一会儿再试一次
            _webhook["retries"] += 1
            t = threading.Timer(WEBHOOK_RETRY_DELAY, webhook_send, args=(url, title, text, False))
            t.daemon = True
            _webhook["thread"] = t
            t.start()
        return False


def fmt_usd(v):
    v = v or 0
    for unit, n in (("B", 1e9), ("M", 1e6), ("K", 1e3)):
        if v >= n:
            return f"${v / n:.1f}{unit}"
    return f"${v:,.0f}"


WATCH_DIRECTIONS = ("all", "in", "out")


def watch_tokens(v):
    """监控规则里的代币名单：接受 "USDT, ETH" 或列表，统一大写去重，最多 20 个；空表示不限"""
    if isinstance(v, str):
        v = v.replace("，", ",").split(",")
    if not isinstance(v, list):
        raise ApiError("tokens 要是代币符号列表")
    out = []
    for t in v:
        t = str(t).strip().upper()
        if t and t not in out:
            out.append(t)
    if len(out) > 20:
        raise ApiError("代币名单最多 20 个")
    return out


def alert_match(item, r):
    """监控规则：金额 ≥ 阈值（阈值为 0 不提醒）、方向符合（all / in / out）、代币在名单里（名单为空不限）"""
    threshold = float(item.get("threshold_usd") or 0)
    if threshold <= 0 or (r.get("usd") or 0) < threshold:
        return False
    d = item.get("direction") or "all"
    if d != "all" and r.get("dir") != d:
        return False
    toks = item.get("tokens") or []
    return not toks or (r.get("symbol") or "").upper() in toks


def run_alerts(background=False):
    """检查一遍监控列表，返回本次新发现的大额转账。
    background=True 且只开了跟单机器人（没开后台提醒）时：只跑机器人，不查巨鲸、不发通知"""
    if not _alert_lock.acquire(blocking=False):
        return []
    try:
        _alert["running"] = True
        st = alert_settings()
        T = ALERT_TEXT.get(st["lang"], ALERT_TEXT["ja"])
        alerts_on = st["enabled"] or not background
        with _store_lock:
            items = load_json("watchlist.json", []) if alerts_on else []
        found, marks, errors = [], {}, []
        smart, events = check_smart_buys(st, errors) if st["smart_enabled"] or hook_any("background_wanted") else ([], [])
        if not st["smart_enabled"] or not alerts_on:
            smart = []  # 只给模拟跟单用，不发通知
        for name, fn in hook_fns("smart_events"):
            try:
                fn(events)
            except Exception as e:  # noqa: BLE001 — 扩展出错不影响提醒
                errors.append(f"{name}: {e}")
        for item in items:
            try:
                data = get_transfers(item["chain"], item["address"], 50, max_age=60)
            except ApiError as e:
                errors.append(f"{item.get('label') or item['address'][:10]}: {e}")
                continue
            rows = [r for r in data["transfers"] if r["verified"]]
            if not rows:
                continue
            since = item.get("alert_ts")
            newest = max(r["ts"] for r in rows)
            if since:  # 第一次运行只记录位置，不把历史转账当成新提醒
                for r in rows:
                    if r["ts"] > since and alert_match(item, r):
                        found.append({"ts": r["ts"], "chain": item["chain"], "address": item["address"], "label": item.get("label") or "",
                                      "dir": r["dir"], "usd": r["usd"], "symbol": r["symbol"], "amount": r["amount"], "hash": r["hash"]})
            marks[watch_key(item)] = max(since or 0, newest)
        with _store_lock:
            current = load_json("watchlist.json", [])
            for i in current:
                if watch_key(i) in marks:
                    i["alert_ts"] = marks[watch_key(i)]
            save_json("watchlist.json", current)
            if found or smart:
                hist = load_json("alerts.json", [])
                save_json("alerts.json", (sorted(found + smart, key=lambda r: r["ts"], reverse=True) + hist)[:300])
        found.sort(key=lambda r: r["usd"] or 0, reverse=True)
        for r in found[:3]:
            who = r["label"] or (r["address"][:6] + "…" + r["address"][-4:])
            notify(T["title"], f"{who} {T[r['dir']] if r['dir'] in T else r['dir']} {fmt_usd(r['usd'])} {r['symbol']}", st["sound"])
        if len(found) > 3:
            notify(T["title"], T["more"].format(n=len(found) - 3), False)
        smart.sort(key=lambda r: r["usd"] or 0, reverse=True)
        for r in smart[:3]:
            who = r["label"] or (r["address"][:6] + "…" + r["address"][-4:])
            notify(T["smart_title"], f"{who} {T['buy']} {r['symbol']} {fmt_usd(r['usd'])}{T['first'] if r['first'] else ''}", st["sound"])
        if len(smart) > 3:
            notify(T["smart_title"], T["smart_more"].format(n=len(smart) - 3), False)
        found = found + smart
        _alert["last_run"] = int(time.time())
        _alert["last_error"] = "; ".join(errors[:3]) or None
        return found
    finally:
        _alert["running"] = False
        _alert_lock.release()


# ---------------- 每天备份 data/（到本机内置硬盘，外接硬盘坏了也不丢）

# Mac 放在“应用程序支持”，Windows 放在 %APPDATA%
BACKUP_DIR = (os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "BlockDetective", "backups") if os.name == "nt"
              else os.path.expanduser("~/Library/Application Support/BlockDetective/backups"))
BACKUP_KEEP = 14


def backup_data(force=False):
    """把 data/ 里的标签、监控、配置、排行榜、账本和研究数据库复制到 BACKUP_DIR/日期/；缓存不备份。保留最近 14 天"""
    dest = os.path.join(BACKUP_DIR, time.strftime("%Y-%m-%d"))
    if os.path.isdir(dest) and not force:
        return dest
    tmp = dest + ".tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    for name in sorted(os.listdir(DATA)):
        src = os.path.join(DATA, name)
        if name.startswith(".") or name.endswith(".tmp") or not os.path.isfile(src):
            continue  # 跳过 macOS 的 ._ 文件、临时文件和 cache 目录
        if name.endswith(".db"):  # SQLite 用在线备份接口，写入中也能得到一致的副本
            a, b = sqlite3.connect(src), sqlite3.connect(os.path.join(tmp, name))
            try:
                a.backup(b)
            finally:
                a.close()
                b.close()
        else:
            with _store_lock:
                shutil.copy2(src, tmp)
    if os.path.exists(os.path.join(tmp, "config.json")):
        os.chmod(os.path.join(tmp, "config.json"), 0o600)  # 里面有 API Key
    shutil.rmtree(dest, ignore_errors=True)
    os.replace(tmp, dest)
    days = sorted(d for d in os.listdir(BACKUP_DIR) if re.fullmatch(r"\d{4}-\d{2}-\d{2}", d))
    for d in days[:-BACKUP_KEEP]:
        shutil.rmtree(os.path.join(BACKUP_DIR, d), ignore_errors=True)
    return dest


def backup_zip(include_secrets=False):
    """把 data/ 打成一个 zip 给浏览器下载（换电脑、重装时用）。不含 cache/；config.json 里的 API Key 和 Webhook 地址默认去掉。
    SQLite 用在线备份接口拿一致的副本"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name in sorted(os.listdir(DATA)):
            src = os.path.join(DATA, name)
            if name.startswith(".") or name.endswith(".tmp") or not os.path.isfile(src):
                continue
            if name.endswith(".db"):
                tmp = src + ".export.tmp"
                a, b = sqlite3.connect(src), sqlite3.connect(tmp)
                try:
                    a.backup(b)
                finally:
                    a.close()
                    b.close()
                z.write(tmp, name)
                os.remove(tmp)
            elif name == "config.json" and not include_secrets:
                with _store_lock:
                    cfg = load_json("config.json", {})
                for k in SECRET_KEYS:
                    cfg.pop(k, None)
                z.writestr(name, json.dumps(cfg, ensure_ascii=False, indent=2))
            else:
                with _store_lock:
                    z.write(src, name)
        note = f"区块侦探 {VERSION} 数据备份 {time.strftime('%Y-%m-%d %H:%M')}\n恢复：先停止服务，把这些文件解压到 block-detective/data/ 里，再启动。\n"
        if not include_secrets:
            note += "API Key 和 Webhook 地址没有包含在内，恢复后请到设置页重新填写。\n"
        z.writestr("README.txt", note)
    return buf.getvalue()


RESTORE_MAX = 200 * 1024 * 1024
RESTORE_NAME = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]*\.(json|db)")


def restore_zip(data):
    """从“下载备份 zip”恢复：只收文件名合法的 .json / .db（忽略目录、路径、其他文件），内容要能解析；
    config.json 合并——zip 里没有的 API Key / Webhook 地址保留现有的。恢复前先把现在的数据备份一份。
    返回恢复了哪些文件；调用方应随后重启服务，让扩展重新打开数据库"""
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ApiError("不是有效的 zip 文件") from None
    entries = [i for i in z.infolist() if not i.is_dir() and RESTORE_NAME.fullmatch(i.filename)]
    if not entries:
        raise ApiError("zip 里没有可恢复的数据文件（应包含 labels.json、watchlist.json 等）")
    if sum(i.file_size for i in entries) > RESTORE_MAX:
        raise ApiError("备份解压后太大")
    files = {}
    for i in entries:
        raw = z.read(i)
        if i.filename.endswith(".json"):
            try:
                files[i.filename] = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                raise ApiError(f"{i.filename} 不是有效的 JSON") from None
        elif not raw.startswith(b"SQLite format 3\x00"):
            raise ApiError(f"{i.filename} 不是 SQLite 数据库")
        else:
            files[i.filename] = raw
    try:
        safety = backup_data(force=True)
    except OSError as e:
        raise ApiError(f"恢复前的自动备份失败，已取消恢复：{e}") from None
    with _store_lock:
        for name, content in files.items():
            if name == "config.json":
                cur = load_json("config.json", {})
                merged = dict(content) if isinstance(content, dict) else {}
                for k in SECRET_KEYS:
                    if not merged.get(k) and cur.get(k):
                        merged[k] = cur[k]
                if cur.get("secrets_in"):
                    merged["secrets_in"] = cur["secrets_in"]
                content = merged
            tmp = os.path.join(DATA, name + ".tmp")
            if isinstance(content, bytes):
                with open(tmp, "wb") as f:
                    f.write(content)
            else:
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(content, f, ensure_ascii=False, indent=2)
            os.replace(tmp, os.path.join(DATA, name))
        _secrets.clear()
    return {"restored": sorted(files), "safety_backup": safety}


def backup_status():
    try:
        days = sorted(d for d in os.listdir(BACKUP_DIR) if re.fullmatch(r"\d{4}-\d{2}-\d{2}", d))
    except OSError:
        days = []
    last = os.path.join(BACKUP_DIR, days[-1]) if days else None
    return {"dir": BACKUP_DIR, "count": len(days), "latest": days[-1] if days else None,
            "latest_ts": int(os.path.getmtime(last)) if last else None,
            "files": sorted(os.listdir(last)) if last else [], "keep": BACKUP_KEEP}


def alert_loop():
    while True:
        time.sleep(20)
        try:
            if time.time() - STARTED > 60 and not os.path.isdir(os.path.join(BACKUP_DIR, time.strftime("%Y-%m-%d"))):
                try:
                    backup_data()  # 每天第一次检查时备份一次
                except OSError as e:
                    _alert["last_error"] = f"备份失败: {e}"
            st = alert_settings()
            if not st["enabled"] and not hook_any("background_wanted"):  # 提醒关着，扩展也不需要后台检查
                _alert["next_run"] = 0
                continue
            now = time.time()
            if not _alert["next_run"]:
                _alert["next_run"] = now + 30  # 开启后 30 秒做第一次检查
            if now >= _alert["next_run"]:
                _alert["next_run"] = now + st["interval"] * 60
                run_alerts(background=True)
            hook("background_tick", now)  # 扩展的定时任务（每 20 秒一次，自己判断要不要干活）
        except Exception as e:  # noqa: BLE001 — 后台线程不能因为一次异常就退出
            _alert["last_error"] = f"{type(e).__name__}: {e}"


def alert_status():
    st = alert_settings()
    return {**st, "last_run": _alert["last_run"], "last_error": _alert["last_error"], "running": _alert["running"],
            "next_run": int(_alert["next_run"]) or None, "history": load_json("alerts.json", [])[:50],
            "started": int(STARTED), "smart_wallets": sum(w["labeled"] for w in smart_wallets()),
            "webhook": {"configured": bool(config().get("webhook_url")), "kind": webhook_kind(config().get("webhook_url") or ""),
                        "sent": _webhook["sent"], "last_ok": _webhook["last_ok"], "last_error": _webhook["last_error"]}}


# ---------------------------------------------------------------- HTTP 服务

# ---------------------------------------------------------------- 扩展
# ext/<名字>/__init__.py 里定义 register(core, ext)，启动时自动加载。扩展可以：
#   ext.route("/api/xxx", fn)      注册接口，fn(method, q, req) 返回 dict（或 Raw 返回文件）
#   ext.on("钩子名", fn)            挂到核心的钩子上（见下方 HOOKS）
#   ext.page(id=..., title=..., ...) 在界面上加一个标签页（html / js / css 放在扩展的 static/ 里）
# 商业扩展（跟单机器人、回测、研究数据）就是这样挂进来的；核心仓库里不含它们的代码。

EXT_DIR = os.path.join(ROOT, "ext")
EXTENSIONS = []     # [{"name", "dir", "static", "module", "pages": [...], "version", "requires_core"}]
EXT_ERRORS = []     # [{"name", "error"}]：没加载成功的扩展和原因（设置页显示）
EXT_ROUTES = {}     # 接口路径 -> fn(method, q, req)
EXT_HOOKS = {}      # 钩子名 -> [(扩展名, fn)]
HOOKS = {
    "background_wanted": "() -> bool：返回 True 时即使后台提醒关着，也每隔设定间隔跑一次检查并拉取聪明钱买卖",
    "smart_events": "(events)：每次后台检查新发现的聪明钱买卖事件",
    "background_tick": "(now)：后台线程每 20 秒调用一次",
    "smart_wallets": "(wallets, board)：往“要跟踪的聪明钱”列表里追加钱包",
}


class _Core:
    """传给扩展的“核心”：按名字实时取 server.py 里的函数和变量（不依赖 sys.modules 里的模块名）"""
    def __getattr__(self, name):
        try:
            return globals()[name]
        except KeyError:
            raise AttributeError(name) from None


class Raw:
    """扩展接口返回文件内容而不是 JSON 时用"""
    def __init__(self, body, content_type, filename=None):
        self.body, self.content_type, self.filename = body, content_type, filename


class ExtApi:
    def __init__(self, name, path):
        self.name, self.dir = name, path
        self.pages = []

    def route(self, path, fn):
        if not path.startswith("/api/") or path in EXT_ROUTES:
            raise ValueError(f"扩展 {self.name} 的接口路径不合法或已被占用: {path}")
        EXT_ROUTES[path] = fn

    def on(self, name, fn):
        if name not in HOOKS:
            raise ValueError(f"扩展 {self.name} 用了不存在的钩子: {name}")
        EXT_HOOKS.setdefault(name, []).append((self.name, fn))

    def page(self, id, title, sub="", icon="", html="", js=(), css=(), i18n=None):
        """在导航里加一个标签页：html 是页面内容（放进 <section id="tab-{id}">），js / css 是扩展 static/ 里的文件名"""
        url = lambda f: f"/ext/{self.name}/{f}?v={int(os.path.getmtime(os.path.join(self.dir, 'static', f)))}"
        self.pages.append({"id": id, "title": title, "sub": sub, "icon": icon, "html": url(html),
                           "js": [url(f) for f in js], "css": [url(f) for f in css], "i18n": url(i18n) if i18n else None})


def hook_fns(name):
    return EXT_HOOKS.get(name, ())


def hook(name, *args):
    """调用所有挂在这个钩子上的扩展函数，返回它们的返回值列表（单个扩展出错只记日志，不影响核心）"""
    out = []
    for ext_name, fn in hook_fns(name):
        try:
            out.append(fn(*args))
        except Exception as e:  # noqa: BLE001
            print(f"[ext {ext_name}] {name}: {type(e).__name__}: {e}", file=sys.stderr)
    return out


def hook_any(name, *args):
    return any(hook(name, *args))


def version_tuple(v):
    return tuple(int(x) for x in re.findall(r"\d+", str(v))[:3]) or (0,)


def load_extensions():
    EXTENSIONS.clear(); EXT_ROUTES.clear(); EXT_HOOKS.clear(); EXT_ERRORS.clear()
    if not os.path.isdir(EXT_DIR):
        return EXTENSIONS
    for name in sorted(os.listdir(EXT_DIR)):
        path = os.path.join(EXT_DIR, name)
        init = os.path.join(path, "__init__.py")
        if not os.path.isfile(init) or not re.fullmatch(r"[A-Za-z0-9_-]+", name):
            continue
        try:
            spec = importlib.util.spec_from_file_location(f"bd_ext_{name}", init, submodule_search_locations=[path])
            mod = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = mod
            spec.loader.exec_module(mod)
            need = getattr(mod, "REQUIRES_CORE", None)
            if need and version_tuple(need) > version_tuple(VERSION):
                raise RuntimeError(f"需要核心 {need} 或更新（当前 {VERSION}），请先更新区块侦探")
            api = ExtApi(name, path)
            mod.register(_Core(), api)
            EXTENSIONS.append({"name": name, "dir": path, "static": os.path.join(path, "static"), "module": mod, "pages": api.pages,
                               "version": getattr(mod, "VERSION", ""), "requires_core": need})
            print(f"已加载扩展: {name} {getattr(mod, 'VERSION', '')}".rstrip())
        except Exception as e:  # noqa: BLE001 — 扩展坏了不影响核心功能
            EXT_ERRORS.append({"name": name, "error": f"{type(e).__name__}: {e}"[:200]})
            print(f"扩展 {name} 加载失败: {type(e).__name__}: {e}", file=sys.stderr)
    return EXTENSIONS


def ext_manifest():
    """给网页：有哪些扩展、各自加了哪些页面"""
    return [{"name": e["name"], "version": e["version"], "pages": e["pages"]} for e in EXTENSIONS]


# ---------------------------------------------------------------- OFAC 制裁地址导入
# 美国财政部 OFAC SDN 名单里的加密货币地址，由 0xB10C 整理成每种资产一个文本文件（每行一个地址）。
# 导入后这些地址在风险评分里是“风险源”（分类“风险”，备注含 OFAC → 80 分并向外传播）。

OFAC_URL = "https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_{}.txt"
OFAC_ASSETS = ("ETH", "USDT", "USDC", "ARB", "BSC", "XBT", "TRX")  # EVM 地址各链通用，一个 evm: 键即可；XBT = 比特币
OFAC_LABEL = "OFAC 制裁地址"


def fetch_text(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(2 * 1024 * 1024).decode("utf-8", "replace")


def ofac_key(addr):
    """地址 → 标签库的键；认不出来的返回 None"""
    a = addr.strip()
    if ADDR_RE["evm"].match(a):
        return "evm:" + a.lower()
    if ADDR_RE["tron"].match(a):
        return "tron:" + a
    if ADDR_RE["btc"].match(a):
        return "btc:" + a
    return None


def import_ofac():
    """拉取名单并合并进标签库：已有的键不覆盖（用户自己的标签优先），只补新地址。返回统计"""
    found, assets, errors = {}, {}, []
    for asset in OFAC_ASSETS:
        try:
            text = fetch_text(OFAC_URL.format(asset))
        except (urllib.error.URLError, OSError, ValueError) as e:
            errors.append(f"{asset}: {str(getattr(e, 'reason', e))[:60]}")
            continue
        n = 0
        for line in text.splitlines():
            k = ofac_key(line)
            if k:
                n += 1
                found.setdefault(k, set()).add(asset)
        assets[asset] = n
    if not found and errors:
        raise ApiError("OFAC 名单全部拉取失败：" + "; ".join(errors[:3]))
    day = time.strftime("%Y-%m-%d")
    added = skipped = 0
    with _store_lock:
        labels = load_json("labels.json", {})
        for k, srcs in found.items():
            if k in labels:
                skipped += 1
                continue
            labels[k] = {"label": OFAC_LABEL, "category": "风险",
                         "note": f"美国财政部 OFAC SDN 制裁名单（{'/'.join(sorted(srcs))} 列表，数据来自 0xB10C 整理，{day} 导入）",
                         "source": "OFAC"}
            added += 1
        save_json("labels.json", labels)
    return {"added": added, "skipped_existing": skipped, "total": len(found), "assets": assets, "errors": errors}


def req_str(b, k):
    """请求里必填的文字字段：缺了或不是文字时回 400，而不是 KeyError 变成 500"""
    v = b.get(k)
    if not isinstance(v, str) or not v.strip():
        raise ApiError(f"缺少字段: {k}")
    return v.strip()


def opt_str(b, k):
    v = b.get(k)
    return v.strip() if isinstance(v, str) else ""


def req_num(v, name, lo=None, hi=None, integer=False):
    """把请求里的数字转成有限的 float / int 并夹在范围内；NaN、Infinity、写错的文字都回 400
    （NaN 一旦写进配置，json.dumps 会输出浏览器解析不了的 NaN，整个页面都会坏掉）"""
    try:
        x = float(v if v not in (None, "") else 0)
    except (TypeError, ValueError):
        raise ApiError(f"{name} 必须是数字") from None
    if not math.isfinite(x):
        raise ApiError(f"{name} 必须是有限的数字")
    if lo is not None:
        x = max(lo, x)
    if hi is not None:
        x = min(hi, x)
    return int(x) if integer else x


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=STATIC, **kw)

    def end_headers(self):
        # 本地工具：界面更新后刷新即可生效，不走浏览器缓存
        self.send_header("Cache-Control", "no-cache")
        # 浏览器侧的安全头：
        # - CSP：只运行本站的脚本文件，禁止内联脚本 / onerror= 之类的注入代码执行，只能连本站接口
        # - 禁止被其他网站用 iframe 嵌入（防点击劫持）、禁止 MIME 嗅探、点外部链接时不带上本机地址
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                         "img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; "
                         "form-action 'self'; frame-ancestors 'none'")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        super().end_headers()

    def translate_path(self, path):
        """/ext/<扩展名>/文件 → 该扩展的 static/ 目录；其余照常从 static/ 取"""
        clean = urllib.parse.urlparse(path).path
        m = re.match(r"^/ext/([A-Za-z0-9_-]+)/(.+)$", clean)
        if m:
            ext = next((e for e in EXTENSIONS if e["name"] == m.group(1)), None)
            if ext:
                root = os.path.realpath(ext["static"])
                target = os.path.realpath(os.path.join(root, *[p for p in urllib.parse.unquote(m.group(2)).split("/") if p]))
                if target == root or target.startswith(root + os.sep):
                    return target
            return os.path.join(STATIC, "__missing__")  # 404
        return super().translate_path(path)

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            super().log_message(fmt, *args)

    def send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body_json(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ApiError("Content-Length 不正确") from None
        if n > 5 * 1024 * 1024:  # 标签导入等最大也就几百 KB，超过 5 MB 直接拒绝
            raise ApiError("请求内容太大")
        try:
            b = json.loads(self.rfile.read(n).decode("utf-8") or "{}") if n else {}
        except (UnicodeDecodeError, ValueError):
            raise ApiError("请求内容不是有效的 JSON") from None
        if not isinstance(b, dict):
            raise ApiError("请求内容必须是 JSON 对象")
        return b

    def body_bytes(self, limit):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ApiError("Content-Length 不正确") from None
        if n > limit:
            raise ApiError(f"文件太大（上限 {limit // 1024 // 1024} MB）")
        return self.rfile.read(n) if n else b""

    def blocked(self, method):
        """防护：只接受本机地址访问，并拒绝其他网站发来的请求。
        - Host 必须是 127.0.0.1 / localhost:端口 —— 挡住“DNS 重绑定”（恶意网站把自己的域名解析到 127.0.0.1 来读数据）
        - 浏览器带了 Origin / Sec-Fetch-Site 时必须是本站 —— 挡住其他网页偷偷发 POST / DELETE 改配置、删标签（CSRF）
        命令行工具（curl、脚本）不带这些头，照常可用"""
        allowed = {f"127.0.0.1:{PORT}", f"localhost:{PORT}", f"[::1]:{PORT}"}
        host = (self.headers.get("Host") or "").lower()
        if host not in allowed:
            return f"bad host: {host[:60]}"
        origin = self.headers.get("Origin")
        if origin and origin != "null" and urllib.parse.urlparse(origin).netloc.lower() not in allowed:
            return f"cross-origin: {origin[:60]}"
        if origin == "null" and method != "GET":
            return "null origin"
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            return "cross-site request"
        return None

    def do_HEAD(self):
        if self.blocked("HEAD"):
            return self.send_json({"error": "forbidden"}, 403)
        return super().do_HEAD()

    def route(self, method):
        why = self.blocked(method)
        if why:
            self.log_message("%s", f"blocked {method} {self.path[:80]} ({why}) /api/")  # 带 /api/ 才会写进日志
            return self.send_json({"error": "forbidden"}, 403)
        url = urllib.parse.urlparse(self.path)
        if not url.path.startswith("/api/"):
            if method == "GET":
                return super().do_GET()
            return self.send_json({"error": "not found"}, 404)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
        try:
            out = self.api(method, url.path, q)
            if isinstance(out, Raw):  # 扩展返回的非 JSON 内容（CSV 下载等）
                self.send_response(200)
                self.send_header("Content-Type", out.content_type)
                if out.filename:
                    self.send_header("Content-Disposition", f"attachment; filename={out.filename}")
                self.send_header("Content-Length", str(len(out.body)))
                self.end_headers()
                self.wfile.write(out.body)
                return
            self.send_json(out)
        except ApiError as e:
            self.send_json({"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001 — 本地工具，把异常直接显示在页面上
            self.send_json({"error": f"{type(e).__name__}: {e}"}, 500)

    def api(self, method, path, q):
        if path == "/api/chains":
            return {k: {kk: vv for kk, vv in v.items() if kk not in ("chainid", "free_api")} for k, v in CHAINS.items()}
        if path == "/api/prices":
            return swr("prices", 300, prices)[0]
        if path == "/api/smart":
            return smart_analyze(q.get("chain", ""), q.get("address", ""), q.get("limit", 1000))
        if path in EXT_ROUTES:
            return EXT_ROUTES[path](method, q, self)
        if path == "/api/ext":
            return ext_manifest()
        if path == "/api/health":
            # 给 launchd / 监控脚本用的健康检查：进程活着、扩展状态、后台提醒是否卡住、Webhook 最近是否失败
            st = alert_settings()
            stuck = bool(st["enabled"] and _alert["last_run"] and time.time() - _alert["last_run"] > st["interval"] * 60 * 3)
            return {"ok": not stuck and not EXT_ERRORS, "version": VERSION, "uptime": int(time.time() - STARTED),
                    "alerts": {"enabled": st["enabled"], "last_run": _alert["last_run"], "stuck": stuck, "last_error": _alert["last_error"]},
                    "extensions": [e["name"] for e in EXTENSIONS], "ext_errors": EXT_ERRORS,
                    "webhook_error": _webhook["last_error"], "data_dir": DATA}
        if path == "/api/version":
            return {"version": VERSION, "python": sys.version.split()[0], "platform": sys.platform, "started": int(STARTED),
                    "extensions": [{"name": e["name"], "version": e["version"], "requires_core": e["requires_core"]} for e in EXTENSIONS],
                    "ext_errors": EXT_ERRORS}
        if path == "/api/restart" and method == "POST":
            # 重新启动服务进程，加载最新代码（Mac 开机自启和 Windows 双击启动都适用）
            def again():
                time.sleep(0.6)  # 先让这次请求的回复发出去
                os.execv(sys.executable, [sys.executable] + sys.argv)
            threading.Thread(target=again, daemon=True).start()
            return {"ok": True, "started": int(STARTED)}
        if path == "/api/backup":
            if method == "POST":
                backup_data(force=True)
            return backup_status()
        if path == "/api/backup/import" and method == "POST":
            return restore_zip(self.body_bytes(RESTORE_MAX))
        if path == "/api/backup/export.zip":
            return Raw(backup_zip(include_secrets=q.get("secrets") == "1"), "application/zip",
                       filename=f"block-detective-backup-{time.strftime('%Y%m%d')}.zip")
        if path == "/api/smart/import" and method == "POST":
            b = self.body_json()
            return start_import(opt_str(b, "chain") or "eth", opt_str(b, "text"))
        if path == "/api/smart/discover":
            if method == "POST":
                return start_discover(q.get("chain", "eth"), q.get("token", ""), q.get("mode", "early"), q.get("n", 20))
            job = _jobs.get(q.get("job", ""))
            if not job:
                raise ApiError("任务不存在或已被新的任务替换")
            return job
        if path == "/api/smart/board":
            with _store_lock:
                board = load_json("smart.json", {})
                if method == "DELETE":
                    board.pop(q.get("key", ""), None)
                    save_json("smart.json", board)
            return sorted(board.values(), key=lambda r: r["score"], reverse=True)
        if path == "/api/market":
            v, t = swr("market", 240, market)
            return {**v, "fetched": int(t)}
        if path == "/api/chainstat":
            return swr("chainstat", 12, chain_stat, max_stale=6 * 3600)[0]
        if path == "/api/transfers":
            return get_transfers(q.get("chain", ""), q.get("address", ""), q.get("limit", 200), q.get("kind", "all"),
                                 max_age=0 if q.get("fresh") else 600)
        if path == "/api/profile":
            return get_profile(q.get("chain", ""), q.get("address", ""))

        if path == "/api/watchlist":
            with _store_lock:
                items = load_json("watchlist.json", [])
                if method == "POST":
                    b = self.body_json()
                    chain = req_str(b, "chain")
                    direction = opt_str(b, "direction") or "all"
                    if direction not in WATCH_DIRECTIONS:
                        raise ApiError("direction 只能是 all / in / out")
                    item = {"chain": chain, "address": norm_addr(chain, req_str(b, "address")),
                            "label": opt_str(b, "label"), "note": opt_str(b, "note"),
                            "threshold_usd": req_num(b.get("threshold_usd"), "threshold_usd", 0),
                            "direction": direction, "tokens": watch_tokens(b.get("tokens") or []), "added": int(time.time())}
                    old = next((i for i in items if watch_key(i) == watch_key(item)), None)
                    if old:
                        old.update({k: item[k] for k in ("label", "note", "threshold_usd", "direction", "tokens")})
                    else:
                        items.append(item)
                    save_json("watchlist.json", items)
                elif method == "DELETE":
                    items = [i for i in items if not (i["chain"] == q.get("chain") and i["address"] == q.get("address"))]
                    save_json("watchlist.json", items)
                return items
        if path == "/api/watchlist/refresh" and method == "POST":
            return refresh_watchlist(q.get("key"))
        if path == "/api/watchlist/flow":
            if q.get("refresh") or time.time() - _flow["ts"] > FLOW_TTL:
                start_flow()
            with _flow_lock:
                return dict(_flow)

        if path == "/api/alerts":
            if method == "POST":
                b = self.body_json()
                with _store_lock:
                    cfg = load_json("config.json", {})
                    if "enabled" in b:
                        cfg["alert_enabled"] = bool(b["enabled"])
                        _alert["next_run"] = 0
                    if "interval" in b:
                        cfg["alert_interval"] = req_num(b["interval"], "interval", 1, 240, integer=True)
                        _alert["next_run"] = 0
                    if b.get("lang") in ALERT_TEXT:
                        cfg["alert_lang"] = b["lang"]
                    if "sound" in b:
                        cfg["alert_sound"] = bool(b["sound"])
                    if "smart" in b:
                        cfg["smart_alert"] = bool(b["smart"])
                    if "smart_min" in b:
                        cfg["smart_min"] = req_num(b["smart_min"], "smart_min", 0.0)
                    if "smart_first_only" in b:
                        cfg["smart_first_only"] = bool(b["smart_first_only"])
                    save_json("config.json", cfg)
            return alert_status()
        if path == "/api/alerts/test" and method == "POST":
            T = ALERT_TEXT.get(alert_settings()["lang"], ALERT_TEXT["ja"])
            notify(T["title"], T["test"], alert_settings()["sound"])
            return {"ok": True}
        if path == "/api/alerts/run" and method == "POST":
            return {"found": run_alerts(), **alert_status()}

        if path == "/api/labels/ofac" and method == "POST":
            return import_ofac()
        if path == "/api/labels":
            with _store_lock:
                labels = load_json("labels.json", {})
                if method == "POST":
                    b = self.body_json()
                    if isinstance(b.get("import"), dict):
                        # 只收 {地址: {标签字段…}} 这种结构，别的东西混进来会让前端渲染标签时出错
                        labels.update({str(k): {f: str(v.get(f, "")) for f in ("label", "category", "note", "source") if v.get(f) is not None}
                                       for k, v in b["import"].items() if isinstance(v, dict)})
                    else:
                        key = req_str(b, "key")
                        labels[key] = {"label": opt_str(b, "label"), "category": opt_str(b, "category"),
                                       "note": opt_str(b, "note"), "source": opt_str(b, "source") or "手动添加"}
                    save_json("labels.json", labels)
                elif method == "DELETE":
                    labels.pop(q.get("key", ""), None)
                    save_json("labels.json", labels)
                return labels

        if path == "/api/config":
            if method == "POST":
                b = self.body_json()
                for k in SECRET_KEYS:
                    if k in b:
                        v = str(b[k]).strip()
                        if k == "webhook_url" and v:
                            check_webhook_url(v)
                        set_secret(k, v)
            cfg = config()
            return {**{k: bool(cfg.get(k)) for k in SECRET_KEYS},
                    "storage": "keychain" if keychain_mode() else "file", "keychain_available": keychain_ok()}
        if path == "/api/secrets/migrate" and method == "POST":
            migrate_secrets()
            return {"ok": True, "storage": "keychain"}
        raise ApiError(f"未知接口: {method} {path}")

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_DELETE(self):
        self.route("DELETE")


def main():
    os.makedirs(DATA, exist_ok=True)
    # 第一次运行：把 seed/ 里预置的知名地址标签和示例监控列表复制到 data/（已有的不覆盖）
    for name in ("labels.json", "watchlist.json"):
        src, dst = os.path.join(ROOT, "seed", name), os.path.join(DATA, name)
        if os.path.exists(src) and not os.path.exists(dst):
            shutil.copyfile(src, dst)
    for attempt in range(20):  # 刚重启时旧进程的端口可能还没完全释放，稍等重试
        try:
            srv = ThreadingHTTPServer((HOST, PORT), Handler)
            break
        except OSError:
            if attempt == 19:
                raise
            time.sleep(0.5)
    load_extensions()
    threading.Thread(target=alert_loop, daemon=True).start()
    print(f"区块侦探已启动: http://{HOST}:{PORT}   （Ctrl+C 停止）")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


def cli(argv):
    """命令行：--version 打印版本；--check 加载扩展并自检（有扩展加载失败时退出码 1）；--port N 指定端口。返回退出码，None 表示继续启动服务"""
    global PORT
    args = list(argv)
    if "--port" in args:
        i = args.index("--port")
        try:
            PORT = int(args[i + 1])
        except (IndexError, ValueError):
            print("--port 后面要跟端口号", file=sys.stderr)
            return 2
        del args[i:i + 2]
    if "--version" in args:
        print(f"block-detective {VERSION}")
        return 0
    if "--check" in args:
        os.makedirs(DATA, exist_ok=True)
        exts = load_extensions()
        print(f"核心 {VERSION} · Python {sys.version.split()[0]} · 数据目录 {DATA}")
        for e in exts:
            print(f"  扩展 {e['name']} {e['version']}" + (f"（需要核心 ≥ {e['requires_core']}）" if e["requires_core"] else ""))
        for e in EXT_ERRORS:
            print(f"  扩展 {e['name']} 加载失败: {e['error']}", file=sys.stderr)
        probe = os.path.join(DATA, ".write-test")
        try:
            with open(probe, "w") as f:
                f.write("ok")
            os.remove(probe)
        except OSError as e:
            print(f"  数据目录不可写: {e}", file=sys.stderr)
            return 1
        print("  检查通过" if not EXT_ERRORS else "  有扩展没加载成功")
        return 1 if EXT_ERRORS else 0
    unknown = [a for a in args if a.startswith("-")]
    if unknown:
        print(f"不认识的参数: {' '.join(unknown)}\n用法: python3 server.py [--port N] [--version] [--check]", file=sys.stderr)
        return 2
    return None


if __name__ == "__main__":
    code = cli(sys.argv[1:])
    if code is None:
        main()
    else:
        sys.exit(code)
