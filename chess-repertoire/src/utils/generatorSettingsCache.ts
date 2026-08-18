import type { GeneratorSettings } from '../types/generator';
import { DEFAULT_GENERATOR_SETTINGS } from '../types/generator';

let cachedGeneratorSettings: GeneratorSettings = DEFAULT_GENERATOR_SETTINGS;
let cachedGeneratorSeeds: string[][] = [];

export function getCachedGeneratorSettings(): GeneratorSettings {
  return cachedGeneratorSettings;
}

export function setCachedGeneratorSettings(settings: GeneratorSettings): void {
  cachedGeneratorSettings = settings;
}

export function getCachedGeneratorSeeds(): string[][] {
  return cachedGeneratorSeeds;
}

export function setCachedGeneratorSeeds(seeds: string[][]): void {
  cachedGeneratorSeeds = seeds;
}
