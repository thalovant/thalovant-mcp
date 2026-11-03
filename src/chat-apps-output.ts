import { ThalovantApiError, ThalovantApiUnreachableError } from "@thalovant/sdk";
import type {
  Bridge,
  BridgeAllowance,
  BridgeChatList,
  BridgeHold,
  BridgeNetworks,
  ChatAppConnector,
  LocalizedText,
} from "@thalovant/sdk";

/**
 * What a model reads about chat apps: connectors, bridges, the allowance and
 * the hints after a refusal.
 *
 * A bridge's token and secrets never reach this server: the API never sends
 * them, and no tool takes them. Each view below is still built from a list of
 * the members the API documents, never by passing the body through, so a
 * member the API adds later (or the platform-only `status.message` and
 * `status.operator_reason`, which an administrator's token is sent) does not
 * reach the model unreviewed. The owner's free-form values -- `settings` and a
 * queued `operation` -- go through the server's secret redaction. Redacting
 * the whole view by key name would hide `secrets_set` and `secrets`, which are
 * names, and `token_updated_at`, which is a time, so it is not done.
 */

export type ChatAppLanguage = "en" | "fr";
type Redact = (value: unknown) => unknown;

/** Where a person creates a bridge or pastes its token and secrets. */
export const CONSOLE_CHAT_APPS =
  "the Thalovant console (Connections > Add connection > Chat apps, or the hub's Chat apps tab)";

/** Where a person replaces a bridge's token or secrets. */
export const CONSOLE_REPLACE_TOKEN =
  "the Thalovant console: open the bot from Connections or the hub's Chat apps tab and use Replace token";

const NO_SECRETS_HERE = "This server never takes a token or secret.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: LocalizedText | null | undefined, language: ChatAppLanguage): string | null {
  if (!value) return null;
  return language === "fr" && value.fr ? value.fr : value.en;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** The settings form a connector's JSON Schema describes, one entry per setting. */
function settingFields(schema: unknown, language: ChatAppLanguage): Array<Record<string, unknown>> {
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  const required = new Set(strings(schema.required));
  return Object.entries(schema.properties).map(([key, raw]) => {
    const property = isRecord(raw) ? raw : {};
    const french = language === "fr" && typeof property["x-title-fr"] === "string" ? property["x-title-fr"] : undefined;
    const field: Record<string, unknown> = {
      key,
      title: french ?? (typeof property.title === "string" ? property.title : key),
      required: required.has(key),
    };
    for (const name of ["type", "format", "description", "pattern", "enum", "default", "minLength", "maxLength"]) {
      if (property[name] !== undefined) field[name] = property[name];
    }
    return field;
  });
}

/** One connector as a model reads it, in one language. */
export function connectorView(connector: ChatAppConnector, language: ChatAppLanguage, redact: Redact): Record<string, unknown> {
  return {
    id: connector.id,
    name: connector.name,
    status: connector.status,
    offered: connector.offered,
    version: connector.version?.version ?? null,
    description: text(connector.description, language),
    setup_steps: text(connector.setup_steps, language),
    // What the console asks the person for: names and labels, never a value.
    secrets: (connector.secrets ?? []).map((secret) => ({
      key: secret.key,
      label: text(secret.label, language),
      description: text(secret.description, language),
      required: secret.required,
    })),
    settings: redact(settingFields(connector.config_schema, language)),
    targets: connector.targets
      ? {
          label: text(connector.targets.label, language),
          pattern: connector.targets.pattern,
          max: connector.targets.max,
          lowercase: connector.targets.lowercase,
          strip_prefix: connector.targets.strip_prefix,
        }
      : null,
    require_mention_fixed: connector.options?.require_mention_fixed ?? false,
    session_scopes: [...(connector.options?.session_scopes ?? [])],
    helpers: [...(connector.helpers ?? [])],
  };
}

export function connectorsOutput(
  connectors: readonly ChatAppConnector[],
  language: ChatAppLanguage,
  redact: Redact,
): Record<string, unknown> {
  return {
    language,
    data: connectors.map((connector) => connectorView(connector, language, redact)),
    next: `Create a bridge, and paste or replace its token or secrets, in ${CONSOLE_CHAT_APPS}. ${NO_SECRETS_HERE} Once it exists, thalovant_list_bridges finds it and the other chat app tools manage it.`,
  };
}

