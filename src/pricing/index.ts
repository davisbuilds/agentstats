import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

// ─── Types ──────────────────────────────────────────────────────────────

interface PricingDataModel {
  aliases?: string[];
  inputCostPerMTok: number;
  outputCostPerMTok: number;
  cacheReadCostPerMTok: number;
  cacheWriteCostPerMTok: number;
  deprecated: boolean;
}

interface PricingDataFile {
  provider: string;
  lastUpdated: string;
  models: Record<string, PricingDataModel>;
}

export interface ModelPricing {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheReadCostPerToken: number;
  cacheWriteCostPerToken: number;
  provider: string;
  deprecated: boolean;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

// ─── PricingRegistry ────────────────────────────────────────────────────

const M_TOK = 1_000_000;

export class PricingRegistry {
  private models = new Map<string, ModelPricing>();
  private aliases = new Map<string, string>(); // alias → canonical name

  constructor() {
    this.loadAll();
  }

  private loadAll(): void {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    // Works in dev (tsx: src/pricing/) and prod (dist/pricing/ after copy)
    const dataDir = path.join(__dirname, 'data');

    for (const file of ['claude.json', 'codex.json', 'gemini.json']) {
      try {
        const raw = readFileSync(path.join(dataDir, file), 'utf-8');
        const data = JSON.parse(raw) as PricingDataFile;
        this.loadProvider(data);
      } catch {
        // Data file missing or malformed — skip silently in production
      }
    }
  }

  private loadProvider(data: PricingDataFile): void {
    for (const [canonicalName, model] of Object.entries(data.models)) {
      const pricing: ModelPricing = {
        inputCostPerToken: model.inputCostPerMTok / M_TOK,
        outputCostPerToken: model.outputCostPerMTok / M_TOK,
        cacheReadCostPerToken: model.cacheReadCostPerMTok / M_TOK,
        cacheWriteCostPerToken: model.cacheWriteCostPerMTok / M_TOK,
        provider: data.provider,
        deprecated: model.deprecated,
      };

      this.models.set(canonicalName, pricing);

      if (model.aliases) {
        for (const alias of model.aliases) {
          this.aliases.set(alias, canonicalName);
        }
      }
    }
  }

  /**
   * Normalize a model name by stripping common provider prefixes.
   */
  private normalize(model: string): string {
    return model
      .replace(/^anthropic\//, '')
      .replace(/^openai\//, '')
      .replace(/^google\//, '');
  }

  /**
   * Look up pricing for a model by canonical name or alias.
   */
  lookup(model: string): ModelPricing | null {
    const normalized = this.normalize(model);

    // Try direct canonical match
    const direct = this.models.get(normalized);
    if (direct) return direct;

    // Try alias
    const canonical = this.aliases.get(normalized);
    if (canonical) return this.models.get(canonical) ?? null;

    return null;
  }

  /**
   * Calculate cost in USD for a set of token counts.
   * Returns null if the model is not found.
   */
  calculate(model: string, tokens: TokenCounts): number | null {
    const pricing = this.lookup(model);
    if (!pricing) return null;

    return (tokens.input * pricing.inputCostPerToken)
      + (tokens.output * pricing.outputCostPerToken)
      + ((tokens.cacheRead ?? 0) * pricing.cacheReadCostPerToken)
      + ((tokens.cacheWrite ?? 0) * pricing.cacheWriteCostPerToken);
  }

  /**
   * Check if a model is known to the registry.
   */
  has(model: string): boolean {
    return this.lookup(model) !== null;
  }

  /**
   * Get all known canonical model names.
   */
  get knownModels(): string[] {
    return [...this.models.keys()];
  }
}

// Singleton instance
export const pricingRegistry = new PricingRegistry();
