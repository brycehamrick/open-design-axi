/**
 * Relative-reference extraction for artifact bundles: pull sibling file
 * references out of HTML/CSS/JS entry files so `artifact` can assemble the
 * full design (entry + tokens.css + images + components) in one call.
 * Ported from the daemon's MCP bundle logic, which has shipped against
 * real-world artifacts.
 */

const HTML_REF_PATTERNS: RegExp[] = [
  /<script\b[^>]*\bsrc=["']([^"']+)["']/gi,
  /<link\b[^>]*\bhref=["']([^"']+)["']/gi,
  /<img\b[^>]*\bsrc=["']([^"']+)["']/gi,
  /<source\b[^>]*\bsrc=["']([^"']+)["']/gi,
  /<video\b[^>]*\bsrc=["']([^"']+)["']/gi,
  /<audio\b[^>]*\bsrc=["']([^"']+)["']/gi,
  /<iframe\b[^>]*\bsrc=["']([^"']+)["']/gi,
];

const CSS_REF_PATTERNS: RegExp[] = [
  /\burl\(\s*["']?([^"')]+)["']?\s*\)/gi,
  /@import\s+(?:url\()?\s*["']([^"')]+)["']/gi,
];

const JS_REF_PATTERNS: RegExp[] = [
  /\bimport\s+[^'"]*?['"]([^'"]+)['"]/g,
  /\bfrom\s+['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const SRCSET_PATTERN = /\bsrcset=["']([^"']+)["']/gi;

export function extractRelativeRefs(text: string, fromPath: string, mime: string | undefined): string[] {
  if (!text) return [];
  const refs = new Set<string>();
  const patterns: RegExp[] = [];
  if (isHtmlLike(mime, fromPath)) patterns.push(...HTML_REF_PATTERNS, ...CSS_REF_PATTERNS);
  if (isCssLike(mime, fromPath)) patterns.push(...CSS_REF_PATTERNS);
  if (isJsLike(mime, fromPath)) patterns.push(...JS_REF_PATTERNS);
  if (patterns.length === 0) patterns.push(...CSS_REF_PATTERNS);

  const candidates: string[] = [];
  for (const re of patterns) {
    for (const match of text.matchAll(re)) {
      const ref = (match[1] ?? "").trim();
      if (ref) candidates.push(ref);
    }
  }
  if (isHtmlLike(mime, fromPath)) {
    for (const match of text.matchAll(SRCSET_PATTERN)) {
      for (const part of (match[1] ?? "").split(",")) {
        const url = part.trim().split(/\s+/)[0];
        if (url) candidates.push(url);
      }
    }
  }

  for (const raw of candidates) {
    if (/^(?:https?:|\/\/|data:|mailto:|tel:|#)/i.test(raw)) continue;
    const dir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/") + 1) : "";
    const resolved = raw.startsWith("/") ? raw.slice(1) : dir + raw;
    const stripped = resolved.replace(/[?#].*$/, "");
    const segments = stripped.split("/").filter((segment) => segment.length > 0 && segment !== ".");
    if (segments.length === 0 || segments.some((segment) => segment === "..")) continue;
    refs.add(segments.join("/"));
  }
  return [...refs];
}

function isHtmlLike(mime: string | undefined, path: string): boolean {
  if (mime && /^text\/html\b/i.test(mime)) return true;
  return /\.html?$/i.test(path);
}

function isCssLike(mime: string | undefined, path: string): boolean {
  if (mime && /^text\/css\b/i.test(mime)) return true;
  return /\.css$/i.test(path);
}

function isJsLike(mime: string | undefined, path: string): boolean {
  if (mime && /javascript|typescript/i.test(mime)) return true;
  return /\.(?:m?jsx?|tsx?|cjs)$/i.test(path);
}

const TEXTUAL_MIME = /^(?:text\/(?!csv)[a-z+-]+|application\/(?:json|xml|javascript|xhtml|typescript))\b/i;

export function isTextualMime(mime: string | undefined): boolean {
  if (!mime) return false;
  return TEXTUAL_MIME.test(mime) || /^image\/svg\+xml$/i.test(mime);
}
