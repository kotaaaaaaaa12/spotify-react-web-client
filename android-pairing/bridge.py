#!/usr/bin/env python3
"""Temporary LAN discovery and ZeroConf relay for a Cloudflare Soloist player."""
import getpass
import ipaddress
import json
import re
import socket
import struct
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SERVICE = "_spotify-connect._tcp.local"
GROUP = "224.0.0.251"
MAX_BODY = 16384


def parse_link(link):
    url = urllib.parse.urlsplit(link.strip())
    values = urllib.parse.parse_qs(url.fragment, strict_parsing=True)
    if (url.scheme != "https" or not url.hostname or url.username or url.password
            or url.port not in (None, 443) or url.path != "/cloud-pair" or url.query
            or set(values) != {"id", "token"} or any(len(v) != 1 for v in values.values())
            or not re.fullmatch(r"[a-f0-9]{32}", values["id"][0])
            or not re.fullmatch(r"[a-f0-9]{64}", values["token"][0])):
        raise ValueError("Invalid pairing link.")
    origin = f"https://{url.netloc}"
    return origin + "/api/soloist/bridge?id=" + values["id"][0], values["token"][0]


def normalize_form(raw):
    values = urllib.parse.parse_qs(raw.decode("utf-8"), keep_blank_values=True, strict_parsing=True)
    allowed = {"action", "userName", "blob", "clientKey", "loginId", "version", "tokenType"}
    if (set(values) - allowed or any(len(v) != 1 for v in values.values())
            or values.get("action") != ["addUser"]
            or any(not values.get(k, [""])[0] for k in ("userName", "blob", "tokenType"))
            or "clientKey" not in values
            or any(re.search(r"[\r\n\x00]", v[0]) for v in values.values())):
        raise ValueError("Invalid pairing request.")
    return urllib.parse.urlencode({k: v[0] for k, v in values.items()}).encode()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Cloud:
    def __init__(self, endpoint, token):
        self.endpoint, self.token = endpoint, token
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, body=None):
        headers = {"Authorization": "Bearer " + self.token, "Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        request = urllib.request.Request(self.endpoint, body, headers, method="GET" if body is None else "POST")
        with self.opener.open(request, timeout=90) as response:
            data = response.read(65537)
            if len(data) > 65536:
                raise ValueError("Cloud response is too large.")
            result = json.loads(data)
            if not isinstance(result, dict):
                raise ValueError("Invalid cloud response.")
            return result


def dns_name(name):
    return b"".join(bytes([len(part.encode())]) + part.encode() for part in name.split(".")) + b"\0"


def read_name(packet, offset, depth=0):
    if depth > 16:
        raise ValueError("Invalid DNS pointer.")
    parts = []
    for _ in range(128):
        if offset >= len(packet):
            raise ValueError("Truncated DNS name.")
        length = packet[offset]
        offset += 1
        if not length:
            return ".".join(parts), offset
        if length & 0xC0 == 0xC0:
            if offset >= len(packet):
                raise ValueError("Truncated DNS pointer.")
            pointer = ((length & 0x3F) << 8) | packet[offset]
            parts.append(read_name(packet, pointer, depth + 1)[0])
            return ".".join(parts), offset + 1
        if length > 63 or offset + length > len(packet):
            raise ValueError("Invalid DNS label.")
        parts.append(packet[offset:offset + length].decode())
        offset += length
    raise ValueError("Invalid DNS name.")


def announcement(identifier, address, port, ttl=120, query_id=0):
    instance = f"cloud-{identifier}.{SERVICE}"
    host = f"spotify-cloud-{identifier}.local"
    def record(name, kind, data, flush=True):
        return dns_name(name) + struct.pack("!HHIH", kind, 0x8001 if flush else 1, ttl, len(data)) + data
    txt = [b"CPath=/zeroconf", b"VERSION=1.0"]
    records = [record(SERVICE, 12, dns_name(instance), False),
               record(instance, 33, struct.pack("!HHH", 0, 0, port) + dns_name(host)),
               record(instance, 16, b"".join(bytes([len(x)]) + x for x in txt)),
               record(host, 1, socket.inet_aton(address))]
    return struct.pack("!HHHHHH", query_id, 0x8400, 0, len(records), 0, 0) + b"".join(records)


class Advertiser:
    def __init__(self, identifier, address, port):
        self.identifier, self.address, self.port = identifier, address, port
        self.done = threading.Event()
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.socket.bind(("", 5353))
        self.socket.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, socket.inet_aton(GROUP) + socket.inet_aton(address))
        self.socket.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(address))
        self.socket.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255)
        self.socket.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_LOOP, 1)
        self.socket.settimeout(1)
        self.thread = threading.Thread(target=self.run, daemon=True)

    def run(self):
        next_announcement = 0
        names = {SERVICE, f"cloud-{self.identifier}.{SERVICE}", f"spotify-cloud-{self.identifier}.local", "_services._dns-sd._udp.local"}
        while not self.done.is_set():
            try:
                if time.monotonic() >= next_announcement:
                    self.socket.sendto(announcement(self.identifier, self.address, self.port), (GROUP, 5353))
                    next_announcement = time.monotonic() + 3
                packet, source = self.socket.recvfrom(65536)
                if len(packet) < 12 or struct.unpack_from("!H", packet, 2)[0] & 0x8000:
                    continue
                count = struct.unpack_from("!H", packet, 4)[0]
                if count > 64:
                    continue
                offset, relevant, unicast = 12, False, source[1] != 5353
                for _ in range(count):
                    name, offset = read_name(packet, offset)
                    if offset + 4 > len(packet):
                        raise ValueError("Truncated DNS question.")
                    _, kind = struct.unpack_from("!HH", packet, offset)
                    offset += 4
                    if name.lower() in names:
                        relevant = True
                        unicast = unicast or bool(kind & 0x8000)
                if relevant:
                    query_id = struct.unpack_from("!H", packet)[0] if source[1] != 5353 else 0
                    self.socket.sendto(announcement(self.identifier, self.address, self.port, query_id=query_id), source if unicast else (GROUP, 5353))
            except socket.timeout:
                pass
            except (OSError, ValueError, UnicodeError):
                if self.done.is_set():
                    break

    def close(self):
        self.done.set()
        try:
            self.socket.sendto(announcement(self.identifier, self.address, self.port, ttl=0), (GROUP, 5353))
        except OSError:
            pass
        self.socket.close()


