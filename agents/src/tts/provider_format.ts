// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Strip only LiveKit expressive `<expr/>` tags, leaving provider-native markup untouched. */
export function stripExprMarkup(text: string): string {
  let stripped = text;
  let previous: string;

  do {
    previous = stripped;
    stripped = stripped
      .replace(/<expr\b[^>]*\/>/gi, '')
      .replace(/<expr\b[^>]*>([\s\S]*?)<\/expr>/gi, '$1');
  } while (stripped !== previous);

  stripped = stripped.replace(/<expr\b[^>]*\/?>/gi, '').replace(/<\/expr\s*>/gi, '');

  return stripped;
}
