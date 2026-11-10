import { test } from "node:test";
import assert from "node:assert/strict";
import {
  windowLabel, parseQuota, colorToken, formatStatus, formatResetDelta,
  humanizeTokens, parseModelUsage, fmtLocal, formatWindowLine,
} from "../extensions/zai-usage.ts";

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApiKey, fetchQuota, fetchModelUsage, renderFooterLines, routedArrow, getCachedSessionStats } from "../extensions/zai-usage.ts";

const quotaData = {
  limits: [
    { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 12000, currentValue: 9436,
      remaining: 2563, percentage: 78, nextResetTime: 1792752215034 },
    { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 60000, currentValue: 13643,
      remaining: 46356, percentage: 22, nextResetTime: 1793262333983 },
  ],
  level: "pro",
};

test("windowLabel: часы, одна неделя, несколько недель, заглушка", () => {
  assert.equal(windowLabel(3, 5), "5ч");
  assert.equal(windowLabel(6, 1), "нед");
  assert.equal(windowLabel(6, 2), "2нед");
  assert.equal(windowLabel(9, 3), "окно 9:3");
});

test("parseQuota: сортировка по возрастанию unit и перенос полей", () => {
  const w = parseQuota(quotaData);
  assert.equal(w.length, 2);
  assert.equal(w[0].label, "5ч");
  assert.equal(w[0].percentage, 78);
  assert.equal(w[0].used, 9436);
  assert.equal(w[0].limit, 12000);
  assert.equal(w[0].remaining, 2563);
  assert.equal(w[0].resetAt, 1792752215034);
  assert.equal(w[1].label, "нед");
});

test("parseQuota: неизвестное окно сохраняется, percentage без значения даёт ?", () => {
  const w = parseQuota({
    limits: [
      { unit: 9, number: 3, usage: 10, currentValue: 1, remaining: 9,
        percentage: null, nextResetTime: 1792752215034 },
    ],
  });
  assert.equal(w[0].label, "окно 9:3");
  assert.equal(w[0].percentText, "?");
  assert.equal(w[0].percentage, 0);
});

test("colorToken: пороги 80 и 95", () => {
  assert.equal(colorToken(78), "success");
  assert.equal(colorToken(80), "warning");
  assert.equal(colorToken(94), "warning");
  assert.equal(colorToken(95), "error");
});

test("formatStatus: две строки через точку-разделитель", () => {
  assert.equal(formatStatus(parseQuota(quotaData)), "5ч 78% · нед 22%");
});

test("formatResetDelta: минуты, часы с минутами, сутки с часами, сброс", () => {
  const reset = 1792752215034;
  assert.equal(formatResetDelta(reset, reset - 45 * 60_000), "45м");
  assert.equal(formatResetDelta(reset, reset - (2 * 3600 + 13 * 60) * 1000), "2ч 13м");
  assert.equal(formatResetDelta(reset, reset - (3 * 24 * 3600 + 4 * 3600) * 1000), "3д 4ч");
  assert.equal(formatResetDelta(reset, reset + 1000), "сброс");
});

test("humanizeTokens: тысячи и миллионы с запятой", () => {
  assert.equal(humanizeTokens(380_000), "380 тыс.");
  assert.equal(humanizeTokens(2_797_781), "2,8 млн");
  assert.equal(humanizeTokens(232_959_732), "233,0 млн");
});

test("parseModelUsage: итоги и сортировка моделей по токенам", () => {
  const mu = parseModelUsage({
    totalUsage: {
      totalModelCallCount: 2059,
      totalTokensUsage: 235_757_513,
      modelSummaryList: [
        { modelName: "GLM-5.3", totalTokens: 2_797_781 },
        { modelName: "GLM-5.3-Flash", totalTokens: 232_959_732 },
      ],
    },
  });
  assert.equal(mu.totalCalls, 2059);
  assert.equal(mu.totalTokens, 235_757_513);
  assert.deepEqual(mu.models.map((m) => m.name), ["GLM-5.3-Flash", "GLM-5.3"]);
});

test("fmtLocal: формат yyyy-MM-dd HH:mm:ss", () => {
  assert.equal(fmtLocal(new Date(2026, 9, 23, 10, 41, 36)), "2026-10-23 10:41:36");
});

test("formatWindowLine: подпись, процент и деталь с временем сброса", () => {
  const [w] = parseQuota(quotaData);
  const line = formatWindowLine(w, w.resetAt - (2 * 3600 + 13 * 60) * 1000);
  assert.equal(line.label, "5ч");
  assert.equal(line.percent, "78%");
  assert.equal(line.detail, "9 436 из 12 000 · сброс через 2ч 13м");
});

