/** Curated publisher provenance. Entries are exact registrable domains. */
export const MANUFACTURER_DOMAIN_REGISTRY: ReadonlyArray<{
  brandKeys: readonly string[];
  domains: readonly string[];
}> = [
  { brandKeys: ['firman'], domains: ['firman.biz'] },
  { brandKeys: ['fubag'], domains: ['fubag.group'] },
  { brandKeys: ['honda'], domains: ['honda.com', 'honda.co.jp', 'honda.ca'] },
  { brandKeys: ['husqvarna'], domains: ['husqvarna.com', 'husqvarnaconstruction.com'] },
  { brandKeys: ['stihl'], domains: ['stihl.com', 'stihlusa.com', 'stihl.co.uk', 'stihl.de'] }
];

export function manufacturerDomainsForBrandKey(brandKey: string): readonly string[] {
  return MANUFACTURER_DOMAIN_REGISTRY.find((entry) => entry.brandKeys.includes(brandKey))?.domains ?? [];
}

export function hostMatchesManufacturerDomain(host: string, domain: string) {
  return host === domain || host.endsWith(`.${domain}`);
}
