import { describe, expect, it } from 'vitest';

import { escapeHtml } from '../../src/mastra/auth/mailer';

describe('escapeHtml', () => {
  it('escapes every character that can open markup or break an attribute', () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'y'`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;',
    );
  });

  it('escapes & first, so existing entities are not double-decoded into markup', () => {
    expect(escapeHtml('&lt;b&gt;')).toBe('&amp;lt;b&amp;gt;');
  });

  it('leaves plain text alone', () => {
    expect(escapeHtml("Acme's org")).toBe('Acme&#39;s org');
    expect(escapeHtml('Plain name')).toBe('Plain name');
  });
});
