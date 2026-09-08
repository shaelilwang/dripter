#!/usr/bin/env python3
"""Static server for the harness, with caching disabled.

python -m http.server sends no Cache-Control, so browsers apply heuristic
freshness and happily serve a stale src/*.js while harness.html is fresh --
which silently tests code you already changed.
"""
import functools, http.server, os, sys

class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, *a):
        pass

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    handler = functools.partial(NoCache, directory=root)
    print(f'serving {root} on http://localhost:{port} (no-cache)')
    http.server.ThreadingHTTPServer(('127.0.0.1', port), handler).serve_forever()
