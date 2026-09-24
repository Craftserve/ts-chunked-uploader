/** Convert std-base64 to base64url (RFC 4648 §5), trailing `=` stripped. */
export function toBase64Url(s: string): string {
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