function holdSentence(hold: BridgeHold): string {
  switch (hold.reason) {
    case "plan_limit":
      return `The platform paused it on ${hold.since} because the plan allows fewer running chat apps than the account has (after a downgrade). It resumes on its own, oldest first, once the plan has room; thalovant_resume_bridge resumes it sooner when thalovant_get_bridge_networks shows room.`;
    case "account_suspended":
      return `The platform paused it on ${hold.since} because the account was deactivated; it resumes when the account is reactivated.`;
    default:
      return `The platform paused it on ${hold.since} (${hold.reason}).`;
  }
}

/**
 * A bridge's status in words, from the API's customer-safe `status.reason`,
 * its `hold` and `status.applied`. Never the platform's own message.
 */
export function bridgeStatusSummary(bridge: Pick<Bridge, "status" | "hold" | "paused">): string {
  const status = bridge.status;
  const reason = status?.reason;
  const hold = bridge.hold ?? null;
  const parts: string[] = [];
  switch (reason) {
    case "Setup":
      parts.push("Setting up: no chats are chosen yet, so it does not run. Choose where it answers with thalovant_update_bridge (allowed); thalovant_list_bridge_chats lists the chats it can see.");
      break;
    case "Starting":
      parts.push("Starting: the bridge is on its way or has not reported yet, usually for a minute or two.");
      break;
    case "Connected":
      parts.push("Connected: the bridge is running and answers in its allowed chats.");
      break;
    case "Paused":
      parts.push(hold ? "Paused." : "Paused by its owner: it answers nowhere until thalovant_resume_bridge.");
      break;
    case "Unavailable":
      parts.push("Unavailable: the bridge is deployed but not running, or the platform hit an error. Nothing on the owner's side needs to change; check again later.");
      break;
    case "TokenMissing":
      parts.push(`Token missing: the bridge's token has not reached it. If this lasts more than a few minutes, paste the token again in ${CONSOLE_REPLACE_TOKEN}.`);
      break;
    case "TokenRejected":
      parts.push(`Token rejected: the chat network refused the bridge's credentials. Paste new ones in ${CONSOLE_REPLACE_TOKEN}. ${NO_SECRETS_HERE}`);
      break;
    default:
      parts.push(`${reason ?? "Unknown"}: a status this server does not know yet (phase ${status?.phase ?? "unknown"}).`);
  }
  if (hold) parts.push(holdSentence(hold));
  else if (bridge.paused && reason === "Setup") parts.push("It is paused too, so choosing chats will not start it until thalovant_resume_bridge.");
  else if (bridge.paused && reason !== "Paused") parts.push("It is paused; stopping it may still be on its way.");
  else if (bridge.paused === false && reason === "Paused") parts.push("It is no longer paused; starting again may still be on its way.");
  if (status?.applied === true) parts.push("Every change is applied.");
  else if (status?.applied === false) parts.push("A change is still on its way to the bridge.");
  return parts.join(" ");
}

/** One bridge as a model reads it: the API's members, without the platform-only status fields. */
export function bridgeView(bridge: Bridge, redact: Redact): Record<string, unknown> {
  const status = bridge.status;
  return {
    id: bridge.id,
    hub_id: bridge.hub_id,
    owner_id: bridge.owner_id,
    network: bridge.network,
    connector: bridge.connector
      ? { id: bridge.connector.id, name: bridge.connector.name, version: bridge.connector.version }
      : null,
    state: bridge.state,
    paused: bridge.paused,
    hold: bridge.hold ? { reason: bridge.hold.reason, since: bridge.hold.since } : null,
    status: {
      reason: status?.reason ?? null,
      phase: status?.phase ?? null,
      ready: status?.ready ?? false,
      applied: status?.applied ?? null,
      summary: bridgeStatusSummary(bridge),
    },
    allowed: (bridge.allowed ?? []).map((chat) => ({
      id: chat.id,
      title: chat.title,
      kind: chat.kind,
      guild_id: chat.guild_id,
      guild_name: chat.guild_name,
    })),
    require_mention: bridge.require_mention,
    session_scope: bridge.session_scope,
    settings: redact(bridge.settings ?? {}),
    // Which secrets are stored, by name; their values are never sent.
    secrets_set: strings(bridge.secrets_set),
    bot: bridge.bot
      ? {
          user_id: bridge.bot.user_id,
          username: bridge.bot.username,
          display_name: bridge.bot.display_name,
          application_id: bridge.bot.application_id,
          avatar_url: bridge.bot.avatar_url,
        }
      : null,
    invite_links: bridge.invite_links
      ? { add_to_group: bridge.invite_links.add_to_group, direct_chat: bridge.invite_links.direct_chat }
      : null,
    etag: bridge.etag,
    token_updated_at: bridge.token_updated_at,
    activated_at: bridge.activated_at,
    created_at: bridge.created_at,
    updated_at: bridge.updated_at,
    operation: bridge.operation ? redact(bridge.operation) : null,
  };
}

