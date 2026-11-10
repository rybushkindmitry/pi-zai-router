/**
 * Zai usage — квота и статистика подписки z.ai (GLM Coding Plan).
 *
 * - Статус-строка в футере: `z.ai 5ч 78% · нед 22%` (обновление раз в 5 минут).
 * - Команда `/zai-usage`: оверлей с окнами лимитов, временем до сброса
 *   и расходом по моделям за последние 24 часа.
 *
 * Ключ: ZAI_API_KEY из окружения, иначе ~/.pi/agent/auth.json (запись zai.key).
 *
 * Endpoint'ы z.ai официально не документированы — ответы разбираются
 * защитно: любое отклонение формы превращается в «z.ai ⚠» в статусе,
 * а не в падение расширения.
 *
 * Чистые функции (парсинг, форматирование) экспортируются для тестов
 * (tests/zai-usage.test.ts) и не зависят от pi; в модуле нет рантайм-импортов
 * из пакетов pi — только import type, чтобы файл грузился чистым Node.
 */

import { readFileSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export type QuotaWindow = {
  /** «5ч» | «нед» | «2нед» | «окно 9:3» */
  label: string;
  /** Как пришло от API; при отсутствии — 0 */
  percentage: number;
  /** «78» | «?» */
  percentText: string;
  used: number;
  limit: number;
  remaining: number;
  /** nextResetTime, epoch ms */
  resetAt: number;
  unit: number;
  number: number;
};

export type ModelUsage = {
  totalCalls: number;
  totalTokens: number;
  /** Отсортировано по totalTokens по убыванию, максимум 6 */
  models: { name: string; totalTokens: number }[];
};

const HOUR = 3;
const WEEK = 6;
const POLL_MS = 5 * 60_000;

export function windowLabel(unit: number, num: number): string {
  if (unit === HOUR) return `${num}ч`;
  if (unit === WEEK) return num === 1 ? "нед" : `${num}нед`;
  return `окно ${unit}:${num}`;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function parseQuota(data: unknown): QuotaWindow[] {
  const limits = (data as { limits?: unknown[] } | null)?.limits;
  if (!Array.isArray(limits)) return [];
  const windows: QuotaWindow[] = limits.map((raw) => {
    const l = (raw ?? {}) as Record<string, unknown>;
    const percentage = typeof l.percentage === "number" && Number.isFinite(l.percentage)
      ? l.percentage
      : 0;
    return {
      label: windowLabel(asNumber(l.unit), asNumber(l.number)),
      percentage,
      percentText: typeof l.percentage === "number" && Number.isFinite(l.percentage)
        ? String(l.percentage)
        : "?",
      used: asNumber(l.currentValue),
      limit: asNumber(l.usage),
      remaining: asNumber(l.remaining),
      resetAt: asNumber(l.nextResetTime),
      unit: asNumber(l.unit),
      number: asNumber(l.number),
    };
  });
  return windows.sort((a, b) => a.unit - b.unit);
}

export function colorToken(percentage: number): "success" | "warning" | "error" {
  if (percentage >= 95) return "error";
  if (percentage >= 80) return "warning";
  return "success";
}

export function formatStatus(windows: QuotaWindow[]): string {
  return windows.map((w) => `${w.label} ${w.percentText}%`).join(" · ");
}

export function formatResetDelta(resetAt: number, now: number): string {
  const minutes = Math.round((resetAt - now) / 60_000);
  if (minutes <= 0) return "сброс";
  if (minutes < 60) return `${Math.max(1, minutes)}м`;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}д ${hours}ч`;
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}ч ${restMinutes}м` : `${hours}ч`;
}

export function humanizeTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(".", ",")} млн`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} тыс.`;
  return String(n);
}

