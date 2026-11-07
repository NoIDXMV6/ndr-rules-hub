#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
s2x_convert.py (v2) — конвертер правил Snort 2 / Snort 3 → Suricata 7.x.
Калибровка: Suricata 7.0.10 (Debian), probes c1-c8, a1-a24, b1-b12.

Ключевые правила:
 1. Inline-модификаторы content (content:"x",nocase,depth 4) → отдельные ключевые слова.
 2. Legacy-буферы: сохраняются как модификаторы ТОЛЬКО после content при пустом
    sticky-контексте; иначе — dot-форма (переключение sticky-буфера).
 3. bsize (и bufferlen) допустимы только в app-layer sticky-буферах; на payload — правило отбрасывается.
 4. bufferlen → bsize; диапазоны не поддерживаются → отброс.
 5. Ключевые слова Snort 3 без эквивалента (byte_math, sip_*, ber_*, http_param...) → отброс.
 6. Протоколы file→tcp, ssl→tls; переменные не из suricata.yaml → $HOME_NET / any.
"""
import re

ACTION_MAP = {"block": "drop", "sdrop": "drop"}
PROTO_MAP = {"file": "tcp", "ssl": "tls"}
VALID_PROTOS = {"tcp", "udp", "icmp", "ip", "http", "tls", "dns", "ftp", "smtp", "ssh",
                "modbus", "dnp3", "enip", "nfs", "smb", "ikev2", "krb5", "dhcp", "rfb",
                "sip", "quic", "http2", "mqtt", "rdp", "sctp"}

LEGACY_TO_DOT = {
    "http_uri": "http.uri", "http_raw_uri": "http.uri.raw",
    "http_header": "http.header", "http_raw_header": "http.header.raw",
    "http_client_body": "http.request_body", "http_server_body": "http.response_body",
    "http_method": "http.method", "http_user_agent": "http.user_agent",
    "http_host": "http.host", "http_cookie": "http.cookie",
    "http_stat_code": "http.stat_code", "http_stat_msg": "http.stat_msg",
    "http_start": "http.start",
}
LEGACY_BUFFERS = set(LEGACY_TO_DOT)
# эти legacy-буферы можно оставлять как модификаторы после content (проверено зондами);
# остальные — всегда dot-форма
LEGACY_MODIFIER_OK = {"http_uri", "http_raw_uri", "http_header", "http_raw_header",
                      "http_client_body", "http_method", "http_server_body"}
# контент-модификаторы: не сбрасывают контекст «content»
CONTENT_MODIFIERS = {"nocase", "fast_pattern", "startswith", "endswith", "rawbytes",
                     "depth", "offset", "within", "distance"}

# dot-буферы Suricata 7, проверенные зондами/документацией
DOT_BUFFERS = set(LEGACY_TO_DOT.values()) | {
    "http.uri", "http.uri.raw", "http.header", "http.header.raw", "http.request_body",
    "http.response_body", "http.method", "http.user_agent", "http.host", "http.cookie",
    "http.stat_code", "http.stat_msg", "http.start", "http.accept", "http.accept_lang",
    "http.accept_enc", "http.referer", "http.connection", "http.content_type",
    "http.content_len", "http.location", "http.server", "http.header_names",
    "http.protocol", "dns.query", "tls.sni", "tls.cert_issuer", "tls.cert_subject",
    "tls.cert_fingerprint", "tls.fingerprint", "tls.certs", "tls.subject", "tls.issuerdn",
    "file.data", "pkt_data", "base64_data",
}
# буферы запроса (для детекта конфликта направлений)
REQUEST_BUFFERS = {"http.uri", "http.uri.raw", "http.header", "http.header.raw",
                   "http.request_body", "http.method", "http.user_agent", "http.host",
                   "http.cookie", "http.referer", "http.connection", "http.accept",
                   "http.accept_lang", "http.accept_enc", "http.content_type",
                   "http.content_len", "http.header_names", "http.start", "http.protocol"}
RESPONSE_BUFFERS = {"http.stat_code", "http.stat_msg", "http.response_body",
                    "http.location", "http.server"}
# legacy-модификаторы, которые Suricata принимает ПОСЛЕ content
LEGACY_MODIFIERS_OK = LEGACY_BUFFERS  # только если last_kind=='content' и sticky пуст

HEADER_FIELD_MAP = {
    "user-agent": "http.user_agent", "host": "http.host", "referer": "http.referer",
    "cookie": "http.cookie", "connection": "http.connection",
    "content-type": "http.content_type", "content-length": "http.content_len",
    "accept": "http.accept", "accept-encoding": "http.accept_enc",
    "accept-language": "http.accept_lang", "location": "http.location", "server": "http.server",
}

KNOWN_ADDR_VARS = {"HOME_NET", "EXTERNAL_NET", "HTTP_SERVERS", "SMTP_SERVERS", "DNS_SERVERS",
                   "SQL_SERVERS", "TELNET_SERVERS", "SSH_SERVERS", "AIM_SERVERS", "DC_SERVERS"}
KNOWN_PORT_VARS = {"HTTP_PORTS", "SHELLCODE_PORTS", "ORACLE_PORTS", "SSH_PORTS",
                   "DNP3_PORTS", "MODBUS_PORTS", "FILE_DATA_PORTS"}
ADDR_VAR_MAP = {"SIP_SERVERS": "$HOME_NET", "INTERNAL_NETWORK": "$HOME_NET",
                "DNP3_SERVERS": "$HOME_NET", "MODBUS_SERVERS": "$HOME_NET", "ENIP_SERVERS": "$HOME_NET"}

DROP_KEYWORDS = {
    # Snort 3 без эквивалента в Suricata 7
    "byte_math", "http_num_headers", "http_header_test", "http_raw_cookie", "http_param",
    "http_version", "keystore", "pkt_trace", "to_utf6", "sniff_interval", "snort",
    "attribute_table", "loop",
    # SIP-буферы Snort (в Suricata другие имена и семантика)
    "sip_method", "sip_header", "sip_body", "sip_stat_code", "sip_stat_msg",
    # ASN.1/препроцессорные (Snort 2/3)
    "ber_data", "ber_skip", "cvs", "modbus_func", "raw_data", "preproc", "asn1",
    "dce_iface", "dce_stub_data", "react", "resp", "ftpbounce", "sd",
}
STRIP_KEYWORDS = {"soid", "service"}          # подсказки без логики обнаружения
DROP_KEYWORDS |= {"http_authorization"}
STRIP_VALUELESS = {"http_raw_body"}            # вырезать, pcre/content остаются в текущем буфере

INLINE_FLAG = {"nocase", "fast_pattern", "startswith", "endswith", "rawbytes"}
INLINE_VALUED = {"depth", "offset", "within", "distance"}
CONTENT_FAMILY = {"content", "pcre", "byte_test", "byte_jump", "byte_extract", "isdataat",
                  "bsize", "dataset", "dotprefix", "urilen", "dsize", "stream_size",
                  "sticky_buffer", "ja3_hash", "sha1", "md5", "sha256"}
DIRECTION_CONFLICT = "конфликт направления: запросный буфер при flow to_client"


class ConvertResult:
    __slots__ = ("raw", "notes", "dropped")

    def __init__(self, raw=None, notes=None, dropped=False):
        self.raw = raw
        self.notes = notes or []
        self.dropped = dropped


def split_options(body: str):
    opts, buf, in_q, depth = [], [], False, 0
    i = 0
    while i < len(body):
        ch = body[i]
        if ch == "\\" and i + 1 < len(body):
            buf.append(body[i:i + 2]); i += 2; continue
        if ch == '"':
            in_q = not in_q
        elif not in_q:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            elif ch == ";" and depth == 0:
                opts.append("".join(buf).strip()); buf = []; i += 1; continue
        buf.append(ch); i += 1
    tail = "".join(buf).strip()
    if tail:
        opts.append(tail)
    return [o for o in opts if o]


def kw_of(opt: str):
    m = re.match(r"^([a-zA-Z][a-zA-Z0-9_.]*)", opt)
    return m.group(1) if m else opt


def map_vars(text: str, position: str, notes):
    def repl(m):
        name = m.group(1)
        if name in KNOWN_ADDR_VARS or name in KNOWN_PORT_VARS:
            return ADDR_VAR_MAP.get(name, m.group(0))
        notes.append(f"var ${name}→{'any' if position == 'port' else '$HOME_NET'}")
        return "any" if position == "port" else "$HOME_NET"
    return re.sub(r"\$([A-Z][A-Z0-9_]+)", repl, text)


def parse_header(line: str):
    m = re.match(r"^(\w+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(->|<>|)\s*(\S+)\s+(\S+)\s*\((.*)\)\s*;?\s*$", line, re.S)
    if not m:
        return None
    return m.groups()  # action, proto, sip, sport, direction, dip, dport, body


def convert_rule(line: str) -> ConvertResult:
    line = line.strip()
    notes = []
    hdr = parse_header(line)
    if hdr is None:
        return ConvertResult(dropped=True, notes=["заголовок не распознан"])
    action, proto, sip, sport, direction, dip, dport, body = hdr

    if action in ("activate", "dynamic"):
        return ConvertResult(dropped=True, notes=["действие activate/dynamic"])
    action = ACTION_MAP.get(action, action)
    if proto in PROTO_MAP:
        notes.append(f"протокол {proto}→{PROTO_MAP[proto]}")
        proto = PROTO_MAP[proto]
    if proto not in VALID_PROTOS:
        return ConvertResult(dropped=True, notes=[f"протокол {proto} не поддерживается"])
    sip = map_vars(sip, "addr", notes); dip = map_vars(dip, "addr", notes)
    sport = map_vars(sport, "port", notes); dport = map_vars(dport, "port", notes)
    to_client = "to_client" in body or "from_server" in body

    out = []
    last_kind = "other"   # other | content | match | buffer
    sticky = None         # имя текущего sticky-буфера (None = payload/pkt)
    saw_request_buf = False
    saw_response_buf = False

    for opt in split_options(body):
        kw = kw_of(opt)
        kwl = kw.lower()

        if kwl in DROP_KEYWORDS:
            return ConvertResult(dropped=True, notes=[f"{kw} отсутствует в Suricata 7"])
        if kwl in STRIP_KEYWORDS:
            notes.append(f"вырезано {kw}")
            continue

        # content с inline-модификаторами
        if kwl == "content":
            neg = opt.startswith("!")
            val_part = opt[1:] if neg else opt
            m = re.match(r"^content\s*:\s*(\"(?:[^\"\\]|\\.)*\")\s*(.*)$", val_part, re.S)
            if not m:
                return ConvertResult(dropped=True, notes=["content не распознан"])
            value, rest = m.group(1), m.group(2).strip()
            out.append(("content:!" if neg else "content:") + value + ";")
            if rest:
                for mod in rest.split(","):
                    mod = mod.strip()
                    if not mod:
                        continue
                    name = re.match(r"^([a-zA-Z_]+)", mod)
                    if not name:
                        return ConvertResult(dropped=True, notes=[f"inline-модификатор не распознан: {mod}"])
                    name = name.group(1)
                    if name in INLINE_FLAG:
                        out.append(f"{name};")
                    elif name in INLINE_VALUED:
                        out.append(f"{name}:{mod[len(name):].lstrip(' :')};")
                    else:
                        return ConvertResult(dropped=True, notes=[f"inline-модификатор {name} не поддержан"])
            last_kind = "content"
            continue

        # bufferlen → bsize
        if kwl == "bufferlen":
            val = opt.split(":", 1)[1].strip()
            if re.search(r"[<>&]", val):
                return ConvertResult(dropped=True, notes=["bufferlen-диапазон не поддерживается"])
            opt, kw, kwl = f"bsize:{val}", "bsize", "bsize"
            notes.append("bufferlen→bsize")
            # провалидировать как bsize ниже

        if kwl == "bsize":
            if sticky is None:
                return ConvertResult(dropped=True, notes=["bsize/bufferlen на payload без app-буфера"])
            out.append(opt + ";")
            last_kind = "match"
            continue

        # http_header:field X
        if kwl == "http_header" and re.match(r"http_header\s*:\s*field\s", opt, re.I):
            fname_m = re.match(r"http_header\s*:\s*field\s+([a-zA-Z0-9-]+)", opt, re.I)
            dot = HEADER_FIELD_MAP.get(fname_m.group(1).lower()) if fname_m else None
            if not dot:
                return ConvertResult(dropped=True, notes=["http_header:field без эквивалента"])
            out.append(f"{dot};")
            notes.append(f"http_header:field→{dot}")
            last_kind = "buffer"; sticky = dot
            saw_request_buf = saw_request_buf or dot in REQUEST_BUFFERS
            saw_response_buf = saw_response_buf or dot in RESPONSE_BUFFERS
            continue

        # legacy-буферы Snort
        if kwl in LEGACY_BUFFERS:
            dot = LEGACY_TO_DOT[kw]
            if last_kind == "content" and sticky is None and kwl in LEGACY_MODIFIER_OK:
                out.append(f"{kw};")           # модификатор после content в payload — валидно
                last_kind = "match"
            elif sticky == dot:
                # уже в этом буфере — мёртвое объявление, пропускаем
                notes.append(f"пропущен дублирующий буфер {dot}")
                continue
            else:
                out.append(f"{dot};")          # переключение sticky-буфера
                notes.append(f"{kw}→{dot}")
                last_kind = "buffer"; sticky = dot
                saw_request_buf = saw_request_buf or dot in REQUEST_BUFFERS
                saw_response_buf = saw_response_buf or dot in RESPONSE_BUFFERS
            continue

        if kwl in STRIP_VALUELESS:
            notes.append(f"вырезано {kw} (pcre/content остаются в текущем буфере)")
            continue

        # dot-буферы и прочие sticky
        if kwl in DOT_BUFFERS:
            name = kwl
            out.append(opt + ";")
            last_kind = "buffer"
            sticky = None if name == "pkt_data" else name
            saw_request_buf = saw_request_buf or name in REQUEST_BUFFERS
            saw_response_buf = saw_response_buf or name in RESPONSE_BUFFERS
            continue

        if kwl == "pkt_data":
            out.append("pkt_data;")
            last_kind = "buffer"; sticky = None
            continue

        # dnp3_ind:"x" → dnp3_ind:x
        if kwl == "dnp3_ind":
            out.append(re.sub(r'^(dnp3_ind)\s*:\s*"([^"]*)"\s*$', r"\1:\2", opt) + ";")
            continue

        # stream_size: синтаксис Snort <op>N,<dir> → Suricata <dir>,<op>,<N>
        if kwl == "stream_size":
            val = opt.split(":", 1)[1].strip()
            m2 = re.match(r"^([<>=!]+)\s*(\d+)\s*,\s*(to_server|to_client|both)\s*$", val)
            if m2:
                op2, num, dirn = m2.groups()
                sur_dir = {"to_server": "client", "to_client": "server", "both": "both"}[dirn]
                out.append(f"stream_size:{sur_dir},{op2},{num};")
                notes.append("stream_size→<dir>,<op>,<N>")
                last_kind = "match"
                continue
            # формат Snort 2 <dir>,<op>,<N> — оставить как есть
            out.append(opt + ";")
            last_kind = "match"
            continue

        # байтовые match-функции и прочие match
        if kwl in CONTENT_FAMILY:
            out.append(opt + ";")
            last_kind = "match"
            continue

        # nocase вне контекста content (например после pcre) — Suricata отвергает: вырезаем
        if kwl == "nocase" and last_kind != "content":
            notes.append("вырезан nocase вне контекста content")
            continue
        # depth/offset/within/distance требуют предшествующего content
        if kwl in {"depth", "offset", "within", "distance"} and last_kind != "content":
            notes.append(f"вырезан {kw} без предшествующего content")
            continue

        # нейтральные опции
        out.append(opt + ";")
        if kwl in CONTENT_MODIFIERS:
            # контент-модификаторы не меняют контекст
            pass
        elif kwl in {"flow", "flowbits", "flowint", "xbits", "threshold", "detection_filter",
                     "tag", "priority", "classtype", "metadata", "reference", "sid", "rev",
                     "gid", "msg", "target", "noalert", "filestore", "fileext",
                     "app-layer-protocol", "ip_proto", "ssl_state", "tls.state",
                     "stream_reassemble", "stream_realign", "snff_int"}:
            # мета-опции: не трогают контекст совпадений
            pass
        else:
            last_kind = "other" if last_kind != "buffer" else last_kind

    if not out:
        return ConvertResult(dropped=True, notes=["пустое тело"])
    if saw_request_buf and to_client:
        return ConvertResult(dropped=True, notes=[DIRECTION_CONFLICT])
    hdr_txt = f"{action} {proto} {sip} {sport} {direction or '->'} {dip} {dport} "
    return ConvertResult(hdr_txt + "(" + " ".join(out) + ")", notes)


if __name__ == "__main__":
    tests = [
        # Snort 3: sticky+inline
        'alert http $HOME_NET any -> $EXTERNAL_NET any (msg:"t1"; flow:to_server,established; http_uri; content:"/x",fast_pattern,nocase; sid:1; rev:1;)',
        # payload bufferlen
        'alert tcp $EXTERNAL_NET any -> $HOME_NET any (msg:"t2"; flow:to_client,established; bufferlen:19; content:"|31 36 00|",depth 3,fast_pattern,nocase; sid:2; rev:1;)',
        # Snort 3 -> dot switch
        'alert http $EXTERNAL_NET any -> $HOME_NET any (msg:"t3"; flow:to_server,established; http_uri; content:"/bot",depth 4,fast_pattern,nocase; content:"/sendMessage",nocase; http_host; content:"api.telegram.org",nocase; http_client_body; content:"Antarctida"; nocase; sid:3; rev:1;)',
        # BadBlue: bsize then legacy pre-content
        'alert tcp $EXTERNAL_NET any -> $HTTP_SERVERS $HTTP_PORTS (msg:"t4"; flow:to_server,established; http_raw_uri; bsize:>250; http_uri; content:"ext.dll"; sid:4; rev:1;)',
        # SIP
        'alert udp $EXTERNAL_NET any -> $HOME_NET any (msg:"t5"; flow:to_server; content:"INVITE"; fast_pattern; nocase; sip_method:invite; sid:5; rev:1;)',
        # dnp3_ind quotes
        'alert tcp $EXTERNAL_NET 20000 -> $HOME_NET any (msg:"t6"; flow:to_client,established; dnp3_ind:"device_trouble"; sid:6; rev:1;)',
        # file proto + soid + service
        'alert file $EXTERNAL_NET any -> $HOME_NET any (msg:"t7"; file_data; content:"MZ"; soid:3; service:http; sid:7; rev:1;)',
        # конфликт направления
        'alert http $EXTERNAL_NET any -> $HOME_NET any (msg:"t8"; flow:to_client,established; http_header; content:"X"; sid:8; rev:1;)',
    ]
    for t in tests:
        r = convert_rule(t)
        print(("DROP " if r.dropped else "OK   ") + (r.raw or "") + ("  | " + "; ".join(r.notes) if r.notes else ""))
