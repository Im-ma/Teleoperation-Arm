"""Serve a UI-only preview on loopback. Never imports or connects to robot code."""
import argparse
import json
import math
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

WEB = Path(__file__).resolve().parents[1] / 'web'
JOINTS = ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll', 'gripper']

class Preview(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def end_headers(self):
        # The production app may auto-start a previously permitted camera.
        # This preview explicitly denies capture and has no hardware bridge.
        self.send_header('Permissions-Policy', 'camera=(), microphone=()')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/api/sessions' or path == '/api/telemetry':
            sessions = [{'id': '120000-preview', 'why': 'UI preview sample', 'n': 80}] if self.server.sample_history else []
            data = {'sessions': sessions, 'tiger': False}
            if path == '/api/telemetry':
                rows = [{'target': {j: 40 + 25 * math.sin(i / 12 + n) for n, j in enumerate(JOINTS)},
                         'measured': {j: 40 + 25 * math.sin((i - 1) / 12 + n) for n, j in enumerate(JOINTS)}} for i in range(80)]
                data = {'rows': rows if self.server.sample_history else []}
            payload = json.dumps(data).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(payload)
            return
        if path.startswith('/api/') or path == '/ws':
            self.send_error(404, 'UI preview has no robot bridge')
            return
        if path == '/':
            self.path = '/index.html'
        elif path.startswith('/web/'):
            self.path = self.path.removeprefix('/web')
        else:
            self.send_error(404)
            return
        super().do_GET()

    def do_POST(self):
        self.send_response(204 if urlsplit(self.path).path == '/api/tts' else 405)
        self.end_headers()

    def log_message(self, format, *args):
        pass

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8767)
    parser.add_argument('--sample-history', action='store_true', help='Use clearly labeled synthetic replay data for layout checks')
    args = parser.parse_args()
    print(f'UI-only preview: http://127.0.0.1:{args.port} (robot disconnected)', flush=True)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Preview)
    server.sample_history = args.sample_history
    server.serve_forever()