test("resolveApiKey: env приоритетнее auth.json, без всего — null", () => {
  const dir = mkdtempSync(join(tmpdir(), "zai-test-"));
  mkdirSync(join(dir, ".pi/agent"), { recursive: true });
  writeFileSync(join(dir, ".pi/agent/auth.json"), JSON.stringify({ zai: { key: "auth-key" } }));
  assert.equal(resolveApiKey({}, dir), "auth-key");
  assert.equal(resolveApiKey({ ZAI_API_KEY: "env-key" }, dir), "env-key");
  assert.equal(resolveApiKey({}, join(dir, "пусто")), null);
});

const jsonOk = () =>
  new Response(JSON.stringify({ code: 200, success: true, data: quotaData }), { status: 200 });

test("fetchQuota: success:true без limits — ошибка формы ответа", async () => {
  await assert.rejects(
    fetchQuota("k", async () =>
      new Response(JSON.stringify({ code: 200, success: true, data: { level: "pro" } }), { status: 200 })),
  );
  await assert.rejects(
    fetchQuota("k", async () =>
      new Response(JSON.stringify({ code: 200, success: true, data: "ok" }), { status: 200 })),
  );
});

test("fetchQuota: возвращает разобранные окна и план", async () => {
  const { windows, level } = await fetchQuota("k", async () => jsonOk());
  assert.equal(windows[0].label, "5ч");
  assert.equal(level, "pro");
});

test("fetchQuota: success:false и HTTP-ошибки бросают исключение", async () => {
  await assert.rejects(
    fetchQuota("k", async () =>
      new Response(JSON.stringify({ code: 500, success: false }), { status: 200 })),
  );
  await assert.rejects(fetchQuota("k", async () => new Response("no", { status: 401 })));
});

test("fetchModelUsage: окно 24 часа в query и разобранный итог", async () => {
  let called = "";
  const mu = await fetchModelUsage("k", new Date(2026, 9, 23, 10, 41, 36), async (url) => {
    called = String(url);
    return new Response(
      JSON.stringify({
        code: 200, success: true,
        data: { totalUsage: { totalModelCallCount: 3, totalTokensUsage: 100,
          modelSummaryList: [{ modelName: "GLM-5.3", totalTokens: 100 }] } },
      }),
      { status: 200 },
    );
  });
  assert.ok(called.includes(encodeURIComponent("2026-10-22 10:41:36")));
  assert.ok(called.includes(encodeURIComponent("2026-10-23 10:41:36")));
  assert.equal(mu.totalCalls, 3);
});

test("renderFooterLines: zai справа с зазором ≥2, прочие статусы слева по алфавиту", () => {
  const lines = renderFooterLines({
    width: 60,
    pwd: "~",
    statsLeft: "↑1k ↓2k",
    modelRight: "m1 • high",
    statuses: new Map([["mcp", "MCP: ok"], ["lsp", "LSP Inactive"]]),
    zaiStatus: "z.ai 5ч 21% · нед 27%",
    truncate: (s, w) => s.slice(0, w),
    visible: (s) => s.length,
  });
  assert.equal(lines.length, 3);
  const statusLine = lines[2];
  const cut = statusLine.indexOf("z.ai");
  const leftPart = statusLine.slice(0, cut);
  assert.ok(leftPart.includes("LSP Inactive") && leftPart.includes("MCP: ok"));
  assert.ok(leftPart.indexOf("LSP") < leftPart.indexOf("MCP"), "статусы по алфавиту");
  const gap = leftPart.length - leftPart.replace(/ +$/, "").length;
  assert.ok(gap >= 2, `зазор ${gap}`);
  assert.ok(statusLine.trimEnd().endsWith("z.ai 5ч 21% · нед 27%"));
});

test("renderFooterLines: не хватает места — zai возвращается в левую группу", () => {
  const lines = renderFooterLines({
    width: 40,
    pwd: "~",
    statsLeft: "↑1k",
    modelRight: "модель-без-правой-части-очень-длинная",
    statuses: new Map([["mcp", "MCP: ok"]]),
    zaiStatus: "z.ai 5ч 21% · нед 27%",
    truncate: (s, w) => s.slice(0, w),
    visible: (s) => s.length,
  });
  const statusLine = lines[2];
  assert.ok(statusLine.includes("z.ai"));
  assert.ok(statusLine.indexOf("z.ai") > statusLine.indexOf("MCP"), "zai после прочих слева");
});

test("renderFooterLines: строка статистики — модель справа, зазор ≥2, обрезка при переполнении", () => {
  const lines = renderFooterLines({
    width: 30,
    pwd: "~",
    statsLeft: "↑1k ↓2k",
    modelRight: "очень-длинное-имя-модели",
    statuses: new Map(),
    truncate: (s, w) => s.slice(0, w),
    visible: (s) => s.length,
  });
  assert.equal(lines.length, 2);
  const stats = lines[1];
  assert.ok(stats.startsWith("↑1k ↓2k"));
  assert.ok(stats.length <= 30);
  assert.ok(stats.includes("очень"), "правая часть частично видна");
  assert.equal(stats.slice("↑1k ↓2k".length, "↑1k ↓2k".length + 2), "  ", "минимальный зазор 2");
});

