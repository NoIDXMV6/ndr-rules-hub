#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────────────────────
# osd-pack-generator.py — генератор каталога дашбордов OpenSearch Dashboards
# для clearNDR (проект NDR Rules Hub).
#
# Создаёт файлы scripts/osd-packs/<key>.json — наборы saved-объектов
# (dashboard + visualization) в классическом формате Kibana 7, совместимом с
# OSD 3.x (такой же формат используют штатные дашборды SELKS/clearNDR — 522
# объекта загружаются в .kibana напрямую).
#
# В файлах-пакетах поля оставлены плейсхолдерами и подставляются при импорте
# (clearndr-osd-dashboard-import.sh) по фактическим маппингам кластера:
#   __IP__      — id index-pattern (найден/создан при импорте)
#   __TS__      — поле времени (timestamp | @timestamp)
#   __F:key__   — фактическое поле события (src_ip, http_host, dns_name, …)
#
# Запуск:  python3 scripts/osd-pack-generator.py  (пересоздаёт все пакеты)
# ─────────────────────────────────────────────────────────────────────────────
import json
import os

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "osd-packs")

IP_REF = "__IP__"
TS = "__F:ts__"


def search_src(filter_field=None, filter_value=None):
    src = {"indexRefName": "index_0", "filter": []}
    if filter_field and filter_value:
        src["filter"] = [{
            "meta": {"index": IP_REF, "negate": False, "disabled": False, "alias": "",
                     "key": filter_field, "value": filter_value,
                     "params": {"query": filter_value}, "type": "phrase"},
            "query": {"match": {filter_field: {"query": filter_value, "type": "phrase"}}},
            "$state": {"store": "appState"},
        }]
    return src


def metric_agg(id="1", field=None, typ="count", label=None):
    a = {"id": id, "enabled": True, "type": typ, "schema": "metric", "params": {}}
    if field:
        a["params"] = {"field": field}
    if label:
        a["params"]["customLabel"] = label
    return a


def date_hist(id="2", group_field=None, filter_q=None):
    p = {"field": TS, "interval": "auto", "min_doc_count": 1, "extended_bounds": {}}
    if filter_q:
        p["filters"] = {"filters": {filter_q: {"query_string": {"query": filter_q}}}}
    return {"id": id, "enabled": True, "type": "date_histogram", "schema": "segment", "params": p}


def terms(id, field, size=10, label=None, group_schema="bucket"):
    return {
        "id": id, "enabled": True, "type": "terms", "schema": group_schema,
        "params": {
            "field": field, "size": size,
            "orderAgg": {"id": id + "-order", "enabled": True, "type": "count",
                         "schema": "orderAgg", "params": {}},
            "order": "desc", "orderBy": id + "-order",
            "otherBucket": False, "otherBucketLabel": "Другое",
            "missingBucket": False, "missingBucketLabel": "Отсутствует",
            "min_doc_count": 1, "customLabel": label or field,
        },
    }


def vis(vid, title, vtype, aggs, params=None, filter_field=None, filter_value=None):
    if vtype == "histogram":
        p = {
            "type": "histogram", "grid": {"categoryLines": False},
            "categoryAxes": [{"id": "CategoryAxis-1", "type": "category", "position": "bottom",
                              "show": True, "style": {}, "scale": {"type": "linear"},
                              "labels": {"show": True, "truncate": 100},
                              "title": {"text": TS}}],
            "valueAxes": [{"id": "ValueAxis-1", "name": "LeftAxis-1", "type": "value",
                           "position": "left", "show": True, "style": {},
                           "scale": {"type": "linear", "mode": "normal"},
                           "labels": {"show": True}, "title": {"text": "Count"}}],
            "seriesParams": [{"show": True, "type": "histogram", "mode": "stacked",
                              "data": {"label": "Count", "id": "1"},
                              "valueAxis": "ValueAxis-1",
                              "drawLinesBetweenPoints": True, "showCircles": True}],
            "addTooltip": True, "addLegend": True, "legendPosition": "right",
            "times": [], "addTimeMarker": False,
        }
    elif vtype == "table":
        p = {"perPage": 10, "showPartialRows": False, "showMetricsAtAllLevels": False,
             "sort": {"columnIndex": None, "direction": None},
             "showTotal": False, "totalFunc": "sum"}
    elif vtype == "pie":
        p = {"type": "pie", "addTooltip": True, "addLegend": True,
             "legendPosition": "right", "isDonut": True,
             "labels": {"show": False, "values": True, "last_level": True, "truncate": 100}}
    elif vtype == "metric":
        p = {"addTooltip": True, "addLegend": False, "style": {"fontSize": 40}}
    else:
        raise ValueError(vtype)
    if params:
        p.update(params)
    return {
        "id": vid, "type": "visualization", "version": 1,
        "attributes": {
            "title": title,
            "visState": json.dumps({"title": title, "type": vtype, "params": p, "aggs": aggs},
                                   ensure_ascii=False),
            "uiStateJSON": "{}",
            "description": "Создано NDR Rules Hub (pack)",
            "kibanaSavedObjectMeta": {
                "searchSourceJSON": json.dumps(search_src(filter_field, filter_value),
                                               ensure_ascii=False)
            },
        },
        "references": [{"id": IP_REF, "name": "index_0", "type": "index-pattern"}],
    }


