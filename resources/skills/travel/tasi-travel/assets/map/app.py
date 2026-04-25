import os
import re
import json
import time
import threading
from hashlib import sha256
from typing import Iterator, List, Dict, Any, Optional
from flask import Flask, request, jsonify, send_from_directory, Response, stream_with_context
import requests
from dotenv import load_dotenv

# 加载 .env 文件中的环境变量
load_dotenv()

app = Flask(__name__, static_folder=None)

# 从环境变量中获取腾讯地图的 Key
# 兼容两种变量名，优先读取 TENCENT_KEY。
TENCENT_KEY = os.getenv('TENCENT_KEY') or os.getenv('TENCENT_MAP_KEY')
if not TENCENT_KEY:
    print(
        "警告: 未找到腾讯地图 API Key。"
        "请在 .env 或环境变量中设置 TENCENT_KEY 或 TENCENT_MAP_KEY。"
    )


def _missing_tencent_key_response(status_code: int = 500):
    return jsonify({
        "error": "地图服务未配置API Key",
        "error_code": "TENCENT_KEY_MISSING",
        "action_required": "set_env_or_disable_map",
        "accepted_env_vars": ["TENCENT_KEY", "TENCENT_MAP_KEY"],
        "how_to_fix": [
            "在项目根目录 .env 文件设置 TENCENT_KEY=<your_key> 或 TENCENT_MAP_KEY=<your_key>",
            "或在启动前设置系统环境变量 TENCENT_KEY/TENCENT_MAP_KEY",
            "如果本次不需要地图，请在请求中关闭 map_render_request.map_enabled"
        ]
    }), status_code


CACHE_DIR = os.path.join(os.path.dirname(__file__), 'cache')
DIRECTION_CACHE_PATH = os.path.join(CACHE_DIR, 'direction_cache.json')
DIRECTION_CACHE_LOCK = threading.Lock()
DEFAULT_ROUTE_CACHE_TTL_SECONDS = 24 * 60 * 60
TRANSIT_ROUTE_CACHE_TTL_SECONDS = 30 * 60
MAX_DIRECTION_CACHE_ITEMS = 3000


def _ensure_cache_dir() -> None:
    if not os.path.isdir(CACHE_DIR):
        os.makedirs(CACHE_DIR, exist_ok=True)


