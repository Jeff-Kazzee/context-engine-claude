// Synthetic-fixture scanning helper imported from pinned MIT source; no captures.
const CREDENTIAL = new RegExp(
  [
    String.raw`eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]*`, // JWT (ChatGPT access/id tokens)
    String.raw`\bBearer\s+[A-Za-z0-9._\-]+`,
    String.raw`\bsk-[A-Za-z0-9_\-]{16,}`,
    String.raw`chatgpt-account-id["':\s=]+[A-Za-z0-9\-]{8,}`,
    String.raw`"?account_id"?\s*[:=]\s*"?[A-Za-z0-9\-]{8,}`,
    String.raw`\b(?:set-)?cookie["':\s=]+[^\s"]{8,}`,
    String.raw`__Secure-[A-Za-z0-9_\-.]+=\S+`,
    String.raw`[A-Za-z0-9+/=_\-]{80,}`,
  ].join('|'),
  'gi',
);

export function redact(s: string): string {
  return s.replace(CREDENTIAL, '<REDACTED>');
}

/** Credential-looking matches in `text` (used on the evidence before it is written). */
export function credentialHits(text: string): string[] {
  return [...text.matchAll(CREDENTIAL)].map((m) => `${m[0].slice(0, 12)}…`);
}

