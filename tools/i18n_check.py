"""检查界面里的中文文案是否都有日 / 英译文。

用法：
    python3 tools/i18n_check.py                 # 检查 static/（核心）
    python3 tools/i18n_check.py --ext ext/pro   # 再加上一个扩展的 static/（它的 i18n.js 里用 I18N.add([...]) 补充词条）
    python3 tools/i18n_check.py --strict        # 有缺失时退出码 1（给 CI 用）

做法：从 index.html 的文本节点和 placeholder / title / aria-label 属性、各 .js 文件的字符串字面量里抽出含中文的文案，
模板字符串按 ${...} 切开后逐段检查；每段先查 ENTRIES 词典，再试 PATTERNS 正则（JS 正则直接当 Python 正则用，
不兼容的跳过）。只用标准库。"""
import html
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CJK = re.compile(r"[一-鿿]")
STR_RE = re.compile(r'"((?:[^"\\\n]|\\.)*)"|\'((?:[^\'\\\n]|\\.)*)\'|`((?:[^`\\]|\\.)*)`', re.S)
ENTRY_RE = re.compile(r'\[\s*("(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\')\s*,\s*("(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\')\s*,\s*("(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\')\s*\]')
PATTERN_RE = re.compile(r"\[\s*/((?:[^/\\]|\\.)+)/([gimsuy]*)\s*,")


def unquote(q):
    body = q[1:-1]
    return re.sub(r"\\(.)", lambda m: {"n": "\n", "t": "\t"}.get(m.group(1), m.group(1)), body)


def load_dict(i18n_src):
    """ENTRIES 的中文键 + PATTERNS 的正则；扩展的 I18N.add([...]) 也是同样的三元组格式"""
    keys = {unquote(m.group(1)) for m in ENTRY_RE.finditer(i18n_src)}
    pats = []
    for m in PATTERN_RE.finditer(i18n_src):
        try:
            pats.append(re.compile(m.group(1)))
        except re.error:
            pass
    return keys, pats


def strings_in_js(src):
    out = set()
    for m in STR_RE.finditer(src):
        s = m.group(1) if m.group(1) is not None else m.group(2) if m.group(2) is not None else m.group(3)
        if s is None or not CJK.search(s):
            continue
        if m.group(3) is not None:  # 模板字符串：${...} 多半是数字 / 名字，用 1 代替后整句去匹配模式，和运行时看到的文本一致
            s = re.sub(r"\$\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}", "1", s)
        s = re.sub(r"<[^>]+>", "\n", s)  # 每个 HTML 标签之间是独立的文本节点
        s = html.unescape(s)
        for piece in s.split("\n"):
            piece = piece.strip()  # 运行时的 tr() 只去首尾空白，标点要原样匹配
            if CJK.search(piece):
                out.add(piece.strip())
    return out


def strings_in_html(src):
    out = set()
    body = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>|<!--[\s\S]*?-->", " ", src)
    for m in re.finditer(r'(?:placeholder|title|aria-label)="([^"]*)"', body):
        if CJK.search(m.group(1)):
            out.add(html.unescape(m.group(1)).strip())
    text = re.sub(r"<[^>]+>", "\n", body)
    for line in text.split("\n"):
        line = html.unescape(line).strip()
        if CJK.search(line):
            out.add(line)
    return out


def covered(s, keys, pats):
    core = s.strip()
    if core in keys or not CJK.search(core):
        return True
    return any(p.search(core) for p in pats)


def check(static_dir, keys, pats, skip_files=("i18n.js",)):
    found = {}
    for name in sorted(os.listdir(static_dir)):
        path = os.path.join(static_dir, name)
        if name in skip_files or not os.path.isfile(path):
            continue
        src = open(path, encoding="utf-8").read()
        if name.endswith(".html"):
            items = strings_in_html(src)
        elif name.endswith(".js"):
            items = strings_in_js(src)
        else:
            continue
        for s in items:
            if not covered(s, keys, pats):
                found.setdefault(s, set()).add(name)
    return found


def main(argv):
    strict = "--strict" in argv
    ext = argv[argv.index("--ext") + 1] if "--ext" in argv else None
    core_i18n = open(os.path.join(ROOT, "static", "i18n.js"), encoding="utf-8").read()
    keys, pats = load_dict(core_i18n)
    targets = [os.path.join(ROOT, "static")]
    if ext:
        ext_static = os.path.join(ROOT, ext, "static")
        ei = os.path.join(ext_static, "i18n.js")
        if os.path.exists(ei):
            k2, p2 = load_dict(open(ei, encoding="utf-8").read())
            keys |= k2
            pats += p2
        targets = [ext_static]  # 只报扩展自己的文件
    missing = {}
    for t in targets:
        for s, files in check(t, keys, pats).items():
            missing.setdefault(s, set()).update(files)
    for s, files in sorted(missing.items(), key=lambda kv: (sorted(kv[1]), kv[0])):
        print(f"{','.join(sorted(files))}\t{s}")
    print(f"\n{len(missing)} 条中文文案没有译文（词典 {len(keys)} 条，模式 {len(pats)} 条）", file=sys.stderr)
    return 1 if strict and missing else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