def dashboard(did, title, desc, panels):
    """panels: [(vis_obj, x, y, w, h)]"""
    panels_json, refs = [], []
    for i, (v, x, y, w, h) in enumerate(panels, 1):
        panels_json.append({
            "panelIndex": str(i), "gridData": {"x": x, "y": y, "w": w, "h": h, "i": str(i)},
            "embeddableConfig": {}, "id": v["id"], "type": "visualization", "version": "3.3.0",
        })
        refs.append({"id": v["id"], "name": "panel_%d" % i, "type": "visualization"})
    return {
        "id": did, "type": "dashboard", "version": 1,
        "attributes": {
            "title": title, "hits": 0, "description": desc,
            "panelsJSON": json.dumps(panels_json, ensure_ascii=False),
            "optionsJSON": json.dumps({"hidePanelTitles": False, "useMargins": True}),
            "timeRestore": False,
        },
        "references": refs,
    }


def pack(key, title, desc, objects):
    return {
        "key": key, "title": title, "description": desc,
        "indexPattern": {"id": "ndr-logstash-pattern", "title": "logstash-*", "timeFieldName": TS},
        "objects": objects,
    }


# ── определение пакетов ──────────────────────────────────────────────────────
def build_traffic():
    v = []
    v.append(vis("ndr-pack-traffic-m01", "Всего событий", "metric", [metric_agg()]))
    v.append(vis("ndr-pack-traffic-h01", "События по времени", "histogram",
                 [metric_agg(), date_hist("2")]))
    v.append(vis("ndr-pack-traffic-p01", "Транспорт (proto)", "pie",
                 [metric_agg(), terms("2", "__F:proto__", 8, "Транспорт")]))
    v.append(vis("ndr-pack-traffic-t01", "Топ источников (talkers)", "table",
                 [metric_agg(), terms("2", "__F:src_ip__", 10, "Источник")]))
    v.append(vis("ndr-pack-traffic-t02", "Топ портов назначения", "table",
                 [metric_agg(), terms("2", "__F:dst_port__", 10, "Порт назначения")]))
    v.append(vis("ndr-pack-traffic-t03", "Топ протоколов приложения", "table",
                 [metric_agg(), terms("2", "__F:app_proto__", 10, "Протокол")]))
    panels = [(v[0], 0, 0, 12, 8), (v[1], 12, 0, 36, 8),
              (v[2], 0, 8, 16, 15), (v[3], 16, 8, 16, 15), (v[4], 32, 8, 16, 15),
              (v[5], 0, 23, 48, 13)]
    obj = v + [dashboard("ndr-pack-traffic", "NDR · Обзор трафика",
                         "Топ говорящих, порты, транспорт и динамика событий (logstash-*)", panels)]
    return pack("traffic", "Обзор трафика",
                "Топ-источники, порты назначения, транспорт, динамика событий.",
                obj)


