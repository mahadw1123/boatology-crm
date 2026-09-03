/**
 * Lightweight predictive models for Boatology.
 *
 * Design choice: models are retrained from scratch on every request rather
 * than incrementally updated or cached. This sounds inefficient but isn't —
 * with a small business's realistic data volume (dozens to low thousands of
 * rows), retraining a linear/logistic regression takes a few milliseconds.
 * The benefit: the model always reflects 100% of the data up to this exact
 * moment, there's no stale cached model, and there's no separate "retrain"
 * step to schedule or forget about. As the business logs more real quotes
 * and jobs, predictions improve automatically on the very next request.
 *
 * Each model refuses to predict below a minimum sample size and says so
 * explicitly, rather than returning a confident-looking guess from too
 * little data.
 */
import MultivariateLinearRegression from "ml-regression-multivariate-linear";
import * as db from "../db";

/**
 * A small, self-contained logistic regression (gradient descent on a
 * sigmoid). Written by hand rather than pulled from a library because the
 * most popular lightweight JS option (ml-logistic-regression) only exposes
 * a one-vs-all multi-class wrapper with inverted label semantics and no way
 * to get a real probability out — the wrong shape for a simple binary
 * "will this be accepted?" question. This version is short enough to read
 * end-to-end and returns an actual probability, not just a hard class.
 */
function trainLogisticRegression(features: number[][], labels: number[], numSteps = 2000, learningRate = 0.1) {
  const numFeatures = features[0].length;
  let weights = new Array(numFeatures).fill(0);
  let bias = 0;
  const n = features.length;

  for (let step = 0; step < numSteps; step++) {
    const gradW = new Array(numFeatures).fill(0);
    let gradB = 0;

    for (let i = 0; i < n; i++) {
      const z = features[i].reduce((sum, x, j) => sum + x * weights[j], bias);
      const prediction = 1 / (1 + Math.exp(-z));
      const error = prediction - labels[i];
      for (let j = 0; j < numFeatures; j++) gradW[j] += error * features[i][j];
      gradB += error;
    }

    for (let j = 0; j < numFeatures; j++) weights[j] -= (learningRate * gradW[j]) / n;
    bias -= (learningRate * gradB) / n;
  }

  return {
    predictProbability: (input: number[]) => {
      const z = input.reduce((sum, x, j) => sum + x * weights[j], bias);
      return 1 / (1 + Math.exp(-z));
    },
  };
}

const MIN_REGRESSION_SAMPLES = 8;
const MIN_CLASSIFICATION_SAMPLES_PER_CLASS = 4;

function monthOf(dateStr?: string | null): number {
  if (!dateStr) return new Date().getMonth() + 1;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? new Date().getMonth() + 1 : d.getMonth() + 1;
}

const PRIORITY_WEIGHT: Record<string, number> = { low: 1, medium: 2, high: 3, urgent: 4 };

// ============================================================================
// AREA 1 — Quote acceptance likelihood (classification)
// ============================================================================

export type QuoteAcceptanceInput = {
  totalAmount: number;
  lineItemCount: number;
  hasVessel: boolean;
  monthOfYear?: number;
};

export type ModelResult<T> =
  | { ready: true; sampleCount: number; result: T }
  | { ready: false; sampleCount: number; minRequired: number; reason: string };

