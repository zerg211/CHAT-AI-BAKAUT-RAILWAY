import { describe, expect, it } from 'vitest';
import { extractContact, hasLeadContact } from '../src/ai/contactExtraction.js';

describe('contact extraction', () => {
  it('extracts explicit name, phone, and email from a lead message', () => {
    const contact = extractContact('Меня зовут Алексей Петров, телефон +7 900 000-00-11, почта buyer@example.com');

    expect(contact).toEqual({
      name: 'Алексей Петров',
      phone: '+7 900 000-00-11',
      email: 'buyer@example.com'
    });
    expect(hasLeadContact(contact)).toBe(true);
  });

  it('extracts a prefix name before the first contact token', () => {
    const contact = extractContact('Алексей Петров: +7 (900) 000-00-11');

    expect(contact.name).toBe('Алексей Петров');
    expect(contact.phone).toBe('+7 (900) 000-00-11');
    expect(contact.email).toBeUndefined();
  });

  it('keeps contact absent when neither phone nor email is present', () => {
    const contact = extractContact('Можно уточнить доставку без звонка');

    expect(contact).toEqual({});
    expect(hasLeadContact(contact)).toBe(false);
  });

  it('does not include sentence punctuation in email contacts', () => {
    const contact = extractContact('Почта buyer@example.com.');

    expect(contact.email).toBe('buyer@example.com');
  });
});
