export const TIERS = ["small", "medium", "strong"] as const;
export type Tier = (typeof TIERS)[number];
export type Difficulty = "easy" | "medium" | "hard";
export type RouterKind = "jev" | "rule" | "fixed";
export const JEV_INPUT_MODES = ["baseline", "hint", "analysis"] as const;
export type JevInputMode = (typeof JEV_INPUT_MODES)[number];

export interface ComplexityFactors {
  changeScope: string;
  dependencies: string;
  integrationRisk: string;
  uncertainties: string[];
  confirmedFacts: { statement: string; evidenceIds: string[] }[];
  assumptions: string[];
}

export interface PlannerAnalysis {
  plannerModel: string;
  complexityHint?: Difficulty;
  complexityFactors?: ComplexityFactors;
  evidenceBasis: "planning_snapshot";
  evidence: CodeEvidence[];
}

export interface ModelConfig {
  provider: string;
  model: string;
  contextWindow: number;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  cacheReadPricePerMillion?: number;
  cacheWritePricePerMillion?: number;
}

export interface ModelsConfig {
  models: Record<Tier, ModelConfig>;
  allowDuplicateModels?: boolean;
}

export interface TaskContext {
  task: string;
  repoPath: string;
  commit: string | null;
  trackedFiles: number;
  languages: string[];
  sampleFiles?: string[];
  workspaceKind?: "empty" | "existing";
  plannerAnalysis?: PlannerAnalysis;
}

export interface PlannedSubtask {
  id: string;
  description: string;
  acceptanceCriteria: string[];
  requirementIds: string[];
  dependsOn: string[];
  inputs: string[];
  outputs: string[];
  expectedFiles: string[];
  verification: string[];
  rationale: string;
  evidenceIds: string[];
  complexityHint?: Difficulty;
  complexityFactors?: ComplexityFactors;
}

export interface TaskRequirement {
  id: string;
  description: string;
  sourceQuote: string;
}

export interface CodeEvidence {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  excerpt: string;
  sha256: string;
}

export interface PlanningInspection {
  evidence: CodeEvidence[];
  filesConsidered: number;
  truncated: boolean;
  notes: string[];
}

export interface PlanValidation {
  status: "passed" | "fallback";
  attempts: number;
  errors: string[];
  warnings: string[];
}

export interface TaskPlan {
  source: "model" | "direct" | "fallback";
  plannerModel: string;
  subtasks: PlannedSubtask[];
  requirements: TaskRequirement[];
  rationale: string;
  inspection: PlanningInspection;
  validation: PlanValidation;
  metrics: AgentMetrics;
  error?: string;
}

export interface QualityCheck {
  name: string;
  command: string;
  status: "passed" | "failed" | "unavailable";
  exitCode: number | null;
  durationMs: number;
  output: string;
}

export interface QualityAssessment {
  score: number | null;
  status: "verified" | "estimated" | "failed" | "unverified";
  checks: QualityCheck[];
  note: string;
  requirementReview?: {
    score: number;
    confidence: number;
    evidence: string[];
    model: string;
    priceSnapshot: ModelConfig;
    metrics: AgentMetrics;
  };
  reviewAttempt?: {
    model: string;
    priceSnapshot: ModelConfig;
    metrics: AgentMetrics;
    error: string;
  };
}

export interface SubtaskTrace {
  plan: PlannedSubtask;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  decision: Decision | null;
  selectedModel: { tier: Tier; provider: string; model: string } | null;
  priceSnapshot: ModelConfig | null;
  costEstimateBasis: string | null;
  agent: AgentResult | null;
  diff: string;
  status: "success" | "failed";
  error: string | null;
}

export interface Decision {
  router: RouterKind;
  tier: Tier;
  difficulty: Difficulty | null;
  confidence: number | null;
  probabilities: Record<Difficulty, number> | null;
  reason: string;
  fallback: boolean;
  jevModel?: string;
  jevUsage?: { inputTokens: number; outputTokens: number };
  /** Exact request state (without authorization), including the input ablation mode. */
  jevInput?: { mode: JevInputMode; state: Record<string, unknown> };
  plannerComparison?: { hint: Difficulty; jevDifficulty: Difficulty | null; disagrees: boolean | null };
}

export interface DecisionEngine {
  decide(context: TaskContext): Promise<Decision>;
}

export interface AgentMetrics {
  modelsUsed: string[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolCalls: { name: string; count: number; errors: number }[];
  estimatedCostUsd: number;
}

export interface AgentResult {
  success: boolean;
  summary: string;
  error?: string;
  metrics: AgentMetrics;
}

export interface RunTrace {
  id: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: "success" | "failed";
  task: string;
  repoPath: string;
  commit: string | null;
  router: RouterKind;
  decision: Decision | null;
  selectedModel: { tier: Tier; provider: string; model: string } | null;
  priceSnapshot: ModelConfig | null;
  costEstimateBasis: string | null;
  agent: AgentResult | null;
  diff: string;
  error: string | null;
  plan?: TaskPlan | null;
  subtasks?: SubtaskTrace[];
  quality?: QualityAssessment | null;
}
