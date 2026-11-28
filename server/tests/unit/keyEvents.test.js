/**
 * Unit tests for UnifiedBackend key event parameters used by typing.
 *
 * windowsVirtualKeyCode decides which key the browser acts on, so a
 * punctuation character sent with its ASCII value as the key code turns
 * into a different key ('.' = 46 = Delete) and the character is lost.
 */

const { UnifiedBackend } = require('../../src/unifiedBackend');

const backend = new UnifiedBackend({}, null);
const params = (char) => backend._keyEventParamsForChar(char);

// Virtual key codes of keys that must never be produced by printable characters
const NAVIGATION_OR_EDITING_KEYS = [8, 9, 13, 27, 33, 34, 35, 36, 37, 38, 39, 40, 44, 45, 46, 47, 91, 92, 93, 96];

describe('UnifiedBackend - key event params for typed characters', () => {
  test.each([
    ['.', 'Period', 190, false],
    ['>', 'Period', 190, true],
    [',', 'Comma', 188, false],
    ['<', 'Comma', 188, true],
    ['-', 'Minus', 189, false],
    ['_', 'Minus', 189, true],
    ['=', 'Equal', 187, false],
    ['+', 'Equal', 187, true],
    [';', 'Semicolon', 186, false],
    [':', 'Semicolon', 186, true],
    ["'", 'Quote', 222, false],
    ['"', 'Quote', 222, true],
    ['/', 'Slash', 191, false],
    ['?', 'Slash', 191, true],
    ['`', 'Backquote', 192, false],
    ['~', 'Backquote', 192, true],
    ['[', 'BracketLeft', 219, false],
    ['{', 'BracketLeft', 219, true],
    [']', 'BracketRight', 221, false],
    ['}', 'BracketRight', 221, true],
    ['\\', 'Backslash', 220, false],
    ['|', 'Backslash', 220, true],
    [' ', 'Space', 32, false]
  ])('%j uses code %s and virtual key %i', (char, code, vk, shift) => {
    const p = params(char);
    expect(p.code).toBe(code);
    expect(p.windowsVirtualKeyCode).toBe(vk);
    expect(p.nativeVirtualKeyCode).toBe(vk);
    expect(p.modifiers).toBe(shift ? 8 : 0);
    expect(p.text).toBe(char);
  });

  test('letters and digits keep their own key codes', () => {
    expect(params('a')).toMatchObject({ code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 0 });
    expect(params('Z')).toMatchObject({ code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 8 });
    expect(params('7')).toMatchObject({ code: 'Digit7', windowsVirtualKeyCode: 55, modifiers: 0 });
    expect(params('!')).toMatchObject({ code: 'Digit1', windowsVirtualKeyCode: 49, modifiers: 8 });
  });

  test('no printable US-keyboard character maps to a navigation or editing key', () => {
    for (let c = 33; c <= 126; c++) {
      const char = String.fromCharCode(c);
      expect([char, NAVIGATION_OR_EDITING_KEYS.includes(params(char).windowsVirtualKeyCode)]).toEqual([char, false]);
    }
  });

  test('press_key with a single character emits the same params as typing it', () => {
    expect(backend._keyEventParamsForKey('.')).toEqual(params('.'));
  });
});