def make_handler(cloud, paired):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        def log_message(self, *args):
            pass

        def setup(self):
            super().setup()
            self.connection.settimeout(95)

        def send_json(self, data, status=200):
            body = json.dumps(data, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
            self.close_connection = True

        def allowed(self):
            try:
                address = ipaddress.ip_address(self.client_address[0])
                return (address.is_private or address.is_loopback) and not self.headers.get("Origin")
            except ValueError:
                return False

        def do_GET(self):
            url = urllib.parse.urlsplit(self.path)
            query = urllib.parse.parse_qs(url.query, keep_blank_values=True)
            if not self.allowed() or url.path != "/zeroconf" or query.get("action") != ["getInfo"] or set(query) - {"action", "version"}:
                return self.send_json({"status": 303, "statusString": "ERROR-INVALID-ARGUMENTS", "spotifyError": 0}, 400)
            try:
                # Never cache public keys: every request reads the real device.
                self.send_json(cloud.request())
            except (urllib.error.URLError, ValueError, OSError):
                self.send_json({"status": 202, "statusString": "ERROR-LOGIN-FAILED", "spotifyError": 0}, 502)

        def do_POST(self):
            url = urllib.parse.urlsplit(self.path)
            if not self.allowed() or url.path != "/zeroconf" or self.headers.get("Transfer-Encoding") or self.headers.get_content_type() != "application/x-www-form-urlencoded":
                return self.send_json({"status": 303, "statusString": "ERROR-INVALID-ARGUMENTS", "spotifyError": 0}, 400)
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_BODY:
                    raise ValueError("Invalid request length.")
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ValueError("Incomplete request.")
                # Spotify clients may put action/version in the query or form.
                query = urllib.parse.parse_qs(url.query, keep_blank_values=True, strict_parsing=True)
                body = urllib.parse.parse_qs(raw.decode("utf-8"), keep_blank_values=True, strict_parsing=True)
                if set(query) - {"action", "version"} or any(len(v) != 1 for v in query.values()):
                    raise ValueError("Invalid pairing query.")
                for key, value in query.items():
                    if key in body and body[key] != value:
                        raise ValueError("Conflicting pairing fields.")
                    body[key] = value
                if any(len(v) != 1 for v in body.values()):
                    raise ValueError("Duplicate pairing fields.")
                raw = urllib.parse.urlencode({k: v[0] for k, v in body.items()}).encode()
                result = cloud.request(normalize_form(raw))
                self.send_json(result)
                if result.get("status") == 101:
                    paired.set()
            except (urllib.error.URLError, ValueError, OSError):
                self.send_json({"status": 202, "statusString": "ERROR-LOGIN-FAILED", "spotifyError": 0}, 502)
    return Handler


def default_address():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("1.1.1.1", 53))
            return sock.getsockname()[0]
    except OSError:
        return ""


def main():
    print("Spotify Cloud Player — Android pairing bridge")
    print("Soloist and audio playback run in Cloudflare. This tool only relays initial pairing.")
    try:
        link = getpass.getpass("Paste the private Android pairing link: ")
        endpoint, token = parse_link(link)
        cloud = Cloud(endpoint, token)
        print("Cloud site: " + urllib.parse.urlsplit(endpoint).netloc)
        info = cloud.request()
        if info.get("status") != 101 or not isinstance(info.get("deviceID"), str) or not isinstance(info.get("remoteName"), str):
            raise ValueError("Soloist is not ready.")
        default = default_address()
        address = input(f"Android Wi-Fi IPv4 address [{default}]: ").strip() or default
        ip = ipaddress.ip_address(address)
        if ip.version != 4 or not ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_unspecified:
            raise ValueError("A private Wi-Fi IPv4 address is required.")
        paired = threading.Event()
        server = ThreadingHTTPServer((address, 0), make_handler(cloud, paired))
        server.daemon_threads = True
        identifier = re.sub(r"[^a-z0-9]", "", info["deviceID"].lower())[:16]
        if not identifier:
            raise ValueError("Invalid device identity.")
        advertiser = Advertiser(identifier, address, server.server_port)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        advertiser.thread.start()
        print("Open Spotify on this phone, or another phone on the same Wi-Fi.")
        print("Select this device: " + info["remoteName"])
        print("Keep Termux running during pairing. No Soloist API key is needed here.")
        try:
            if paired.wait(20 * 60):
                print("Paired. The session is saved in Cloudflare. You can close Termux.")
            else:
                print("Pairing timed out. Create a new Android pairing link and run this tool again.")
        finally:
            advertiser.close()
            server.shutdown()
            server.server_close()
    except KeyboardInterrupt:
        print("Pairing bridge stopped.")
    except (ValueError, OSError, urllib.error.URLError):
        print("Pairing could not start. Check the private link, Wi-Fi address, and Cloudflare server report.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