function allowanceSummary(allowance: BridgeAllowance): string {
  if (!allowance.paid_plan) {
    return `The ${allowance.plan} plan is not a paid plan, and chat apps need one: Free plans get 0, and creating one answers 402. Pausing and deleting a bridge always work.`;
  }
  if (allowance.limit === 0) {
    return `The ${allowance.plan} plan includes no chat apps.`;
  }
  const room = allowance.can_create
    ? `A new one would pass the plan checks (create it in ${CONSOLE_CHAT_APPS}).`
    : "A new one would not pass the plan checks now.";
  return `The ${allowance.plan} plan: ${allowance.used} of ${allowance.limit} chat apps used (set up or running), ${allowance.remaining} left. ${room}`;
}

export function networksOutput(networks: BridgeNetworks, redact: Redact): Record<string, unknown> {
  return {
    networks: (networks.networks ?? []).map((offer) => ({
      network: offer.network,
      name: offer.name,
      status: offer.status,
      offered: offer.offered,
    })),
    allowance: redact({ ...networks.allowance }),
    summary: allowanceSummary(networks.allowance),
  };
}

export function chatsOutput(list: BridgeChatList, redact: Redact): Record<string, unknown> {
  return {
    ...(redact({
      network: list.network,
      manual_entry: list.manual_entry,
      note: list.note,
      data: (list.data ?? []).map((chat) => ({
        id: chat.id,
        title: chat.title,
        kind: chat.kind,
        guild_id: chat.guild_id,
        guild_name: chat.guild_name,
        guild_icon_url: chat.guild_icon_url,
        allowed: chat.allowed,
        encrypted: chat.encrypted,
        selectable: chat.selectable,
      })),
    }) as Record<string, unknown>),
    next: list.manual_entry
      ? "This chat app cannot list its chats: type each id yourself, matching targets.pattern from thalovant_list_chat_app_connectors, in allowed for thalovant_update_bridge."
      : "Pass the chosen rows (id, title, kind, guild_id, guild_name) as allowed to thalovant_update_bridge. allowed replaces the whole list, so keep the chats the bridge already answers in (allowed: true). A row with selectable false cannot be chosen.",
  };
}

/**
 * Setting names a tool refuses to send because they look like a token or
 * secret, at any depth, as dotted paths (`server.auth.token`, `hosts.0.token`).
 * Only names are returned, never values.
 */