export async function predictQuoteAcceptance(
  input: QuoteAcceptanceInput
): Promise<ModelResult<{ probability: number }>> {
  const allQuotes = await db.getQuotes();
  const resolved = allQuotes.filter((q) => q.status === "accepted" || q.status === "rejected");

  const accepted = resolved.filter((q) => q.status === "accepted").length;
  const rejected = resolved.length - accepted;

  if (
    resolved.length < MIN_CLASSIFICATION_SAMPLES_PER_CLASS * 2 ||
    accepted < MIN_CLASSIFICATION_SAMPLES_PER_CLASS ||
    rejected < MIN_CLASSIFICATION_SAMPLES_PER_CLASS
  ) {
    return {
      ready: false,
      sampleCount: resolved.length,
      minRequired: MIN_CLASSIFICATION_SAMPLES_PER_CLASS * 2,
      reason: `Needs at least ${MIN_CLASSIFICATION_SAMPLES_PER_CLASS} accepted and ${MIN_CLASSIFICATION_SAMPLES_PER_CLASS} rejected quotes to learn from (have ${accepted} accepted, ${rejected} rejected).`,
    };
  }

  const rawFeatures: number[][] = [];
  const labels: number[] = [];

  for (const q of resolved) {
    const items = Array.isArray(q.lineItems) ? (q.lineItems as any[]) : [];
    rawFeatures.push([q.totalAmount || 0, items.length, q.vesselId ? 1 : 0, monthOf(q.createdAt)]);
    labels.push(q.status === "accepted" ? 1 : 0);
  }

  // Standardize features (z-score) before gradient descent — a large-scale
  // feature like totalAmount (hundreds-to-thousands) versus a small-scale
  // one like month (1-12) makes gradient descent converge poorly otherwise.
  const numFeatures = rawFeatures[0].length;
  const means: number[] = [];
  const stds: number[] = [];
  for (let col = 0; col < numFeatures; col++) {
    const values = rawFeatures.map((r) => r[col]);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    means.push(mean);
    stds.push(Math.sqrt(variance) || 1);
  }
  const standardize = (row: number[]) => row.map((v, i) => (v - means[i]) / stds[i]);

  const features = rawFeatures.map(standardize);
  const model = trainLogisticRegression(features, labels);

  const rawQuery = [input.totalAmount, input.lineItemCount, input.hasVessel ? 1 : 0, input.monthOfYear ?? new Date().getMonth() + 1];
  const probability = model.predictProbability(standardize(rawQuery));

  return {
    ready: true,
    sampleCount: resolved.length,
    result: { probability: Math.max(0, Math.min(1, probability)) },
  };
}

// ============================================================================
// AREA 2 — Job duration estimate (regression)
// ============================================================================

export type JobDurationInput = {
  estimatedLaborHours: number;
  lineItemCount: number;
  priority: string;
  monthOfYear?: number;
};

export async function predictJobDuration(
  input: JobDurationInput
): Promise<ModelResult<{ hours: number }>> {
  const allJobs = await db.getJobs();
  const withActuals = allJobs.filter((j) => typeof j.actualLaborHours === "number" && j.actualLaborHours! > 0);

  if (withActuals.length < MIN_REGRESSION_SAMPLES) {
    return {
      ready: false,
      sampleCount: withActuals.length,
      minRequired: MIN_REGRESSION_SAMPLES,
      reason: `Needs at least ${MIN_REGRESSION_SAMPLES} completed jobs with logged actual hours to learn from (have ${withActuals.length}).`,
    };
  }

  const features: number[][] = [];
  const targets: number[][] = [];

  for (const j of withActuals) {
    const linkedQuote = j.quoteId ? await db.getQuoteById(j.quoteId) : null;
    const lineItemCount = linkedQuote && Array.isArray(linkedQuote.lineItems) ? (linkedQuote.lineItems as any[]).length : 0;
    features.push([
      j.estimatedLaborHours || 0,
      lineItemCount,
      PRIORITY_WEIGHT[j.priority || "medium"] || 2,
      monthOf(j.createdAt),
    ]);
    targets.push([j.actualLaborHours!]);
  }

  const model = new MultivariateLinearRegression(features, targets);

  const prediction = model.predict([
    input.estimatedLaborHours,
    input.lineItemCount,
    PRIORITY_WEIGHT[input.priority] || 2,
    input.monthOfYear ?? new Date().getMonth() + 1,
  ]);

  const hours = Math.max(0, Math.round(prediction[0] * 100) / 100);

  return {
    ready: true,
    sampleCount: withActuals.length,
    result: { hours },
  };
}
