// "Bonfire": the Stoat events WebSocket (protocol version 1, JSON).
// Translates World changes into the events stoat.js / the web client expect.

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { type WebSocket, WebSocketServer } from "ws";

import { savedChannelId } from "../core/event.ts";
import { has, Permission } from "../state/permissions.ts";
import { channelPermissions } from "../state/server.ts";
import type { WorldChange } from "../state/world.ts";
import type { StoatNode } from "../node.ts";
import type { Account, Session } from "./accounts.ts";
import type { Json } from "./serialize.ts";

interface Connection {
  ws: WebSocket;
  account: Account;
  session: Session;
  servers: Set<string>;
  channels: Set<string>;
}

export class Bonfire {
  readonly #node: StoatNode;
  readonly #wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  readonly connections = new Set<Connection>();

  constructor(node: StoatNode) {
    this.#node = node;
    node.world.on("change", (change: WorldChange) => this.#onChange(change));
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#accept(ws, req));
  }

  close(): void {
    for (const connection of this.connections) connection.ws.terminate();
    this.#wss.close();
  }

  onlineUsers(): Set<string> {
    return new Set([...this.connections].map((c) => c.account.id));
  }

  #accept(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    const token = url.searchParams.get("token");
    let authenticated = false;

    const authenticate = (token: string | null) => {
      const auth = this.#node.accounts.byToken(token);
      if (!auth) {
        ws.send(JSON.stringify({ type: "Error", data: { type: "InvalidSession" } }));
        ws.close();
        return;
      }
      if (!auth.account.onboarded) {
        ws.send(JSON.stringify({ type: "Error", data: { type: "OnboardingNotFinished" } }));
        ws.close();
        return;
      }
      authenticated = true;
      const connection: Connection = { ws, account: auth.account, session: auth.session, servers: new Set(), channels: new Set() };
      const wasOnline = this.#node.presence.isOnline(auth.account.id);
      this.connections.add(connection);
      ws.send(JSON.stringify({ type: "Authenticated" }));
      ws.send(JSON.stringify(this.#ready(connection)));
      if (!wasOnline) this.#node.presence.changed(auth.account.id);
      ws.on("close", () => {
        this.connections.delete(connection);
        if (!this.#node.presence.isOnline(auth.account.id)) this.#node.presence.changed(auth.account.id);
      });
      ws.on("message", (raw) => this.#onClientMessage(connection, raw.toString()));
    };

    if (token) authenticate(token);
    else {
      ws.once("message", (raw) => {
        try {
          const message = JSON.parse(raw.toString());
          if (message.type === "Authenticate") authenticate(message.token);
          else ws.close();
        } catch {
          ws.close();
        }
      });
      setTimeout(() => !authenticated && ws.close(), 10_000).unref();
    }
  }

  #onClientMessage(connection: Connection, raw: string): void {
    let message: Json;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    switch (message.type) {
      case "Ping":
        connection.ws.send(JSON.stringify({ type: "Pong", data: message.data }));
        break;
      case "BeginTyping":
      case "EndTyping":
        if (typeof message.channel === "string") {
          this.#node.typing(connection.account.id, message.channel, message.type === "BeginTyping");
        }
        break;
    }
  }

  // Ready -----------------------------------------------------------------------

  #ready(connection: Connection): Json {
    const node = this.#node;
    const s = node.serializer;
    const me = connection.account.id;
    const userIds = new Set<string>([me]);
    const servers: Json[] = [];
    const channels: Json[] = [];
    const members: Json[] = [];
    const emojis: Json[] = [];

    for (const state of node.world.serversOf(me)) {
      connection.servers.add(state.id);
      servers.push(s.server(state));
      for (const channel of Object.values(state.snap.channels)) {
        channels.push(s.serverChannel(channel));
        connection.channels.add(channel.id);
      }
      members.push(s.member(state.id, state.snap.members[me]!));
      for (const user of Object.keys(state.snap.members)) userIds.add(user);
      for (const emoji of Object.values(state.snap.emojis)) emojis.push(s.emoji(state.id, emoji));
    }

    for (const dm of node.dmChannelsOf(me)) {
      channels.push(s.channel(dm)!);
      connection.channels.add(dm.channel);
      for (const user of dm.users) userIds.add(user);
    }
    for (const relation of s.relationsOf(me)) userIds.add(relation._id as string);

    const saved = savedChannelId(me);
    if (node.world.lastMessageId(saved) || node.accounts.openDms(me).includes(saved)) {
      channels.push(s.savedMessages(me));
      connection.channels.add(saved);
    }

    return {
      type: "Ready",
      users: [...userIds].map((id) => s.user(id, me)),
      servers,
      channels,
      members,
      emojis,
      voice_states: [],
      policy_changes: [],
    };
  }

  // Outgoing events ---------------------------------------------------------------

  sendTo(user: string, event: Json, exceptSession?: string): void {
    const data = JSON.stringify(event);
    for (const connection of this.connections) {
      if (connection.account.id === user && connection.session.id !== exceptSession) connection.ws.send(data);
    }
  }

  broadcast(event: Json, filter: (connection: Connection) => boolean = () => true): void {
    const data = JSON.stringify(event);
    for (const connection of this.connections) if (filter(connection)) connection.ws.send(data);
  }

  #canView(connection: Connection, channel: string): boolean {
    const ref = this.#node.world.channel(channel);
    if (!ref) return false;
    if (ref.kind === "server") {
      const state = this.#node.world.server(ref.server);
      return (
        !!state &&
        connection.servers.has(ref.server) &&
        has(channelPermissions(state.snap, channel, connection.account.id), Permission.ViewChannel)
      );
    }
    if (ref.kind === "dm") return ref.users.includes(connection.account.id);
    return ref.user === connection.account.id;
  }

  /** Make sure a DM / saved channel is known to the connection before messages arrive. */
  #ensureChannel(connection: Connection, channel: string): void {
    if (connection.channels.has(channel)) return;
    const ref = this.#node.world.channel(channel);
    if (!ref || ref.kind === "server") return;
    connection.channels.add(channel);
    connection.ws.send(JSON.stringify({ type: "ChannelCreate", ...this.#node.serializer.channel(ref) }));
  }

  #onChange(change: WorldChange): void {
    const node = this.#node;
    const s = node.serializer;
    switch (change.type) {
      case "server":
        this.#onServerChange(change.server, change.changes);
        return;

      case "message.create": {
        const message = s.message(change.message);
        for (const connection of this.connections) {
          if (!this.#canView(connection, change.message.channel)) continue;
          this.#ensureChannel(connection, change.message.channel);
          connection.ws.send(JSON.stringify({ type: "Message", ...message }));
        }
        return;
      }
      case "message.update":
        this.broadcast(
          { type: "MessageUpdate", id: change.message.id, channel: change.message.channel, data: change.data, clear: change.clear },
          (c) => this.#canView(c, change.message.channel),
        );
        return;
      case "message.delete":
        this.broadcast({ type: "MessageDelete", id: change.id, channel: change.channel }, (c) => this.#canView(c, change.channel));
        return;
      case "message.react":
        this.broadcast(
          {
            type: change.on ? "MessageReact" : "MessageUnreact",
            id: change.id,
            channel_id: change.channel,
            user_id: change.user,
            emoji_id: change.emoji,
          },
          (c) => this.#canView(c, change.channel),
        );
        return;
      case "message.clear":
        this.broadcast(
          { type: "MessageRemoveReaction", id: change.id, channel_id: change.channel, emoji_id: change.emoji },
          (c) => this.#canView(c, change.channel),
        );
        return;

      case "profile": {
        const data = s.profileFields(change.profile);
        const clear: string[] = [];
        if (change.previous?.avatar && !change.profile.avatar) clear.push("Avatar");
        if (change.previous?.display_name && !change.profile.display_name) clear.push("DisplayName");
        if (change.previous?.status?.text && !change.profile.status?.text) clear.push("StatusText");
        if (change.previous?.pronouns && !change.profile.pronouns) clear.push("Pronouns");
        this.broadcast({ type: "UserUpdate", id: change.user, data, clear });
        return;
      }

      case "dm":
        for (const connection of this.connections) {
          if (change.users.includes(connection.account.id)) this.#ensureChannel(connection, change.channel);
        }
        return;

      case "relation":
        for (const connection of this.connections) {
          const me = connection.account.id;
          if (!change.users.includes(me)) continue;
          const other = change.users[0] === me ? change.users[1] : change.users[0];
          connection.ws.send(
            JSON.stringify({ type: "UserRelationship", id: me, user: s.user(other, me), status: node.world.relationship(me, other) }),
          );
        }
        return;
    }
  }

  #onServerChange(serverId: string, changes: import("../state/diff.ts").ServerChange[]): void {
    const node = this.#node;
    const s = node.serializer;
    const state = node.world.servers.get(serverId)!;
    const members = (c: Connection) => c.servers.has(serverId);

    for (const change of changes) {
      switch (change.kind) {
        case "server.create":
        case "member.join": {
          const joined = change.kind === "server.create" ? state.snap.server?.owner : change.user;
          for (const connection of this.connections) {
            if (connection.account.id === joined && !connection.servers.has(serverId) && node.world.server(serverId)) {
              connection.servers.add(serverId);
              const channels = Object.values(state.snap.channels).map((c) => s.serverChannel(c));
              for (const channel of Object.keys(state.snap.channels)) connection.channels.add(channel);
              connection.ws.send(JSON.stringify({ type: "ServerCreate", id: serverId, server: s.server(state), channels }));
              for (const emoji of Object.values(state.snap.emojis)) {
                connection.ws.send(JSON.stringify({ type: "EmojiCreate", ...s.emoji(serverId, emoji) }));
              }
            }
          }
          if (change.kind === "member.join") {
            this.broadcast({ type: "ServerMemberJoin", id: serverId, user: change.user }, members);
          }
          break;
        }
        case "member.leave":
          this.broadcast({ type: "ServerMemberLeave", id: serverId, user: change.user }, members);
          for (const connection of this.connections) {
            if (connection.account.id === change.user) connection.servers.delete(serverId);
          }
          break;
        case "server.update":
          this.broadcast({ type: "ServerUpdate", id: serverId, data: s.serverData(change.data), clear: change.clear }, members);
          break;
        case "server.delete":
          this.broadcast({ type: "ServerDelete", id: serverId }, members);
          for (const connection of this.connections) connection.servers.delete(serverId);
          break;
        case "channel.create":
          for (const connection of this.connections) if (members(connection)) connection.channels.add(change.channel.id);
          this.broadcast({ type: "ChannelCreate", ...s.serverChannel(change.channel) }, members);
          break;
        case "channel.update":
          this.broadcast({ type: "ChannelUpdate", id: change.channel.id, data: s.channelData(change.data), clear: change.clear }, members);
          break;
        case "channel.delete":
          this.broadcast({ type: "ChannelDelete", id: change.channel }, members);
          break;
        case "role.update":
          this.broadcast({ type: "ServerRoleUpdate", id: serverId, role_id: change.role, data: s.role(change.data) }, members);
          break;
        case "role.delete":
          this.broadcast({ type: "ServerRoleDelete", id: serverId, role_id: change.role }, members);
          break;
        case "member.update":
          this.broadcast(
            { type: "ServerMemberUpdate", id: { server: serverId, user: change.user }, data: s.memberData(change.data), clear: change.clear },
            members,
          );
          break;
        case "emoji.create":
          this.broadcast({ type: "EmojiCreate", ...s.emoji(serverId, change.emoji) }, members);
          break;
        case "emoji.delete":
          this.broadcast({ type: "EmojiDelete", id: change.emoji }, members);
          break;
        case "system.add": {
          const message = node.world.message(change.message.channel, change.message.id);
          if (message) {
            this.broadcast({ type: "Message", ...s.message(message) }, (c) => this.#canView(c, change.message.channel));
          }
          break;
        }
        case "system.remove":
          this.broadcast({ type: "MessageDelete", id: change.message.id, channel: change.message.channel }, members);
          break;
      }
    }
  }
}