export function parseModelUsage(data: unknown): ModelUsage {
  const total = (data as { totalUsage?: Record<string, unknown> } | null)?.totalUsage;
  const list = Array.isArray(total?.modelSummaryList) ? total.modelSummaryList : [];
  const models = list
    .map((raw) => {
      const m = (raw ?? {}) as Record<string, unknown>;
      return { name: String(m.modelName ?? "?"), totalTokens: asNumber(m.totalTokens) };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 6);
  return {
    totalCalls: asNumber(total?.totalModelCallCount),
    totalTokens: asNumber(total?.totalTokensUsage),
    models,
  };
}

export function fmtLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

function thousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

export function formatWindowLine(
  w: QuotaWindow,
  now: number,
): { label: string; percent: string; detail: string } {
  const delta = formatResetDelta(w.resetAt, now);
  const resetSuffix = delta === "сброс" ? "сброс" : `сброс через ${delta}`;
  return {
    label: w.label,
    percent: `${w.percentText}%`,
    detail: `${thousands(w.used)} из ${thousands(w.limit)} · ${resetSuffix}`,
  };
}

const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const MODEL_USAGE_URL = "https://api.z.ai/api/monitor/usage/model-usage";
const FETCH_TIMEOUT_MS = 10_000;

export function resolveApiKey(
  env: Record<string, string | undefined>,
  homedir: string,
): string | null {
  const fromEnv = env.ZAI_API_KEY;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv;
  try {
    const auth = JSON.parse(readFileSync(join(homedir, ".pi/agent/auth.json"), "utf8")) as {
      zai?: { key?: unknown };
    };
    const key = auth?.zai?.key;
    if (typeof key === "string" && key.trim() !== "") return key;
  } catch {
    // нет файла или не JSON — ключа нет
  }
  return null;
}

async function fetchJson(
  url: string,
  key: string,
  doFetch: typeof fetch,
): Promise<Record<string, unknown>> {
  const res = await doFetch(url, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as Record<string, unknown>;
  if (json?.success !== true || !json.data) throw new Error("неожиданный ответ z.ai");
  return json.data as Record<string, unknown>;
}

export async function fetchQuota(
  key: string,
  doFetch: typeof fetch = fetch,
): Promise<{ windows: QuotaWindow[]; level?: string }> {
  const data = await fetchJson(QUOTA_URL, key, doFetch);
  if (!Array.isArray((data as { limits?: unknown }).limits)) {
    throw new Error("неожиданный ответ z.ai: нет limits");
  }
  const level = typeof data.level === "string" && data.level.trim() !== "" ? data.level : undefined;
  return { windows: parseQuota(data), level };
}

export async function fetchModelUsage(
  key: string,
  now: Date,
  doFetch: typeof fetch = fetch,
): Promise<ModelUsage> {
  const start = new Date(now.getTime() - 24 * 3600_000);
  const qs =
    `?startTime=${encodeURIComponent(fmtLocal(start))}` +
    `&endTime=${encodeURIComponent(fmtLocal(now))}`;
  const data = await fetchJson(MODEL_USAGE_URL + qs, key, doFetch);
  return parseModelUsage(data);
}

function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function paintStatus(ctx: ExtensionContext, windows: QuotaWindow[]): void {
  if (!ctx.hasUI || windows.length === 0) return;
  const theme = ctx.ui.theme;
  const segments = windows.map(
    (w) => ` ${w.label} ${theme.fg(colorToken(w.percentage), `${w.percentText}%`)}`,
  );
  ctx.ui.setStatus("zai", theme.fg("dim", "z.ai") + segments.join(theme.fg("dim", " ·")));
}

async function refreshStatus(ctx: ExtensionContext): Promise<void> {
  try {
    const key = resolveApiKey(process.env, osHomedir());
    if (!key) return;
    const { windows } = await fetchQuota(key);
    paintStatus(ctx, windows);
  } catch {
    if (ctx.hasUI) ctx.ui.setStatus("zai", ctx.ui.theme.fg("warning", "z.ai ⚠"));
  }
}

export function renderFooterLines(input: {
  width: number;
  pwd: string;
  statsLeft: string;
  modelRight: string;
  statuses: Map<string, string>;
  zaiStatus?: string;
  ellipsis?: string;
  truncate: (s: string, width: number, ellipsis?: string) => string;
  visible: (s: string) => number;
}): string[] {
  const { width, truncate, visible } = input;
  const dot = input.ellipsis ?? "...";
  const lines: string[] = [
    truncate(input.pwd, width, dot),
  ];

  // Строка 2: статистика слева, модель справа (как во встроенном футере pi).
  const minPadding = 2;
  let left = input.statsLeft;
  let leftWidth = visible(left);
  if (leftWidth > width) {
    left = truncate(left, width, "...");
    leftWidth = visible(left);
  }
  let right = input.modelRight;
  if (leftWidth + minPadding + visible(right) > width) {
    const availableForRight = width - leftWidth - minPadding;
    right = availableForRight > 0 ? truncate(right, availableForRight, "") : "";
  }
  if (right === "") {
    // Как во встроенном: без правой части строка не паддится до ширины.
    lines.push(truncate(left, width, "..."));
  } else {
    const rightWidth = visible(right);
    const padding = " ".repeat(Math.max(0, width - leftWidth - rightWidth));
    lines.push(truncate(left + padding + right, width));
  }

  // Строка 3: статусы расширений; zai уходит вправо под модель.
  const sanitize = (t: string) => t.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
  const entries = Array.from(input.statuses.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => sanitize(text))
    .filter((text) => text !== "");
  const zai = input.zaiStatus ? sanitize(input.zaiStatus) : "";
  if (entries.length === 0 && !zai) return lines;

  if (zai) {
    const leftGroup = entries.join(" ");
    const leftGroupWidth = visible(leftGroup);
    const zaiWidth = visible(zai);
    if (entries.length > 0 && leftGroupWidth + minPadding + zaiWidth <= width) {
      const gap = " ".repeat(width - leftGroupWidth - zaiWidth);
      lines.push(truncate(leftGroup + gap + zai, width));
      return lines;
    }
    if (entries.length === 0 && zaiWidth <= width) {
      lines.push(" ".repeat(width - zaiWidth) + zai);
      return lines;
    }
  }
  const all = zai ? [...entries, zai] : entries;
  lines.push(truncate(all.join(" "), width, dot));
  return lines;
}

export function routedArrow(
  selected: { id: string; api?: string } | undefined,
  last: { model: string; thinkingLevel?: string } | null | undefined,
): string {
  if (!selected || selected.api !== "pi-virtual") return "";
  if (!last || last.model === selected.id) return "";
  return ` → ${last.model}${last.thinkingLevel ? ` • ${last.thinkingLevel}` : ""}`;
}

export type CachedSessionStats = {
  key?: string;
  stats?: {
    totals: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
    latestCacheRate?: number;
    contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
  };
};

export function computeSessionStats(
  entries: unknown[],
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined,
): NonNullable<CachedSessionStats["stats"]> {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let latestCacheRate: number | undefined;
  for (const entry of entries) {
    const e = entry as {
      type?: string;
      usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
      message?: { role?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } };
    };
    const usage = e.type === "message"
      ? e.message?.usage
      : e.type === "usage" || e.type === "branch_summary" || e.type === "compaction"
        ? e.usage
        : undefined;
    if (!usage) continue;
    totals.input += asNumber(usage.input);
    totals.output += asNumber(usage.output);
    totals.cacheRead += asNumber(usage.cacheRead);
    totals.cacheWrite += asNumber(usage.cacheWrite);
    totals.cost += asNumber(usage.cost?.total);
    if (e.type === "message" && e.message?.role === "assistant") {
      const prompt = asNumber(usage.input) + asNumber(usage.cacheRead) + asNumber(usage.cacheWrite);
      latestCacheRate = prompt > 0 ? (asNumber(usage.cacheRead) / prompt) * 100 : undefined;
    }
  }
  return { totals, latestCacheRate, contextUsage };
}

export function getCachedSessionStats(
  cache: CachedSessionStats,
  sm: { getSessionId(): string; getLeafId(): string | null; getEntryCount(): number },
  modelId: string | undefined,
  getEntries: () => unknown[],
  getContextUsage?: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined,
): NonNullable<CachedSessionStats["stats"]> {
  const key = `${sm.getSessionId()}:${String(sm.getLeafId())}:${sm.getEntryCount()}:${modelId ?? ""}`;
  if (cache.key === key && cache.stats) return cache.stats;
  const stats = computeSessionStats(getEntries(), getContextUsage?.());
  cache.key = key;
  cache.stats = stats;
  return stats;
}

/** Реплика встроенного футера pi: собственный включается в session_start, /zai-footer переключает. */
let piTui: typeof import("@earendil-works/pi-tui") | undefined;
const statsCache: CachedSessionStats = {};

function formatCwdForFooter(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const rel = relative(resolve(home), resolve(cwd));
  const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  if (!inside) return cwd;
  return rel === "" ? "~" : `~${sep}${rel}`;
}

function renderCustomFooter(
  ctx: ExtensionContext,
  theme: Theme,
  footerData: {
    getGitBranch(): string | null;
    getExtensionStatuses(): ReadonlyMap<string, string>;
    getAvailableProviderCount(): number;
    onBranchChange(cb: () => void): () => void;
  },
  width: number,
): string[] {
  const { truncateToWidth: truncate, visibleWidth: visible } = piTui!;

  // Строка 1: pwd с ~ , веткой и именем сессии.
  let pwd = formatCwdForFooter(ctx.cwd, process.env.HOME || process.env.USERPROFILE);
  const branch = footerData.getGitBranch();
  if (branch) pwd += ` (${branch})`;
  const sessionName = ctx.sessionManager.getSessionName();
  if (sessionName) pwd += ` • ${sessionName}`;

  // Строка 2 слева: накопленная статистика по всей сессии (как во встроенном), с кэшем по кадрам.
  const stats = getCachedSessionStats(
    statsCache,
    ctx.sessionManager,
    ctx.model?.id,
    () => ctx.sessionManager.getEntries(),
    () => ctx.getContextUsage(),
  );
  const { totals, latestCacheRate } = stats;
  const fmtTokens = (n: number) =>
    n < 1000 ? String(n)
      : n < 10_000 ? `${(n / 1000).toFixed(1)}k`
        : n < 1_000_000 ? `${Math.round(n / 1000)}k`
          : n < 10_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
            : `${Math.round(n / 1_000_000)}M`;
  const statsParts: string[] = [];
  if (totals.input) statsParts.push(`↑${fmtTokens(totals.input)}`);
  if (totals.output) statsParts.push(`↓${fmtTokens(totals.output)}`);
  if (totals.cacheRead) statsParts.push(`R${fmtTokens(totals.cacheRead)}`);
  if (totals.cacheWrite) statsParts.push(`W${fmtTokens(totals.cacheWrite)}`);
  if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheRate !== undefined) {
    statsParts.push(`CH${latestCacheRate.toFixed(1)}%`);
  }
  if (totals.cost) statsParts.push(`$${totals.cost.toFixed(3)}`);
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const percentValue = usage?.percent ?? 0;
  const percentText = usage?.percent !== null && usage?.percent !== undefined
    ? `${usage.percent.toFixed(1)}%/${fmtTokens(contextWindow)}`
    : `?/${fmtTokens(contextWindow)}`;
  statsParts.push(
    percentValue > 90 ? theme.fg("error", percentText)
      : percentValue > 70 ? theme.fg("warning", percentText)
        : percentText,
  );
  const statsLeft = statsParts.join(" ");

  // Строка 2 справа: модель, thinking, стрелка роутинга по последнему ответу.
  const model = ctx.model;
  const level = ctx.thinkingLevel;
  let modelRight = model?.id ?? "no-model";
  if (model?.reasoning && level) {
    modelRight = level === "off" ? `${modelRight} • thinking off` : `${modelRight} • ${level}`;
  }
  const branchEntries = ctx.sessionManager.getBranch();
  let lastAssistant: AssistantMessage | undefined;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const e = branchEntries[i] as { type?: string; message?: AssistantMessage };
    if (e?.type === "message" && e.message?.role === "assistant") {
      lastAssistant = e.message;
      break;
    }
  }
  modelRight += routedArrow(model ? { id: model.id, api: model.api } : undefined, lastAssistant);
  if (footerData.getAvailableProviderCount() > 1 && model) {
    const withProvider = `(${model.provider}) ${modelRight}`;
    const leftWidth = visible(statsLeft);
    if (leftWidth + 2 + visible(withProvider) <= width) modelRight = withProvider;
  }

  // Строка 3: статусы расширений слева, z.ai справа под моделью.
  const statuses = new Map<string, string>();
  for (const [key, text] of footerData.getExtensionStatuses()) {
    if (key !== "zai") statuses.set(key, text);
  }
  const zaiStatus = footerData.getExtensionStatuses().get("zai");

  const raw = renderFooterLines({
    width,
    pwd: theme.fg("dim", pwd),
    statsLeft,
    modelRight,
    statuses,
    zaiStatus,
    ellipsis: theme.fg("dim", "..."),
    truncate,
    visible,
  });

  // Приглушение как во встроенном: строку статистики кусками
  // (процент контекста несёт свой цвет, внешний dim его бы сбросил).
  const statsLine = raw[1] ?? "";
  if (statsLine.startsWith(statsLeft)) {
    raw[1] = theme.fg("dim", statsLeft) + theme.fg("dim", statsLine.slice(statsLeft.length));
  } else {
    raw[1] = theme.fg("dim", statsLine);
  }
  return raw;
}

