import type { GeneratorSettings } from '../types/generator';
import { DEFAULT_GENERATOR_SETTINGS } from '../types/generator';

let cachedGeneratorSettings: GeneratorSettings = DEFAULT_GENERATOR_SETTINGS;

export function getCachedGeneratorSettings(): GeneratorSettings {
  return cachedGeneratorSettings;
}

export function setCachedGeneratorSettings(settings: GeneratorSettings): void {
  cachedGeneratorSettings = settings;
}
