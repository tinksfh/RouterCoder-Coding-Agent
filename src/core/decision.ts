import type { Decision, DecisionEngine, Difficulty, RouterKind, TaskContext, Tier } from "./types.js";

const DIFFICULTY_TIER: Record<Difficulty, Tier> = { easy: "small", medium: "medium", hard: "strong" };

export class FixedDecisionEngine implements DecisionEngine {
  constructor(private readonly tier: Tier) {}

  async decide(): Promise<Decision> {
    return {
      router: "fixed", tier: this.tier, difficulty: null, confidence: null,
      probabilities: null, reason: `Fixed tier requested: ${this.tier}`, fallback: false,
    };
  }
}

export class RuleDecisionEngine implements DecisionEngine {
  async decide(context: TaskContext): Promise<Decision> {
    const task = context.task.toLowerCase();
    const hard = /架构|跨模块|迁移|复杂算法|性能瓶颈|安全漏洞|architecture|migration|multi.module|security vulnerability|performance bottleneck/.test(task);
    const easy = /拼写|错别字|注释|文档|readme|typo|comment|documentation|single function|单个函数/.test(task);
    const difficulty: Difficulty = hard ? "hard" : easy ? "easy" : "medium";
    return {
      router: "rule", tier: DIFFICULTY_TIER[difficulty], difficulty,
      confidence: null, probabilities: null,
      reason: hard ? "Matched high-complexity coding rule" : easy ? "Matched narrow coding rule" : "Default coding rule",
      fallback: false,
    };
  }
}

interface JevChoiceAnswer {
  type: "choice";
  choice: Difficulty;
  confidence: number;
  probabilities: Record<Difficulty, number>;
}

export function parseJevResponse(payload: unknown): { answer: JevChoiceAnswer; model: string; usage: { inputTokens: number; outputTokens: number } } {
  if (typeof payload !== "object" || payload === null) throw new Error("Jev returned a non-object response");
  const body = payload as Record<string, unknown>;
  const answers = body.answers as Record<string, unknown> | undefined;
  const answer = answers?.difficulty as Record<string, unknown> | undefined;
  const usage = body.usage as Record<string, unknown> | undefined;
  if (answer?.type !== "choice" || !["easy", "medium", "hard"].includes(String(answer.choice))) {
    throw new Error("Jev returned an invalid difficulty choice");
  }
  if (typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) {
    throw new Error("Jev returned invalid confidence");
  }
  const probabilities = answer.probabilities as Record<string, unknown> | undefined;
  if (!probabilities || ["easy", "medium", "hard"].some((key) => typeof probabilities[key] !== "number" || !Number.isFinite(probabilities[key]) || (probabilities[key] as number) < 0 || (probabilities[key] as number) > 1)) {
    throw new Error("Jev returned invalid probabilities");
  }
  if (typeof body.model !== "string" || typeof usage?.input_tokens !== "number" || typeof usage.output_tokens !== "number") {
    throw new Error("Jev returned invalid model or token usage");
  }
  return {
    answer: answer as unknown as JevChoiceAnswer,
    model: body.model,
    usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
  };
}

export class JevDecisionEngine implements DecisionEngine {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly model = "jev-latest",
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async decide(context: TaskContext): Promise<Decision> {
    try {
      if (!this.apiKey) throw new Error("JEV_API_KEY is not set");
      const response = await this.fetcher("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          state: { task: context.task, languages: context.languages, tracked_files: context.trackedFiles },
          questions: {
            difficulty: {
              type: "choice",
              instructions: "Assess the coding and repository reasoning required to complete the requested code change. Choose one difficulty level.",
              criteria: {
                easy: "A narrow, well-specified change such as a typo, documentation, or one simple function.",
                medium: "Ordinary debugging or implementation involving multiple steps or files.",
                hard: "Cross-module reasoning, architecture changes, difficult algorithms, or high-risk fixes.",
              },
            },
          },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Jev HTTP ${response.status}`);
      const parsed = parseJevResponse(await response.json());
      const confidenceFallback = parsed.answer.confidence < 0.6;
      return {
        router: "jev",
        tier: confidenceFallback ? "strong" : DIFFICULTY_TIER[parsed.answer.choice],
        difficulty: parsed.answer.choice,
        confidence: parsed.answer.confidence,
        probabilities: parsed.answer.probabilities,
        reason: confidenceFallback ? "Jev confidence below 0.60; selected strong" : `Jev classified coding task as ${parsed.answer.choice}`,
        fallback: confidenceFallback,
        jevModel: parsed.model,
        jevUsage: parsed.usage,
      };
    } catch (error) {
      return {
        router: "jev", tier: "strong", difficulty: null, confidence: null,
        probabilities: null, reason: `Jev unavailable: ${error instanceof Error ? error.message : "unknown error"}; selected strong`,
        fallback: true,
      };
    }
  }
}

export function createDecisionEngine(router: RouterKind, tier?: Tier): DecisionEngine {
  if (router === "fixed") {
    if (!tier) throw new Error("Fixed routing requires a tier");
    return new FixedDecisionEngine(tier);
  }
  if (router === "rule") return new RuleDecisionEngine();
  return new JevDecisionEngine(process.env.JEV_API_KEY, process.env.JEV_MODEL || "jev-latest");
}
