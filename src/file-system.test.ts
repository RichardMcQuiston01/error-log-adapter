import { describe, expect, it } from 'vitest';
import { parentDirectory } from './file-system.js';

describe('parentDirectory', () => {
  it.each([
    ['/var/log/app.log', '/var/log'],
    ['logs/app.log', 'logs'],
    ['./app.log', '.'],
    ['C:\\logs\\app.log', 'C:\\logs'],
    ['C:/logs/app.log', 'C:/logs'],
    ['D:\\a\\b\\c.log', 'D:\\a\\b'],
  ])('returns the folder of %s', (filePath: string, expected: string) => {
    expect(parentDirectory(filePath)).toBe(expected);
  });

  it.each([
    ['app.log'],
    ['C:app.log'],
    ['/app.log'],
    ['\\app.log'],
    ['C:\\app.log'],
    ['C:/app.log'],
    ['d:\\app.log'],
  ])('returns null for %s, whose folder is a root or missing', (filePath) => {
    expect(parentDirectory(filePath)).toBeNull();
  });
});
