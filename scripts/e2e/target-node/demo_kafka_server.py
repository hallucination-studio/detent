"""Small TCP service for process and socket inspection on the managed host."""

import argparse
from socketserver import BaseRequestHandler, TCPServer


class DemoKafkaHandler(BaseRequestHandler):
    def handle(self):
        self.request.sendall(b"demo-kafka\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    TCPServer.allow_reuse_address = True
    with TCPServer(("0.0.0.0", args.port), DemoKafkaHandler) as server:
        server.serve_forever()