let footerEnabled = false;

async function enableFooter(ctx: ExtensionContext): Promise<boolean> {
  if (!piTui) {
    try {
      piTui = await import("@earendil-works/pi-tui");
    } catch {
      return false;
    }
  }
  footerEnabled = true;
  ctx.ui.setFooter((tui, theme, footerData) => {
    const unsub = footerData.onBranchChange(() => tui.requestRender());
    return {
      dispose() {
        unsub();
      },
      invalidate() {},
      render(width: number): string[] {
        try {
          return renderCustomFooter(ctx, theme, footerData, width);
        } catch {
          return ["", ""];
        }
      },
    };
  });
  return true;
}

function disableFooter(ctx: ExtensionContext): void {
  footerEnabled = false;
  ctx.ui.setFooter(undefined);
}

export default function (pi: ExtensionAPI): void {
  let timer: ReturnType<typeof setInterval> | undefined;

  pi.on("session_start", async (_event, ctx) => {
    void refreshStatus(ctx);
    timer = setInterval(() => void refreshStatus(ctx), POLL_MS);
    if (ctx.hasUI) void enableFooter(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    footerEnabled = false;
    statsCache.key = undefined;
    statsCache.stats = undefined;
    try {
      ctx.ui.setFooter(undefined);
    } catch {
      // режим без футера — не страшно
    }
  });

  pi.registerCommand("zai-footer", {
    description: "Переключить футер: свой (z.ai справа) / встроенный",
    handler: async (_args, ctx) => {
      if (footerEnabled) {
        disableFooter(ctx);
        ctx.ui.notify("Встроенный футер восстановлен", "info");
      } else {
        const ok = await enableFooter(ctx);
        ctx.ui.notify(
          ok ? "Свой футер включён: z.ai справа под моделью" : "Не удалось загрузить pi-tui — остался встроенный футер",
          ok ? "info" : "warning",
        );
      }
    },
  });

  pi.registerCommand("zai-usage", {
    description: "Квота и статистика z.ai (GLM Coding Plan)",
    handler: async (_args, ctx) => {
      const key = resolveApiKey(process.env, osHomedir());
      if (!key) {
        ctx.ui.notify("Ключ z.ai не найден: задайте ZAI_API_KEY или выполните /login для z.ai", "error");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Для просмотра деталей нужен интерактивный режим", "warning");
        return;
      }

      const [quotaRes, usageRes] = await Promise.allSettled([
        fetchQuota(key),
        fetchModelUsage(key, new Date()),
      ]);
      if (quotaRes.status === "rejected") {
        ctx.ui.notify("Не удалось получить квоту z.ai: " + reasonText(quotaRes.reason), "error");
        return;
      }
      const { windows, level } = quotaRes.value;
      const usage = usageRes.status === "fulfilled" ? usageRes.value : undefined;
      paintStatus(ctx, windows);

      await ctx.ui.custom<void>(
        (_tui, theme, _keybindings, done) => {
          let cachedWidth: number | undefined;
          let cachedLines: string[] | undefined;
          const invalidate = () => {
            cachedWidth = undefined;
            cachedLines = undefined;
          };

          return {
            render(width: number): string[] {
              if (cachedLines && cachedWidth === width) return cachedLines;
              cachedWidth = width;
              const lines: string[] = [
                theme.fg("accent", level ? `z.ai · план ${level}` : "z.ai"),
              ];
              for (const w of windows) {
                const line = formatWindowLine(w, Date.now());
                if (width >= 72) {
                  lines.push(
                    `  ${line.label}  ${theme.fg(colorToken(w.percentage), line.percent)}  ` +
                    theme.fg("dim", line.detail),
                  );
                } else {
                  lines.push(`  ${line.label}  ${theme.fg(colorToken(w.percentage), line.percent)}`);
                }
              }
              lines.push("");
              if (usage) {
                lines.push(
                  theme.fg(
                    "text",
                    `За 24 часа: ${usage.totalCalls} вызовов · ${humanizeTokens(usage.totalTokens)} токенов`,
                  ),
                );
                for (const m of usage.models) {
                  lines.push(theme.fg("text", `  ${m.name} — ${humanizeTokens(m.totalTokens)}`));
                }
              } else {
                lines.push(theme.fg("dim", "Статистика по моделям недоступна"));
              }
              lines.push("");
              lines.push(theme.fg("dim", "любая клавиша — закрыть"));
              cachedLines = lines;
              return lines;
            },
            handleInput(_data: string): void {
              done();
            },
            invalidate,
          };
        },
        { overlay: true },
      );

      void refreshStatus(ctx);
    },
  });
}
