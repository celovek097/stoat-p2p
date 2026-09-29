// Root configuration, local accounts, sessions, onboarding and settings sync.

import { hashPassword, randomToken } from "../../core/crypto.ts";
import { randomUlid } from "../../core/ulid.ts";
import type { StoatNode } from "../../node.ts";
import { TAG_LIMITS } from "../files.ts";
import { ApiError, errors, type RequestContext, type Router } from "../http.ts";
import { asObject, USERNAME_RE } from "./common.ts";

export const VERSION = "0.1.0";

function limits() {
  return {
    outgoing_friend_requests: 10,
    bots: 0,
    message_length: 2000,
    message_attachments: 5,
    servers: 100,
    voice_quality: 16000,
    video: false,
    video_resolution: [1280, 720],
    video_aspect_ratio: [0.3, 2.5],
    file_upload_size_limits: TAG_LIMITS,
  };
}

export function rootConfig(origin: string) {
  const ws = origin.replace(/^http/, "ws");
  return {
    stoat: `${VERSION}-p2p`,
    revolt: `${VERSION}-p2p`,
    features: {
      captcha: { enabled: false, key: "" },
      email: false,
      invite_only: false,
      autumn: { enabled: true, url: `${origin}/autumn` },
      january: { enabled: false, url: "" },
      livekit: { enabled: false, nodes: [] },
      limits: {
        global: {
          group_size: 100,
          message_embeds: 5,
          message_replies: 5,
          message_reactions: 20,
          server_emoji: 100,
          server_roles: 200,
          server_channels: 200,
          body_limit_size: 20_000_000,
          restrict_server_creation: [],
          new_user_hours: 0,
          max_invite_duration_days: 0,
        },
        new_user: limits(),
        default: limits(),
      },
      legal_links: { terms_of_service: "", privacy_policy: "", guidelines: "" },
      assets: "",
    },
    ws: `${ws}/events`,
    app: origin,
    vapid: "",
    p2p: true,
  };
}

const mfaTickets = new Map<string, { user: string; expires: number }>();

function requireTicket(node: StoatNode, ctx: RequestContext): void {
  const token = ctx.req.headers["x-mfa-ticket"];
  const ticket = typeof token === "string" ? mfaTickets.get(token) : undefined;
  if (!ticket || ticket.user !== ctx.account.id || ticket.expires < Date.now()) throw new ApiError(401, "InvalidToken");
  mfaTickets.delete(token as string);
  void node;
}

