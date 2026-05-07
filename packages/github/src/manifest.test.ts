import { describe, expect, it } from 'vitest';
import { buildManifest, preflightPublicUrl } from './manifest.js';

describe('buildManifest', () => {
  const m = buildManifest({ name: 'gcr-bot', publicUrl: 'https://reviewer.example.com' });

  it('generates the webhook + redirect URLs from publicUrl', () => {
    expect(m.hook_attributes.url).toBe('https://reviewer.example.com/webhooks/github');
    expect(m.redirect_url).toBe('https://reviewer.example.com/setup/callback');
    expect(m.callback_urls).toContain('https://reviewer.example.com/setup/callback');
  });

  it('uses the minimal permission set', () => {
    expect(m.default_permissions).toEqual({
      pull_requests: 'write',
      issues: 'write',
      contents: 'read',
      metadata: 'read',
    });
    expect(Object.keys(m.default_permissions)).not.toContain('members');
  });

  it('does NOT subscribe to installation/installation_repositories (GitHub rejects those in default_events)', () => {
    expect(m.default_events).not.toContain('installation');
    expect(m.default_events).not.toContain('installation_repositories');
  });

  it('subscribes to the events we actually need', () => {
    expect(m.default_events).toEqual(['pull_request', 'issue_comment']);
  });

  it('marks the App private (not listed in the GitHub Marketplace)', () => {
    expect(m.public).toBe(false);
  });
});

describe('preflightPublicUrl', () => {
  it('accepts a real https URL', () => {
    const r = preflightPublicUrl('https://reviewer.example.com');
    expect(r.ok).toBe(true);
  });

  it('accepts smee.io', () => {
    const r = preflightPublicUrl('https://smee.io/abc123');
    expect(r.ok).toBe(true);
  });

  it('rejects localhost with a smee.io suggestion', () => {
    const r = preflightPublicUrl('http://localhost:3000');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('localhost');
      expect(r.suggestion).toContain('smee.io');
    }
  });

  it('rejects 127.0.0.1', () => {
    const r = preflightPublicUrl('http://127.0.0.1:3000');
    expect(r.ok).toBe(false);
  });

  it('rejects RFC1918 (private network) addresses', () => {
    expect(preflightPublicUrl('http://10.0.0.1').ok).toBe(false);
    expect(preflightPublicUrl('http://192.168.1.1').ok).toBe(false);
    expect(preflightPublicUrl('http://172.16.0.1').ok).toBe(false);
    expect(preflightPublicUrl('http://172.31.0.1').ok).toBe(false);
  });

  it('PRESERVES non-RFC1918 ranges that look similar', () => {
    // 172.15.x and 172.32.x are public; the regex has to bound 16-31 properly.
    expect(preflightPublicUrl('http://172.15.0.1').ok).toBe(true);
    expect(preflightPublicUrl('http://172.32.0.1').ok).toBe(true);
  });

  it('rejects .local hostnames (mDNS / Bonjour)', () => {
    expect(preflightPublicUrl('http://my-mac.local').ok).toBe(false);
  });

  it('rejects unparseable URLs', () => {
    expect(preflightPublicUrl('not a url').ok).toBe(false);
  });

  it('rejects unsupported schemes', () => {
    expect(preflightPublicUrl('ftp://example.com').ok).toBe(false);
  });
});
