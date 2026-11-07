#!/usr/bin/env python3
"""Deep analysis of unpacked Snort rule archives: files, rule counts, SIDs, overlaps, Suricata compat."""
import os, re, json, gzip
from collections import defaultdict

ROOT = "/home/z/my-project/work/unpacked"
RULE_RE = re.compile(r"^\s*(alert|drop|pass|sdrop|reject|block|rewrite|log|activate|dynamic)\b")

def iter_rule_files(base):
    for dirpath, _, files in os.walk(base):
        for fn in files:
            if fn.endswith((".rules", ".rule")):
                yield os.path.join(dirpath, fn)

def open_maybe_gz(path):
    return gzip.open(path, "rt", errors="replace") if path.endswith(".gz") else open(path, "r", errors="replace")

def parse_rule(line):
    """Return (sid, rev, hdr_action, proto) or None."""
    if not RULE_RE.match(line):
        return None
    m = re.search(r"\bsid\s*:\s*(\d+)\s*;", line)
    sid = int(m.group(1)) if m else None
    m2 = re.search(r"\brev\s*:\s*(\d+)\s*;", line)
    rev = int(m2.group(1)) if m2 else None
    m3 = re.match(r"\s*(\w+)", line)
    action = m3.group(1) if m3 else None
    return sid, rev, action

SNORT3_ONLY = {"bsize","isdataat","sticky_buffer","http.header_names","http.accept","http.accept_lang",
    "http.accept_enc","http.connection","http.content_type","http.header_raw","http.startbuf","http.body,"
    "http.client_body","http.uri.raw","http.method","http.stat_code","http.stat_msg","http.host.raw",
    "http.request_line","http.response_line","ftp.data_chan","dns.query","dns.header_flags","tls.sni",
    "tls.cert_subject","tls.cert_issuer","tls.fingerprint","ssl_version","ja3.hash","ja3.string",
    "keystore","pkt_trace","file.data","base64_decode","strip_whitespace","to_utf6","unlimit"}

SURICATA_ONLY = {"app-layer-protocol","app-layer-event","flowint","xbits","ipset","libhtp","dataset",
    "datasets","lua","pcrexform","http.uri.buffer","http.user_agent","http.content_len","fwsam","noalert",
    "fast_pattern:only"}

def classify_compat(line):
    """heuristic: snort3-only sticky buffers, suricata-specific keywords"""
    s3 = bool(re.search(r";\s*(bsize|isdataat|sticky_buffer|http\.header_names|http\.request_line|"
                        r"http\.response_line|http\.accept|http\.accept_lang|http\.accept_enc|"
                        r"http\.connection|http\.content_type|http\.header_raw|http\.startbuf|"
                        r"http\.client_body|http\.uri\.raw|http\.host\.raw|ftp\.data_chan|"
                        r"dns\.query|dns\.header_flags|tls\.sni|tls\.cert_subject|tls\.cert_issuer|"
                        r"tls\.fingerprint|ja3\.hash|ja3\.string|keystore|file\.data|base64_decode|"
                        r"strip_whitespace|to_utf6|pkt_trace)\s*;", line))
    # snort2-only keywords not in suricata
    snort2_only = bool(re.search(r":\s*(dsize\s*>|offset\s|rawbytes|asn1\s|react\s*[:;]|resp\s*[:;]|"
                                 r" activate\s| dynamic\s|tag\s*:\s*session|priority\s*:\s*\d+\s*;\s*reference)"
                                 , line)) or bool(re.search(r"\b(rawbytes|dce_iface|dce_stub_data|sip_method)\b", line))
    return {"snort3_style": s3, "snort2_legacy": snort2_only}

result = {}
for arch in sorted(os.listdir(ROOT)):
    base = os.path.join(ROOT, arch)
    if not os.path.isdir(base):
        continue
    files = {}
    all_sids = set()
    sid_files = defaultdict(set)
    total_rules = 0
    s3_style = s2_legacy = 0
    actions = defaultdict(int)
    for rf in iter_rule_files(base):
        rel = os.path.relpath(rf, base)
        n_rules = 0
        with open_maybe_gz(rf) as f:
            for line in f:
                p = parse_rule(line)
                if not p:
                    continue
                sid, rev, action = p
                n_rules += 1
                actions[action] += 1
                if sid is not None:
                    all_sids.add(sid)
                    sid_files[sid].add(rel)
                c = classify_compat(line)
                if c["snort3_style"]: s3_style += 1
                if c["snort2_legacy"]: s2_legacy += 1
        if n_rules:
            files[rel] = n_rules
            total_rules += n_rules
    result[arch] = {
        "rule_files": len(files), "total_rule_lines": total_rules, "unique_sids": len(all_sids),
        "actions": dict(actions), "snort3_style_lines": s3_style, "snort2_legacy_lines": s2_legacy,
        "files": dict(sorted(files.items(), key=lambda kv: -kv[1])[:15]),
        "all_files": files,
        "_sid_files": {str(k): sorted(v) for k, v in sid_files.items()},
    }

# overlaps between archives
arch_names = list(result.keys())
overlaps = {}
for i, a in enumerate(arch_names):
    for b in arch_names[i+1:]:
        sa = set(int(k) for k in result[a]["_sid_files"])
        sb = set(int(k) for k in result[b]["_sid_files"])
        inter = sa & sb
        overlaps[f"{a} ∩ {b}"] = len(inter)

out = {k: {kk: vv for kk, vv in v.items() if kk != "_sid_files"} for k, v in result.items()}
out["_overlaps"] = overlaps
with open("/home/z/my-project/work/analysis.json", "w") as f:
    json.dump(out, f, indent=1, ensure_ascii=False)
# also dump sid->files map for detailed duplicate detection
with open("/home/z/my-project/work/sidmap.json", "w") as f:
    json.dump({a: r["_sid_files"] for a, r in result.items()}, f)

for a in arch_names:
    r = result[a]
    print(f"=== {a}: {r['rule_files']} files, {r['total_rule_lines']} rules, {r['unique_sids']} unique SIDs")
    print(f"    actions={dict(r['actions'])} s3-style={r['snort3_style_lines']} s2-legacy={r['snort2_legacy_lines']}")
print("\n=== OVERLAPS (unique SIDs shared):")
for k, v in sorted(overlaps.items(), key=lambda kv: -kv[1]):
    print(f"  {v:>7}  {k}")