def build_http():
    f = ("__F:event_type__", "http")
    v = []
    v.append(vis("ndr-pack-http-h01", "HTTP-события по времени", "histogram",
                 [metric_agg(), date_hist("2")], filter_field=f[0], filter_value=f[1]))
    v.append(vis("ndr-pack-http-p01", "Методы", "pie",
                 [metric_agg(), terms("2", "__F:http_method__", 8, "Метод")],
                 filter_field=f[0], filter_value=f[1]))
    v.append(vis("ndr-pack-http-t01", "Топ хостов", "table",
                 [metric_agg(), terms("2", "__F:http_host__", 10, "Хост")],
                 filter_field=f[0], filter_value=f[1]))
    v.append(vis("ndr-pack-http-t02", "Топ URL", "table",
                 [metric_agg(), terms("2", "__F:http_url__", 10, "URL")],
                 filter_field=f[0], filter_value=f[1]))
    v.append(vis("ndr-pack-http-t03", "Коды ответа", "table",
                 [metric_agg(), terms("2", "__F:http_status__", 10, "Код ответа")],
                 filter_field=f[0], filter_value=f[1]))
    panels = [(v[0], 0, 0, 48, 10), (v[1], 0, 10, 16, 15),
              (v[2], 16, 10, 16, 15), (v[3], 32, 10, 16, 15), (v[4], 0, 25, 48, 12)]
    return pack("http", "HTTP",
                "Хосты, URL, методы, коды ответа по событиям http.",
                v + [dashboard("ndr-pack-http", "NDR · HTTP",
                               "Активность HTTP-трафика сети", panels)])


def build_dns():
    f = ("__F:event_type__", "dns")
    v = []
    v.append(vis("ndr-pack-dns-h01", "DNS-события по времени", "histogram",
                 [metric_agg(), date_hist("2")], filter_field=f[0], filter_value=f[1]))
    v.append(vis("ndr-pack-dns-t01", "Топ DNS-запросов", "table",
                 [metric_agg(), terms("2", "__F:dns_name__", 10, "Запрос")],
                 filter_field=f[0], filter_value=f[1]))
    v.append(vis("ndr-pack-dns-p01", "Типы запросов", "pie",
                 [metric_agg(), terms("2", "__F:dns_type__", 10, "Тип")],
                 filter_field=f[0], filter_value=f[1]))
    v.append(vis("ndr-pack-dns-t02", "Коды ответа (rcode)", "table",
                 [metric_agg(), terms("2", "__F:dns_rcode__", 10, "rcode")],
                 filter_field=f[0], filter_value=f[1]))
    v.append(vis("ndr-pack-dns-t03", "Топ источников запросов", "table",
                 [metric_agg(), terms("2", "__F:src_ip__", 10, "Источник")],
                 filter_field=f[0], filter_value=f[1]))
    panels = [(v[0], 0, 0, 48, 10), (v[1], 0, 10, 16, 15), (v[2], 16, 10, 16, 15),
              (v[3], 32, 10, 16, 15), (v[4], 0, 25, 48, 12)]
    return pack("dns", "DNS",
                "DNS-запросы, типы, rcode, источники — база для выявления туннелей и C2.",
                v + [dashboard("ndr-pack-dns", "NDR · DNS", "DNS-активность сети", panels)])


def build_tls():
    f = ("__F:event_type__", "tls")
    v = []
    v.append(vis("ndr-pack-tls-h01", "TLS-события по времени", "histogram",
                 [metric_agg(), date_hist("2")], filter_field=f[0], filter_value=f[1]))
    v.append(vis("ndr-pack-tls-t01", "Топ SNI (server_name)", "table",
                 [metric_agg(), terms("2", "__F:tls_sni__", 10, "SNI")],
                 filter_field=f[0], filter_value=f[1]))
    v.append(vis("ndr-pack-tls-p01", "JA3-отпечатки клиентов", "pie",
                 [metric_agg(), terms("2", "__F:ja3__", 8, "JA3")],
                 filter_field=f[0], filter_value=f[1]))
    v.append(vis("ndr-pack-tls-t02", "Топ источников", "table",
                 [metric_agg(), terms("2", "__F:src_ip__", 10, "Источник")],
                 filter_field=f[0], filter_value=f[1]))
    panels = [(v[0], 0, 0, 48, 10), (v[1], 0, 10, 16, 15),
              (v[2], 16, 10, 16, 15), (v[3], 32, 10, 16, 15)]
    return pack("tls", "TLS",
                "SNI, JA3-отпечатки, источники TLS-сессий — выявление вредоносного C2.",
                v + [dashboard("ndr-pack-tls", "NDR · TLS", "TLS-активность сети", panels)])


