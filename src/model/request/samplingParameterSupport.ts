import type {
  CanonicalModelRequest,
  CanonicalSamplingParameter,
  ModelProtocol,
  ProviderConfig,
} from "../protocol/canonical.js";

export const CANONICAL_SAMPLING_PARAMETERS = [
  "topP",
  "topK",
  "minP",
  "presencePenalty",
  "frequencyPenalty",
  "repetitionPenalty",
  "seed",
] as const satisfies readonly CanonicalSamplingParameter[];

const PROTOCOL_DEFAULTS: Record<ModelProtocol, readonly CanonicalSamplingParameter[]> = {
  anthropic: ["topP", "topK"],
  google: ["topP", "topK", "presencePenalty", "frequencyPenalty", "seed"],
  openai: ["topP", "presencePenalty", "frequencyPenalty", "seed"],
  "openai-responses": ["topP"],
};

const PROVIDER_DEFAULTS: Record<string, readonly CanonicalSamplingParameter[]> = {
  // OpenRouter documents these OpenAI-compatible extensions.
  openrouter: ["topK", "minP", "repetitionPenalty"],
};

export function supportsSamplingParameter(
  provider: Pick<ProviderConfig, "id" | "protocol" | "supportedRequestParameters">,
  parameter: CanonicalSamplingParameter,
): boolean {
  return PROTOCOL_DEFAULTS[provider.protocol].includes(parameter)
    || (PROVIDER_DEFAULTS[provider.id] ?? []).includes(parameter)
    || (
      provider.protocol === "openai"
      && (provider.supportedRequestParameters ?? []).includes(parameter)
    );
}

export function requestedSamplingParameters(
  request: CanonicalModelRequest,
): CanonicalSamplingParameter[] {
  return CANONICAL_SAMPLING_PARAMETERS.filter((parameter) => request[parameter] !== undefined);
}
