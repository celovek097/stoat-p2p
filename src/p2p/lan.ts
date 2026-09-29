// Zero-configuration discovery of other nodes on the local network using
// a small UDP multicast beacon.

import { createSocket, type Socket } from "node:dgram";

const GROUP = "239.255.47.70";
const PORT = 47470;
const INTERVAL = 10_000;

export class LanDiscovery {
  readonly #node: string;
  readonly #port: number;
  readonly #onPeer: (url: string) => void;
  readonly #log: (level: "info" | "debug" | "warn", message: string) => void;
  #socket: Socket | undefined;
  #timer: NodeJS.Timeout | undefined;
  readonly #seen = new Map<string, number>();

  constructor(
    node: string,
    port: number,
    onPeer: (url: string) => void,
    log: (level: "info" | "debug" | "warn", message: string) => void,
  ) {
    this.#node = node;
    this.#port = port;
    this.#onPeer = onPeer;
    this.#log = log;
  }

  start(): void {
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    this.#socket = socket;
    socket.on("error", (error) => {
      this.#log("debug", `LAN discovery unavailable: ${error.message}`);
      this.stop();
    });
    socket.on("message", (data, rinfo) => {
      try {
        const beacon = JSON.parse(data.toString());
        if (beacon.t !== "stoat-p2p" || beacon.node === this.#node || !Number.isInteger(beacon.port)) return;
        const last = this.#seen.get(beacon.node) ?? 0;
        if (Date.now() - last < 60_000) return;
        this.#seen.set(beacon.node, Date.now());
        const host = rinfo.family === "IPv6" ? `[${rinfo.address}]` : rinfo.address;
        this.#log("info", `found node on LAN at ${host}:${beacon.port}`);
        this.#onPeer(`ws://${host}:${beacon.port}/p2p`);
      } catch {
        // not ours
      }
    });
    socket.bind(PORT, () => {
      try {
        socket.addMembership(GROUP);
        socket.setMulticastTTL(1);
      } catch (error) {
        this.#log("debug", `LAN multicast unavailable: ${(error as Error).message}`);
      }
      const beacon = () => {
        const payload = Buffer.from(JSON.stringify({ t: "stoat-p2p", node: this.#node, port: this.#port }));
        socket.send(payload, PORT, GROUP, () => {});
      };
      beacon();
      this.#timer = setInterval(beacon, INTERVAL);
    });
  }

  stop(): void {
    clearInterval(this.#timer);
    try {
      this.#socket?.close();
    } catch {
      // already closed
    }
    this.#socket = undefined;
  }
}
