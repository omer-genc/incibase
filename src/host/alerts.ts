// Telling the owner (design sections 9 and 13): the alerts table holds one
// row per problem key, and the owner hears about each episode twice, when
// it opens and when it resolves, never on every check tick:
//
//   firing, notified_at NULL  ->  POST "open", notified_at set
//   resolved                  ->  POST "resolved" (when its open was sent), state 'closed'
//
// A row re-raised while resolved or closed starts a new episode
// (Registry.raiseAlert); one that resolves while its open is being POSTed
// still gets its resolve (Registry.markAlertNotified). Delivery is an HTTP
// POST to settings.alert_webhook, shaped for an ntfy.sh topic: a plain-text
// body with Title, Priority and Tags headers. It has a timeout, follows no redirect, and stops at the first
// failure (the rest wait for the next tick). Messages never carry a secret:
// key-like tokens, every env value of every branch and the webhook itself are
// redacted, and the webhook URL (which is the topic's only secret) never
// reaches a log, an audit row or an error.
import { z } from "zod";
import type { OpsContext } from "./context.ts";
import { printable } from "./driver.ts";
import { branchRef } from "./names.ts";
import { OpError } from "./ops.ts";
import { currentActor, type AlertRow } from "./registry.ts";

export const ALERT_WEBHOOK = "alert_webhook";
/** How long one POST may take. */
export const WEBHOOK_TIMEOUT_MS = 10_000;
const MAX_URL = 2048;
const MAX_BODY = 3000;
/** Env values shorter than this are not treated as secrets (flags, small numbers). */
const MIN_SECRET = 8;
const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD/i;

const now = (ctx: OpsContext) => (ctx.now ?? Date.now)();
const actor = (ctx: OpsContext) => ctx.actor ?? currentActor();

/** An https URL without credentials or a fragment, e.g. an ntfy.sh topic: `https://ntfy.sh/<random topic>`. */
export function checkAlertWebhook(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > MAX_URL || /[\s\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new OpError("INVALID", `alert_webhook must be an https URL of at most ${MAX_URL} characters without spaces`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OpError("INVALID", "alert_webhook is not a URL");
  }
  if (url.protocol !== "https:") throw new OpError("INVALID", "alert_webhook must be an https URL (the alerts leave the machine)");
  if (url.username || url.password) throw new OpError("INVALID", "alert_webhook must not carry a user or password");
  if (!url.hostname) throw new OpError("INVALID", "alert_webhook has no host");
  if (url.hash) throw new OpError("INVALID", "alert_webhook must not have a #fragment");
  return url.href;
}

/** Text with every secret the registry knows (and key-like tokens) replaced. */
export function redact(ctx: OpsContext, text: string, extra: string[] = []): string {
  const secrets = new Set<string>(extra.filter((s) => s.length >= MIN_SECRET));
  for (const branch of ctx.registry.listBranches()) {
    for (const row of ctx.registry.listEnv(branch.id)) {
      // Every app value may be a secret; of the host's own, the keys (the rest are labels such as shop/prod).
      if (row.value.length >= MIN_SECRET && (!row.system || SECRET_NAME.test(row.name))) secrets.add(row.value);
    }
  }
  let out = text;
  // Longest first, so a secret that contains another is replaced whole.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(secret).join("[redacted]");
  return out.replace(/\bik_(?:admin|svc)_[A-Za-z0-9_-]+/g, "ik_[redacted]");
}

/** What a header may carry: printable ASCII, short. */
function headerText(text: string, max = 200): string {
  const ascii = text.replace(/[^\x20-\x7e]/g, "?");
  return ascii.length > max ? `${ascii.slice(0, max - 3)}...` : ascii;
}

interface AlertKind {
  title: string;
  /** ntfy priority while firing. */
  priority: "high" | "default";
}

/** What a key is about, from its prefix: `health:<branch id>`, `disk:90`, ... */
function describeKey(ctx: OpsContext, key: string): { kind: AlertKind; subject: string } {
  const [prefix = "", rest = ""] = key.split(/:(.*)/s);
  const kinds: Record<string, AlertKind> = {
    health: { title: "branch killed after failed health checks", priority: "high" },
    startup: { title: "branch slow to start", priority: "default" },
    unit: { title: "branch down", priority: "high" },
    restarts: { title: "branch restarting repeatedly", priority: "high" },
    release: { title: "release problem", priority: "high" },
    branch: { title: "branch problem", priority: "high" },
    disk: { title: `disk ${rest}% full`, priority: rest === "80" ? "default" : "high" },
  };
  const kind = kinds[prefix] ?? { title: key, priority: "high" };
  const branch = prefix === "disk" ? null : ctx.registry.getBranch(rest);
  return { kind, subject: branch ? branchRef(branch.project, branch.name) : "" };
}

/** One notification as it goes out: never more than the alert's own (redacted) text. */
export function notification(ctx: OpsContext, alert: AlertRow, extraSecrets: string[] = []) {
  const { kind, subject } = describeKey(ctx, alert.key);
  const resolved = alert.state !== "firing";
  const domain = ctx.registry.getSetting("domain");
  const head = `${resolved ? "resolved: " : ""}${subject ? `${subject} ` : ""}${kind.title}`;
  const lines = resolved
    ? [`Resolved after about ${Math.max(0, Math.round((alert.since - (alert.notified_at ?? alert.since)) / 1000))} s: ${alert.message ?? alert.key}`]
    : [alert.message ?? alert.key];
  lines.push(`${resolved ? "Resolved" : "Since"} ${new Date(alert.since).toISOString()}${domain ? ` on ${domain}` : ""}`, `(alert ${alert.key})`);
  // printable() per line: no control characters, but the lines stay lines.
  const body = lines.map((line) => printable(redact(ctx, line, extraSecrets), MAX_BODY)).join("\n");
  return {
    title: headerText(redact(ctx, `incibase ${head}`, extraSecrets)),
    priority: resolved ? "low" : kind.priority,
    tags: resolved ? "white_check_mark" : "warning",
    body,
  };
}

/** POSTs one notification; an Error without the URL in it when it fails. */
async function post(url: string, note: ReturnType<typeof notification>, timeoutMs: number): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      body: note.body,
      headers: { "content-type": "text/plain; charset=utf-8", title: note.title, priority: note.priority, tags: note.tags },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = (err as Error).name;
    throw new Error(name === "TimeoutError" || name === "AbortError" ? `no answer within ${timeoutMs / 1000} s` : `${(err as { code?: string }).code ?? name}`);
  }
  // The body is not needed (and comes from elsewhere).
  await res.body?.cancel().catch(() => {});
  if (res.status < 200 || res.status > 299) throw new Error(`HTTP ${res.status}`);
}