def build_alerts():
    f = ("__F:event_type__", "alert")
    v = []
    v.append(vis("ndr-pack-alerts-h01", "Алерты по времени (по severity)", "histogram",
                 [metric_agg(), date_hist("2"), terms("3", "__F:alert_sev__", 5, "severity", group_schema="group")],
                 filter_field=f[0], filter_value=f[1]))
    v.append(vis("ndr-pack-alerts-t01", "Топ сигнатур", "table",
                 [metric_agg(), terms("2", "__F:alert_name__", 10, "Сигнатура")],
                 filter_field=f[0], filter_value=f[1]))
    v.append(vis("ndr-pack-alerts-p01", "Категории атак", "pie",
                 [metric_agg(), terms("2", "__F:alert_cat__", 10, "Категория")],
                 filter_field=f[0], filter_value=f[1]))
    v.append(vis("ndr-pack-alerts-t02", "Топ источников алертов", "table",
                 [metric_agg(), terms("2", "__F:src_ip__", 10, "Источник")],
                 filter_field=f[0], filter_value=f[1]))
    v.append(vis("ndr-pack-alerts-t03", "Топ целей алертов", "table",
                 [metric_agg(), terms("2", "__F:dst_ip__", 10, "Цель")],
                 filter_field=f[0], filter_value=f[1]))
    panels = [(v[0], 0, 0, 48, 12), (v[1], 0, 12, 16, 15),
              (v[2], 16, 12, 16, 15), (v[3], 32, 12, 16, 15), (v[4], 0, 27, 48, 12)]
    return pack("alerts", "Алерты Suricata",
                "Сигнатуры, категории, severity, источники и цели — срез event_type=alert.",
                v + [dashboard("ndr-pack-alerts", "NDR · Алерты Suricata",
                               "Сводка срабатываний IDS", panels)])


def build_files():
    f = ("__F:event_type__", "fileinfo")
    v = []
    v.append(vis("ndr-pack-files-m01", "Всего файлов", "metric", [metric_agg()],
                 filter_field=f[0], filter_value=f[1]))
    v.append(vis("ndr-pack-files-t01", "Топ имён файлов", "table",
                 [metric_agg(), terms("2", "__F:file_name__", 10, "Файл")],
                 filter_field=f[0], filter_value=f[1]))
    v.append(vis("ndr-pack-files-p01", "Типы файлов (magic)", "pie",
                 [metric_agg(), terms("2", "__F:file_magic__", 8, "Тип")],
                 filter_field=f[0], filter_value=f[1]))
    v.append(vis("ndr-pack-files-h01", "Передачи файлов по времени", "histogram",
                 [metric_agg(), date_hist("2")], filter_field=f[0], filter_value=f[1]))
    panels = [(v[0], 0, 0, 12, 8), (v[1], 12, 0, 36, 8),
              (v[2], 0, 8, 16, 15), (v[3], 16, 8, 32, 15)]
    return pack("files", "Файлы",
                "Передача файлов в сети: имена, типы (magic), динамика.",
                v + [dashboard("ndr-pack-files", "NDR · Файлы",
                               "Активность fileinfo", panels)])


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    builders = {
        "traffic": build_traffic, "http": build_http, "dns": build_dns,
        "tls": build_tls, "alerts": build_alerts, "files": build_files,
    }
    for key, fn in builders.items():
        p = fn()
        path = os.path.join(OUT_DIR, key + ".json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(p, fh, ensure_ascii=False, indent=1)
        n_dash = sum(1 for o in p["objects"] if o["type"] == "dashboard")
        n_vis = sum(1 for o in p["objects"] if o["type"] == "visualization")
        print("  %-8s -> %s (dashboard=%d, visualization=%d)" % (key, path, n_dash, n_vis))
    print("OK: %d пакета(ов) в %s" % (len(builders), OUT_DIR))


if __name__ == "__main__":
    main()
