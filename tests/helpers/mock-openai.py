"""假的 OpenAI 接口（测试用）：/v1/audio/speech 回一段正弦波 mp3（时长随字数），/v1/images/* 回一张 PNG；每个请求记一行日志"""
import base64, io, json, subprocess, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT, LOG = int(sys.argv[1]), sys.argv[2]


def mp3(seconds):
    import imageio_ffmpeg
    r = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                        f"sine=frequency=440:duration={seconds:.2f}", "-ac", "1", "-ar", "24000", "-f", "mp3", "-"], capture_output=True)
    return r.stdout


class H(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        rec = {"path": self.path, "auth": self.headers.get("Authorization")}
        if self.path.endswith("/audio/speech"):
            j = json.loads(body)
            rec.update({"model": j.get("model"), "voice": j.get("voice"), "input": j.get("input"), "instructions": j.get("instructions")})
            out, ctype = mp3(max(0.6, len(j.get("input", "")) * 0.12)), "audio/mpeg"
        else:
            from PIL import Image
            buf = io.BytesIO(); Image.new("RGB", (1536, 1024), (90, 120, 200)).save(buf, "PNG")
            out, ctype = json.dumps({"data": [{"b64_json": base64.b64encode(buf.getvalue()).decode()}]}).encode(), "application/json"
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        self.send_response(200); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(out))); self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


HTTPServer(("127.0.0.1", PORT), H).serve_forever()
