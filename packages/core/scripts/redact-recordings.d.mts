// Types for redact-recordings.mjs, so TypeScript (hosts/redact.ts from c13, and the tests) can import
// its rules under strict mode.
export declare const PLACEHOLDER: Readonly<{
  token: string;
  secret: string;
  signature: string;
  auth: string;
  cookie: string;
  email: string;
}>;
export declare const OWNER_EMAIL_SHA256: readonly string[];
export declare const SECRET_KEYS: readonly string[];
export interface RedactionRule {
  name: string;
  pattern: RegExp;
  replace: (match: string, ...groups: string[]) => string;
}
export declare const RULES: readonly RedactionRule[];
export declare function isAllowedEmail(address: string): boolean;
export declare function redactText(text: string): string;
export declare function redactTree(source: string, destination: string): number;