export function secretLookingSettings(settings: Record<string, unknown> | undefined, isSecretKey: (key: string) => boolean): string[] {
  const found: string[] = [];
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}.${index}`));
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, nested] of Object.entries(value)) {
      const here = path ? `${path}.${key}` : key;
      if (isSecretKey(key)) found.push(here);
      else visit(nested, here);
    }
  };
  visit(settings, "");
  return found;
}

export function secretSettingsRefusal(names: readonly string[]): string {
  return `Nothing was sent: settings never carry a token or secret, and these setting names look like one: ${names.join(", ")}. Paste tokens and secrets in ${CONSOLE_REPLACE_TOKEN}. ${NO_SECRETS_HERE}`;
}

function named(error: ThalovantApiError, what: string): string {
  const names = error.fields ?? [];
  return names.length ? ` The API named the ${what}: ${names.join(", ")} (values are never repeated).` : "";
}

/**
 * Guidance after a refused chat app call, by the API's code first and then
 * its status. Undefined when there is nothing a hint could add.
 */
export function bridgeErrorHint(error: unknown): string | undefined {
  if (error instanceof ThalovantApiUnreachableError) {
    return "The Thalovant API could not be reached, which says nothing about the bridge: a change may have been made all the same. Read the bridge with thalovant_get_bridge before trying again.";
  }
  if (!(error instanceof ThalovantApiError)) return undefined;
  const wait = error.retryAfterSeconds !== undefined ? ` Wait ${error.retryAfterSeconds} seconds before trying again.` : " Wait before trying again.";
  switch (error.code) {
    case "bridge_running":
      return "Telegram lists chats only while the bridge is paused, because the running bridge reads the bot's messages itself. Pause it with thalovant_pause_bridge, send /start@<bot username> in the new group, list the chats, choose them with thalovant_update_bridge, then resume it with thalovant_resume_bridge. A chat id you already know can be set without listing.";
    case "bridge_telegram_updates_busy":
      return "Telegram itself refused the listing: another program or a webhook is reading this bot's messages. Stop it, or type the chat id.";
    case "bridge_helper_unavailable":
      return "This chat app has no test message. Mention the bot in one of its allowed chats instead.";
    case "bridge_token_missing":
    case "bridge_token_malformed":
    case "bridge_token_invalid":
    case "bridge_token_not_a_bot":
    case "bridge_token_other_bot":
    case "bridge_bot_in_use":
    case "bridge_secrets_invalid":
      return `This is about the bridge's token or secrets, which only ${CONSOLE_CHAT_APPS} takes. ${NO_SECRETS_HERE}${named(error, "secrets")}`;
    case "bridge_network_refused":
      return "The chat network refused the request, for example because the bot was removed from that chat; detail gives its reason. Add the bot back, or choose another chat.";
    case "bridge_allowed_required":
      return "allowed cannot be empty. To stop the bridge answering, pause it with thalovant_pause_bridge.";
    case "bridge_chat_id_invalid":
      return "A chat id does not match this chat app's format: see targets.pattern in thalovant_list_chat_app_connectors, or pick ids from thalovant_list_bridge_chats.";
    case "bridge_chat_not_allowed":
      return "A test message goes only to a chat in the bridge's allowed list. Pick one from thalovant_get_bridge, or add the chat with thalovant_update_bridge first (allowed replaces the whole list).";
    case "bridge_settings_invalid":
      return `A setting is unknown, missing or outside the chat app's settings form (settings in thalovant_list_chat_app_connectors).${named(error, "settings")} Tokens and secrets are never settings: they go in ${CONSOLE_CHAT_APPS}.`;
    case "bridge_url_invalid":
    case "bridge_url_port_not_allowed":
    case "bridge_url_not_public":
    case "bridge_url_unresolvable":
      return `An address setting must be https on port 443, with a public host name (no IP address, no local or internal name, no user name, query or fragment) that resolves to public addresses only.${named(error, "settings")}`;
    case "bridge_too_many_targets":
      return "More chats than this chat app allows: see targets.max in thalovant_list_chat_app_connectors.";
    case "bridge_mention_required":
      return "A Discord bridge answers only messages that mention it or reply to it, so requireMention cannot be false.";
    case "bridge_rate_limited":
      return `Too many test messages or chat listings for this bridge.${wait}`;
    case "bridge_network_rate_limited":
      return `The chat network is limiting this bot.${wait}`;
    case "bridge_network_unavailable":
    case "bridge_network_timeout":
      return "The chat network could not be reached or did not answer in time. Try again later.";
    case "bridge_network_not_offered":
      return "This chat app is not offered on this API right now; thalovant_get_bridge_networks says which are.";
    case "bridge_secret_store_failed":
    case "bridge_secret_store_unavailable":
      return "The platform could not reach the store that keeps bridge tokens. Try again later.";
    case "plan_limit":
      return "The plan's chat-app allowance is used (resource, limit and used are in the fields above). Resuming needs room in it: pause or delete another bridge, or move to a larger plan; thalovant_get_bridge_networks shows the allowance. Pausing is always allowed, and granting a scope will not help.";
    default:
      break;
  }
  switch (error.statusCode) {
    case 401:
    case 423:
      return "The API refused the token itself: it is unknown, expired or revoked (401), or the account is locked (423). Sign in again with thalovant_begin_device_login, or configure a valid token.";
    case 402:
      return "The hub's owner is on a plan without chat apps (Free plans get 0). Pausing and deleting a bridge always work; anything else needs a paid plan, and granting a scope will not help.";
    case 403:
      return "Reading chat apps needs the hubs:read scope, and changing them hubs:write. Listing a bridge's chats (thalovant_list_bridge_chats) also needs hubs:write and a paid plan, because it asks the chat network. A 403 can also mean the token's account does not manage this bridge (only the hub's owner or a workspace manager may change it or list its chats), or that the owner's account is deactivated.";
    case 404:
      return "No bridge with this id is visible to this token: a bridge is visible to its hub's owner, the workspace's members above basic, and platform administrators. thalovant_list_bridges lists the visible ones. An API without chat apps answers 404 on every bridge route.";
    case 412:
      return "ETag mismatch: the bridge changed after its etag was read, and nothing changed now. Read it again with thalovant_get_bridge and retry with its new etag field, or leave etag out to change the bridge as it is now.";
    case 429:
      return `Too many requests.${wait}`;
    default:
      return undefined;
  }
}
