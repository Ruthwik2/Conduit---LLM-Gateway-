import type { Config } from "../config/schema.js";
import type { RoutePlan } from "../types/internal.js";
import { AnthropicProvider } from "./anthropic.js";
import { MockProvider } from "./mock.js";
import { OpenAIProvider } from "./openai.js";
import type { ChatProvider } from "./provider.js";

/**
 * Instantiates every configured provider and answers two questions for the
 * router: "give me the provider named X" and "for model M, what's the ordered
 * list of providers to try?". A route whose model is `*` is the catch-all.
 */
export class ProviderRegistry {
  private providers = new Map<string, ChatProvider>();
  private routes: Config["routes"];

  constructor(config: Config) {
    this.routes = config.routes;
    for (const pc of config.providers) {
      this.providers.set(pc.name, buildProvider(pc));
    }
    // Validate that every route target references a real provider — fail fast.
    for (const route of this.routes) {
      for (const target of route.targets) {
        if (!this.providers.has(target.provider)) {
          throw new Error(
            `Route for model "${route.model}" references unknown provider "${target.provider}".`,
          );
        }
      }
    }
  }

  getProvider(name: string): ChatProvider | undefined {
    return this.providers.get(name);
  }

  /** Only the mock providers, exposed for the demo-control endpoint. */
  mockProviders(): MockProvider[] {
    return [...this.providers.values()].filter((p): p is MockProvider => p instanceof MockProvider);
  }

  /** A specific mock provider by name (for the demo-control endpoint). */
  findMock(name: string): MockProvider | undefined {
    return this.mockProviders().find((p) => p.name === name);
  }

  /** Distinct, concrete model ids this gateway advertises (excludes the `*` route). */
  routeModels(): string[] {
    const ids = this.routes.map((r) => r.model).filter((m) => m !== "*");
    return [...new Set(ids)];
  }

  /** Resolve a requested model to an ordered failover plan, or null if unrouted. */
  resolveRoute(model: string): RoutePlan | null {
    const exact = this.routes.find((r) => r.model === model);
    const wildcard = this.routes.find((r) => r.model === "*");
    const route = exact ?? wildcard;
    if (!route) return null;

    return {
      model,
      targets: route.targets.map((t) => ({
        provider: t.provider,
        upstreamModel: t.model ?? (route.model === "*" ? model : route.model),
      })),
    };
  }
}

function buildProvider(pc: Config["providers"][number]): ChatProvider {
  switch (pc.type) {
    case "openai":
      return new OpenAIProvider({
        name: pc.name,
        apiKey: pc.apiKey,
        ...(pc.baseURL ? { baseURL: pc.baseURL } : {}),
        ...(pc.vendor ? { vendor: pc.vendor } : {}),
      });
    case "anthropic":
      return new AnthropicProvider({
        name: pc.name,
        apiKey: pc.apiKey,
        ...(pc.baseURL ? { baseURL: pc.baseURL } : {}),
        ...(pc.defaultMaxTokens ? { defaultMaxTokens: pc.defaultMaxTokens } : {}),
      });
    case "mock":
      return new MockProvider(pc.name, pc.behavior ?? {});
  }
}