def _load_direction_cache() -> Dict[str, Any]:
    _ensure_cache_dir()
    if not os.path.isfile(DIRECTION_CACHE_PATH):
        return {}
    try:
        with open(DIRECTION_CACHE_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except Exception as e:
        print(f"警告: 读取路线缓存失败，将使用空缓存: {e}")
    return {}


def _save_direction_cache(cache_data: Dict[str, Any]) -> None:
    _ensure_cache_dir()
    temp_path = f"{DIRECTION_CACHE_PATH}.tmp"
    with open(temp_path, 'w', encoding='utf-8') as f:
        json.dump(cache_data, f, ensure_ascii=False)
    os.replace(temp_path, DIRECTION_CACHE_PATH)


def _make_direction_cache_key(mode: str, origin: str, destination: str) -> str:
    raw_key = f"{mode}|{origin}|{destination}"
    return sha256(raw_key.encode('utf-8')).hexdigest()


def _get_route_ttl_seconds(mode: str) -> int:
    if mode == 'transit':
        return TRANSIT_ROUTE_CACHE_TTL_SECONDS
    return DEFAULT_ROUTE_CACHE_TTL_SECONDS


def _prune_direction_cache(now_ts: int) -> None:
    expired = [
        key for key, item in DIRECTION_CACHE.items()
        if not isinstance(item, dict) or item.get('expires_at', 0) <= now_ts
    ]
    for key in expired:
        DIRECTION_CACHE.pop(key, None)

    if len(DIRECTION_CACHE) <= MAX_DIRECTION_CACHE_ITEMS:
        return

    ordered = sorted(
        DIRECTION_CACHE.items(),
        key=lambda kv: kv[1].get('created_at', 0) if isinstance(kv[1], dict) else 0
    )
    remove_count = len(DIRECTION_CACHE) - MAX_DIRECTION_CACHE_ITEMS
    for key, _ in ordered[:remove_count]:
        DIRECTION_CACHE.pop(key, None)


def _get_cached_direction(cache_key: str, now_ts: int) -> Optional[Dict[str, Any]]:
    with DIRECTION_CACHE_LOCK:
        item = DIRECTION_CACHE.get(cache_key)
        if not isinstance(item, dict):
            return None
        if item.get('expires_at', 0) <= now_ts:
            DIRECTION_CACHE.pop(cache_key, None)
            return None
        payload = item.get('payload')
        if not isinstance(payload, dict):
            return None
        return payload


def _set_cached_direction(cache_key: str, payload: Dict[str, Any], ttl_seconds: int, now_ts: int) -> None:
    with DIRECTION_CACHE_LOCK:
        DIRECTION_CACHE[cache_key] = {
            'created_at': now_ts,
            'expires_at': now_ts + max(1, ttl_seconds),
            'payload': payload,
        }
        _prune_direction_cache(now_ts)
        _save_direction_cache(DIRECTION_CACHE)


DIRECTION_CACHE = _load_direction_cache()

# API 端点：代理腾讯地图的方向服务
@app.route('/api/direction')
def direction_proxy():
    if not TENCENT_KEY:
        return _missing_tencent_key_response(500)

    mode = request.args.get('mode')
    origin = request.args.get('from')
    destination = request.args.get('to')
    refresh = (request.args.get('refresh', '').strip().lower() in ['1', 'true', 'yes'])

    if not all([mode, origin, destination]):
        return jsonify({"error": "缺少参数: mode, from, to"}), 400

    api_mode = mode

    # 腾讯地图 API URL
    # 注意：腾讯地图的 transit (公交) 和 edriving (新能源汽车) 模式和其他模式的 URL 不同
    if mode in ['driving', 'walking', 'bicycling', 'ebicycling']:
        base_url = f"https://apis.map.qq.com/ws/direction/v1/{mode}/"
    elif mode == 'edriving':
        base_url = "https://apis.map.qq.com/ws/direction/v1/edriving/"
    elif mode in ['bus', 'metro', 'transfer', 'transit']:
        api_mode = 'transit'
        base_url = "https://apis.map.qq.com/ws/direction/v1/transit/"
    else:
        return jsonify({"error": f"不支持的模式: {mode}"}), 400

    now_ts = int(time.time())
    cache_key = _make_direction_cache_key(api_mode, origin, destination)

    if not refresh:
        cached_payload = _get_cached_direction(cache_key, now_ts)
        if cached_payload is not None:
            return jsonify(cached_payload)

    params = {
        'from': origin,
        'to': destination,
        'key': TENCENT_KEY,
        'output': 'json'
    }

    try:
        response = requests.get(base_url, params=params)
        response.raise_for_status()  # 如果请求失败则引发异常
        payload = response.json()
        _set_cached_direction(cache_key, payload, _get_route_ttl_seconds(api_mode), now_ts)
        return jsonify(payload)
    except requests.exceptions.RequestException as e:
        return jsonify({"error": f"请求地图服务失败: {e}"}), 502

# API 端点：获取地图配置（包括API key）
@app.route('/api/config')
def get_config():
    if not TENCENT_KEY:
        return _missing_tencent_key_response(500)
    return jsonify({"key": TENCENT_KEY})

# API 端点：读取指定的路线 JSON 文件
@app.route('/api/routes')
def get_routes():
    routes_file = request.args.get('file', 'routes.json')

    routes_dir = os.path.join(app.root_path, 'routes')
    if not os.path.isdir(routes_dir):
        return jsonify({"error": "routes 目录不存在"}), 500

    safe_name = (routes_file or '').strip()
    safe_name = safe_name.replace('\\', '/').split('/')[-1]
    if not safe_name:
        safe_name = 'routes.json'
    if not safe_name.lower().endswith('.json'):
        safe_name = f"{safe_name}.json"

    if '..' in safe_name or safe_name.startswith('/'):
        return jsonify({"error": "无效的文件名"}), 400

    file_path = os.path.join(routes_dir, safe_name)
    if not os.path.isfile(file_path):
        available = [f for f in os.listdir(routes_dir) if f.lower().endswith('.json')]
        return jsonify({
            "error": f"文件未找到: {safe_name}",
            "available": available
        }), 404

    return send_from_directory(routes_dir, safe_name)

# 根路径：提供 map.html
@app.route('/')
def index():
    return send_from_directory('.', 'map.html')


@app.route('/map.html')
def map_html():
    return send_from_directory('.', 'map.html')

# ===================== 日志展示 API =====================

LOG_DIR = os.path.join(os.path.dirname(__file__), 'logs')


def _list_session_logs() -> List[Dict]:
    """列出 logs 目录下的 session_*.log 文件，按修改时间倒序"""
    sessions = []
    if not os.path.isdir(LOG_DIR):
        return sessions
    for fname in os.listdir(LOG_DIR):
        if not fname.startswith('session_') or not fname.endswith('.log'):
            continue
        fpath = os.path.join(LOG_DIR, fname)
        try:
            st = os.stat(fpath)
            mtime = int(st.st_mtime)
            size = int(st.st_size)
            # 提取 session_id
            session_id = fname[len('session_'):-len('.log')]
            sessions.append({
                'file': fname,
                'session_id': session_id,
                'mtime': mtime,
                'size': size,
            })
        except OSError:
            continue
    # 按时间倒序
    sessions.sort(key=lambda x: x['mtime'], reverse=True)
    return sessions


def _safe_session_to_path(session: str) -> str:
    """将 session 参数转换为安全的日志文件路径，允许传入完整文件名或 session_id"""
    if not session:
        return ''
    s = session.strip()
    # 仅允许字母、数字、下划线、连字符、点
    if not re.fullmatch(r'[\w\-.]+', s):
        return ''
    if s.endswith('.log'):
        fname = s
    elif s.startswith('session_'):
        fname = f"{s}.log" if not s.endswith('.log') else s
    else:
        fname = f"session_{s}.log"
    fpath = os.path.join(LOG_DIR, fname)
    if os.path.isfile(fpath):
        return fpath
    return ''


LOG_LINE_RE = re.compile(r'^(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[(?P<level>\w+)\] (?P<name>[^:]+): (?P<msg>.*)$')


def _parse_log_stream(lines: List[str]) -> List[Dict]:
    """将日志文本按行解析为结构化事件，处理多行消息（续行）"""
    events: List[Dict] = []
    current = None
    for raw in lines:
        line = raw.rstrip('\n')
        m = LOG_LINE_RE.match(line)
        if m:
            # 先推入之前的累计
            if current is not None:
                events.append(current)
            current = {
                'timestamp': m.group('ts'),
                'level': m.group('level'),
                'name': m.group('name'),
                'message': m.group('msg'),
                'raw': line,
                'is_tool_call': (
                    ('MCP调用' in line) or
                    ('MCP' in line and '调用' in line) or
                    ('工具调用' in line) or
                    ('工具调用返回' in line) or
                    ('返回:' in line and '工具' in line) or
                    ('function_call' in line) or
                    ('发起的调用' in line)
                ),
                'is_user_io': any(k in line for k in ['用户请求', '用户输入', 'UserAgent问题', 'UserAgent反馈', '最终攻略']),
            }
        else:
            # 非首行，作为上一条的续行
            if current is None:
                # 没有首行，作为原始文本存入
                current = {
                    'timestamp': '',
                    'level': 'INFO',
                    'name': 'Unknown',
                    'message': line,
                    'raw': line,
                    'is_tool_call': False,
                    'is_user_io': False,
                }
            else:
                current['message'] += '\n' + line
                current['raw'] += '\n' + line
    if current is not None:
        events.append(current)
    return events


@app.route('/api/logs/sessions')
def api_list_sessions():
    return jsonify({'sessions': _list_session_logs()})


@app.route('/api/logs/file')
def api_read_log_file():
    session = request.args.get('session', '').strip()
    tail = int(request.args.get('tail', '5000') or 5000)
    fpath = _safe_session_to_path(session)
    if not fpath:
        return jsonify({'error': '无效的 session 或文件不存在'}), 400
    try:
        with open(fpath, 'r', encoding='utf-8', errors='replace') as f:
            lines = f.readlines()
        if tail > 0:
            lines = lines[-tail:]
        events = _parse_log_stream(lines)
        return jsonify({'events': events, 'file': os.path.basename(fpath)})
    except Exception as e:
        return jsonify({'error': f'读取日志失败: {e}'}), 500


def _sse_format(data: Dict) -> str:
    import json as _json
    return f"data: {_json.dumps(data, ensure_ascii=False)}\n\n"


@app.route('/api/logs/stream')
def api_stream_log():
    session = request.args.get('session', '').strip()
    poll_interval = float(request.args.get('interval', '0.5') or 0.5)
    fpath = _safe_session_to_path(session)
    if not fpath:
        return jsonify({'error': '无效的 session 或文件不存在'}), 400

    def generate() -> Iterator[str]:
        # 初始偏移移动到文件末尾，避免重复之前内容
        try:
            with open(fpath, 'r', encoding='utf-8', errors='replace') as f:
                f.seek(0, os.SEEK_END)
                buffer: List[str] = []
                last_event = None
                while True:
                    pos = f.tell()
                    line = f.readline()
                    if not line:
                        # 没有新内容，输出缓冲中的事件（解析续行）
                        if buffer:
                            events = _parse_log_stream(buffer)
                            for ev in events:
                                yield _sse_format(ev)
                            buffer.clear()
                        time.sleep(poll_interval)
                        f.seek(pos)
                        continue
                    # 读取到新行，加入缓冲；为了处理多行消息，按块解析
                    buffer.append(line)
                    # 当读取到下一条以 header 开头的行时，立即解析之前的块
                    if LOG_LINE_RE.match(line) and len(buffer) > 1:
                        # 把前面的内容（除最后一行）解析
                        chunk, last = buffer[:-1], buffer[-1:]
                        events = _parse_log_stream(chunk)
                        for ev in events:
                            yield _sse_format(ev)
                        buffer = last
        except GeneratorExit:
            return
        except Exception as e:
            yield _sse_format({'error': f'日志流中断: {e}'})

    return Response(stream_with_context(generate()), mimetype='text/event-stream')


@app.route('/dashboard')
def dashboard_page():
    return send_from_directory('.', 'dashboard.html')

if __name__ == '__main__':
    # 建议使用 waitress 或 gunicorn 在生产环境中运行
    app.run(host='0.0.0.0', port=8123, debug=True)