export function registerAuth(router: Router, node: StoatNode): void {
  router.get("/", (ctx) => rootConfig(ctx.origin), false);

  // Accounts -------------------------------------------------------------------
  router.post(
    "/auth/account/create",
    (ctx) => {
      if (!node.options.registration) throw new ApiError(403, "FeatureDisabled", { feature: "registration" });
      const { email, password } = asObject(ctx.body);
      if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 128) {
        throw new ApiError(400, "IncorrectData", { with: "email" });
      }
      if (typeof password !== "string" || password.length < 8) throw new ApiError(400, "ShortPassword");
      if (node.accounts.byEmail(email)) throw new ApiError(409, "EmailInUse");
      node.accounts.create(email, password);
      return undefined;
    },
    false,
  );

  router.get("/auth/account/", (ctx) => ({ _id: ctx.account.id, email: ctx.account.email }));

  router.patch("/auth/account/change/password", (ctx) => {
    const { password, current_password } = asObject(ctx.body);
    if (!node.accounts.verifyPassword(ctx.account, current_password)) throw errors.invalidCredentials();
    if (typeof password !== "string" || password.length < 8) throw new ApiError(400, "ShortPassword");
    node.accounts.update(ctx.account, { password: hashPassword(password) });
    return undefined;
  });

  router.patch("/auth/account/change/email", (ctx) => {
    const { email, current_password } = asObject(ctx.body);
    if (!node.accounts.verifyPassword(ctx.account, current_password)) throw errors.invalidCredentials();
    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(email)) throw new ApiError(400, "IncorrectData", { with: "email" });
    if (node.accounts.byEmail(email)) throw new ApiError(409, "EmailInUse");
    node.accounts.update(ctx.account, { email: email.trim().toLowerCase() });
    return undefined;
  });

  for (const path of ["/auth/account/reverify", "/auth/account/reset_password"]) {
    router.post(path, () => {
      throw new ApiError(400, "FeatureDisabled", { feature: "email" });
    }, false);
  }
  router.patch("/auth/account/reset_password", () => {
    throw new ApiError(400, "FeatureDisabled", { feature: "email" });
  }, false);
  for (const path of ["/auth/account/delete", "/auth/account/disable"]) {
    router.post(path, () => {
      throw new ApiError(400, "FeatureDisabled", { feature: "account_deletion" });
    });
  }

  // Sessions -------------------------------------------------------------------
  router.post(
    "/auth/session/login",
    (ctx) => {
      const { email, password, friendly_name } = asObject(ctx.body);
      if (typeof email !== "string") throw errors.invalidCredentials();
      const account = node.accounts.byEmail(email);
      if (!account || !node.accounts.verifyPassword(account, password)) throw errors.invalidCredentials();
      const session = node.accounts.login(account, typeof friendly_name === "string" ? friendly_name.slice(0, 64) : "Unknown");
      return {
        result: "Success",
        _id: session.id,
        user_id: account.id,
        token: session.token,
        name: session.name,
        last_seen: new Date(session.lastSeen).toISOString(),
      };
    },
    false,
  );

  router.post("/auth/session/logout", (ctx) => {
    node.accounts.removeSession(ctx.session.id);
    return undefined;
  });

  router.get("/auth/session/all", (ctx) => node.accounts.sessionsOf(ctx.account.id).map((s) => ({ _id: s.id, name: s.name })));

  router.delete("/auth/session/all", (ctx) => {
    const revokeSelf = ctx.query.get("revoke_self") === "true";
    for (const session of node.accounts.sessionsOf(ctx.account.id)) {
      if (revokeSelf || session.id !== ctx.session.id) node.accounts.removeSession(session.id);
    }
    return undefined;
  });

  router.delete("/auth/session/:id", (ctx) => {
    if (!node.accounts.sessionsOf(ctx.account.id).some((s) => s.id === ctx.params.id)) throw errors.notFound();
    node.accounts.removeSession(ctx.params.id!);
    return undefined;
  });

  router.patch("/auth/session/:id", (ctx) => {
    const { friendly_name } = asObject(ctx.body);
    const session = node.accounts.sessionsOf(ctx.account.id).find((s) => s.id === ctx.params.id);
    if (!session || typeof friendly_name !== "string") throw errors.notFound();
    node.accounts.renameSession(session.id, friendly_name.slice(0, 64));
    return { _id: session.id, name: friendly_name.slice(0, 64) };
  });

  // MFA (password only) -----------------------------------------------------------
  router.get("/auth/mfa/", () => ({
    email_otp: false,
    trusted_handover: false,
    email_mfa: false,
    totp_mfa: false,
    security_key_mfa: false,
    recovery_active: false,
  }));
  router.get("/auth/mfa/methods", () => ["Password"]);
  router.put("/auth/mfa/ticket", (ctx) => {
    const { password } = asObject(ctx.body);
    if (!node.accounts.verifyPassword(ctx.account, password)) throw errors.invalidCredentials();
    const token = randomToken();
    mfaTickets.set(token, { user: ctx.account.id, expires: Date.now() + 5 * 60 * 1000 });
    return { _id: randomUlid(), account_id: ctx.account.id, token, validated: true, authorised: true };
  });
  for (const path of ["/auth/mfa/totp", "/auth/mfa/recovery"]) {
    router.post(path, () => {
      throw new ApiError(400, "DisallowedMFAMethod");
    });
    router.put(path, () => {
      throw new ApiError(400, "DisallowedMFAMethod");
    });
  }
  router.delete("/auth/mfa/totp", (ctx) => {
    requireTicket(node, ctx);
    return undefined;
  });

  // Onboarding -----------------------------------------------------------------
  router.get("/onboard/hello", (ctx) => ({ onboarding: !ctx.account.onboarded }));

  router.post("/onboard/complete", (ctx) => {
    if (ctx.account.onboarded) throw new ApiError(403, "AlreadyOnboarded");
    const { username } = asObject(ctx.body);
    if (typeof username !== "string" || username.length < 2 || username.length > 32 || !USERNAME_RE.test(username)) {
      throw new ApiError(400, "InvalidUsername");
    }
    node.accounts.update(ctx.account, { onboarded: true });
    node.publishProfile(ctx.account, { username });
    node.p2p.localUsersChanged();
    return node.serializer.user(ctx.account.id, ctx.account.id);
  });

  // Misc -------------------------------------------------------------------------
  router.post("/policy/acknowledge", () => undefined);
  router.post("/push/subscribe", () => undefined);
  router.post("/push/unsubscribe", () => undefined);
  router.post("/safety/report", () => undefined);

  // Settings sync ------------------------------------------------------------------
  router.post("/sync/settings/fetch", (ctx) => {
    const { keys } = asObject(ctx.body);
    const settings = node.accounts.settings(ctx.account.id);
    const out: Record<string, [number, string]> = {};
    for (const key of Array.isArray(keys) ? keys : []) if (settings[key]) out[key] = settings[key];
    return out;
  });

  router.post("/sync/settings/set", (ctx) => {
    const values = asObject(ctx.body);
    const timestamp = Number(ctx.query.get("timestamp")) || Date.now();
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === "string" && key.length <= 64 && value.length <= 256 * 1024) clean[key] = value;
    }
    node.accounts.setSettings(ctx.account.id, clean, timestamp);
    const update = Object.fromEntries(Object.entries(clean).map(([k, v]) => [k, [timestamp, v]]));
    node.bonfire.sendTo(ctx.account.id, { type: "UserSettingsUpdate", id: ctx.account.id, update }, ctx.session.id);
    return undefined;
  });

  router.get("/sync/unreads", (ctx) =>
    Object.entries(node.accounts.unreads(ctx.account.id)).map(([channel, unread]) => ({
      _id: { channel, user: ctx.account.id },
      last_id: unread.last_id,
      mentions: unread.mentions,
    })),
  );

  // Bots and webhooks are not part of stoat-p2p (yet) ---------------------------------
  router.get("/bots/@me", () => ({ bots: [], users: [] }));
  router.post("/bots/create", () => {
    throw new ApiError(400, "FeatureDisabled", { feature: "bots" });
  });
}