test("renderFooterLines: правая часть не влезает вовсе — без хвостового паддинга, с заданным многоточием", () => {
  const calls: Array<{ s: string; w: number; e?: string }> = [];
  const lines = renderFooterLines({
    width: 10,
    pwd: "~",
    statsLeft: "↑1k ↓2k ↓",
    modelRight: "m",
    statuses: new Map([["x", "длинный-статус-ради-обрезки"]]),
    zaiStatus: "z.ai 5ч 21%",
    ellipsis: "DIM...",
    truncate: (s, w, e) => {
      calls.push({ s, w, e });
      return s.slice(0, w);
    },
    visible: (s) => s.length,
  });
  const statsLine = lines[1];
  assert.equal(statsLine, "↑1k ↓2k ↓", "строка не паддится до ширины");
  const statusLine = lines[2];
  const call = calls.find((c) => c.s.includes("z.ai"));
  assert.ok(call, "строка статусов обрезается через truncate");
  assert.equal(call?.e, "DIM...", "многоточие — из параметра");
});

test("renderFooterLines: санитизация статусов и нет третьей строки при пустых", () => {
  const withStatus = renderFooterLines({
    width: 60, pwd: "~", statsLeft: "s", modelRight: "m",
    statuses: new Map([["x", "строка1\nстрока2"]]),
    truncate: (s, w) => s.slice(0, w), visible: (s) => s.length,
  });
  assert.ok(withStatus[2].includes("строка1 строка2"));
  const noStatus = renderFooterLines({
    width: 60, pwd: "~", statsLeft: "s", modelRight: "m",
    statuses: new Map(),
    truncate: (s, w) => s.slice(0, w), visible: (s) => s.length,
  });
  assert.equal(noStatus.length, 2);
});

test("renderFooterLines: одинокий zai — справа, без других статусов", () => {
  const lines = renderFooterLines({
    width: 60,
    pwd: "~",
    statsLeft: "s",
    modelRight: "m",
    statuses: new Map(),
    zaiStatus: "z.ai 5ч 21% · нед 27%",
    truncate: (s, w) => s.slice(0, w),
    visible: (s) => s.length,
  });
  assert.equal(lines.length, 3);
  const cut = lines[2].indexOf("z.ai");
  const leftOfZai = lines[2].slice(0, cut);
  const gap = leftOfZai.length - leftOfZai.replace(/ +$/, "").length;
  assert.ok(gap >= 2, `зазор ${gap}`);
  assert.ok(lines[2].trimEnd().endsWith("z.ai 5ч 21% · нед 27%"));
});

test("routedArrow: только для виртуальной модели и при другом id ответа", () => {
  assert.equal(
    routedArrow({ id: "auto", api: "pi-virtual" }, { model: "glm-5.3-flash", thinkingLevel: "high" }),
    " → glm-5.3-flash • high",
  );
  assert.equal(
    routedArrow({ id: "glm-5.3", api: "openai-completions" }, { model: "glm-5.3-flash" }),
    "",
    "обычная модель — стрелки нет",
  );
  assert.equal(
    routedArrow({ id: "auto", api: "pi-virtual" }, { model: "auto" }),
    "",
    "физическая модель совпала с выбранной — стрелки нет",
  );
  assert.equal(routedArrow(undefined, { model: "glm-5.3-flash" }), "");
});

test("getCachedSessionStats: пересчёт только при смене ключа сессии", () => {
  const cache: { key?: string } = {};
  let scans = 0;
  const sm = {
    getSessionId: () => "s1",
    getLeafId: () => "leaf1" as string | null,
    getEntryCount: () => 3,
  };
  const entries = () => {
    scans++;
    return [{ type: "message", message: { role: "assistant", usage: { input: 10 } } }];
  };
  const stats1 = getCachedSessionStats(cache, sm, "auto", entries);
  assert.equal(stats1.totals.input, 10);
  assert.equal(scans, 1);
  getCachedSessionStats(cache, sm, "auto", entries);
  assert.equal(scans, 1, "кэш не пересчитывает при том же ключе");
  const stats3 = getCachedSessionStats(cache, { ...sm, getEntryCount: () => 4 }, "auto", entries);
  assert.equal(scans, 2, "новая запись — пересчёт");
  assert.equal(stats3.totals.input, 10);
});

test("getCachedSessionStats: contextUsage кэшируется вместе со статистикой", () => {
  const cache: { key?: string } = {};
  let calls = 0;
  const sm = { getSessionId: () => "s", getLeafId: () => null, getEntryCount: () => 0 };
  const getCu = () => {
    calls++;
    return { tokens: 5, contextWindow: 200_000, percent: 0.0025 };
  };
  getCachedSessionStats(cache, sm, "m", () => [], getCu);
  getCachedSessionStats(cache, sm, "m", () => [], getCu);
  assert.equal(calls, 1);
});
