import { describe, expect, it } from 'vitest';
import { containsExplicitContactName, extractContact, hasLeadContact } from '../src/ai/contactExtraction.js';

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

  it('does not turn an ordinary first-person request into a fake name', () => {
    expect(extractContact('Я хочу узнать про генератор. Мой телефон +7 900 000-00-11')).toEqual({
      phone: '+7 900 000-00-11'
    });
    expect(extractContact('Я ищу виброплиту, номер +7 900 000-00-11')).toEqual({
      phone: '+7 900 000-00-11'
    });
  });

  it('accepts an explicit short prefix name without accepting the pronoun as part of it', () => {
    expect(extractContact('Я Алексей: +7 900 000-00-11')).toEqual({
      name: 'Алексей',
      phone: '+7 900 000-00-11'
    });
  });

  it('detects an explicit pronoun-name phrase even without a phone or email', () => {
    expect(containsExplicitContactName('Я Алексей, проверьте способ запуска')).toBe(true);
    expect(containsExplicitContactName('Я Алексей Петров, проверьте способ запуска')).toBe(true);
    expect(containsExplicitContactName('Я хочу узнать про генератор')).toBe(false);
  });

  it('does not mistake product-name questions for a buyer name', () => {
    expect(containsExplicitContactName('Какое имя модели генератора?')).toBe(false);
    expect(containsExplicitContactName('Имя товара FIRMAN RD3910E?')).toBe(false);
    expect(containsExplicitContactName('Подскажите имя производителя')).toBe(false);
    expect(extractContact('Какое имя модели генератора?')).toEqual({});
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

  it('counts phone digits rather than formatting characters and rejects overlong numeric blobs', () => {
    expect(extractContact('+7 (12) 34-56')).toEqual({});
    expect(extractContact('1234567890123456')).toEqual({});
    expect(extractContact('+7 (900) 000-00-11').phone).toBe('+7 (900) 000-00-11');
    expect(extractContact('89000000011').phone).toBe('89000000011');
    expect(extractContact('Телефон 9000000011').phone).toBe('9000000011');
  });

  it('does not mistake product identifiers for phone numbers or names', () => {
    expect(extractContact('Подойдет ремень 1234567890 к резчику?')).toEqual({});
    expect(extractContact('Артикул 5901234123457')).toEqual({});
    expect(extractContact('Модель 123456789012 характеристики')).toEqual({});
  });
});