export interface DeliveryReport {
  sent: number;
  /** Alerts closed without a message: resolved before their open was ever sent. */
  closed: number;
  /** Why delivery stopped (the rest wait for the next run); never the URL. */
  error: string | null;
  /** No alert_webhook is set: alerts wait in the registry. */
  unconfigured: boolean;
}

/** Sends what is due: each episode's open and resolve, once. Run by every `host check`. */
export async function deliverAlerts(ctx: OpsContext, { timeoutMs = WEBHOOK_TIMEOUT_MS } = {}): Promise<DeliveryReport> {
  const { registry } = ctx;
  const url = registry.getSetting(ALERT_WEBHOOK);
  const report: DeliveryReport = { sent: 0, closed: 0, error: null, unconfigured: !url };
  for (const alert of registry.listAlerts()) {
    const due = alert.state === "firing" ? alert.notified_at === null : alert.state === "resolved";
    if (!due) continue;
    // A resolve of an episode whose open was never sent says nothing new.
    if (alert.state === "resolved" && alert.notified_at === null) {
      await registry.withLock(() => registry.markAlertNotified(alert.key, "resolved", alert.since, now(ctx)));
      report.closed++;
      continue;
    }
    if (!url) {
      // No way to tell the owner that it ended; status still shows firing ones.
      if (alert.state === "resolved") {
        await registry.withLock(() => registry.markAlertNotified(alert.key, "resolved", alert.since, now(ctx)));
        report.closed++;
      }
      continue;
    }
    const at = now(ctx);
    try {
      await post(url, notification(ctx, alert, [url]), timeoutMs);
    } catch (err) {
      report.error = `${alert.key}: ${redact(ctx, (err as Error).message, [url])}`;
      break;
    }
    await registry.withLock(() => registry.markAlertNotified(alert.key, alert.state as "firing" | "resolved", alert.since, at));
    report.sent++;
  }
  return report;
}

const setSettingSchema = z.discriminatedUnion("key", [
  z.strictObject({
    key: z.literal(ALERT_WEBHOOK),
    /** The URL; null or "" removes it. */
    value: z.string().max(MAX_URL).nullable(),
    /** Send a test notification right away. */
    test: z.boolean().default(false),
  }),
]);

/**
 * `incibase host set alert_webhook <url|->`: where alerts go. Only https URLs;
 * the audit row keeps the host, never the URL (an ntfy topic is its secret;
 * `-` reads it from stdin so it stays off the command line too).
 */
export async function setSetting(ctx: OpsContext, input: z.input<typeof setSettingSchema>) {
  const parsed = setSettingSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new OpError("INVALID", `${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`);
  }
  const data = parsed.data;
  const value = data.value ? checkAlertWebhook(data.value) : null;
  const host = value ? new URL(value).host : null;
  await ctx.registry.withLock(() =>
    ctx.registry.tx(() => {
      if (value) ctx.registry.setSetting(data.key, value);
      else ctx.registry.deleteSetting(data.key);
      ctx.registry.audit({ actor: actor(ctx), action: "host.set", detail: { key: data.key, host }, ok: true }, now(ctx));
    }),
  );
  let tested: boolean | null = null;
  if (data.test && value) {
    const at = now(ctx);
    const probe: AlertRow = { key: "test", state: "firing", since: at, notified_at: null, message: "incibase alerts reach this topic." };
    try {
      await post(value, { ...notification(ctx, probe, [value]), title: "incibase test notification", priority: "low", tags: "white_check_mark" }, WEBHOOK_TIMEOUT_MS);
      tested = true;
    } catch (err) {
      throw new OpError("FAILED", `alert_webhook is saved, but the test notification to ${host} failed: ${redact(ctx, (err as Error).message, [value])}`);
    }
  }
  return { key: data.key, set: value !== null, host, tested };
}
