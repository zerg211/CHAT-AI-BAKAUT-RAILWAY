/**
 * Company-knowledge classification for first-party site pages (F05).
 *
 * Public company facts (addresses, phones, payment/warranty rules) are STABLE or
 * SEMI_VOLATILE and must be answered from the company's own pages — never guessed
 * and never delegated to the buyer. Operational state (live stock, reservations,
 * exact delivery quotes, personal discounts) is HUMAN-only and stays out of here.
 */
export type CompanyPageKind =
  | 'company_contacts'
  | 'company_delivery'
  | 'company_about'
  | 'company_warranty'
  | 'company_brands';

export type InfoVolatility = 'STABLE' | 'SEMI_VOLATILE';

/** First path segments that carry public company information. */
export const COMPANY_CONTENT_ROOTS = [
  'contacts',
  'delivery-and-payment',
  'about',
  'garantiya',
  'guarantee',
  'brands'
] as const;

const VOLATILITY: Record<CompanyPageKind, InfoVolatility> = {
  company_contacts: 'STABLE',
  company_delivery: 'SEMI_VOLATILE',
  company_about: 'STABLE',
  company_warranty: 'STABLE',
  company_brands: 'STABLE'
};

export interface CompanyPageClass {
  kind: CompanyPageKind;
  volatility: InfoVolatility;
}

function firstPathSegment(pathname: string): string {
  const parts = pathname.split('/').filter((part) => part.length > 0);
  return (parts[0] ?? '').toLowerCase();
}

/** Classifies a same-origin pathname as a company page, or null when it is not one. */
export function classifyCompanyPath(pathname: string): CompanyPageClass | null {
  const root = firstPathSegment(pathname);
  switch (root) {
    case 'contacts':
      return { kind: 'company_contacts', volatility: VOLATILITY.company_contacts };
    case 'delivery-and-payment':
      return { kind: 'company_delivery', volatility: VOLATILITY.company_delivery };
    case 'about':
      return { kind: 'company_about', volatility: VOLATILITY.company_about };
    case 'garantiya':
    case 'guarantee':
      return { kind: 'company_warranty', volatility: VOLATILITY.company_warranty };
    case 'brands':
      return { kind: 'company_brands', volatility: VOLATILITY.company_brands };
    default:
      return null;
  }
}

/** True when the pathname belongs to the company-knowledge space (not catalog). */
export function isCompanyPath(pathname: string): boolean {
  return classifyCompanyPath(pathname) !== null;
}
