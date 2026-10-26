import type { Api, Model } from '@earendil-works/pi-ai'
import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent'

// pi-ai builds both clients with the resolved key as an Authorization bearer
// and hands every request to the caller's fetch. Models of any other api send
// their key elsewhere and are never served.
export const bearerApis = ['openai-completions', 'openai-responses'] as const
export type BearerApi = (typeof bearerApis)[number]

function isBearerApi(api: string): api is BearerApi {
  return bearerApis.some((candidate) => candidate === api)
}

// A Pi registration serves one api. Pick the one most of the provider's models
// use, preferring chat completions on a tie, so the registration is stable.
export function bearerApi(
  models: readonly Model<Api>[],
): BearerApi | undefined {
  let best: BearerApi | undefined
  let bestCount = 0
  for (const api of bearerApis) {
    const count = models.filter((model) => model.api === api).length
    if (count > bestCount) {
      best = api
      bestCount = count
    }
  }
  return best
}

export function isServableModel(model: Model<Api>) {
  return isBearerApi(model.api)
}

// The owned registration replaces the provider's model list. It keeps every
// model of the served api exactly as Pi composed it (built-in catalog plus
// models.json), and leaves out the rest, which would otherwise reach their
// built-in stream with the placeholder as their key.
export function ownedModels(
  models: readonly Model<Api>[],
  api: BearerApi,
): ProviderModelConfig[] {
  return models
    .filter((model) => model.api === api)
    .map(({ provider: _provider, ...model }) => model as ProviderModelConfig)
}
