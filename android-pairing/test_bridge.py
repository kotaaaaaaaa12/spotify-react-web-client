import importlib.util
import json
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

spec = importlib.util.spec_from_file_location("bridge", Path(__file__).with_name("bridge.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class FakeCloud:
    def __init__(self):
        self.bodies = []

    def request(self, body=None):
        if body is None:
            return {"status": 101, "remoteName": "Spotify Cloud Player 12345678", "publicKey": "fresh-public-key"}
        self.bodies.append(body)
        return {"status": 101, "statusString": "OK", "spotifyError": 0}


class Tests(unittest.TestCase):
    def test_safe_startup_diagnostics(self):
        secret = "PRIVATE-TOKEN"
        for status in (401, 403, 404, 409, 429, 502, 503):
            error = urllib.error.HTTPError("https://private.example/#" + secret, status, secret, {}, None)
            code, message = bridge.startup_failure("cloud_check", error)
            self.assertEqual(code, "cloud_http_" + str(status))
            self.assertNotIn(secret, message)
        code, message = bridge.startup_failure("private_link", ValueError(secret))
        self.assertEqual(code, "invalid_pairing_link")
        self.assertIn("address bar", message)
        self.assertNotIn(secret, message)
        self.assertEqual(bridge.startup_failure("lan_listener", OSError(secret))[0], "wifi_bind_failed")

    def test_private_link(self):
        link = "https://music.example/cloud-pair#id=" + "a" * 32 + "&token=" + "b" * 64
        endpoint, token = bridge.parse_link(link)
        self.assertEqual(endpoint, "https://music.example/api/soloist/bridge?id=" + "a" * 32)
        self.assertNotIn(token, endpoint)
        for value in [link.replace("https:", "http:"), link.replace("music.example", "user@music.example"), link + "&destination=other"]:
            with self.assertRaises(ValueError):
                bridge.parse_link(value)

    def test_dns_records(self):
        packet = bridge.announcement("12345678", "192.168.1.20", 34567)
        self.assertEqual(packet[6:8], b"\x00\x04")
        self.assertIn(b"CPath=/zeroconf", packet)
        self.assertIn(b"\xc0\xa8\x01\x14", packet)
        with self.assertRaises(ValueError):
            bridge.read_name(b"\xc0\x00", 0)

    def test_http_relay_and_action_query(self):
        cloud = FakeCloud()
        paired = threading.Event()
        server = ThreadingHTTPServer(("127.0.0.1", 0), bridge.make_handler(cloud, paired))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f"http://127.0.0.1:{server.server_port}/zeroconf"
        try:
            for _ in range(2):
                self.assertEqual(json.load(urllib.request.urlopen(url + "?action=getInfo"))["publicKey"], "fresh-public-key")
            fields = {"userName": "linked-user", "blob": "opaque-encrypted-blob", "clientKey": "", "tokenType": "accesstoken"}
            body = urllib.parse.urlencode(fields).encode()
            request = urllib.request.Request(url + "?action=addUser&version=2.10.0", body, {"Content-Type": "application/x-www-form-urlencoded"})
            self.assertEqual(json.load(urllib.request.urlopen(request))["status"], 101)
            self.assertTrue(paired.wait(1))
            self.assertEqual(len(cloud.bodies), 1)
            self.assertEqual(urllib.parse.parse_qs(cloud.bodies[0].decode())["action"], ["addUser"])
            for path, data, headers in [("?action=resetUsers", body, {}), ("", body, {"Origin": "https://untrusted.example"}), ("?action=addUser", body + b"&destination=other", {})]:
                request = urllib.request.Request(url + path, data, {"Content-Type": "application/x-www-form-urlencoded", **headers})
                with self.assertRaises(urllib.error.HTTPError):
                    urllib.request.urlopen(request)
            self.assertEqual(len(cloud.bodies), 1)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
