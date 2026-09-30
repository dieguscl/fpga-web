import { describe, expect, it } from 'vitest';
import { DICTIONARIES, getLang, setLang, t } from '../src/i18n';

describe('i18n', () => {
  const langs = Object.keys(DICTIONARIES) as (keyof typeof DICTIONARIES)[];
  const en = DICTIONARIES.en;
  const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it('every language has every key, with the same placeholders, non-empty', () => {
    for (const lang of langs) {
      const d = DICTIONARIES[lang];
      expect(Object.keys(d).sort(), lang).toEqual(Object.keys(en).sort());
      for (const [k, v] of Object.entries(d)) {
        expect(v.trim().length, `${lang} ${k}`).toBeGreaterThan(0);
        expect(vars(v), `${lang} ${k}`).toEqual(vars(en[k as keyof typeof en]));
      }
    }
  });

  it('defaults to English outside a browser and switches languages', () => {
    expect(getLang()).toBe('en');
    expect(t('status.queued', { n: 3 })).toBe('Queued (position 3)');
    setLang('pt-PT');
    expect(t('status.queued', { n: 3 })).toBe('Em fila (posição 3)');
    setLang('es');
    expect(t('btn.build')).toBe('Compilar');
    setLang('en');
  });
});
