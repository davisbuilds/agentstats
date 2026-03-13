use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Deserialize;
use tracing::warn;

const M_TOK: f64 = 1_000_000.0;

const CLAUDE_PRICING_JSON: &str = include_str!("../../src/pricing/data/claude.json");
const CODEX_PRICING_JSON: &str = include_str!("../../src/pricing/data/codex.json");
const GEMINI_PRICING_JSON: &str = include_str!("../../src/pricing/data/gemini.json");

#[derive(Debug, Clone, Copy)]
struct ModelPricing {
    input_cost_per_token: f64,
    output_cost_per_token: f64,
    cache_read_cost_per_token: f64,
    cache_write_cost_per_token: f64,
}

#[derive(Debug, Default)]
struct PricingRegistry {
    models: HashMap<String, ModelPricing>,
    aliases: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct PricingDataFile {
    models: HashMap<String, PricingDataModel>,
}

#[derive(Debug, Deserialize)]
struct PricingDataModel {
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(rename = "inputCostPerMTok")]
    input_cost_per_m_tok: f64,
    #[serde(rename = "outputCostPerMTok")]
    output_cost_per_m_tok: f64,
    #[serde(rename = "cacheReadCostPerMTok")]
    cache_read_cost_per_m_tok: f64,
    #[serde(rename = "cacheWriteCostPerMTok")]
    cache_write_cost_per_m_tok: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct TokenCounts {
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
}

static PRICING_REGISTRY: OnceLock<PricingRegistry> = OnceLock::new();

impl PricingRegistry {
    fn load() -> Self {
        let mut registry = Self::default();
        for raw in [CLAUDE_PRICING_JSON, CODEX_PRICING_JSON, GEMINI_PRICING_JSON] {
            let parsed = serde_json::from_str::<PricingDataFile>(raw);
            match parsed {
                Ok(file) => registry.load_provider(file),
                Err(err) => warn!("failed to parse pricing data file: {err}"),
            }
        }
        registry
    }

    fn load_provider(&mut self, file: PricingDataFile) {
        for (canonical_name, model) in file.models {
            let pricing = ModelPricing {
                input_cost_per_token: model.input_cost_per_m_tok / M_TOK,
                output_cost_per_token: model.output_cost_per_m_tok / M_TOK,
                cache_read_cost_per_token: model.cache_read_cost_per_m_tok / M_TOK,
                cache_write_cost_per_token: model.cache_write_cost_per_m_tok / M_TOK,
            };
            self.models.insert(canonical_name.clone(), pricing);
            for alias in model.aliases {
                self.aliases.insert(alias, canonical_name.clone());
            }
        }
    }

    fn lookup(&self, model_name: &str) -> Option<ModelPricing> {
        let normalized = normalize_model_name(model_name);
        if let Some(pricing) = self.models.get(&normalized) {
            return Some(*pricing);
        }
        self.aliases
            .get(&normalized)
            .and_then(|canonical_name| self.models.get(canonical_name))
            .copied()
    }

    fn calculate(&self, model_name: &str, tokens: TokenCounts) -> Option<f64> {
        let pricing = self.lookup(model_name)?;
        Some(
            (tokens.input as f64 * pricing.input_cost_per_token)
                + (tokens.output as f64 * pricing.output_cost_per_token)
                + (tokens.cache_read as f64 * pricing.cache_read_cost_per_token)
                + (tokens.cache_write as f64 * pricing.cache_write_cost_per_token),
        )
    }
}

fn normalize_model_name(model_name: &str) -> String {
    model_name
        .trim_start_matches("anthropic/")
        .trim_start_matches("openai/")
        .trim_start_matches("google/")
        .to_string()
}

pub fn calculate_cost(model_name: &str, tokens: TokenCounts) -> Option<f64> {
    let registry = PRICING_REGISTRY.get_or_init(PricingRegistry::load);
    registry.calculate(model_name, tokens)
}

#[cfg(test)]
mod tests {
    use super::{TokenCounts, calculate_cost};

    #[test]
    fn calculates_cost_for_known_model() {
        let cost = calculate_cost(
            "gpt-5.4",
            TokenCounts {
                input: 100_000,
                output: 50_000,
                cache_read: 40_000,
                cache_write: 999_999,
            },
        );
        let value = cost.expect("known model should return cost");
        // 100K * $2.50/MTok + 50K * $15/MTok + 40K * $0.25/MTok + cache write * $0
        assert!((value - 1.01).abs() < 1e-10);
    }

    #[test]
    fn supports_aliases_and_provider_prefixes() {
        let cost = calculate_cost(
            "openai/gpt-5.4-2026-03-05",
            TokenCounts {
                input: 1_000_000,
                output: 0,
                cache_read: 0,
                cache_write: 0,
            },
        );
        let value = cost.expect("alias should resolve");
        assert!((value - 2.5).abs() < 1e-10);
    }

    #[test]
    fn resolves_new_gemini_model() {
        let cost = calculate_cost(
            "google/gemini-3-flash-preview",
            TokenCounts {
                input: 1_000_000,
                output: 0,
                cache_read: 0,
                cache_write: 0,
            },
        );
        let value = cost.expect("gemini model should resolve");
        assert!((value - 0.5).abs() < 1e-10);
    }

    #[test]
    fn returns_none_for_unknown_model() {
        let cost = calculate_cost(
            "unknown-model-xyz",
            TokenCounts {
                input: 1_000_000,
                output: 0,
                cache_read: 0,
                cache_write: 0,
            },
        );
        assert!(cost.is_none());
    }
}
