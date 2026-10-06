/**
 * Zai router — виртуальная модель `<provider>/auto` для подписки z.ai.
 *
 * Маршрутизирует между моделями провайдера zai:
 *
 * - Планирование: Jev-классификатор оценивает первое сообщение пользователя.
 *   `complex` → complex-модель, `standard` → fast-модель.
 * - Реализация: после первой успешной правки (edit/write) остаток хода
 *   идёт на fast-модель, и сессия остаётся на ней (один промпт-кэш-мисс).
 * - Картинки в сообщениях → fast-модель (умеет vision, 1M контекста),
 *   независимо от фазы: complex-модель картинки не принимает.
 * - Запросы вне агентного цикла (компакция и т.п.) → fast-модель.
 *
 * Требуются ключи TYPESAFE_API_KEY (Jev) и zai (подписка).
 * Выбор уровня thinking передаётся выбранной модели как есть.
 *
 * Конфигурация через переменные окружения (значения по умолчанию — z.ai):
 * - ZAI_ROUTER_PROVIDER      провайдер каталога (default: zai)
 * - ZAI_ROUTER_COMPLEX_MODEL модель планирования (default: glm-5.3)
 * - ZAI_ROUTER_FAST_MODEL    модель реализации/compaction (default: glm-5.3-flash)
 * - ZAI_ROUTER_QUIET=1       отключить диагностический лог
 */

import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ModelRoute,
	ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";

const PROVIDER = process.env.ZAI_ROUTER_PROVIDER ?? "zai";
const COMPLEX_MODEL = process.env.ZAI_ROUTER_COMPLEX_MODEL ?? "glm-5.3";
const FAST_MODEL = process.env.ZAI_ROUTER_FAST_MODEL ?? "glm-5.3-flash";

/** Инструменты, чей успешный результат означает, что реализация началась. */
const EDIT_TOOLS = new Set(["edit", "write"]);

interface ZaiState {
	phase: "planning" | "implementation";
	/** Модель zai для текущей фазы. */
	model: string;
}

/** Диагностический лог роутера (отключается ZAI_ROUTER_QUIET=1). */
const LOG_FILE = join(homedir(), ".pi", "agent", "zai-router.log");

function routerLog(line: string): void {
	if (process.env.ZAI_ROUTER_QUIET === "1") return;
	try {
		appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
	} catch {
		// лог не должен ломать роутинг
	}
}

function routeTo(
	request: ModelRouteRequest<ZaiState>,
	ctx: ExtensionContext,
	id: string,
	state?: ZaiState,
): ModelRoute<ZaiState> {
	const model = ctx.modelRegistry.find(PROVIDER, id);
	if (!model) throw new Error(`Модель ${PROVIDER}/${id} отсутствует в каталоге`);
	return { model, thinkingLevel: request.thinkingLevel, state };
}

function lastUserText(messages: readonly Message[]): string {
	const content = messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
	if (typeof content === "string") return content;
	return content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
}

/** Есть ли в сообщениях запроса картинки. */
function hasImages(messages: readonly Message[]): boolean {
	return messages.some((m) => {
		const content = m.content;
		return typeof content !== "string" && content.some((b) => b.type === "image");
	});
}

/** Была ли успешная правка файла с последнего сообщения пользователя. */
function editedThisTurn(messages: readonly Message[]): boolean {
	const lastUser = messages.findLastIndex((m) => m.role === "user");
	return messages
		.slice(lastUser + 1)
		.some((m) => m.role === "toolResult" && EDIT_TOOLS.has(m.toolName) && !m.isError);
}

/**
 * Модель планирования для новой сессии: complex-модель для сложной работы,
 * fast-модель иначе или если Jev недоступен.
 * Если сессия уже работает на одной из моделей уровней — остаёмся на ней,
 * чтобы переход на auto не стоил промпт-кэш-мисс.
 */
async function choosePlanningModel(
	request: ModelRouteRequest<ZaiState>,
	ctx: ExtensionContext,
): Promise<string> {
	const previous = request.previous?.model;
	if (
		previous?.provider === PROVIDER &&
		(previous.id === COMPLEX_MODEL || previous.id === FAST_MODEL)
	) {
		return previous.id;
	}

	const jev = ctx.modelRegistry.findOfType("classifier", "typesafe", "jev-latest");
	if (!jev) {
		routerLog(`  jev: недоступен -> ${FAST_MODEL}`);
		return FAST_MODEL;
	}
	const t0 = Date.now();
	const result = await ctx.modelRegistry.classify(
		jev,
		{
			state: { prompt: lastUserText(request.messages).slice(0, 16_000) },
			questions: {
				complexity: {
					type: "choice",
					instructions:
						"How demanding is the software engineering work requested in `prompt`?",
					criteria: {
						standard: "Ordinary features, fixes, reviews, or questions",
						complex: "Subtle design, cross-cutting changes, or hard debugging",
					},
				},
			},
		},
		{ signal: request.signal },
	);
	const answer = result.stopReason === "stop" ? result.answers.complexity : undefined;
	const choice =
		answer?.type === "choice" && (answer.probabilities.complex ?? 0) >= 0.5
			? COMPLEX_MODEL
			: FAST_MODEL;
	routerLog(
		`  jev classify: ${answer?.type === "choice" ? answer.choice : `stopReason=${result.stopReason}`}` +
			` p=${answer?.type === "choice" ? JSON.stringify(answer.probabilities) : "-"}` +
			` conf=${answer?.type === "choice" ? answer.confidence?.toFixed(2) : "-"}` +
			` tokens=${result.usage?.totalTokens ?? "-"} ${Date.now() - t0}ms -> ${choice}`,
	);
	return choice;
}

export default function (pi: ExtensionAPI) {
	pi.registerVirtualModel<ZaiState>({
		provider: PROVIDER,
		id: "auto",
		name: "Auto (Jev)",
		thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
		// Консервативные общие лимиты; до первого ответа, после — лимиты физической модели.
		contextWindow: 200_000,
		maxTokens: 131_072,
		async route(request: ModelRouteRequest<ZaiState>, ctx: ExtensionContext) {
			const t0 = Date.now();
			let branch: string;
			let result: ModelRoute<ZaiState>;
			// Компакция и прочие служебные запросы — всегда на дешёвую модель.
			if (request.reason === "direct") {
				branch = "direct";
				result = routeTo(request, ctx, FAST_MODEL);
			} else if (hasImages(request.messages)) {
				// Картинки: fast-модель умеет vision, complex-модель — нет.
				branch = "images";
				result = routeTo(request, ctx, FAST_MODEL);
			} else {
				const state = request.state;
				if (!state) {
					branch = "new-branch(classify)";
					const model = await choosePlanningModel(request, ctx);
					result = routeTo(request, ctx, model, { phase: "planning", model });
				} else if (state.phase === "planning" && editedThisTurn(request.messages)) {
					// Модель планирования сделала первую правку — отдаём остаток хода fast-модели.
					branch = "phase-switch";
					result = routeTo(request, ctx, FAST_MODEL, {
						phase: "implementation",
						model: FAST_MODEL,
					});
				} else {
					branch = `sticky(${state.phase})`;
					result = routeTo(request, ctx, state.model);
				}
			}
			routerLog(
				`route reason=${request.reason} branch=${branch} -> ${result.model.id}:${result.thinkingLevel} (${Date.now() - t0}ms)`,
			);
			return result;
		},
	});
}
